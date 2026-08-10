import { after, before, test } from "node:test";
import "./quiet-log.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Exercises the data layer against a real repository. This is the code that makes
 * clicking a commit do anything, and none of it is covered by the pure layout
 * snapshots — the `git log` record format, name-status parsing, stash splicing and
 * porcelain parsing all only fail against real git output.
 */

let dir = "";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-graph-test-"));
  git("init", "--initial-branch=main");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");

  const write = (name: string, body: string): void =>
    fs.writeFileSync(path.join(dir, name), body);

  write("a.txt", "one\n");
  git("add", "."); git("commit", "-m", "first commit");

  write("a.txt", "one\ntwo\n");
  git("commit", "-am", "second commit");
  git("tag", "v1.0.0");

  git("checkout", "-b", "feature");
  write("b.txt", "feature\n");
  git("add", "."); git("commit", "-m", "add b on feature");

  git("checkout", "main");
  write("c.txt", "main\n");
  git("add", "."); git("commit", "-m", "add c on main");
  git("merge", "feature", "--no-ff", "-m", "Merge branch 'feature'");

  // A rename, so name-status R parsing is exercised.
  git("mv", "c.txt", "renamed.txt");
  git("commit", "-m", "rename c to renamed");

  // A stash.
  write("a.txt", "one\ntwo\nstashed\n");
  git("stash", "push", "-m", "work in progress");

  // Leave the tree dirty, so the uncommitted row appears.
  write("a.txt", "one\ntwo\ndirty\n");
  write("untracked.txt", "new\n");

  // The panel calls muxy.exec with no cwd; Muxy scopes it to the worktree.
  (globalThis as Record<string, unknown>).muxy = {
    exec(command: string[] | { shell: string }) {
      try {
        const stdout = Array.isArray(command)
          ? execFileSync(command[0], command.slice(1), { cwd: dir, encoding: "utf8" })
          : execFileSync("/bin/sh", ["-c", command.shell], { cwd: dir, encoding: "utf8" });
        return Promise.resolve({ stdout, stderr: "", exitCode: 0 });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return Promise.resolve({ stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 });
      }
    },
    git: { repoInfo: () => Promise.resolve({ root: dir, gitDir: `${dir}/.git`, isWorktree: false, currentBranch: "main" }) },
  };
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("loadCommits returns the graph, refs, stash and uncommitted row", async () => {
  const repo = await import("../src/data/repo.ts");
  const state = await repo.loadCommits(100);

  assert.equal(state.headBranch, "main");
  assert.ok(state.head, "HEAD resolved");

  const subjects = state.commits.map((c) => c.subject);
  assert.equal(subjects[0], "Uncommitted Changes", "uncommitted row is first");
  assert.ok(subjects.includes("rename c to renamed"));
  assert.ok(subjects.includes("Merge branch 'feature'"));
  assert.ok(subjects.includes("first commit"));

  const uncommitted = state.commits[0];
  assert.equal(uncommitted.hash, "*");
  assert.deepEqual(uncommitted.parents, [state.head]);

  const stash = state.commits.find((c) => c.isStash === true);
  assert.ok(stash, "stash is spliced into the feed");
  assert.match(stash.stashRef ?? "", /^stash@\{0\}$/);
  assert.equal(stash.parents.length, 1, "stash keeps only its base parent");

  const merge = state.commits.find((c) => c.subject.startsWith("Merge branch"));
  assert.equal(merge?.parents.length, 2, "merge commit keeps both parents");

  const tagged = state.commits.find((c) => c.refs.some((r) => r.kind === "tag"));
  assert.equal(tagged?.refs.find((r) => r.kind === "tag")?.name, "v1.0.0");

  const head = state.commits.find((c) => c.refs.some((r) => r.kind === "head" && r.name === "main"));
  assert.ok(head, "local branch ref is parsed");

  for (const commit of state.commits) {
    if (commit.hash === "*") continue;
    assert.match(commit.hash, /^[0-9a-f]{40}$/, "hash parsed cleanly");
    assert.ok(commit.authorName === "Test User", `author parsed for ${commit.subject}`);
    assert.ok(!commit.subject.includes(""), "no separator leaked into the subject");
  }
});

