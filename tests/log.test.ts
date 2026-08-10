import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

/**
 * The log is a shared surface: every extension writes to Muxy's one Extension
 * Output panel. So the two things worth pinning are that lines identify
 * themselves, and that debug chatter cannot escape without the toggle — a
 * regression in either drowns the panel for everyone.
 */

import * as log from "../src/log.ts";

interface Captured { level: "log" | "warn" | "error"; line: string }

const captured: Captured[] = [];
const original = { log: console.log, warn: console.warn, error: console.error };

beforeEach(() => {
  captured.length = 0;
  console.log = (line: string) => { captured.push({ level: "log", line }); };
  console.warn = (line: string) => { captured.push({ level: "warn", line }); };
  console.error = (line: string) => { captured.push({ level: "error", line }); };
  log.useSurface("panel");
});

afterEach(() => {
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
});

test("every line names the extension and the surface it came from", () => {
  log.info("graph reloaded", { commits: 300 });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].line, "[git-graph:panel] graph reloaded commits=300");

  log.useSurface("diff");
  log.info("diff opening");
  assert.equal(captured[1].line, "[git-graph:diff] diff opening");
});

test("warn and error go out at their own console level, which Muxy labels", () => {
  log.warn("exec failed");
  log.error("reload failed");
  assert.deepEqual(captured.map((c) => c.level), ["warn", "error"]);
});

test("debug is silent until the toggle is on, and silent again after", () => {
  log.debug("exec", { cmd: "git log" });
  assert.equal(captured.length, 0);

  log.setVerbose(true);
  log.debug("exec", { cmd: "git log" });
  // The announcement, then the line — which names its level, because Muxy shows
  // both info and debug as plain `log`.
  assert.equal(captured[0].line, "[git-graph:panel] verbose logging on");
  assert.equal(captured[1].line, `[git-graph:panel] debug exec cmd="git log"`);

  log.setVerbose(false);
  captured.length = 0;
  log.debug("exec");
  assert.equal(captured.length, 0);
});

test("fields are quoted only when they would run into the next pair", () => {
  const line = log.format("info", "probe direct: no", {
    sent: "git --version",
    exit: 127,
    ok: false,
    key: "/Users/dev/gateway",
    missing: undefined,
    error: new Error("spawn process: No such file or directory"),
  });
  assert.equal(
    line,
    `[git-graph:panel] probe direct: no sent="git --version" exit=127 ok=false ` +
    `key=/Users/dev/gateway error="spawn process: No such file or directory"`,
  );
});

test("clip flattens and bounds a command, because git output is unbounded", () => {
  assert.equal(log.clip("  git   log\n  --all  "), "git log --all");
  const long = log.clip("x".repeat(500));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("…"));
});

test("reason unwraps what was thrown, whatever it was", () => {
  assert.equal(log.reason(new Error("no such worktree")), "no such worktree");
  assert.equal(log.reason("plain string"), "plain string");
});
