# Tunnel git over SSH for remote workspaces

Supersedes the degradation strategy in
[ADR-0015](./0015-degrade-to-muxy-git-when-exec-is-unavailable.md).

`muxy.exec` spawns on the machine running Muxy, so for a project on a remote (SSH)
device the worktree path does not exist locally and every command fails with
`spawn process: No such file or directory`. Muxy's own `git` extension does nothing
about this — every call is a bare `muxy.exec(argv)` with no options, wrapped in
`.catch(() => null)`, so on a remote it silently swallows the failures and leans on
`muxy.git`. It downgrades invisibly.

We do not downgrade, and we do not reach for SSH before exhausting Muxy's own
`exec`. The data layer resolves a transport once per workspace, cheapest first:

1. **`direct`** — plain `muxy.exec(argv)`.
2. **`shellCwd`** — `muxy.exec({shell: "cd <path> && …"})`. Muxy reports a remote
   project's path as `~/projects/gateway`, tilde intact. `spawn(2)` cannot resolve
   `~`, so a bare exec fails with `No such file or directory` — but a shell expands
   it. This is still Muxy's own exec, and it is the rung most likely to fix a remote
   workspace with no SSH plumbing at all.
3. **`ssh`** — only if both of the above fail.

Rungs 2 and 3 pass an explicit `cwd`. This is the crux: Muxy sets the spawn cwd to
the project path, which for a remote project is `~/projects/gateway` — unresolvable,
so **every** spawn fails before the process starts, including `git --version`, which
never reads the cwd. Wrapping the command in a shell cannot help, because the shell
itself is what fails to launch. Overriding cwd to a directory that certainly exists
is what makes any fallback possible at all.

The SSH target is **not** asked for. `muxy.exec` runs on the machine holding Muxy's
own configuration, so the extension reads `projects.json` (which carries
`remoteDeviceID` and the remote `path`) and `remote-devices.json` (which maps that id
to `ssh.host`) and resolves the target itself. `muxy.files` cannot reach those paths —
it is sandboxed to the worktree — but `exec` can. The dialog remains only for the case
where no remote project in Muxy's config matches the worktree.

Having resolved a target, it tunnels every subsequent command:

```
ssh -o BatchMode=yes <host> -- cd ~/'projects/gateway' && 'git' 'log' …
```

## Connection reuse

A connection per command would be unusable — a host may sit behind a `ProxyCommand`
that probes several endpoints before connecting.

`ssh -G <host>` resolves the effective config **locally, without connecting**. If it
reports a live `ControlMaster` and `ControlPath`, we pass **no control options at
all** and inherit the user's setup. Only when a host has no reuse configured do we
impose our own `ControlMaster=auto`, `ControlPath=~/.ssh/muxy-git-graph-%C`,
`ControlPersist=120`.

Overriding the user's `ControlPath` — including pointing it at Muxy's own
`~/.ssh/muxy-%C` socket — was tried and rejected: on a host whose config already
multiplexes, it bypasses their master and redials the expensive path every time.

Measured against a real remote: **2.3s cold, then 0.22s and 0.30s** reusing the
user's existing master.

## Quoting

The remote command is one shell string, so every argument is POSIX single-quoted,
with `'` escaped as `'\''`. A leading `~` is deliberately left outside the quotes
(`~/'projects/gateway'`) because the remote home directory is not knowable locally.
`tests/remote.test.ts` proves the round trip by running the generated string through
a real `/bin/sh` and asserting every argument comes back byte for byte, including
`$(…)`, backticks, quotes, globs and pipes.

## Consequences

- `\x1f` / `\x1e` record separators in the `git log` format survive SSH unchanged —
  verified against a real host — so the parser needs no transport-specific handling.
- The SSH target is stored per workspace in `muxy.storage` and must be re-probed on
  `project.switched` / `worktree.switched` (`resetCapabilities()`).
- `BatchMode=yes` throughout: a hidden password prompt would hang the panel, and a
  clean failure with a message is better.
- If Muxy later routes `exec` to the active remote worktree, the local probe
  succeeds and this whole path goes dormant with no code change.
