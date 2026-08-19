# Muxy Git Graph

A Muxy extension that renders a repository's commit history as a graph and lets the
user act on it. The product spec is `vscode-git-graph`; the implementation is a
Muxy-native rewrite (see [ADR-0001](./docs/adr/0001-rewrite-not-port.md)).

## Language

### The graph

**Commit Feed**:
The ordered list of commits backing the graph, read in pages from a single `git log`
invocation.
_Avoid_: history, log, commit list

**Vertex**:
A single commit's dot in the graph, at the intersection of one row and one lane.
_Avoid_: node, dot, point

**Lane**:
A vertical track in the graph that a chain of commits is drawn along. Lanes are
assigned positionally per row and reused once free; a lane is not a git branch.
_Avoid_: column, branch line, swimlane

**Ref**:
A name pointing at a commit — a local head, a remote-tracking branch, or a tag.
_Avoid_: label, decoration, badge

**Ref Chip**:
A ref as drawn on a row. A local head whose remotes are at the same commit is one
chip, not several: `origin │ main` names the remotes that agree with it and then
the branch once, as `vscode-git-graph`'s `combineLocalAndRemoteBranchLabels` does.
Each half acts on its own ref. A remote's symbolic `HEAD` (`origin/HEAD`) is not a
Ref Chip at all — it is dropped when the decoration is parsed, since it always
repeats the branch it points at.
_Avoid_: badge, tag, pill

> Terminology note: `vscode-git-graph` calls a lane a `Branch` and Muxy's official
> git extension calls it a `column`. Both are rejected here — `Branch` collides with
> the git concept, and `column` collides with the graph view's *table* columns
> (Graph / Description / Date / Author / Commit).

**Ref Digest**:
A hash of every ref's target object, used to detect that the repository moved
underneath us. Cheap to compute and the only signal available for commits, fetches,
tags and stashes (see [ADR-0008](./docs/adr/0008-freshness-events-plus-focused-poll.md)).
It is also what validates a cached graph on a project switch
(see [ADR-0019](./docs/adr/0019-warm-graph-per-project.md)).

**Warm Graph**:
A project's cached Commit Feed, plus the Ref Digest that says whether it is still
true. Painted immediately on a switch and revalidated behind the paint.
_Avoid_: snapshot, stale state

### Surfaces

**Graph Tab**:
The extension's tab surface — the whole product. It follows the active project and
worktree rather than being pinned to one repository
(see [ADR-0003](./docs/adr/0003-graph-tab-follows-active-project.md)).
_Avoid_: view, window, panel

**Commit Details**:
The pane docked at the bottom of the Graph Tab showing a selected commit's message,
refs and changed files. It lists files; it does not render diffs.
_Avoid_: inspector, sidebar, preview

**Find Widget**:
The search control summoned by the topbar's Find button or `⌘F`, dropping into the
graph's top-right corner clear of the column header, and dismissed with Escape or a
second press of the button. It searches the Commit Feed itself rather than the
rendered rows
(see [ADR-0018](./docs/adr/0018-find-matches-the-feed-not-the-dom.md)).
_Avoid_: find field, find bar, search box, filter

**In-Progress Banner**:
The persistent banner shown when the repository is mid-merge, mid-rebase,
mid-cherry-pick or mid-revert, offering Abort and Continue. Has no equivalent in
`vscode-git-graph` (see [ADR-0004](./docs/adr/0004-v1-includes-destructive-actions.md)).

### Muxy concepts

**Project**:
A repository registered in Muxy's sidebar. The unit `muxy.git` targets by default.

**Worktree**:
A checkout belonging to a Project. A Project always has an active Worktree, and all
git reads and writes are scoped to it.

**Extension Output**:
Muxy's panel for extension logs, shared by every installed extension. Muxy feeds it
by wrapping `console` in each surface, so it is where every line this extension
writes ends up (see [ADR-0020](./docs/adr/0020-log-to-muxys-extension-output.md)).
_Avoid_: console, devtools, debug panel
