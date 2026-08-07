# Freshness comes from events plus a ref digest polled only while focused

`vscode-git-graph` watches `.git/config`, `.git/index`, `.git/HEAD`,
`.git/refs/stash`, `refs/heads/*`, `refs/remotes/*` and `refs/tags/*`, and refreshes
on any of them. Muxy exposes almost none of that. Its event catalogue contains
exactly one git event — `worktree.headChanged`, which watches `.git/HEAD` and fires
on branch switch — and `file.changed` explicitly skips `.git/` as "Git-internal
noise." There is no commit event, no index event and no status event, so a new
commit on the current branch, a fetch, a new tag and a stash push are all invisible.

The refresh strategy is therefore layered:

- `worktree.headChanged` → full refresh.
- `project.switched` / `worktree.switched` → rebind and full refresh.
- `file.changed`, debounced → refresh **only** the uncommitted-changes row via
  `muxy.git.status`. This is the one thing `file.changed` is genuinely good for.
- Our own writes → refresh immediately, since we know when we ran them.
- `cmd+R` → manual refresh.
- **While the Graph Tab is focused**, `git for-each-ref --format=%(objectname)`
  every ~4s, hashed and compared. One cheap subprocess, no output parsing, and it
  catches commits, fetches, tags and stashes in a single check. It stops when the
  tab loses focus, so an unfocused tab costs nothing and refreshes on refocus.

Events-only was rejected: Muxy's usage pattern is a graph sitting beside a terminal,
and `git commit` in that terminal would leave the graph silently stale.

## Consequences

- Pulls in `worktrees:read` (for `worktree.headChanged`) and `files:read` (for
  `file.changed`).
