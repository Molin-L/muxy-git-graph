# We render our own diffs rather than delegating to the `git` extension

Clicking a file in the Commit Details pane opens our own `diff-viewer` tab, built on
the `@pierre/diffs` parser. This makes the marketplace's third diff viewer, after
`git` and `git-workspace`.

Delegation was seriously considered and rejected. `muxy.tabs.open` does support
cross-extension targeting (`extension: { id, tabType, data }`), and the official
`git` extension's `diff-viewer` already accepts exactly the payload we would want to
send — `{ source: "commit", hash, shortHash, focusPath }`. But that payload shape is
another extension's *private* contract, not documented API: it can change in any
release of a package we do not control, and it would break silently. It also creates
a hard runtime dependency — someone installs Git Graph without the `git` extension,
clicks a file, and nothing happens. That is a poor first run for a marketplace
listing.

Note that `muxy.git.diff` is not an alternative here: its arguments are
`{filePath, raw, staged, lineLimit}` with no ref parameters, so it cannot diff a
commit against its parent at all.

## Amendment: our own parser, not `@pierre/diffs`

The original decision named `@pierre/diffs` as the parser. It is now a ~140-line
unified-diff parser of our own (`src/diff/parse.ts`). Marketplace CI builds with
`npm_config_offline: true`, so every dependency has to resolve from the committed
lockfile and every dependency is one more thing the security review has to read.
Parsing unified diff output is small and fully covered by tests, so the dependency
bought little.

## Consequences

- Ours is deliberately smaller than the official viewer. That one carries a file
  rail, zoom and persisted preferences; our docked Commit Details pane already *is*
  the file list, so ours is a patch renderer with a unified/split toggle.
- The same tab serves two-commit comparison (`git diff A B`) with no extra work.
