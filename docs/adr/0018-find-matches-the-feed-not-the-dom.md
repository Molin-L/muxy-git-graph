# Find matches the Commit Feed; highlighting happens as rows render

The find widget searches the in-memory Commit Feed and produces a list of commit
indices. Nothing about matching touches the DOM. Highlighting is applied inside
`renderRow`, the same function that fills a recycled row's cells.

`vscode-git-graph` does the opposite. Its `findMatches` walks the commit rows in
the document, splits each text node at the match boundaries and splices in
`<span class="findMatch">` elements; `clearMatches` walks back over them,
reassembling the sibling text nodes it previously tore apart. About seventy lines
of the widget are that surgery.

That approach is not available here, and would not be worth having if it were.
Rows are virtualised (ADR-0007): a few dozen exist at any moment, so a DOM walk
would find only the matches on screen, and any row scrolled past would lose its
highlights the moment it recycled. The Commit Feed is the only complete copy of
the history the panel holds — it is the thing to search.

Rendering-time highlighting then falls out for free. A row scrolled into view is
painted from data that already knows the active pattern, so it arrives
highlighted. There is no highlight state to install, and none to tear down: the
`clearMatches` half of upstream's problem does not exist, because closing the
find widget drops the pattern and the next render writes plain `textContent`.

## Consequences

- Matching is pure — query plus commits in, indices out — so it is unit-tested
  (`tests/find.test.ts`) rather than only observable by eye. This matters more
  here than upstream, where every match is on screen by construction: a matcher
  bug in a virtualised list looks like "the commit two screens down was never
  found", which no other test in this repo would catch.
- **A hidden column is still searched.** Upstream gates matching on column
  visibility, so a hidden Author column makes author queries silently return
  nothing. Its columns drop only in a narrow editor pane; ours drop at widths a
  right panel sits at every day — Author below 480px, Date below 620px. A search
  for a name that finds nothing is worse than a match the user opens the commit
  to explain. Consequently a match is not always visibly highlighted; the row
  ring marks it either way.
- The Commit column shows an abbreviation and the Date column a relative time,
  so the full hash and the ISO date are searched but never highlighted — the
  text that matched is not the text on screen.
- Zero-length patterns are rejected at compile time rather than discovered
  mid-walk. Upstream searches everything, notices `.*` produced empty matches,
  then throws the results away. Here `.*` never gets a result set: it would
  report every commit as a match while highlighting nothing.
- **The widget is summoned, as it is upstream, but from a button as well as from
  `⌘F`.** An earlier revision kept the field permanently in the topbar, reasoning
  that `⌘F` is a chord a panel webview competes with the host for, and that a find
  which only exists once the chord lands is one some users never find at all. The
  button answers that objection without the cost: it is always visible, so find is
  still discoverable by eye, and the widget itself is then free to be a readable
  input with both modifiers and the match count beside it, because it borrows the
  graph's top-right corner instead of sharing the topbar with the branch name and
  the status.
- **It clears the topbar and the column header, and carries neither a ✕ nor
  steppers.** Upstream lands its widget on its control bar and gives it a ✕ and a
  pair of match arrows. None of the three survives a right panel. Covering the
  topbar would take the branch name and Refresh with it, so the widget floats
  inside the graph area rather than the panel — which also keeps it below the
  column header when a banner pushes the graph down. The ✕ and the arrows are
  width spent on controls the user already has: the Find button toggles and shows
  pressed while the widget is out, and `⏎`/`⇧⏎` (or `⌘G`/`⇧⌘G`) walk the matches,
  which the input's tooltip says. What is left — the input, `Aa`, `.*` and the
  count — is what nothing else can do, and it fits at 260px with the input still
  the part that grows.
- Stepping through matches scrolls and rings the row, but does not select it.
  Selecting would open the Commit Details pane, and on a remote workspace each
  open is a round trip (ADR-0017) — upstream reaches the same default from the
  same reasoning, and puts it behind a toggle this widget does not carry.
