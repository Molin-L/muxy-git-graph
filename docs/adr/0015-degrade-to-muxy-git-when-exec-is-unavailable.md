# Fall back to `muxy.git` when `exec` cannot spawn

> **Superseded by [ADR-0016](./0016-tunnel-git-over-ssh-for-remote-workspaces.md).**
> Degrading was the wrong answer: on a remote workspace the extension now asks for
> SSH details and tunnels git, rather than running a reduced feature set. The
> `muxy.git` reader below remains only as the path used before a target is set.

Amends [ADR-0002](./0002-data-layer-split.md), which routed **every** read through
`muxy.exec`.

`muxy.exec` spawns a process on the machine running Muxy. For a project on a remote
(SSH) device the worktree path does not exist locally, so every command fails with:

```
exec failed to launch: spawn process: No such file or directory
```

Because ADR-0002 put all reads behind `exec`, the extension was not degraded on a
remote workspace — it was completely dead, with a blank panel. The official `git`
extension survives there precisely because it reads through `muxy.git`, which is the
app's own git core and does follow the remote workspace.

So the data layer probes `git --version` once per workspace and picks a path:

- **`exec` available** — the rich path of ADR-0002, unchanged. Commit bodies, author
  emails, stashes, `--branches --tags --remotes`, diffs, merge/rebase/reset/stash.
- **`exec` unavailable** — `muxy.git.log` and `muxy.git.status`. That covers
  everything the graph and all four text columns need: hash, parent hashes, refs,
  subject, author name, author date, plus a synthesised uncommitted-changes row.
  Lost are the author *email* (avatars, deferred to Tier 4 anyway) and the commit
  *body*, which only the details pane uses.

Features that genuinely cannot work without a shell — commit details, diffs, commit
comparison, remotes, pending-operation detection — fail with an explicit message
rather than silently, and the panel shows a persistent "Limited mode" notice naming
what does and does not work.

## Consequences

- The probe result is cached per workspace and **must be reset on
  `project.switched` / `worktree.switched`** (ADR-0003 has the panel follow the
  active project, so it can move between a local and a remote repository at any
  time). `repo.resetCapabilities()` does this; a stale cache reintroduces the bug.
- ADR-0002's reasoning still holds where `exec` works, and its conclusion — "prefer
  `exec` for reads" — was correct only for local workspaces. The cost it weighed
  (missing author emails and bodies) was real but far smaller than the cost it
  missed (no remote support at all).
- `muxy.git.log` has no `--branches --tags --remotes` equivalent, so in limited mode
  the graph shows only commits reachable from the current history, and stashes do
  not appear.
