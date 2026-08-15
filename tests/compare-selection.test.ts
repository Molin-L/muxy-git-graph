import { test } from "node:test";
import assert from "node:assert/strict";
import { locateEnds, nextComparison } from "../src/view/compare-selection.ts";
import type { CompareSelection } from "../src/view/compare-selection.ts";

/**
 * The ⌘-click gesture, which is the whole of "compare two commits" as far as the
 * user is concerned: two clicks from a cold panel, one from an expanded one.
 */

const COLD: CompareSelection = { selected: null, compareWith: null };

test("the first ⌘-click marks a row without expanding anything", () => {
  const step = nextComparison(COLD, 4);
  assert.equal(step.load, false, "one end is not a comparison yet");
  assert.equal(step.selected, null, "no pane opens");
  assert.equal(step.compareWith, 4, "the row is marked");
});

test("the second ⌘-click opens the pane under the commit just clicked", () => {
  const armed = nextComparison(COLD, 4);
  const step = nextComparison(armed, 9);

  assert.equal(step.load, true);
  assert.equal(step.selected, 9, "the pane follows the second click");
  assert.equal(step.compareWith, 4, "the armed row stays the other end");
  assert.equal(step.load === true && step.expanded, true, "the layout has to reflow");
});

test("⌘-clicking the armed row again disarms it", () => {
  const step = nextComparison({ selected: null, compareWith: 4 }, 4);
  assert.equal(step.load, false);
  assert.equal(step.compareWith, null);
  assert.equal(step.selected, null);
});

test("with a commit expanded, one ⌘-click compares against it", () => {
  const step = nextComparison({ selected: 2, compareWith: null }, 7);
  assert.equal(step.load, true);
  assert.equal(step.selected, 2, "the open pane does not move");
  assert.equal(step.compareWith, 7);
  assert.equal(step.load === true && step.expanded, false, "the gap is already open");
});

test("⌘-clicking the expanded row changes nothing", () => {
  const step = nextComparison({ selected: 2, compareWith: 5 }, 2);
  assert.equal(step.load, false, "no fetch");
  assert.equal(step.selected, 2);
  assert.equal(step.compareWith, 5, "the pane the user is reading survives");
});

test("a third ⌘-click moves the far end, keeping the pane put", () => {
  const step = nextComparison({ selected: 2, compareWith: 5 }, 8);
  assert.equal(step.load, true);
  assert.equal(step.selected, 2);
  assert.equal(step.compareWith, 8);
});

test("the ends are ordered by row, not by click order", () => {
  const older = nextComparison(nextComparison(COLD, 9), 4);
  const newer = nextComparison(nextComparison(COLD, 4), 9);
  const ends = (s: typeof older): number[] =>
    [s.selected, s.compareWith].filter((n): n is number => n !== null).sort((a, b) => a - b);

  // Rows run newest-first, so the larger index is always the `from` of the diff.
  assert.deepEqual(ends(older), [4, 9]);
  assert.deepEqual(ends(newer), [4, 9]);
});

/**
 * A poll that inserts or drops the uncommitted row (or a commit, or a stash)
 * shifts every later index. The marker has to follow the hash, not the slot.
 */
const FEED = [{ hash: "*" }, { hash: "aaa" }, { hash: "bbb" }, { hash: "ccc" }];

test("an armed row stays on its commit when a row is inserted above it", () => {
  // No uncommitted row yet: bbb sat at index 1. Then * appears at 0.
  assert.deepEqual(locateEnds(FEED, null, "bbb"), { selected: null, compareWith: 2 });
});

test("an armed row stays on its commit when a row above it disappears", () => {
  assert.deepEqual(locateEnds(FEED.slice(1), null, "bbb"), { selected: null, compareWith: 1 });
});

test("both ends of an open comparison remap together", () => {
  assert.deepEqual(locateEnds(FEED, "aaa", "ccc"), { selected: 1, compareWith: 3 });
});

test("an end whose commit left the feed is dropped, not pointed at a neighbour", () => {
  assert.deepEqual(locateEnds(FEED, "aaa", "gone"), { selected: 1, compareWith: null });
  assert.deepEqual(locateEnds(FEED, "gone", "bbb"), { selected: null, compareWith: 2 });
});
