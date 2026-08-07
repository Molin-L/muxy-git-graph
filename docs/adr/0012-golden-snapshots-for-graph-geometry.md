# Golden snapshots of emitted SVG geometry, on top of pure-module unit tests

Tests run under `node --test`, matching the house convention in the official `git`
extension, and cover the pure modules: the `git log` parser, ref parsing, date
formatting, and Lane assignment treated as data.

On top of that, the graph geometry is pinned with **golden snapshots of the emitted
SVG path data**, against DAG fixtures captured from real repositories — octopus
merges, orphan branches, criss-cross merges, long-lived release branches.

The reason is that ADR-0005 chose TypeScript to de-risk the geometry port, but types
catch shape errors, not off-by-one errors; nothing in the type system stops a line
bending one Lane too early. Upstream has no `graph.ts` tests to port, so we are
authoring the first tests this algorithm has ever had, and there is no oracle other
than one we build.

The quality gate is not the assertion. It is the one-time act of generating each
fixture's first snapshot and studying it before locking it in. Skip that and we have
snapshotted our bugs.

jsdom component tests of the virtualised table were rejected as high-maintenance and
low-yield — the failure modes that matter are in the SVG, which the snapshots pin.

## Consequences

- Marketplace CI does not run extension tests (`build.mjs` runs only `npm ci
  --ignore-scripts` and `npm run build`), so gating on tests requires a GitHub
  Actions workflow in this repo.
- `node --test` over TypeScript uses Node's built-in type stripping rather than a
  `tsx` devDependency, so `engines.node` is `>=22`. One less package in a lockfile
  that CI installs with `npm_config_offline: true` — no dependency can be fetched at
  build time.
