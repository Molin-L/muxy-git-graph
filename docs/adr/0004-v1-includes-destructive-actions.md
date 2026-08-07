# v1 ships the full action set, including destructive operations

`vscode-git-graph`'s feature surface splits into five tiers: the graph itself,
reads around it (commit details, find, filtering, comparison), safe writes,
destructive writes (fetch, merge, rebase, reset, stash, remote management), and a
long tail (code-review tracking, issue linking, PR-provider config, config export,
avatars, 110 settings). v1 covers the first four; the long tail is deferred.

The destructive tier is in v1 because it is where the reason-to-install lives.
Muxy's official `git` extension already does cherry-pick, revert, copy-hash and
diffs, so a graph plus safe writes would overlap it almost entirely. Nothing in
Muxy today offers fetch, merge, rebase, reset or stash.

Including that tier is also cheaper than it looks: `vscode-git-graph` has **no
conflict handling at all** — a grep for "conflict" across its `src/` and `web/`
returns nothing. It surfaces the raw `git` error and expects you to resolve the
mess in VS Code's SCM view. So each destructive action is roughly one `exec` call
plus a confirm dialog.

## Consequences

- We add what git-graph does not have: an **In-Progress Banner** offering **Abort**
  and **Continue**. Without it, hitting a conflict strands the user with a raw error
  and no signal that resolution lives in a *different extension's* panel.
- Detection uses `git rev-parse --git-path` and `git rev-parse --verify --quiet`
  rather than probing `.git/` directly, so it stays correct inside linked worktrees
  where the git dir is not `.git`. The official `git` extension's
  `PENDING_OP_PROBE` is the reference implementation.
- The expensive work is the graph tier, not the action tiers. Schedule accordingly.
