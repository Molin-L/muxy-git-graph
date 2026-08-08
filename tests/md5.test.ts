import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { md5Hex } from "../src/view/md5.ts";

test("matches the RFC 1321 vectors", () => {
  assert.equal(md5Hex(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5Hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(md5Hex("The quick brown fox jumps over the lazy dog"),
    "9e107d9d372bb6826bd81d3542a419d6");
});

test("matches node:crypto across lengths, incl. padding edges and unicode", () => {
  const cases = ["molin@live.cn", "a".repeat(55), "a".repeat(56), "a".repeat(64),
    "a".repeat(119), "文字化けしないこと", "user+tag@example.com"];
  for (const input of cases) {
    const expected = createHash("md5").update(input, "utf8").digest("hex");
    assert.equal(md5Hex(input), expected, JSON.stringify(input));
  }
});