test("commitDetails parses metadata, body and changed files", async () => {
  const repo = await import("../src/data/repo.ts");
  const state = await repo.loadCommits(100);
  const rename = state.commits.find((c) => c.subject === "rename c to renamed")!;

  const details = await repo.commitDetails(rename.hash);
  assert.equal(details.authorName, "Test User");
  assert.equal(details.authorEmail, "test@example.com");
  assert.equal(details.committerName, "Test User");
  assert.equal(details.files.length, 1);
  assert.equal(details.files[0].status, "R");
  assert.equal(details.files[0].path, "renamed.txt");
  assert.equal(details.files[0].oldPath, "c.txt");
  assert.equal(details.files[0].additions, 0, "a pure rename adds no lines");
  assert.equal(details.files[0].deletions, 0);
});

test("commitDetails on the initial commit works (--root)", async () => {
  const repo = await import("../src/data/repo.ts");
  const state = await repo.loadCommits(100);
  const first = state.commits.find((c) => c.subject === "first commit")!;

  const details = await repo.commitDetails(first.hash);
  assert.equal(details.files.length, 1);
  assert.equal(details.files[0].status, "A");
  assert.equal(details.files[0].path, "a.txt");
  assert.equal(details.files[0].additions, 1, "numstat counts ride the same command");
  assert.equal(details.files[0].deletions, 0);
});

test("commitDetails on a merge lists what it brought onto the branch", async () => {
  const repo = await import("../src/data/repo.ts");
  const state = await repo.loadCommits(100);
  const merge = state.commits.find((c) => c.subject === "Merge branch 'feature'")!;

  // Plain `git diff-tree` prints nothing for a merge, which read as "0 files changed".
  const details = await repo.commitDetails(merge.hash);
  assert.deepEqual(details.files.map((f) => f.path), ["b.txt"],
    "the merge carries the feature branch's file, not the first parent's own work");
  assert.equal(details.files[0].status, "A");
  assert.equal(details.files[0].additions, 1, "counts survive the first-parent reading");

  const patch = await repo.fileDiff(merge.hash, "b.txt");
  assert.match(patch, /\+feature/, "the listed file opens with a real patch");
});

test("uncommitted details list modified and untracked files", async () => {
  const repo = await import("../src/data/repo.ts");
  const details = await repo.commitDetails("*");
  const paths = details.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["a.txt", "untracked.txt"]);
  assert.equal(details.files.find((f) => f.path === "untracked.txt")?.status, "?");
  const modified = details.files.find((f) => f.path === "a.txt");
  assert.equal(modified?.status, "M");
  assert.ok((modified?.additions ?? 0) >= 1, "worktree changes carry counts");
  assert.equal(details.files.find((f) => f.path === "untracked.txt")?.additions, undefined,
    "untracked files have no diff to count");
});

test("fileDiff returns a patch that the diff parser understands", async () => {
  const repo = await import("../src/data/repo.ts");
  const { parseUnifiedDiff } = await import("../src/diff/parse.ts");
  const state = await repo.loadCommits(100);
  const second = state.commits.find((c) => c.subject === "second commit")!;

  const patch = await repo.fileDiff(second.hash, "a.txt");
  const files = parseUnifiedDiff(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "a.txt");
  assert.equal(files[0].additions, 1);
  assert.equal(files[0].deletions, 0);
  assert.ok(files[0].rows.some((r) => r.kind === "addition" && r.text === "two"));
});

test("fileDiff handles untracked files in the working tree", async () => {
  const repo = await import("../src/data/repo.ts");
  const { parseUnifiedDiff } = await import("../src/diff/parse.ts");
  const patch = await repo.fileDiff("*", "untracked.txt");
  const files = parseUnifiedDiff(patch);
  assert.ok(files.length > 0, "untracked file produces a patch");
  assert.ok(files[0].rows.some((r) => r.kind === "addition"));
});

test("comparisonFiles diffs two commits", async () => {
  const repo = await import("../src/data/repo.ts");
  const state = await repo.loadCommits(100);
  const first = state.commits.find((c) => c.subject === "first commit")!;
  const head = state.commits.find((c) => c.hash === state.head)!;

  const files = await repo.comparisonFiles(first.hash, head.hash);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["a.txt", "b.txt", "renamed.txt"]);
});

