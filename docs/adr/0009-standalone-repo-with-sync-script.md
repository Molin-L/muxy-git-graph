# A standalone repo with the extension at its root, synced into a marketplace fork

The extension targets the Muxy marketplace, whose flow is: fork
`muxy-app/extensions`, sparse-checkout, add `extensions/<name>/`, open a PR titled
`<name> <version>` containing exactly one extension.

`manifest.name` is **`muxy-git-graph`**, matching this repository's directory name.
That constraint is not merely a marketplace CI rule: the manifest schema states the
name "must equal the directory name", and **Muxy identifies a loaded extension by
its directory**. An earlier `git-graph` name broke Load Unpacked in a way that gave
no error — the topbar item rendered, but its command, the panel and the
`tabs.open({ extension: { id } })` call all resolved against an identity Muxy did
not have, so clicking did nothing. `tests/manifest.test.ts` now asserts the match.

Rather than working inside a fork, this repo holds the extension at its root and
ships a `scripts/sync-marketplace.mjs` that rsyncs the shippable tree into a sibling
fork checkout, refusing to run on a dirty working tree.

The reason is that this repo has content the marketplace PR should not carry:
`CONTEXT.md`, `docs/adr/`, and the migration notes. Working directly in a fork would
either leak those into the marketplace or mean discarding them. Mirroring the
marketplace's own `extensions/git-graph/` nesting inside this repo was rejected as
two levels of path noise in a single-extension repo.

## Consequences

- Git history does not follow into the marketplace PR; each release is a tree copy.
- The sync script, not the directory layout, is what decides what ships. It needs to
  be explicit about the exclude list.
- Marketplace CI obligations now apply: an SVG listing icon, at least one
  screenshot, a `marketplace` block, a committed `package-lock.json`, a `README.md`,
  and a human security review triggered by the `commands:exec` use that ADR-0002
  makes unavoidable.
