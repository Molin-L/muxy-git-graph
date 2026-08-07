# One Graph Tab, following the active project and worktree

`vscode-git-graph` opens one view per repository and ships its own repository
dropdown. Muxy does not work that way: the sidebar *is* the repository switcher,
`muxy.git` implicitly targets the active project's active worktree, and
`project.switched` / `worktree.switched` events are available to subscribe to.

So there is a single Graph Tab, it subscribes to both events, and it re-queries and
re-renders when either fires. Pinning a tab to a fixed repository was rejected
because it would force us to rebuild repository identity and switching inside the
tab — duplicating native chrome, against the "indistinguishable from a native
surface" rule of ADR-0001.

## Consequences

- You cannot view repository A's graph while working in repository B. If that turns
  out to matter, the intended fix is a pin toggle, not a redesign.
- To keep that fix cheap, the project selector passed to every git call is resolved
  in exactly one place, so switching from "active" to "pinned" is a change to one
  function rather than to every call site.
