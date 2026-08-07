# Reads go through `muxy.exec`, writes go through `muxy.git`

> **Amended by [ADR-0015](./0015-degrade-to-muxy-git-when-exec-is-unavailable.md).**
> This decision holds only where `exec` can spawn. On a remote (SSH) workspace it
> cannot, and routing every read through `exec` left the extension completely dead
> there rather than degraded.


The extension has two ways to reach git — Muxy's structured `muxy.git` API and raw
`muxy.exec` — and it uses both, split by **intent** rather than by capability.

**Reads use `muxy.exec`** with hand-written `--format` strings. `muxy.git.log()`
returns only `{hash, shortHash, subject, authorName, authorDate, isMerge,
parentHashes, refs}` — no author email (so no avatars, no identity matching), no
commit body (so no commit-details message and no issue linking), no stash refs, and
no way to request `--branches --tags --remotes`. Sourcing the commit feed from
`muxy.git.log()` would mean a second `exec` pass for the missing fields and two
sources of truth for the same commits. The exceptions, where `muxy.git` returns
richer structured data than we would want to parse ourselves, are `diff`, `status`,
`worktrees` and `pr.*`.

**Writes use `muxy.git`** wherever the operation exists — `commit`, `push`, `pull`,
`checkout`, `cherryPick`, `revert`, `branch.create`/`delete`/`deleteRemote`,
`tag.create` — because each one triggers its own named consent prompt. A user
approving *"allow git.cherryPick"* is meaningfully better informed than a user who
granted blanket `commands:exec` once and cannot see what is being run. Operations
`muxy.git` does not have — merge, rebase, reset, stash, fetch, tag delete, remote
management — fall back to `exec`.

## Consequences

- `commands:exec` is required either way, since fetch/merge/rebase/reset/stash are
  core actions with no `muxy.git` equivalent. Minimising permissions was never
  available as a reason to prefer one API.
- Reads do not benefit from `muxy.git`'s HEAD/index-aware cache; refresh is ours to
  manage.
- The split is genuinely surprising on first read (`exec` for log, `muxy.git` for
  revert), which is why it is recorded here.
