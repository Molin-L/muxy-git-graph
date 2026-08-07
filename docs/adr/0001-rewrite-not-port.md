# Rewrite in the Muxy house style rather than porting vscode-git-graph

`vscode-git-graph` (MIT, mhutchie) is ~17.6k LOC of TypeScript split into a VS Code
extension host (`src/`, 9.7k) and a vanilla DOM/SVG webview (`web/`, 7.9k). We are
treating it as the **design spec for the product**, not as the source to port: the
graph, refs, commit details, actions and find widget get rebuilt in Muxy's house
style (vanilla JS + Vite, `var(--muxy-*)` theming, the native sizing scale).

A faithful port was rejected because it drags in a VS Code-shaped `postMessage`
request/response protocol that Muxy webviews do not need (they call `window.muxy`
directly), plus `web/styles/main.css` — 1,022 lines of hardcoded colors that would
have to be gutted to follow the Muxy theme anyway. Muxy's own authoring guidance is
that an extension should be indistinguishable from a native surface.

## Consequences

- The long tail of git-graph's 110 configuration settings will not survive; the
  settings surface is re-scoped from scratch.
- `web/graph.ts`'s lane/branch-assignment algorithm is the deliberate exception —
  it is the hard part and will be ported closely rather than reinvented. Note that
  it carries **no upstream test coverage**: jest's `collectCoverageFrom` is
  `src/utils/*.ts` and `src/*.ts`, `web/` is excluded entirely, and there is no
  `graph.test.ts`. We are porting battle-tested-in-production code, not
  battle-tested-in-CI code.
- This extension deliberately overlaps with Muxy's official `git` extension, which
  already ships a thin 6-lane commit rail in its Source Control panel.
- The MIT licence and mhutchie's copyright must be carried across for any ported
  algorithm.
