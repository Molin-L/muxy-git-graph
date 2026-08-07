# Spike findings

The walking skeleton was built to answer three questions before committing to the
architecture. It has since been replaced by the working panel, but the answers stand
and the instrumentation that produced them is gone from the shipping code.

## 1. How much stdout will `muxy.exec` marshal into a webview? — STILL UNANSWERED

Not measurable outside Muxy. It is the one remaining architectural risk: ADR-0002
routes every read through `exec`, and ADR-0007's page size is set by whatever
ceiling this has.

The panel now surfaces it in normal use rather than through a probe button — it
loads 300 commits initially and 300 more each time you scroll near the bottom, and
any `exec` failure lands in the topbar status label. If `exec` has a low ceiling it
will show up as a failed load on a large repository, at a known commit count.

## 2. Does virtualised-rows-over-one-SVG hold up? — YES, with a caveat

Measured at 50,000 synthetic commits, in headless Chromium:

| | |
|---|---|
| Paths | 3,181 (a 16:1 merge — better than ADR-0007 predicted) |
| SVG elements | **53,181** (3,181 paths + 50,000 vertex circles) |
| Row elements in DOM | 29 |
| SVG height | 1,700,000 px |
| Initial layout / first draw | 164.7 ms / 89.5 ms |
| Scroll median / p95 / worst frame | 8.4 ms / 16.8 ms / 49.9 ms |

Scrolled 289,000 px deep, vertices still aligned exactly with their recycled rows —
no drift, which was the model's main correctness risk.

The finding that amended ADR-0007: the SVG's node count is dominated by **vertices**,
not paths, because vertices are 1:1 with commits and unvirtualised.

**Caveat: headless Chromium, not WKWebView.** Both the frame numbers and the
viability of a 1.7M px tall SVG need re-checking inside Muxy.

## 3. Does the styling read as native? — PARTIALLY

Renders correctly against a synthetic dark theme, at panel width, against the real
`vscode-git-graph` repository. The real question — the user's actual accent, light
mode, a non-100% interface scale — still needs the app.

One thing this settled: **lane colour is applied by CSS class, never by SVG
attribute.** SVG presentation attributes do not resolve `var()`, so
`stroke="var(--lane-0)"` silently fails; a class plus a stylesheet rule works and
tracks theme changes with no redraw. The graph needs no `onThemeChange` handler at
all.

## What the browser harness caught

Driving the panel against the real `vscode-git-graph` repository through a throwaway
`exec` bridge found four defects that no unit test would have:

- `%gD` yields `refs/stash@{0}`, not `stash@{0}` — the format needed `%gd`.
- `git diff --no-index` exits **1** whenever the files differ, so the untracked-file
  diff path was discarding every patch it produced.
- Context-menu dismiss listeners were registered per open but only removed from
  inside themselves, so opening a second menu leaked the first one's listeners.
- `event.target` is not always a `Node`, which crashed the dismiss handler.

The first two are now covered by `tests/repo.test.ts`, which runs the data layer
against a real temporary repository with a merge, a rename, a tag, a stash, an
untracked file and a deliberately conflicted merge.
