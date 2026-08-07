import { UNCOMMITTED } from "../src/graph/types.ts";
import type { CommitInput, GraphConfig } from "../src/graph/types.ts";

/**
 * DAG shapes chosen to exercise the cases ADR-0012 names: octopus merges, orphan
 * branches, criss-cross merges and long-lived release branches. Commits are listed
 * newest-first, the order `git log` produces.
 */
export const FIXTURES: ReadonlyArray<{
  name: string;
  head: string | null;
  commits: CommitInput[];
}> = [
  {
    name: "linear",
    head: "c3",
    commits: [
      { hash: "c3", parents: ["c2"] },
      { hash: "c2", parents: ["c1"] },
      { hash: "c1", parents: ["c0"] },
      { hash: "c0", parents: [] },
    ],
  },
  {
    name: "simple-merge",
    head: "m",
    commits: [
      { hash: "m", parents: ["f1", "t1"] },
      { hash: "f1", parents: ["b"] },
      { hash: "t1", parents: ["b"] },
      { hash: "b", parents: [] },
    ],
  },
  {
    name: "criss-cross",
    head: "a2",
    commits: [
      { hash: "a2", parents: ["a1", "b1"] },
      { hash: "b2", parents: ["b1", "a1"] },
      { hash: "a1", parents: ["r"] },
      { hash: "b1", parents: ["r"] },
      { hash: "r", parents: [] },
    ],
  },
  {
    name: "octopus",
    head: "o",
    commits: [
      { hash: "o", parents: ["p1", "p2", "p3"] },
      { hash: "p1", parents: ["base"] },
      { hash: "p2", parents: ["base"] },
      { hash: "p3", parents: ["base"] },
      { hash: "base", parents: [] },
    ],
  },
  {
    name: "orphan-branches",
    head: "x1",
    commits: [
      { hash: "x1", parents: ["x0"] },
      { hash: "y1", parents: ["y0"] },
      { hash: "x0", parents: [] },
      { hash: "y0", parents: [] },
    ],
  },
  {
    name: "long-lived-release",
    head: "m6",
    commits: [
      { hash: "m6", parents: ["m5", "r3"] },
      { hash: "m5", parents: ["m4"] },
      { hash: "r3", parents: ["r2"] },
      { hash: "m4", parents: ["m3"] },
      { hash: "r2", parents: ["r1"] },
      { hash: "m3", parents: ["m2"] },
      { hash: "r1", parents: ["m1"] },
      { hash: "m2", parents: ["m1"] },
      { hash: "m1", parents: ["m0"] },
      { hash: "m0", parents: [] },
    ],
  },
  {
    name: "uncommitted-and-stash",
    head: "h1",
    commits: [
      { hash: UNCOMMITTED, parents: ["h1"] },
      { hash: "s1", parents: ["h1"], isStash: true },
      { hash: "h1", parents: ["h0"] },
      { hash: "h0", parents: [] },
    ],
  },
  {
    name: "truncated-parents",
    head: "t1",
    commits: [
      { hash: "t1", parents: ["t0"] },
      { hash: "t0", parents: ["not-loaded"] },
    ],
  },
];

export const TEST_CONFIG: GraphConfig = {
  grid: { x: 16, y: 24, offsetX: 16, offsetY: 12, expandY: 250 },
  style: "rounded",
  uncommittedChanges: "openCircleAtUncommitted",
};
