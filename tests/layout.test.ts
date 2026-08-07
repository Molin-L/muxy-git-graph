import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { computeLayout } from "../src/graph/layout.ts";
import { FIXTURES, TEST_CONFIG } from "./fixtures.ts";

const SNAPSHOT_DIR = path.join(import.meta.dirname, "__snapshots__");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

function compareSnapshot(name: string, actual: unknown): void {
  const file = path.join(SNAPSHOT_DIR, `${name}.json`);
  const serialised = JSON.stringify(actual, null, 2) + "\n";

  if (UPDATE) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(file, serialised);
    return;
  }

  if (!fs.existsSync(file)) {
    assert.fail(
      `No snapshot for "${name}". Run \`npm run test:update\`, then READ the generated ` +
        `file before committing it — per ADR-0012 the review of the first snapshot is ` +
        `the actual quality gate, not the assertion.`,
    );
  }

  assert.equal(serialised, fs.readFileSync(file, "utf8"), `layout changed for "${name}"`);
}

for (const fixture of FIXTURES) {
  test(`layout: ${fixture.name}`, () => {
    const layout = computeLayout(fixture.commits, TEST_CONFIG, { commitHead: fixture.head });
    compareSnapshot(fixture.name, layout);
  });

  test(`invariants: ${fixture.name}`, () => {
    const layout = computeLayout(fixture.commits, TEST_CONFIG, { commitHead: fixture.head });

    assert.equal(
      layout.vertices.length,
      fixture.commits.length,
      "every commit should be placed on a lane",
    );

    const currents = layout.vertices.filter((v) => v.isCurrent);
    assert.equal(currents.length, 1, "exactly one vertex should be marked current");

    for (const vertex of layout.vertices) {
      assert.ok(Number.isFinite(vertex.cx) && Number.isFinite(vertex.cy), `finite centre for ${vertex.id}`);
      assert.ok(vertex.colour >= 0, `non-negative lane colour for ${vertex.id}`);
      assert.ok(vertex.cx >= 0, `vertex ${vertex.id} sits inside the graph`);
    }

    for (const p of layout.paths) {
      assert.ok(p.d.length > 0, "path data is non-empty");
      assert.ok(!/NaN|undefined/.test(p.d), `path data is numeric: ${p.d}`);
      assert.ok(p.d.startsWith("M"), `path data starts with a move: ${p.d}`);
    }

    assert.ok(layout.height > 0, "height is positive");
    assert.equal(layout.widthsAtVertices.length, fixture.commits.length);
    assert.equal(layout.coloursAtVertices.length, fixture.commits.length);
  });
}

test("rounded and angular styles differ only in path data", () => {
  const fixture = FIXTURES.find((f) => f.name === "long-lived-release")!;
  const rounded = computeLayout(fixture.commits, TEST_CONFIG, { commitHead: fixture.head });
  const angular = computeLayout(
    fixture.commits,
    { ...TEST_CONFIG, style: "angular" },
    { commitHead: fixture.head },
  );

  assert.deepEqual(angular.vertices, rounded.vertices);
  assert.equal(angular.paths.length, rounded.paths.length);
  assert.ok(rounded.paths.some((p) => p.d.includes("C")), "rounded style uses curves");
  assert.ok(!angular.paths.some((p) => p.d.includes("C")), "angular style uses no curves");
});

test("expanding a commit pushes later vertices down by expandY", () => {
  const fixture = FIXTURES.find((f) => f.name === "linear")!;
  const flat = computeLayout(fixture.commits, TEST_CONFIG, { commitHead: fixture.head });
  const expanded = computeLayout(fixture.commits, TEST_CONFIG, {
    commitHead: fixture.head,
    expandAt: 1,
  });

  assert.equal(expanded.vertices[0].cy, flat.vertices[0].cy);
  assert.equal(expanded.vertices[1].cy, flat.vertices[1].cy);
  assert.equal(expanded.vertices[2].cy, flat.vertices[2].cy + TEST_CONFIG.grid.expandY);
  assert.equal(expanded.height, flat.height + TEST_CONFIG.grid.expandY);
});
