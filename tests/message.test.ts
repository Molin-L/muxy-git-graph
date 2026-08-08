import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMessage } from "../src/view/commit-details.ts";

test("subject-only message has no body", () => {
  const m = splitMessage("fix: one liner\n");
  assert.equal(m.subject, "fix: one liner");
  assert.equal(m.body, "");
  assert.deepEqual(m.coAuthors, []);
});

test("subject and body split on the first line", () => {
  const m = splitMessage("feat: add thing\n\nLonger explanation\nover two lines.\n");
  assert.equal(m.subject, "feat: add thing");
  assert.equal(m.body, "Longer explanation\nover two lines.");
});

test("co-authored-by trailers become fields and leave the body", () => {
  const m = splitMessage(
    "feat: pair work\n\nSome body.\n\n" +
    "Co-authored-by: Ada Lovelace <ada@example.com>\n" +
    "co-authored-by: Grace Hopper <grace@example.com>\n",
  );
  assert.deepEqual(m.coAuthors, [
    "Ada Lovelace <ada@example.com>",
    "Grace Hopper <grace@example.com>",
  ]);
  assert.equal(m.body, "Some body.", "trailers are not rendered twice");
});

test("CRLF and empty messages are handled", () => {
  const m = splitMessage("subject\r\n\r\nbody line\r\n");
  assert.equal(m.subject, "subject");
  assert.equal(m.body, "body line");
  assert.deepEqual(splitMessage(""), { subject: "", body: "", coAuthors: [] });
});
