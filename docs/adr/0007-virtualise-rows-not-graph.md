# Virtualise the table rows; keep one SVG for the whole loaded range

Row elements recycle as the user scrolls, but the graph itself stays a single,
absolutely-positioned SVG covering every loaded commit, translated underneath the
recycled rows.

`vscode-git-graph` does no virtualisation at all — no windowing, no
`IntersectionObserver`. Its 300-initial / +100-on-scroll paging is a workaround for
that, not a data-fetching decision, and it is why the view degrades on large
repositories.

Virtualisation belongs on the rows because that is where the cost is: five cells per
row, each with text, ref chips and hover handlers. The SVG is comparatively cheap,
because each Lane's contiguous run is merged into a single polyline rather than one
path per row — a few thousand commits is a few hundred paths. Keeping the SVG whole
also preserves the absolute-coordinate geometry that the `graph.ts` port depends on;
splitting it into per-row segments would mean rewriting that geometry rather than
porting it, which would undercut ADR-0005.

## Amendment after the spike (measured)

The path-merging claim held, and then some: **50,000 commits produced 3,181 paths**,
a 16:1 reduction.

The claim that "the SVG is comparatively cheap" was still wrong, because it counted
only paths. The SVG also carries **one `<circle>` per commit**, so at 50,000 commits
it held **53,181 elements** — against 29 recycled row elements. The SVG, not the
rows, is where the node count lives.

It survives anyway. An aggressive scripted scroll traversing 289,000 px in 3s
measured a median frame of 8.4 ms, p95 of 16.8 ms and a single 49.9 ms hitch, with
18 of 320 frames over 16.7 ms. Initial layout was 164.7 ms and the first draw
89.5 ms — a visible quarter-second stall on load at that size, but a one-off.

Two caveats on those numbers. They were taken in **headless Chromium**, and Muxy
renders in a WKWebView, where SVG behaviour and the practical ceiling on a
1,700,000 px tall element both differ. And if WebKit does struggle, the fix is to
virtualise the **vertices** — they are independent per row — while keeping the paths
whole. That is a far smaller change than abandoning the single-SVG model, so the
decision stands either way.

## Consequences

- Initial load can be set well above git-graph's 300.
- Paged `git log` fetching stays regardless. ADR-0002 puts reads through
  `muxy.exec`, and there is no documented bound on how much stdout `exec` will
  marshal back into a webview; a 50k-commit log in one call is not something to
  discover in production.
