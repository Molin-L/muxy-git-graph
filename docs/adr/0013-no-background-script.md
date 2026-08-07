# No `background.js`

> **Partially superseded by [ADR-0017](./0017-background-exec-relay.md):** a
> background script now exists, but solely as an exec relay for workspaces the
> webview's exec cannot reach. The reasoning below still governs everything else —
> no durable event handling, no shared state, no logic in the background.

The extension ships no background script. The Graph Tab and the diff-viewer tab do
all the work, including the ref-digest poll from ADR-0008 — which is deliberately
tab-local, since it only runs while the tab is focused and has nothing to do when it
is not.

A future reader may find that surprising, because a polling loop is the kind of
thing that usually lives in a background script. It does not here: nothing in this
extension needs durable event handling that must survive the tab closing, shared
state across surfaces, or background `exec`. Muxy's own authoring guidance is that
most extensions do not need one.

The command that opens the Graph Tab uses the `openTab` action kind, which Muxy
resolves itself — only the `event` action kind would require a background listener.
Combined with `singleton: true` on the tab type, that also enforces ADR-0003's
one-Graph-Tab rule without any code.

## Consequences

- With no background script running, `muxy.events.emit('extension.*')` is
  unavailable to us — a webview emit is relayed through `background.js` and rejects
  when none exists. The Graph Tab and the diff-viewer tab therefore cannot talk to
  each other directly; the diff-viewer receives everything it needs in its
  `tabs.open` payload and is otherwise independent.
