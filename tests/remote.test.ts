import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { quote, quotePath, shellCommand, shellScript } from "../src/data/remote.ts";

test("a leading ~ stays expandable, the rest is literal", () => {
  // spawn(2) cannot resolve `~`; a shell can. That is the whole point of this rung.
  assert.equal(quotePath("~"), "~");
  assert.equal(quotePath("~/projects/gateway"), "~/'projects/gateway'");
  assert.equal(quotePath("/srv/repo"), "'/srv/repo'");
  assert.equal(quotePath("/srv/~weird"), "'/srv/~weird'");
});

test("arguments with shell metacharacters survive intact", () => {
  const nasty = [
    "git", "log", "--format=%H%x1f%P", "--branches",
    "a b", "it's", 'say "hi"', "$(rm -rf /)", "`whoami`", "semi;colon", "pipe|d", "*glob*",
  ];
  const command = shellCommand(nasty, "~/repo");
  assert.ok(command.startsWith("cd ~/'repo' && "));

  // Behavioural proof: /bin/sh must echo every argument back byte for byte.
  const script = command.slice(command.indexOf(" && ") + 4);
  const out = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${script}`], { encoding: "utf8" });
  assert.deepEqual(out.split("\n").slice(0, -1), nasty);
});

test("shell scripts keep their redirection", () => {
  const command = shellScript("git rev-parse --verify MERGE_HEAD >/dev/null 2>&1 && echo merge", "~/r");
  assert.ok(command.startsWith("cd ~/'r' && "));
  assert.ok(command.includes(">/dev/null 2>&1"), "a script is not an argv — it must stay live");
});

test("quote round-trips awkward values through a real shell", () => {
  assert.equal(quote(""), "''");
  for (const value of ["''", "\\", "a\nb", "  ", "--flag=v'x", "$HOME", "~"]) {
    const out = execFileSync("/bin/sh", ["-c", `printf '%s' ${quote(value)}`], { encoding: "utf8" });
    assert.equal(out, value, `round-trips ${JSON.stringify(value)}`);
  }
});
