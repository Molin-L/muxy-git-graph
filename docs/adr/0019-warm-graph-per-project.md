# Switching projects paints from a per-project cache, then revalidates

The Graph Tab follows the active project (ADR-0003), and real work rotates
between projects constantly. Each switch re-read the repository from scratch,
which took about three seconds on a remote workspace — and for the whole of it
the panel showed the *previous* project's graph, with nothing saying so.

None of that cost was git. Every command in a repaint runs in about ten
milliseconds. The cost was the number of round trips, serialised:

| | round trip | why it waited |
|---|---|---|
| 1–3 | the transport ladder: direct → shellCwd → background | `resetCapabilities()` on every switch, one rung at a time |
| 4 | `rev-parse HEAD` + `rev-parse --abbrev-ref` | |
| 5 | `git log` | issued after the head resolved |
| 6 | `git stash list` | issued after the log parsed |
| 7 | `git status --porcelain` | issued after the stashes |

Seven hops, each an SSH round trip on a remote workspace. Three changes remove
them, in that order of payoff.

## The transport is remembered per workspace

Which rung of the ladder works depends only on the workspace, which the
repository root identifies. `rebindWorkspace()` now forgets only the *active*
verdict; a workspace visited before recovers its rung with no probe at all.

Only successes are remembered. A degraded verdict is often transient — Muxy's
workspace context syncs after the stores load — and ADR-0015 leans on re-probing
to recover from it, so caching one would freeze a workspace in read-only mode. A
rejected `exec` (a spawn failure or a timeout, as distinct from a non-zero exit,
which is git reporting a git problem) drops the memory, and `resetCapabilities()`
behind a manual refresh clears all of it.

## A repaint is one command

Head, branch, log, stashes, status, refs, remotes and the in-progress probe are
eight commands in four serial waves, and none of them needs another's *output*.
They are now a single shell invocation with the results separated by `U+001D`,
which every rung of the ladder can carry. Four waves become one.

`git rev-parse --is-inside-work-tree` leads the batch so that an empty reply from
a shell that never reached the worktree is not rendered as a healthy, empty
repository.

This is what makes a *first* visit to a project fast. The cache below does
nothing for one.

## A visited project paints from cache, then revalidates

Each project keeps its graph, remotes, in-progress state, page size, selection
and scroll offset, keyed by repository root — in memory, and a prefix of it in
storage so the first switch after an app restart is fast too. On a switch the
cached graph paints immediately and `refDigest` — one round trip, and already the
signal the poll trusts (ADR-0008) — says whether it was true. Matching means the
paint was the whole of the work. Differing costs what a cold load would have.

This also fixes the wrong-repository window: a project with nothing cached
adopts an empty panel rather than leaving the previous project's graph up.

The freshness contract in ADR-0008 changes accordingly: a switch no longer
*always* re-reads. It always revalidates, and re-reads when the digest says to.

## Consequences

- A warm switch is one round trip; a cold one is two (probe, then batch).
- The digest must be byte-identical between `loadSnapshot` and `refDigest`, or
  every poll would look like the repository had moved. One function builds it,
  and a test pins the two together.
- A cached graph can be shown for the length of one digest check before being
  corrected. Acceptable: the same staleness window already exists between polls.
- Commit details are now keyed by project as well as hash. Hashes are globally
  unique, but `*` — the uncommitted row — is every repository's working tree, and
  reading one project's under another's would be wrong rather than merely stale.
- Persisted graphs are truncated to a prefix, so a restored project drops its
  selection and scroll offset rather than restoring them to the wrong commit.
- Nothing prefetches a project the user has not opened. Muxy exposes no
  project-enumeration API, and `exec` is routed to the active workspace by the
  app (ADR-0016), so warming an unvisited project would mean constructing
  routing of our own.
