# TypeScript, despite every other Muxy extension being vanilla JS

All 14 extensions published in the Muxy marketplace are vanilla JavaScript built
with Vite; not one uses TypeScript. This extension does.

The reason is `web/graph.ts` in `vscode-git-graph`: 913 lines of lane geometry built
on `Point`, `Line`, `PlacedLine`, `UnavailablePoint`, `Branch` and `Vertex`, all
typed. It is the highest-risk thing we are carrying over, and hand-translating typed
geometry into untyped JavaScript is exactly where silent off-by-one and
null-handling bugs appear — bugs that surface as subtly wrong lines on screen rather
than as exceptions.

Vite compiles `.ts` with no extra configuration, and marketplace CI only requires a
`build` script, so the cost is social rather than technical: reviewers used to
reading `src/lib/*.js` in sibling extensions have to read `.ts` here.

## Consequences

- Styling is plain CSS against the `--s1…--s10` scale from Muxy's authoring guide,
  not Tailwind. Tailwind's default scale is not Muxy's, so the sibling extensions
  end up writing `text-[12px] h-[34px] max-w-[88px]` — and this UI is a dense SVG
  graph plus a virtualised table, which utility classes do not help with.
- Upstreaming any of this into the official `git` extension later would require
  translating back to JavaScript.
