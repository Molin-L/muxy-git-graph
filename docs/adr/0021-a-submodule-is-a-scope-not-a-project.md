# A submodule is a scope over the active worktree, not a project of its own

`vscode-git-graph` treats a submodule as another repository. It reads
`.gitmodules` for every repository it knows, resolves each `path =` entry to a
repository root, and adds the ones that resolve to the list its repository
dropdown offers. Opening one is then indistinguishable from opening any other
repository.

That shape is not available here. The Graph Tab has no repository dropdown to add
an entry to: it follows whatever project and worktree Muxy has active (ADR-0003),
and Muxy's sidebar — which owns that choice — does not know submodules exist. So
the panel keeps one identity, the active worktree, and gains a **scope**: a path
inside it that every git command runs at instead of the root.

The scope lives in `repo.ts` beside the transport, because that is the one place
a command becomes a payload. `target()` answers "where does this run", the three
transports already wrap commands in `cd <path> &&` or a `cwd`, and pointing that
at a submodule instead of the worktree is the whole mechanism. Nothing above the
data layer needs to know: the graph, the details pane, the poll and the diff all
ask the same functions they always did.

## Consequences

- **Discovery is `submodule foreach`, not `.gitmodules`.** Upstream's file parse
  lists submodules that were never initialised — no history to show — and finding
  out which is a round trip each (ADR-0017). `git submodule foreach --quiet
  --recursive 'printf "%s\0" "$displaypath"'` visits exactly the initialised
  ones in a single command, and NUL-separates paths so a submodule under a
  directory with a space survives. It is asked once per worktree, after that
  worktree's graph is already on screen, and only where there is something to
  find: a repository without submodules never grows a switcher.
- **The scope is a selector, not a toggle.** Upstream's repository dropdown shows
  the repository being viewed as its value, and this is the same control with the
  same default: the worktree itself, named after its directory, with each
  submodule's path beneath it. It appears only where a repository has submodules,
  because a selector with one option is not a choice — and the topbar is shared
  with the branch name, the status and two buttons.
- **The repository is not one of the submodules.** They are different kinds of
  entry, and a flat list of names says otherwise, so the options are grouped
  under `Repository` and `Submodules`. A closed selector shows a name and no
  group, so it also takes the accent colour whenever a submodule is selected:
  everything else in the panel — graph, refs, details — looks identical in a
  submodule and in the repository containing it, and that is the only standing
  sign of which one is on screen.
- **Writes leave `muxy.git` while a scope is set.** ADR-0002 routes writes
  through `muxy.git` for its named consent prompts, but those calls take no path
  — every one of them lands on the worktree Muxy has active. In a submodule that
  is the wrong repository, and the failure is silent and destructive: a checkout
  meant for the submodule moves the parent's HEAD. Scoped, those ten operations
  fall through to plain git, which the transport already puts in the right place.
  The trade is the consent prompt, and it is worth it; `tests/repo.test.ts`
  asserts a branch created in a scope lands in the submodule and not in the
  repository containing it.
- **A submodule cannot be read in degraded mode.** With no shell, history comes
  from `muxy.git` (ADR-0015), which again answers about the active worktree. A
  scoped read there would be the parent's history wearing the submodule's name,
  so it throws instead. In practice the switcher never appears, because
  discovery needs the same shell.
- **Two scopes of one worktree are two repositories.** The warm graph, the
  details cache and the persisted state are keyed by worktree *and* scope
  (ADR-0019), so switching back and forth repaints instantly rather than
  re-reading, and one repository's commit hashes can never be looked up in the
  other.
- **The scope does not outlive the session.** It is where you are working, not a
  setting: leaving the project and coming back restores it, restarting does not.
  Persisting it would mean the panel could open showing a repository the user has
  no memory of choosing, with the worktree's own name in Muxy's sidebar.
- **A transport re-test keeps the scope.** `rebindWorkspace()` deliberately does
  not clear it — ⌘R re-tests how git is reached, which is a question about the
  machine, not about which repository is on screen. Only a project switch drops
  it, and the panel does that explicitly.
- **The diff tab is told.** It is a separate surface with its own transport
  (ADR-0006), so the scope travels in the tab payload. Without it a submodule's
  file would be diffed against the parent, where that path does not exist.
