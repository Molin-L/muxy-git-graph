import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, search, segment } from "../src/view/find.ts";
import type { Commit } from "../src/data/repo.ts";
import { UNCOMMITTED } from "../src/graph/types.ts";

/**
 * The find matcher runs over the Commit Feed rather than the DOM (ADR-0018), so
 * it is testable without a browser — and has to be, because virtualised rows
 * mean a broken matcher shows up as "the commit two screens down was never
 * found", which nothing else here would catch.
 */

function commit(overrides: Partial<Commit> & { hash: string }): Commit {
  return {
    parents: [],
    authorName: "Molin. L",
    authorEmail: "molin@live.cn",
    authorDate: "2026-07-19T19:33:00+08:00",
    subject: "chore: tidy",
    refs: [],
    ...overrides,
  };
}

const FEED: Commit[] = [
  commit({ hash: UNCOMMITTED, subject: "Uncommitted Changes" }),
  commit({
    hash: "ac88bf3d1e0000000000000000000000000000aa",
    subject: "fix(conns): cross-thread-safe lws send",
    refs: [{ name: "main", kind: "head" }],
  }),
  commit({
    hash: "fe2a1fb3c20000000000000000000000000000bb",
    subject: "fix(ipc): recv timeout, SIGPIPE-safe sends",
    authorName: "Ada Lovelace",
  }),
  commit({
    hash: "83f551e0aa0000000000000000000000000000cc",
    subject: "fix(shm): fresh-inode segment create",
    authorDate: "2025-01-02T08:00:00+00:00",
    refs: [{ name: "v1.2.0", kind: "tag" }],
  }),
  commit({
    hash: "0183601bb00000000000000000000000000000dd",
    subject: "docs: SHM protocol specification",
    isStash: true,
    stashRef: "stash@{0}",
  }),
];

function hits(query: string, options = { caseSensitive: false, regex: false }): string[] {
  const pattern = compile(query, options);
  assert.ok(pattern !== null && pattern.ok, `expected ${query} to compile`);
  return search(FEED, pattern.test).map((index) => FEED[index].subject);
}

test("an empty query is not a search", () => {
  assert.equal(compile("", { caseSensitive: false, regex: false }), null);
});

test("literal queries are escaped, so punctuation is searchable", () => {
  // Without escaping, `fix(ipc)` would be a group matching the bare text `ipc`,
  // and would wrongly match every other `fix(...)` subject.
  assert.deepEqual(hits("fix(ipc)"), ["fix(ipc): recv timeout, SIGPIPE-safe sends"]);
});

test("matches are case-insensitive until asked otherwise", () => {
  assert.equal(hits("SIGPIPE").length, 1);
  assert.equal(hits("sigpipe").length, 1);
  assert.equal(hits("sigpipe", { caseSensitive: true, regex: false }).length, 0);
  assert.equal(hits("SIGPIPE", { caseSensitive: true, regex: false }).length, 1);
});

test("regex mode passes the pattern through", () => {
  const found = hits("^fix\\((conns|shm)\\)", { caseSensitive: false, regex: true });
  assert.deepEqual(found, [
    "fix(conns): cross-thread-safe lws send",
    "fix(shm): fresh-inode segment create",
  ]);
});

test("an unparseable regex reports the error instead of throwing", () => {
  const pattern = compile("fix(", { caseSensitive: false, regex: true });
  assert.ok(pattern !== null && !pattern.ok);
  assert.ok(pattern.error.length > 0);
});

test("patterns that match empty text are rejected, not silently useless", () => {
  // `.*` matches all 5 commits while highlighting nothing — a result count with
  // no visible cause. Upstream discovers this only after walking the DOM.
  for (const query of [".*", "a*", "x?", "foo|"]) {
    const pattern = compile(query, { caseSensitive: false, regex: true });
    assert.ok(pattern !== null && !pattern.ok, `${query} should be rejected`);
  }
});

test("searches every field the row can show, plus hash and date in full", () => {
  assert.deepEqual(hits("Ada"), ["fix(ipc): recv timeout, SIGPIPE-safe sends"]);
  assert.deepEqual(hits("main"), ["fix(conns): cross-thread-safe lws send"]);
  assert.deepEqual(hits("v1.2.0"), ["fix(shm): fresh-inode segment create"]);
  assert.deepEqual(hits("stash@{0}"), ["docs: SHM protocol specification"]);
  // Abbreviated as shown in the Commit column, and in full.
  assert.deepEqual(hits("fe2a1fb"), ["fix(ipc): recv timeout, SIGPIPE-safe sends"]);
  assert.deepEqual(hits("fe2a1fb3c2"), ["fix(ipc): recv timeout, SIGPIPE-safe sends"]);
  // The row shows a relative date; the ISO value is what is searchable.
  assert.deepEqual(hits("2025-01"), ["fix(shm): fresh-inode segment create"]);
});

test("uncommitted changes never match", () => {
  assert.deepEqual(hits("Uncommitted"), []);
});

test("results are newest-first, following the feed", () => {
  const pattern = compile("fix", { caseSensitive: false, regex: false });
  assert.ok(pattern !== null && pattern.ok);
  assert.deepEqual(search(FEED, pattern.test), [1, 2, 3]);
});

test("segment splits text into alternating plain and matched runs", () => {
  const pattern = compile("fix", { caseSensitive: false, regex: false });
  assert.ok(pattern !== null && pattern.ok);
  assert.deepEqual(segment("fix(ipc): fix again", pattern.all), [
    { text: "fix", hit: true },
    { text: "(ipc): ", hit: false },
    { text: "fix", hit: true },
    { text: " again", hit: false },
  ]);
});

test("segment handles matches at both edges and adjacent matches", () => {
  const pattern = compile("ab", { caseSensitive: false, regex: false });
  assert.ok(pattern !== null && pattern.ok);
  assert.deepEqual(segment("abab", pattern.all), [
    { text: "ab", hit: true },
    { text: "ab", hit: true },
  ]);
  assert.deepEqual(segment("xxab", pattern.all), [
    { text: "xx", hit: false },
    { text: "ab", hit: true },
  ]);
});

test("segment returns one plain run when nothing matches", () => {
  const pattern = compile("zzz", { caseSensitive: false, regex: false });
  assert.ok(pattern !== null && pattern.ok);
  assert.deepEqual(segment("nothing here", pattern.all), [
    { text: "nothing here", hit: false },
  ]);
});

test("segment survives a pattern whose matches are zero-length mid-string", () => {
  // `\b` compiles (it cannot match the empty string) but every match it makes
  // has no width. Advancing past them is what keeps this from spinning forever.
  const pattern = compile("\\b", { caseSensitive: false, regex: true });
  assert.ok(pattern !== null && pattern.ok);
  assert.deepEqual(segment("abc def", pattern.all), [{ text: "abc def", hit: false }]);
});

test("segment is reusable — lastIndex never leaks between calls", () => {
  const pattern = compile("a", { caseSensitive: false, regex: false });
  assert.ok(pattern !== null && pattern.ok);
  const first = segment("banana", pattern.all);
  assert.deepEqual(segment("banana", pattern.all), first);
});