test("pendingOperation reports null on a clean tree and detects a conflict", async () => {
  const repo = await import("../src/data/repo.ts");
  assert.equal(await repo.pendingOperation(), null);

  // Force a real merge conflict.
  git("checkout", "-b", "conflict-a");
  fs.writeFileSync(path.join(dir, "conflict.txt"), "left\n");
  git("add", "conflict.txt"); git("commit", "-m", "left side");
  git("checkout", "-b", "conflict-b", "HEAD~1");
  fs.writeFileSync(path.join(dir, "conflict.txt"), "right\n");
  git("add", "conflict.txt"); git("commit", "-m", "right side");
  try {
    git("merge", "conflict-a");
  } catch { /* expected to conflict */ }

  assert.equal(await repo.pendingOperation(), "merge", "in-progress merge is detected");
  git("merge", "--abort");
  assert.equal(await repo.pendingOperation(), null);
  git("checkout", "main");
});

test("refDigest changes when the repository moves", async () => {
  const repo = await import("../src/data/repo.ts");
  const before = await repo.refDigest();
  git("tag", "v2.0.0");
  const after = await repo.refDigest();
  assert.notEqual(before, after);
});

test("localBranches and remotes read cleanly", async () => {
  const repo = await import("../src/data/repo.ts");
  const branches = await repo.localBranches();
  assert.ok(branches.includes("main"));
  assert.ok(branches.includes("feature"));
  assert.deepEqual(await repo.remotes(), []);
});

/**
 * The three tests below are about latency, which is the whole reason the graph
 * feels slow on a remote workspace: every command is an SSH round trip, so what
 * costs is the *number* of commands, not the work any one of them does.
 */

/** Counts what actually reaches the transport while `body` runs. */
async function countingExec<T>(body: () => Promise<T>): Promise<{ value: T; execs: string[] }> {
  const muxy = (globalThis as Record<string, unknown>).muxy as { exec: (...a: never[]) => unknown };
  const real = muxy.exec;
  const execs: string[] = [];
  muxy.exec = ((command: string[] | { shell: string }, ...rest: never[]) => {
    execs.push(Array.isArray(command) ? command.join(" ") : command.shell);
    return (real as (...a: unknown[]) => unknown)(command, ...rest);
  }) as never;
  try {
    return { value: await body(), execs };
  } finally {
    muxy.exec = real;
  }
}

test("a whole repaint is one round trip", async () => {
  const repo = await import("../src/data/repo.ts");
  repo.resetCapabilities();
  await repo.loadSnapshot(100); // warm the probe, as the panel's first load does

  const { value: snapshot, execs } = await countingExec(() => repo.loadSnapshot(100));
  assert.equal(execs.length, 1,
    `head, branch, log, stashes, status, refs, remotes and the in-progress probe ` +
    `must batch into one command — saw:\n${execs.join("\n")}`);

  // And the batch really did answer all of it.
  assert.equal(snapshot.state.headBranch, "main");
  assert.equal(snapshot.state.commits[0].subject, "Uncommitted Changes");
  assert.ok(snapshot.state.commits.some((c) => c.isStash === true), "stashes are spliced");
  assert.equal(snapshot.pending, null);
  assert.deepEqual(snapshot.remotes, []);
  assert.notEqual(snapshot.digest, "");
});

test("the snapshot's digest is the one the poll compares against", async () => {
  const repo = await import("../src/data/repo.ts");
  // A mismatch here would make every single poll look like the repo had moved,
  // turning a 4s freshness check into a 4s full reload forever.
  const snapshot = await repo.loadSnapshot(100);
  assert.equal(snapshot.digest, await repo.refDigest());
});

test("a workspace already probed is not probed again", async () => {
  const repo = await import("../src/data/repo.ts");
  repo.resetCapabilities();
  await repo.loadSnapshot(10);

  // Switching to another project and back: the panel rebinds, but this
  // workspace's rung is already known and costs nothing to recover.
  repo.rebindWorkspace();
  const { execs } = await countingExec(() => repo.loadSnapshot(10));
  assert.deepEqual(execs.filter((c) => c.includes("--version")), [],
    "walking the ladder again is up to three serial round trips for a known answer");
  assert.equal(execs.length, 1, "so a warm switch is one command in total");

  // A manual refresh is the deliberate "re-test everything" gesture.
  repo.resetCapabilities();
  const after = await countingExec(() => repo.loadSnapshot(10));
  assert.equal(after.execs.filter((c) => c.includes("--version")).length, 1,
    "resetCapabilities must still force a real probe");
});

