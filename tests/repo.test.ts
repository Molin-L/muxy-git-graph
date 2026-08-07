import { after, before, test } from "node:test";
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
});

test("commitDetails on the initial commit works (--root)", async () => {
  const repo = await import("../src/data/repo.ts");
  const state = await repo.loadCommits(100);
  const first = state.commits.find((c) => c.subject === "first commit")!;

  const details = await repo.commitDetails(first.hash);
  assert.equal(details.files.length, 1);
  assert.equal(details.files[0].status, "A");
  assert.equal(details.files[0].path, "a.txt");
});

test("uncommitted details list modified and untracked files", async () => {
  const repo = await import("../src/data/repo.ts");
  const details = await repo.commitDetails("*");
  const paths = details.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["a.txt", "untracked.txt"]);
  assert.equal(details.files.find((f) => f.path === "untracked.txt")?.status, "?");
  assert.equal(details.files.find((f) => f.path === "a.txt")?.status, "M");
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

    // Features that genuinely need a shell fail with a clear message.
    await assert.rejects(() => repo.commitDetails("a".repeat(40)), /shell access/);
    await assert.rejects(() => repo.fileDiff("a".repeat(40), "x.txt"), /shell access/);
    assert.deepEqual(await repo.remotes(), []);
    assert.equal(await repo.pendingOperation(), null);
  } finally {
    muxy.exec = realExec;
    muxy.git = realGit;
    repo.resetCapabilities();
  }
});

test("fallback transports override the spawn cwd", async () => {
  const repo = await import("../src/data/repo.ts");
  const muxy = (globalThis as Record<string, unknown>).muxy as Record<string, unknown>;
  const realExec = muxy.exec;
  const realGit = muxy.git;

  const calls: Array<{ command: unknown; options: unknown }> = [];
  repo.resetCapabilities();

  // Reproduces the real failure: Muxy's spawn cwd is unresolvable, so *every*
  // launch fails — including `git --version`, which never reads the cwd.
  muxy.exec = (command: unknown, options?: unknown) => {
    calls.push({ command, options });
    const opts = options as { cwd?: string } | undefined;
    if (opts?.cwd === undefined) {
      return Promise.reject(new Error("exec failed to launch: spawn process: No such file or directory"));
    }
    return Promise.resolve({ stdout: "git version 2.43.0\n", stderr: "", exitCode: 0 });
  };
  muxy.git = {
    repoInfo: () => Promise.resolve({ root: "~/projects/gateway", gitDir: "", isWorktree: false, currentBranch: "main" }),
    log: () => Promise.resolve([]),
    status: () => Promise.resolve({ branch: "main", stagedFiles: [], unstagedFiles: [] }),
  };

  try {
    await repo.loadCommits(10).catch(() => undefined);
    const report = repo.probeReport();

    assert.equal(report[0]?.rung, "direct", "the plain exec is always tried first");
    assert.equal(report[0]?.ok, false);
    assert.equal(calls[0]?.options, undefined, "the direct rung passes no cwd");

    const shellCwd = report.find((a) => a.rung === "shellCwd");
    assert.ok(shellCwd, "the shell rung runs when repoInfo reports a root");
    assert.ok(shellCwd.ok, "with a valid spawn cwd the shell launches");
    assert.ok(shellCwd.sent.includes("cd ~/'projects/gateway'"),
      "the tilde is left expandable for the shell");

    const withCwd = calls.find((c) => (c.options as { cwd?: string } | undefined)?.cwd === "/");
    assert.ok(withCwd, "fallback rungs spawn from a directory that certainly exists");
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
