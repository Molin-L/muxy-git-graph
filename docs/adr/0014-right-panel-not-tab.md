# The graph lives in the right panel, not a tab

Supersedes the surface half of [ADR-0003](./0003-graph-tab-follows-active-project.md).
The binding half of that ADR still stands: one surface, following the active project
and worktree.

ADR-0003 argued for a tab because `vscode-git-graph` is a wide table — Graph /
Description / Date / Author / Commit — and a narrow panel would collapse those
columns. That reasoning was about the *original's* layout rather than about how
Muxy is actually used: a graph is something you keep visible beside your work, not
something you switch to a full pane to look at. The official `git` extension puts
source control in the right panel for the same reason, and a graph that displaces
your editor is a graph you close.

The panel is `position: right`, `mode: pinned`, toggled by `cmd+shift+g`.

## Consequences

- **The column set has to adapt to width.** A `ResizeObserver` drops Date, then
  Author, then Commit as the panel narrows, leaving Graph + Description + refs at
  the smallest sizes. The columns are not removed from the model, only from view,
  so a user who widens the panel gets them back.
- The Commit Details view docks at the bottom of the panel and is vertically
  cramped, so it scrolls independently and the file list is the priority content.
- The diff viewer stays a **tab** (ADR-0006). A panel is the wrong place to read a
  diff, and this keeps the split clean: the panel is for navigating history, the tab
  is for reading a change.
- `togglePanel` replaces `openTab` as the command action. Still no background script
  is required (ADR-0013).
- **`panels:write` is required**, even though `togglePanel` is a declarative action
  Muxy resolves itself. It gates `panel.open` / `panel.toggle` / `panel.close`, and
  it is a manifest-only check with no runtime consent prompt — so omitting it makes
  the topbar button render and silently do nothing. Least privilege does not apply
  here: shipping a panel means shipping this permission.
  `tests/manifest.test.ts` asserts the pairing.