test("a remembered rung that stops working re-probes on its own", async () => {
  const repo = await import("../src/data/repo.ts");
  const muxy = (globalThis as Record<string, unknown>).muxy as { exec: (...a: never[]) => unknown };
  const real = muxy.exec;
  repo.resetCapabilities();
  await repo.loadSnapshot(10); // settles, and is remembered

  try {
    // The workspace moves out from under the remembered rung: a rejection, which
    // is a transport failure — git reports its own problems with an exit code.
    muxy.exec = (() => Promise.reject(new Error("spawn process: No such file or directory"))) as never;
    await assert.rejects(() => repo.loadSnapshot(10));

    muxy.exec = real;
    const { execs } = await countingExec(() => repo.loadSnapshot(10));
    assert.equal(execs.filter((c) => c.includes("--version")).length, 1,
      "a stale rung must be re-tested, not trusted until the next manual refresh");
  } finally {
    muxy.exec = real;
    // Left settled, not reset: the tests below this one assume a warm probe.
    repo.resetCapabilities();
    await repo.loadSnapshot(10);
  }
});

test("an unreachable host is an error, not an empty repository", async () => {
  const repo = await import("../src/data/repo.ts");
  const muxy = (globalThis as Record<string, unknown>).muxy as { exec: unknown };
  const real = muxy.exec;

  // Simulate a dead SSH transport: exec rejects rather than returning an exit code.
  muxy.exec = () => Promise.reject(new Error("ssh: connect to host dev-box port 22: timed out"));
  try {
    await assert.rejects(() => repo.loadCommits(10), /dev-box/,
      "a transport failure must propagate, not read as 'no commits yet'");
  } finally {
    muxy.exec = real;
  }
});

