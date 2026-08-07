# Relay exec through background.js for workspaces the webview cannot reach

Partially supersedes [ADR-0013](./0013-no-background-script.md) (no background
script) and closes the question left open by
[ADR-0016](./0016-exec-routing-is-muxys-job.md).

The Muxy binary contains **two** extension bridges: a `dispatch`-based one injected
into webviews, and a `send`-based one for background scripts and `runScript`
commands. The documentation page that promises remote execution — "when the active
workspace is a remote SSH workspace, `muxy.exec` … run on the remote server", with
remote `cwd` interpretation, the SSH device's environment, and channel-based
cancellation — is the **scripts** page. That promise belongs to the second bridge.
Webview exec spawns on the machine running Muxy, always; that is the wall ADR-0016
measured, and the official git extension's webviews hit it identically.

So the extension now ships a `background.js` whose only job is to be the other
bridge: the panel sends `{kind: "exec", id, argv|shell}` over the same-extension
event channel, the background script runs it with its own synchronous `muxy.exec`,
and the result comes back chunked — 8 KiB of raw text per event, because event
payloads are capped at 64 KiB and JSON-escaping control-character-heavy git output
(the `\x1f`/`\x1e` record separators) can inflate it several-fold.

The transport ladder is therefore: `direct` (webview exec), `shellCwd` (webview
exec through a shell, for local paths the spawn cwd cannot resolve), `background`
(the relay). The relay's probe is deliberately strict: `git rev-parse
--show-toplevel` must equal the root `muxy.git.repoInfo()` reports for the active
workspace. Without that check, a background exec that happened to land in some
local repository would silently render the wrong project's history.

## Consequences

- On a workspace where the relay works, **everything** works — per-commit file
  lists, diffs, merge/rebase/stash/fetch — because every existing exec call site
  rides the same `exec()` seam.
- If the relay also fails (or reaches the wrong repository), behaviour falls back
  to ADR-0016's read-only `muxy.git` mode, and the probe report — persisted to
  `storage["diagnostics.lastProbe"]` — records all three rungs.
- ADR-0013's reasoning survives for everything else: the panel still owns its
  polling and UI state. The background script is a dumb relay with no state beyond
  the subscription.
- The relay serialises commands (background exec is synchronous). Fine for git's
  short reads; the panel's adaptive polling already scales with observed latency.
