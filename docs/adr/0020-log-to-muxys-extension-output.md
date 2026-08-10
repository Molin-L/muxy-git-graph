# The log is `console`, and it goes to Muxy's Extension Output panel

Until now the extension wrote nothing anywhere. Every failure was a string in the
topbar's status label or the notice line, which is the right place for a user and
the wrong place for anyone diagnosing a workspace: the interesting part is the
*sequence* — which transport rung was tried, what the probe actually sent, how long
a reload took, whether an event ever arrived — and a one-line label can only ever
show the last of those, if it survives the next repaint at all.

Muxy already has the surface. It runs an **Extension Output** panel (View → Toggle
Extension Output) fed by an `ExtensionLogTailer`, and both of its bridges wire
`console` into it: a webview's `console.log`/`warn`/`error` are wrapped and posted
through a `muxyConsole` message handler, along with uncaught errors and unhandled
rejections, while `background.js` gets a `console` shim over the same channel.

So there is no logging API to adopt and nothing to open. `console` **is** the log,
and `src/log.ts` is a thin formatter over it: a `[git-graph:<surface>]` prefix, then
a message, then `key=value` fields.

Three things follow from the panel being *shared* with every other extension:

- **`console.debug` is not wrapped.** Only `log`, `warn` and `error` are, so debug
  lines go out over `console.log` and name their own level.
- **Milestones are always on; chatter is not.** A bound project, a settled
  transport, a finished reload, a failed action — those are `info` and cost a line
  each. Every exec and every relay round trip is `debug`, and stays off until
  someone presses ⌘⌥L. Polling never logs unless the digest actually moved, so an
  idle panel is silent.
- **The surface is in the prefix.** The panel, the diff tab and the relay all write
  to one place, and a line that does not say which one it came from is barely a
  line.

The verbose toggle persists to `storage["log.verbose"]`, which is what lets the diff
tab open already verbose and a debugging session survive a panel reload.

## Consequences

- The relay's two halves stay on one toggle without a second channel: the
  background script cannot read a webview's setting, so `verbose` rides along in
  each exec request and the relay logs per-command lines only for a request that
  asked. Its own startup line and any exec that *throws* are unconditional — that
  failure is what a blank panel on a remote workspace looks like from the inside.
- Log lines are a shared, user-visible surface, so commands and detail strings are
  clipped (`log.clip`) rather than printed whole. Git output is unbounded; the
  panel's line is not.
- The transport probe is now recorded twice — into
  `storage["diagnostics.lastProbe"]` as before ([ADR-0017](./0017-background-exec-relay.md)),
  and into the output panel as it happens. The stored copy answers "what did it
  settle on"; the panel answers "what did it try, and in what order".
- Tests import `tests/quiet-log.ts` to drop our own lines from the runner's output.
  `tests/log.test.ts` does not — it asserts on them.