test("a repository with no commits reports null head, not an error", async () => {
  const repo = await import("../src/data/repo.ts");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "git-graph-empty-"));
  const previous = dir;
  dir = empty;
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: empty });
    assert.equal(await repo.headHash(), null);
    const state = await repo.loadCommits(10);
    assert.equal(state.head, null);
    assert.deepEqual(state.commits, []);
  } finally {
    dir = previous;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("falls back to muxy.git when exec cannot spawn (remote workspace)", async () => {
  const repo = await import("../src/data/repo.ts");
  const muxy = (globalThis as Record<string, unknown>).muxy as Record<string, unknown>;
  const realExec = muxy.exec;
  const realGit = muxy.git;

  // Exactly what a remote worktree produces: the path does not exist locally.
  repo.resetCapabilities();
  muxy.exec = () => Promise.reject(new Error("exec failed to launch: spawn process: No such file or directory"));
  muxy.git = {
    repoInfo: () => Promise.resolve({ root: "/remote/repo", gitDir: "", isWorktree: false, currentBranch: "main" }),
    status: () => Promise.resolve({
      branch: "main",
      stagedFiles: [{ path: "staged.txt", status: "M", isStaged: true, isUnstaged: false }],
      unstagedFiles: [{ path: "dirty.txt", status: "M", isStaged: false, isUnstaged: true }],
    }),
    log: () => Promise.resolve([
      { hash: "a".repeat(40), shortHash: "aaaaaaa", subject: "top", authorName: "Remote User",
        authorDate: "2026-01-02T00:00:00Z", isMerge: false, parentHashes: ["b".repeat(40)],
        refs: [{ name: "main", kind: "head" }, { name: "v1", kind: "tag" }] },
      { hash: "b".repeat(40), shortHash: "bbbbbbb", subject: "root", authorName: "Remote User",
        authorDate: "2026-01-01T00:00:00Z", isMerge: false, parentHashes: [], refs: [] },
    ]),
  };

  try {
    const state = await repo.loadCommits(100);
    assert.ok(repo.isDegraded(), "degraded mode detected");
    assert.equal(state.headBranch, "main");
    assert.equal(state.head, "a".repeat(40), "HEAD resolved from the branch ref");

    // Uncommitted row is synthesised from status, then the two real commits.
    assert.equal(state.commits.length, 3);
    assert.equal(state.commits[0].subject, "Uncommitted Changes");
    assert.deepEqual(state.commits[0].parents, ["a".repeat(40)]);
    assert.equal(state.commits[1].subject, "top");
    assert.deepEqual(state.commits[1].parents, ["b".repeat(40)], "graph edges survive");
    assert.deepEqual(
      state.commits[1].refs.map((r) => r.kind).sort(), ["head", "tag"],
      "ref kinds are mapped");

    // The uncommitted details view still works without a shell.
    const details = await repo.commitDetails("*");
    assert.deepEqual(details.files.map((f) => f.path).sort(), ["dirty.txt", "staged.txt"]);

    // Commit details still render from the log entry the caller already holds —
    // there is no shell to list files with, but the metadata is real.
    const known = state.commits.find((c) => c.hash === "a".repeat(40))!;
    const detail = await repo.commitDetails("a".repeat(40), known);
    assert.equal(detail.authorName, "Remote User");
    assert.deepEqual(detail.parents, ["b".repeat(40)]);
    assert.deepEqual(detail.files, [], "no shell means no file list, but no error either");

    // Diffs genuinely cannot work and say so.
    await assert.rejects(() => repo.fileDiff("a".repeat(40), "x.txt"), /shell access/);
    assert.deepEqual(await repo.remotes(), []);
    assert.equal(await repo.pendingOperation(), null);
  } finally {
    muxy.exec = realExec;
    muxy.git = realGit;
    repo.resetCapabilities();
  }
});

test("fallback transports pass cwd where Muxy actually reads it", async () => {
  const repo = await import("../src/data/repo.ts");
  const muxy = (globalThis as Record<string, unknown>).muxy as Record<string, unknown>;
  const realExec = muxy.exec;
  const realGit = muxy.git;
  repo.resetCapabilities();

  // Models Muxy's own buildExecPayload: for the object form the payload is built
  // from the FIRST argument alone, so a `cwd` passed beside it is discarded.
  const seen: Array<{ cwd: string | undefined; shell: string | undefined }> = [];
  muxy.exec = (command: unknown, options?: unknown) => {
    const isObject = !Array.isArray(command);
    const record = command as { shell?: string; cwd?: string };
    const cwd = isObject ? record.cwd : (options as { cwd?: string } | undefined)?.cwd;
    seen.push({ cwd, shell: isObject ? record.shell : undefined });

    // Reproduces the real failure: Muxy spawns with the worktree path as cwd, which
    // does not exist locally, unless the call supplies its own.
    if (cwd === undefined) {
      return Promise.reject(new Error("exec failed to launch: spawn process: No such file or directory"));
    }
    return Promise.resolve({ stdout: "git version 2.43.0\n", stderr: "", exitCode: 0 });
  };
  muxy.git = {
    repoInfo: () => Promise.resolve({
      root: "/home/dev/projects/gateway", gitDir: "", isWorktree: false, currentBranch: "main",
    }),
    log: () => Promise.resolve([]),
    status: () => Promise.resolve({ branch: "main", stagedFiles: [], unstagedFiles: [] }),
  };

  try {
    await repo.loadCommits(10).catch(() => undefined);
    const report = repo.probeReport();

    assert.equal(report[0]?.rung, "direct");
    assert.equal(report[0]?.ok, false, "the plain form has no cwd of its own to give");

    const shellCwd = report.find((a) => a.rung === "shellCwd");
    assert.ok(shellCwd?.ok, "the shell rung must succeed once cwd reaches the payload");

    const objectCall = seen.find((c) => c.shell !== undefined);
    assert.ok(objectCall, "the shell rung uses the object form");
    assert.equal(objectCall.cwd, "/",
      "cwd must be inside the object — beside it, Muxy drops it silently");
    assert.ok(objectCall.shell?.includes("cd '/home/dev/projects/gateway'"),
      "and the shell still enters the worktree");
  } finally {
    muxy.exec = realExec;
    muxy.git = realGit;
    repo.resetCapabilities();
  }
});

test("concurrent readers share a single probe", async () => {
  const repo = await import("../src/data/repo.ts");
  const muxy = (globalThis as Record<string, unknown>).muxy as Record<string, unknown>;
  const real = muxy.exec;
  let versionProbes = 0;
  repo.resetCapabilities();

  muxy.exec = (command: unknown) => {
    if (Array.isArray(command) && command[1] === "--version") versionProbes++;
    return Promise.resolve({ stdout: "git version 2.43.0\n", stderr: "", exitCode: 0 });
  };

  try {
    await Promise.all([repo.refDigest(), repo.remotes(), repo.pendingOperation()]);
    assert.equal(versionProbes, 1,
      "four concurrent reads previously fired four probes — costly on a remote");
  } finally {
    muxy.exec = real;
    repo.resetCapabilities();
  }
});

test("without a shell, working-tree diffs still come from muxy.git", async () => {
  const repo = await import("../src/data/repo.ts");
  const muxy = (globalThis as Record<string, unknown>).muxy as Record<string, unknown>;
  const realExec = muxy.exec;
  const realGit = muxy.git;
  repo.resetCapabilities();

  const asked: Array<Record<string, unknown>> = [];
  muxy.exec = () => Promise.reject(new Error("exec failed to launch: spawn process: No such file or directory"));
  muxy.git = {
    repoInfo: () => Promise.resolve({ root: "/home/dev/x", gitDir: "", isWorktree: false, currentBranch: "main" }),
    log: () => Promise.resolve([]),
    status: () => Promise.resolve({ branch: "main", stagedFiles: [], unstagedFiles: [] }),
    diff: (o: Record<string, unknown>) => {
      asked.push(o);
      return Promise.resolve({
        diff: o.staged === true ? "" : "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n",
        truncated: false,
      });
    },
  };

  try {
    const patch = await repo.fileDiff("*", "x");
    assert.match(patch, /^diff --git/, "the working-tree diff is real, not a placeholder");
    assert.equal(asked[0]?.staged, true, "staged is preferred, then the working tree");
    assert.equal(asked[0]?.raw, true);

    // A commit cannot be diffed: the bridge exposes no ref parameter.
    await assert.rejects(() => repo.fileDiff("abc123", "x"), /shell/);
  } finally {
    muxy.exec = realExec;
    muxy.git = realGit;
    repo.resetCapabilities();
  }
});

test("remote workspace: the ladder lands on the background relay and everything works", async () => {
  const repo = await import("../src/data/repo.ts");
  const muxy = (globalThis as Record<string, unknown>).muxy as Record<string, unknown>;
  const realExec = muxy.exec;
  const realGit = muxy.git;
  const realEvents = (muxy as { events?: unknown }).events;
  repo.resetCapabilities();

  const REMOTE_ROOT = "/home/dev/projects/gateway";
  const FLD = String.fromCharCode(0x1f);

  // Webview exec: fails the way the user's machine actually fails.
  muxy.exec = (command: unknown) => {
    const isObject = !Array.isArray(command);
    if (isObject && (command as { cwd?: string }).cwd !== undefined) {
      return Promise.resolve({
        stdout: "", exitCode: 1,
        stderr: `/bin/sh: line 0: cd: ${REMOTE_ROOT}: No such file or directory`,
      });
    }
    return Promise.reject(new Error("exec failed to launch: spawn process: No such file or directory"));
  };

  // The relay: answered by a pretend background whose exec runs on the remote.
  const handlers: Array<(p: unknown) => void> = [];
  const remoteExec = (argv: string[] | { shell: string }): { stdout: string; stderr: string; exitCode: number } => {
    const joined = Array.isArray(argv) ? argv.join(" ") : argv.shell;
    if (joined === "git rev-parse --show-toplevel") return { stdout: `${REMOTE_ROOT}\n`, stderr: "", exitCode: 0 };
    if (joined.startsWith("git show --no-patch")) {
      return {
        stdout: ["h", "p1 p2", "Remote User", "r@x", "2026-01-01", "Remote User", "r@x", "2026-01-01", "full body"].join(FLD),
        stderr: "", exitCode: 0,
      };
    }
    if (joined.startsWith("git diff-tree")) {
      return {
        stdout: ":100644 100644 abc1234 def5678 M\tsrc/app.ts\n1\t2\tsrc/app.ts\n",
        stderr: "", exitCode: 0,
      };
    }
    if (joined.startsWith("git show --format=")) return { stdout: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n", stderr: "", exitCode: 0 };
    if (joined.includes("MERGE_HEAD")) return { stdout: "", stderr: "", exitCode: 1 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  muxy.events = {
    subscribe: (_c: string, h: (p: unknown) => void) => { handlers.push(h); return () => {}; },
    emit: (_c: string, payload: unknown) => {
      const p = payload as { kind?: string; id?: string; argv?: string[]; shell?: string };
      if (p.kind === "exec" && p.id) {
        const res = remoteExec(p.argv ?? { shell: p.shell ?? "" });
        for (const h of [...handlers]) {
          if (res.stdout) h({ kind: "exec-chunk", id: p.id, stream: "out", seq: 0, data: res.stdout });
          if (res.stderr) h({ kind: "exec-chunk", id: p.id, stream: "err", seq: 0, data: res.stderr });
          h({ kind: "exec-done", id: p.id, exitCode: res.exitCode,
              outChunks: res.stdout ? 1 : 0, errChunks: res.stderr ? 1 : 0 });
        }
      }
      return Promise.resolve();
    },
  };
  muxy.git = {
    repoInfo: () => Promise.resolve({ root: REMOTE_ROOT, gitDir: "", isWorktree: false, currentBranch: "main" }),
    log: () => Promise.resolve([]),
    status: () => Promise.resolve({ branch: "main", stagedFiles: [], unstagedFiles: [] }),
  };

  try {
    const details = await repo.commitDetails("a".repeat(40));
    assert.equal(repo.transportKind(), "background", "the ladder settles on the relay");
    assert.ok(!repo.isDegraded(), "not degraded — full features");
    assert.equal(details.authorName, "Remote User");
    assert.equal(details.body, "full body");
    assert.deepEqual(details.files,
      [{ status: "M", path: "src/app.ts", additions: 1, deletions: 2 }],
      "per-commit file lists carry line counts on the remote");

    const patch = await repo.fileDiff("a".repeat(40), "src/app.ts");
    assert.match(patch, /^diff --git/, "per-commit diffs work on the remote");

    assert.equal(await repo.pendingOperation(), null, "the shell probe rides the relay too");

    const report = repo.probeReport();
    assert.deepEqual(report.map((a) => [a.rung, a.ok]),
      [["direct", false], ["shellCwd", false], ["background", true]]);
  } finally {
    muxy.exec = realExec;
    muxy.git = realGit;
    (muxy as { events?: unknown }).events = realEvents;
    repo.resetCapabilities();
  }
});

test("a relay that reaches the wrong repository is refused", async () => {
  const repo = await import("../src/data/repo.ts");
  const muxy = (globalThis as Record<string, unknown>).muxy as Record<string, unknown>;
  const realExec = muxy.exec;
  const realGit = muxy.git;
  const realEvents = (muxy as { events?: unknown }).events;
  repo.resetCapabilities();

  muxy.exec = () => Promise.reject(new Error("exec failed to launch: spawn process: No such file or directory"));
  const handlers: Array<(p: unknown) => void> = [];
  muxy.events = {
    subscribe: (_c: string, h: (p: unknown) => void) => { handlers.push(h); return () => {}; },
    emit: (_c: string, payload: unknown) => {
      const p = payload as { kind?: string; id?: string };
      if (p.kind === "exec" && p.id) {
        // A background exec that ran locally in some other repository.
        for (const h of [...handlers]) {
          h({ kind: "exec-chunk", id: p.id, stream: "out", seq: 0, data: "/Users/molin/some/local/repo\n" });
          h({ kind: "exec-done", id: p.id, exitCode: 0, outChunks: 1, errChunks: 0 });
        }
      }
      return Promise.resolve();
    },
  };
  muxy.git = {
    repoInfo: () => Promise.resolve({ root: "/home/dev/projects/gateway", gitDir: "", isWorktree: false, currentBranch: "main" }),
    log: () => Promise.resolve([]),
    status: () => Promise.resolve({ branch: "main", stagedFiles: [], unstagedFiles: [] }),
  };

  try {
    await repo.loadCommits(10).catch(() => undefined);
    assert.ok(repo.isDegraded(), "wrong repo means refuse the relay, degrade to muxy.git");
    const background = repo.probeReport().find((a) => a.rung === "background");
    assert.ok(background && !background.ok);
    assert.match(background.detail, /wrong repository/);
  } finally {
    muxy.exec = realExec;
    muxy.git = realGit;
    (muxy as { events?: unknown }).events = realEvents;
    repo.resetCapabilities();
  }
});
