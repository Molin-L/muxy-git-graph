import { test } from "node:test";
import assert from "node:assert/strict";
import { combineRefs, remoteOf } from "../src/view/refs.ts";
import type { Ref } from "../src/data/repo.ts";

/**
 * Folding `origin/master` into the `master` chip is a display decision made from
 * ref names alone, so it is tested here rather than by eye — the cases that go
 * wrong (a branch called `feature/x`, a remote missing from the list) are
 * exactly the ones a glance at one repository's graph never shows.
 */

const head = (name: string): Ref => ({ name, kind: "head" });
const remote = (name: string): Ref => ({ name, kind: "remote" });
const tag = (name: string): Ref => ({ name, kind: "tag" });

const REMOTES = ["origin", "upstream"];

/** One label, written as the remotes it absorbed followed by the ref itself —
 *  the order the chip draws them in. */
function shape(refs: readonly Ref[], remotes: readonly string[] = REMOTES): string[] {
  return combineRefs(refs, remotes).map((label) =>
    [...label.remotes.map((r) => r.name), label.ref.name].join(" │ "));
}

test("a branch and its remote counterpart become one label", () => {
  assert.deepEqual(shape([head("master"), remote("origin/master")]), ["origin/master │ master"]);
});

test("every remote holding the branch is folded into it", () => {
  assert.deepEqual(
    shape([head("master"), remote("origin/master"), remote("upstream/master")]),
    ["origin/master │ upstream/master │ master"],
  );
});

test("a remote branch with no local counterpart keeps its own label", () => {
  assert.deepEqual(
    shape([head("master"), remote("origin/master"), remote("origin/topic")]),
    ["origin/master │ master", "origin/topic"],
  );
});

test("a local branch that has not been pushed is untouched", () => {
  assert.deepEqual(shape([head("topic")]), ["topic"]);
});

test("tags and stashes are never folded", () => {
  assert.deepEqual(
    shape([head("master"), remote("origin/master"), tag("v1.0"), { name: "stash@{0}", kind: "stash" }]),
    ["origin/master │ master", "v1.0", "stash@{0}"],
  );
});

test("the remote is matched against the repository's remotes, not the first slash", () => {
  // `feature/x` on `origin` and a local `feature/x`: the naive split would read
  // the remote as `feature` and leave both chips standing.
  assert.deepEqual(
    shape([head("feature/x"), remote("origin/feature/x")]),
    ["origin/feature/x │ feature/x"],
  );
});

test("the longest matching remote wins", () => {
  assert.deepEqual(
    shape([head("main"), remote("origin/mirror/main")], ["origin", "origin/mirror"]),
    ["origin/mirror/main │ main"],
  );
});

test("without a remote list the name still splits at the first slash", () => {
  // The snapshot can arrive without remotes — a failed read, or muxy.git.
  assert.deepEqual(shape([head("master"), remote("origin/master")], []), ["origin/master │ master"]);
});

test("a same-named branch on a different remote is not folded into another", () => {
  assert.deepEqual(
    shape([remote("origin/master"), remote("upstream/master")]),
    ["origin/master", "upstream/master"],
  );
});

test("labels keep the order the refs arrived in", () => {
  assert.deepEqual(
    shape([tag("v1.0"), head("master"), remote("origin/master")]),
    ["v1.0", "origin/master │ master"],
  );
});

test("remoteOf names the remote, or nothing when there is no prefix", () => {
  assert.equal(remoteOf("origin/master", REMOTES), "origin");
  assert.equal(remoteOf("origin/feature/x", REMOTES), "origin");
  assert.equal(remoteOf("master", REMOTES), null);
});
