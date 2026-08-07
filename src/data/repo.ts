/**
 * All git access. Reads shell out via `muxy.exec` because `muxy.git` cannot return
 * the fields the graph needs; writes prefer `muxy.git` so each one raises its own
 * named consent prompt. See docs/adr/0002-data-layer-split.md.
 */

import type { ExecResult } from "../muxy.d.ts";
import { execViaBackground } from "./background-rpc.ts";
import * as remote from "./remote.ts";

const REC = "\u001e";
const FLD = "\u001f";

const LOG_FORMAT = [
  "%H", "%P", "%an", "%ae", "%aI", "%D", "%s",
].join("%x1f") + "%x1e";

const DETAIL_FORMAT = [
  "%H", "%P", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%B",
].join("%x1f");

export const UNCOMMITTED = "*";

export interface Ref {
  readonly name: string;
  readonly kind: "head" | "remote" | "tag" | "stash";
}

export interface Commit {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly subject: string;
  readonly refs: readonly Ref[];
  readonly isStash?: boolean;
  /** `stash@{0}` — present only on stash entries. */
  readonly stashRef?: string;
}

export type FileStatus = "A" | "M" | "D" | "R" | "C" | "U" | "?";

export interface ChangedFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: FileStatus;
}

export interface CommitDetails {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committerDate: string;
  readonly body: string;
  readonly files: readonly ChangedFile[];
}

export interface RepoState {
  readonly commits: readonly Commit[];
  readonly head: string | null;
  readonly headBranch: string;
  readonly moreAvailable: boolean;
}

export type PendingOperation = "merge" | "rebase" | "cherry-pick" | "revert" | null;

function api() {
  const muxy = globalThis.muxy;
  if (!muxy) throw new Error("This panel must run inside Muxy.");
  return muxy;
}

/**
 * Every command is bounded. On a remote (SSH) workspace each `exec` is a round
 * trip, and without a ceiling a single stalled call leaves the panel blank forever
 * with nothing to show the user.
 */
const EXEC_TIMEOUT_MS = 30_000;

/**
 * How commands reach git, cheapest first:
 *
 * - `direct`     — plain `muxy.exec(argv)` from this webview. Local spawn; works
 *   whenever Muxy's spawn cwd is valid, i.e. every local workspace.
 * - `shellCwd`   — the same exec through a shell with an explicit cwd, for local
 *   workspaces whose project path the spawn cwd cannot resolve.
 * - `background` — relayed to `background.js` over the extension event channel.
 *   Webview exec always spawns on the machine running Muxy, but the background
 *   context is the one Muxy documents as running exec on the remote server for a
 *   remote SSH workspace. See docs/adr/0017-background-exec-relay.md.
 */
type Transport =
  | { kind: "direct" }
  | { kind: "shellCwd"; path: string }
  | { kind: "background" };

let transportMode: Transport = { kind: "direct" };

function transport(
  command: string[] | { shell: string },
): string[] | { shell: string; cwd?: string } {
  switch (transportMode.kind) {
    case "direct":
    case "background":
      return command;
    case "shellCwd":
      return {
        // `cwd` must live inside this object, not beside it.
        cwd: SAFE_CWD,
        shell: Array.isArray(command)
          ? remote.shellCommand(command, transportMode.path)
          : remote.shellScript(command.shell, transportMode.path),
      };
  }
}

/**
 * A directory that certainly exists on the machine doing the spawning. Muxy sets
 * the spawn cwd to the project path, which for a remote project is `~/projects/x`
 * — unresolvable, so *every* spawn fails before the process starts, even
 * `git --version`. Overriding cwd is what makes any of the fallbacks possible.
 */
const SAFE_CWD = "/";

function exec(command: string[] | { shell: string }): Promise<ExecResult> {
  // The relay owns its own timeout and correlation; nothing below applies to it.
  if (transportMode.kind === "background") return execViaBackground(command);

  const label = Array.isArray(command) ? command.join(" ") : command.shell;
  const sent = transport(command);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${EXEC_TIMEOUT_MS / 1000}s: ${label}`)),
      EXEC_TIMEOUT_MS,
    );
    // The object form takes its options inline: Muxy's bridge builds the payload
    // from the first argument alone and discards a second one, so a `cwd` passed
    // alongside `{shell}` is silently dropped.
    const call = Array.isArray(sent)
      ? api().exec(sent, transportMode.kind === "direct" ? undefined : { cwd: SAFE_CWD })
      : api().exec(sent);
    call.then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function run(args: string[]): Promise<string> {
  const res = await exec(args);
  if (res.exitCode !== 0) {
    const reason = res.stderr.trim() || res.stdout.trim() || `exited ${res.exitCode}`;
    throw new Error(`${args.slice(0, 3).join(" ")}: ${reason}`);
  }
  return res.stdout;
}

async function tryRun(args: string[]): Promise<string | null> {
  try {
    const res = await exec(args);
    return res.exitCode === 0 ? res.stdout : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- reads --- */

export async function repoInfo(): Promise<{ root: string; branch: string }> {
  const info = await api().git.repoInfo();
  return { root: info.root, branch: info.currentBranch };
}

/**
 * Null means "the repository has no commits yet". A transport or repository
 * failure throws instead — on a remote workspace an unreachable host must not be
 * reported to the user as an empty repository.
 */
export async function headHash(): Promise<string | null> {
  const res = await exec(["git", "rev-parse", "--verify", "--quiet", "HEAD"]);
  if (res.exitCode === 0) return res.stdout.trim() || null;
  const reason = res.stderr.trim();
  // `--quiet` exits 1 with no output when HEAD simply does not resolve yet.
  if (reason === "") return null;
  throw new Error(`git rev-parse: ${reason}`);
}

/** A cheap digest of every ref, used to notice the repo moved (ADR-0008). */
export async function refDigest(): Promise<string> {
  if (!(await probeExec())) {
    // No shell: approximate with what the API can see cheaply.
    const status = await api().git.status({ local: true, fresh: true }).catch(() => null);
    const entries = await api().git.log({ maxCount: 1, fresh: true }).catch(() => []);
    return [
      entries[0]?.hash ?? "",
      status?.branch ?? "",
      status?.stagedFiles.length ?? 0,
      status?.unstagedFiles.length ?? 0,
    ].join("|");
  }
  const out = await tryRun(["git", "for-each-ref", "--format=%(objectname)%(refname)"]);
  const status = await tryRun(["git", "status", "--porcelain"]);
  return `${out ?? ""}|${status ?? ""}`;
}

/**
 * `muxy.exec` spawns a process on the machine running Muxy. For a project on a
 * remote (SSH) device the worktree path does not exist locally, so every command
 * fails with "spawn process: No such file or directory". `muxy.git` is the app's
 * own git core and does follow the remote workspace, so we probe once and fall
 * back to it. See docs/adr/0015-degrade-to-muxy-git-when-exec-is-unavailable.md.
 */
let execUsable: boolean | null = null;

export function isDegraded(): boolean {
  return execUsable === false;
}

/**
 * Must be called whenever the active project or worktree changes: the panel
 * follows the active project (ADR-0003), so switching between a local and a
 * remote workspace changes whether `exec` can spawn at all.
 */
export function resetCapabilities(): void {
  execUsable = null;
  transportMode = { kind: "direct" };
  awaitingRemoteSetup = false;
}

/** True when the workspace needs an SSH target before anything can run. */
let awaitingRemoteSetup = false;

export function needsRemoteSetup(): boolean {
  return awaitingRemoteSetup;
}

/** One rung of the transport ladder, recorded so failures are explainable. */
export interface ProbeAttempt {
  readonly rung: string;
  readonly sent: string;
  readonly ok: boolean;
  readonly detail: string;
}

let probeLog: ProbeAttempt[] = [];

export function probeReport(): readonly ProbeAttempt[] {
  return probeLog;
}

async function gitRuns(rung: string): Promise<boolean> {
  const probe = ["git", "--version"];
  const sent = transport(probe);
  const rendered = Array.isArray(sent) ? sent.join(" ") : `sh -c ${sent.shell}`;
  try {
    const res = await exec(probe);
    const ok = res.exitCode === 0;
    probeLog.push({
      rung, sent: rendered, ok,
      detail: ok ? res.stdout.trim() : (res.stderr.trim() || `exit ${res.exitCode}`),
    });
    return ok;
  } catch (err) {
    probeLog.push({
      rung, sent: rendered, ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Identifies the workspace for storing its SSH target. */
export async function workspaceKey(): Promise<string> {
  const info = await api().git.repoInfo().catch(() => null);
  return info?.root ?? "default";
}

/**
 * Resolution ladder, cheapest first. Every rung still goes through `muxy.exec`
 * except the last. See ADR-0016.
 */
let probeInFlight: Promise<boolean> | null = null;

/** Concurrent readers must share one probe, not race four of them. */
function probeExec(): Promise<boolean> {
  if (execUsable !== null) return Promise.resolve(execUsable);
  probeInFlight ??= runProbe().finally(() => { probeInFlight = null; });
  return probeInFlight;
}

async function runProbe(): Promise<boolean> {
  probeLog = [];

  const settle = (mode: Transport): true => {
    transportMode = mode;
    execUsable = true;
    awaitingRemoteSetup = false;
    void persistDiagnostics();
    return true;
  };

  // 1. Plain exec, as Muxy intends it.
  transportMode = { kind: "direct" };
  if (await gitRuns("direct")) return settle({ kind: "direct" });

  // 2. Same exec, but through a shell so the project path's `~` expands. Muxy
  //    passes the path through unexpanded, which `spawn` cannot resolve.
  const root = await projectPath();
  if (root === null) {
    probeLog.push({
      rung: "shellCwd", sent: "(skipped)", ok: false,
      detail: "muxy.git.repoInfo() returned no root path, so there was nothing to cd into",
    });
  } else {
    transportMode = { kind: "shellCwd", path: root };
    if (await gitRuns("shellCwd")) return settle({ kind: "shellCwd", path: root });
  }

  // 3. Relay through background.js, whose exec Muxy documents as running on the
  //    remote server for a remote SSH workspace — the one context that can reach
  //    a worktree the webview's local spawn cannot.
  transportMode = { kind: "background" };
  if (await backgroundReachesRepo(root)) return settle({ kind: "background" });

  // Nothing can run git here. `muxy.git` follows the workspace, so that becomes
  // the read-only source.
  transportMode = { kind: "direct" };
  execUsable = false;
  awaitingRemoteSetup = false;
  void persistDiagnostics();
  return false;
}

/**
 * The background probe must prove more than "a git ran": if the background host
 * were to spawn locally in some directory that happens to be a repository, its
 * answers would silently describe the wrong repo. `--show-toplevel` has to match
 * the root `muxy.git` reports for the active workspace.
 */
async function backgroundReachesRepo(root: string | null): Promise<boolean> {
  const sent = "git rev-parse --show-toplevel (via background.js)";
  try {
    const res = await exec(["git", "rev-parse", "--show-toplevel"]);
    const toplevel = res.stdout.trim();
    if (res.exitCode !== 0 || toplevel === "") {
      probeLog.push({
        rung: "background", sent, ok: false,
        detail: res.stderr.trim() || `exit ${res.exitCode}`,
      });
      return false;
    }
    const trim = (p: string): string => p.replace(/\/+$/, "");
    if (root !== null && trim(toplevel) !== trim(root)) {
      probeLog.push({
        rung: "background", sent, ok: false,
        detail: `reached ${toplevel}, but the active workspace is ${root} — refusing to show the wrong repository`,
      });
      return false;
    }
    probeLog.push({ rung: "background", sent, ok: true, detail: toplevel });
    return true;
  } catch (err) {
    probeLog.push({
      rung: "background", sent, ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Writes the probe result to extension storage. Muxy persists that to disk, which
 * makes a failed workspace diagnosable without the user having to open a dialog and
 * read numbers back.
 */
async function persistDiagnostics(): Promise<void> {
  try {
    const info = await api().git.repoInfo().catch(() => null);
    await globalThis.muxy?.storage.set("diagnostics.lastProbe", {
      at: new Date().toISOString(),
      repoInfoRoot: info?.root ?? null,
      repoInfoBranch: info?.currentBranch ?? null,
      attempts: probeLog,
    });
  } catch { /* diagnostics must never break the panel */ }
}

/** The worktree path as Muxy reports it — may be `~`-relative on a remote. */
async function projectPath(): Promise<string | null> {
  const info = await api().git.repoInfo().catch(() => null);
  const root = info?.root?.trim();
  return root !== undefined && root !== "" ? root : null;
}

/** Which rung of the ladder is in use, for the status line. */
export function transportKind(): Transport["kind"] {
  return transportMode.kind;
}

/** Thrown by the features that genuinely cannot work without a local shell. */
export function degradedError(what: string): Error {
  return new Error(
    `${what} needs shell access, which is unavailable for this workspace ` +
    `(muxy.exec cannot reach a remote worktree).`,
  );
}

export async function loadCommits(maxCount: number): Promise<RepoState> {
  return (await probeExec()) ? loadViaExec(maxCount) : loadViaApi(maxCount);
}

/** Fallback path: everything the graph and the row columns need, minus author
 *  email (avatars, deferred) and the commit body (details pane only). */
async function loadViaApi(maxCount: number): Promise<RepoState> {
  const git = api().git;
  const [entries, status, info] = await Promise.all([
    git.log({ maxCount: maxCount + 1 }),
    git.status({ local: true }).catch(() => null),
    git.repoInfo().catch(() => null),
  ]);

  const moreAvailable = entries.length > maxCount;
  const list = (moreAvailable ? entries.slice(0, maxCount) : entries).map(fromLogEntry);
  const branch = status?.branch ?? info?.currentBranch ?? "HEAD";
  const head =
    list.find((c) => c.refs.some((r) => r.kind === "head" && r.name === branch))?.hash ??
    list[0]?.hash ?? null;

  const dirty = status !== null && status.stagedFiles.length + status.unstagedFiles.length > 0;
  const commits = dirty && head !== null
    ? [uncommittedRow(head), ...list]
    : list;

  return { commits, head, headBranch: branch, moreAvailable };
}

function fromLogEntry(entry: {
  hash: string; subject: string; authorName: string; authorDate: string;
  parentHashes?: string[]; refs?: Array<{ name: string; kind: string }>;
}): Commit {
  return {
    hash: entry.hash,
    parents: entry.parentHashes ?? [],
    authorName: entry.authorName,
    authorEmail: "",
    authorDate: entry.authorDate,
    subject: entry.subject,
    refs: (entry.refs ?? []).map((ref) => ({ name: ref.name, kind: refKind(ref) })),
  };
}

function refKind(ref: { name: string; kind: string }): Ref["kind"] {
  const kind = ref.kind.toLowerCase();
  if (kind.includes("tag")) return "tag";
  if (kind.includes("stash")) return "stash";
  if (kind.includes("remote") || ref.name.includes("/")) return "remote";
  return "head";
}

function uncommittedRow(head: string): Commit {
  return {
    hash: UNCOMMITTED,
    parents: [head],
    authorName: "",
    authorEmail: "",
    authorDate: new Date().toISOString(),
    subject: "Uncommitted Changes",
    refs: [],
  };
}

async function loadViaExec(maxCount: number): Promise<RepoState> {
  const [head, branch] = await Promise.all([headHash(), currentBranch()]);
  if (head === null) {
    return { commits: [], head: null, headBranch: branch, moreAvailable: false };
  }

  const stdout = await run([
    "git", "log",
    `--max-count=${maxCount + 1}`,
    `--format=${LOG_FORMAT}`,
    "--branches", "--tags", "--remotes", "HEAD",
  ]);

  const parsed = parseLog(stdout);
  const moreAvailable = parsed.length > maxCount;
  const commits = moreAvailable ? parsed.slice(0, maxCount) : parsed;

  const merged = [...commits];
  const known = new Set(merged.map((c) => c.hash));

  // Stashes are not reachable from --branches/--tags/--remotes. They are spliced in
  // against their base commit only, so the index commit does not pollute the graph.
  for (const stash of await stashes()) {
    if (known.has(stash.hash)) continue;
    const at = merged.findIndex((c) => c.authorDate < stash.authorDate);
    merged.splice(at === -1 ? merged.length : at, 0, stash);
    known.add(stash.hash);
  }

  if (await hasUncommittedChanges()) merged.unshift(uncommittedRow(head));

  return { commits: merged, head, headBranch: branch, moreAvailable };
}

function parseLog(stdout: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of stdout.split(REC)) {
    const line = record.replace(/^\n/, "");
    if (line.trim() === "") continue;
    const [hash, parents, authorName, authorEmail, authorDate, decoration, subject] = line.split(FLD);
    if (hash === undefined || subject === undefined) continue;
    commits.push({
      hash,
      parents: parents === "" ? [] : parents.split(" "),
      authorName,
      authorEmail,
      authorDate,
      subject,
      refs: parseRefs(decoration),
    });
  }
  return commits;
}

function parseRefs(decoration: string): Ref[] {
  if (!decoration) return [];
  const refs: Ref[] = [];
  for (const raw of decoration.split(", ")) {
    let name = raw.trim();
    if (name === "") continue;
    if (name.startsWith("HEAD -> ")) name = name.slice(8);
    if (name === "HEAD") continue;
    if (name.startsWith("tag: ")) refs.push({ name: name.slice(5), kind: "tag" });
    else if (name.includes("/")) refs.push({ name, kind: "remote" });
    else refs.push({ name, kind: "head" });
  }
  return refs;
}

async function stashes(): Promise<Commit[]> {
  const out = await tryRun([
    "git", "stash", "list",
    // %gd, not %gD — the capital form yields `refs/stash@{0}`.
    `--format=%H%x1f%gd%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e`,
  ]);
  if (!out) return [];

  const list: Commit[] = [];
  for (const record of out.split(REC)) {
    const line = record.replace(/^\n/, "");
    if (line.trim() === "") continue;
    const [hash, stashRef, parents, authorName, authorEmail, authorDate, subject] = line.split(FLD);
    if (!hash) continue;
    const base = (parents ?? "").split(" ").filter(Boolean)[0];
    list.push({
      hash,
      parents: base ? [base] : [],
      authorName,
      authorEmail,
      authorDate,
      subject,
      refs: [{ name: stashRef, kind: "stash" }],
      isStash: true,
      stashRef,
    });
  }
  return list;
}

export async function hasUncommittedChanges(): Promise<boolean> {
  const out = await tryRun(["git", "status", "--porcelain", "--untracked-files=normal"]);
  return (out ?? "").trim() !== "";
}

export async function currentBranch(): Promise<string> {
  const out = await tryRun(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  if (out !== null && out.trim() !== "") return out.trim();
  const info = await api().git.repoInfo().catch(() => null);
  return info?.currentBranch ?? "HEAD";
}

export async function commitDetails(hash: string, known?: Commit): Promise<CommitDetails> {
  if (!(await probeExec())) {
    if (hash === UNCOMMITTED) return uncommittedDetailsViaApi();
    return detailsFromLogEntry(hash, known);
  }
  if (hash === UNCOMMITTED) return uncommittedDetails();

  const meta = (await run(["git", "show", "--no-patch", `--format=${DETAIL_FORMAT}`, hash])).split(FLD);
  const files = await changedFiles(hash);
  return {
    hash: meta[0] ?? hash,
    parents: (meta[1] ?? "").split(" ").filter(Boolean),
    authorName: meta[2] ?? "",
    authorEmail: meta[3] ?? "",
    authorDate: meta[4] ?? "",
    committerName: meta[5] ?? "",
    committerEmail: meta[6] ?? "",
    committerDate: meta[7] ?? "",
    body: (meta[8] ?? "").trim(),
    files,
  };
}

/**
 * Without a shell there is no way to list a commit's files — `muxy.git` has no
 * commit-diff method — but everything already carried on the log entry is real, so
 * the pane shows that rather than an error.
 */
function detailsFromLogEntry(hash: string, known?: Commit): CommitDetails {
  return {
    hash,
    parents: known?.parents ?? [],
    authorName: known?.authorName ?? "",
    authorEmail: known?.authorEmail ?? "",
    authorDate: known?.authorDate ?? "",
    committerName: known?.authorName ?? "",
    committerEmail: known?.authorEmail ?? "",
    committerDate: known?.authorDate ?? "",
    body: known?.subject ?? "",
    files: [],
  };
}

/** The one details view that survives without a shell: `muxy.git.status` lists
 *  the working-tree changes directly. */
async function uncommittedDetailsViaApi(): Promise<CommitDetails> {
  const status = await api().git.status({ local: true });
  const seen = new Set<string>();
  const files: ChangedFile[] = [];
  for (const file of [...status.stagedFiles, ...status.unstagedFiles]) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    const letter = (file.status.trim()[0] ?? "M").toUpperCase();
    files.push({
      path: file.path,
      oldPath: file.oldPath,
      status: (letter === "?" ? "?" : letter) as FileStatus,
    });
  }
  return {
    hash: UNCOMMITTED, parents: [], authorName: "", authorEmail: "", authorDate: "",
    committerName: "", committerEmail: "", committerDate: "", body: "", files,
  };
}

async function uncommittedDetails(): Promise<CommitDetails> {
  const out = (await tryRun(["git", "status", "--porcelain", "--untracked-files=all"])) ?? "";
  const files: ChangedFile[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    if (code.includes("?")) {
      files.push({ path: rest, status: "?" });
    } else if (code.trimStart().startsWith("R")) {
      const [oldPath, path] = rest.split(" -> ");
      files.push({ path, oldPath, status: "R" });
    } else {
      const letter = (code.replace(/\s/g, "")[0] ?? "M") as FileStatus;
      files.push({ path: rest, status: letter });
    }
  }
  return {
    hash: UNCOMMITTED,
    parents: [],
    authorName: "",
    authorEmail: "",
    authorDate: "",
    committerName: "",
    committerEmail: "",
    committerDate: "",
    body: "",
    files,
  };
}

async function changedFiles(hash: string): Promise<ChangedFile[]> {
  const out = await run([
    "git", "diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "--root", hash,
  ]);
  return parseNameStatus(out);
}

export async function comparisonFiles(from: string, to: string): Promise<ChangedFile[]> {
  if (!(await probeExec())) throw degradedError("Comparing commits");
  const out = await run(["git", "diff", "--name-status", "-M", from, to]);
  return parseNameStatus(out);
}

function parseNameStatus(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    const code = parts[0][0] as FileStatus;
    if (code === "R" || code === "C") {
      files.push({ status: code, oldPath: parts[1], path: parts[2] });
    } else {
      files.push({ status: code, path: parts[1] });
    }
  }
  return files;
}

export async function fileDiff(hash: string, path: string, oldPath?: string): Promise<string> {
  if (!(await probeExec())) {
    // `muxy.git.diff` has no ref parameter — working tree only — but that is
    // exactly the case that matters without a shell, and it follows the workspace.
    if (hash === UNCOMMITTED) {
      const staged = await api().git.diff({ filePath: path, raw: true, staged: true })
        .catch(() => null);
      if (staged !== null && staged.diff.trim() !== "") return staged.diff;
      const working = await api().git.diff({ filePath: path, raw: true });
      return working.diff;
    }
    throw degradedError("Diffing a commit");
  }
  const paths = oldPath ? ["--", oldPath, path] : ["--", path];
  if (hash === UNCOMMITTED) {
    const tracked = await tryRun(["git", "diff", "HEAD", "--no-color", "-M", ...paths]);
    if (tracked && tracked.trim() !== "") return tracked;
    // `--no-index` exits 1 whenever the files differ, which is the normal case here.
    const res = await api().exec(["git", "diff", "--no-index", "--no-color", "/dev/null", path]);
    return res.exitCode <= 1 ? res.stdout : "";
  }
  return run(["git", "show", "--format=", "--no-color", "-M", hash, ...paths]);
}

export async function comparisonDiff(
  from: string, to: string, path: string, oldPath?: string,
): Promise<string> {
  const paths = oldPath ? ["--", oldPath, path] : ["--", path];
  return run(["git", "diff", "--no-color", "-M", from, to, ...paths]);
}

export async function pendingOperation(): Promise<PendingOperation> {
  if (!(await probeExec())) return null;
  const probe = [
    `[ -f "$(git rev-parse --git-path rebase-merge/head-name)" ] || `
      + `[ -f "$(git rev-parse --git-path rebase-apply/applying)" ] && { printf %s rebase; exit; }`,
    `git rev-parse --verify --quiet REVERT_HEAD >/dev/null 2>&1 && { printf %s revert; exit; }`,
    `git rev-parse --verify --quiet CHERRY_PICK_HEAD >/dev/null 2>&1 && { printf %s cherry-pick; exit; }`,
    `git rev-parse --verify --quiet MERGE_HEAD >/dev/null 2>&1 && { printf %s merge; exit; }`,
  ].join("; ");
  try {
    const res = await api().exec({ shell: probe });
    const value = res.stdout.trim();
    return value === "" ? null : (value as PendingOperation);
  } catch {
    return null;
  }
}

export async function localBranches(): Promise<string[]> {
  const out = await tryRun(["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return (out ?? "").split("\n").filter((s) => s.trim() !== "");
}

export async function remotes(): Promise<string[]> {
  if (!(await probeExec())) return [];
  const out = await tryRun(["git", "remote"]);
  return (out ?? "").split("\n").filter((s) => s.trim() !== "");
}

/* --------------------------------------------------------------- writes --- */
/* muxy.git where the operation exists (named consent prompts), exec otherwise. */

export const write = {
  checkoutCommit: (hash: string) => api().git.checkout({ hash }),
  checkoutBranch: (branch: string) => api().git.branch.switchTo({ branch }),
  cherryPick: (hash: string) => api().git.cherryPick({ hash }),
  revert: (hash: string) => api().git.revert({ hash }),
  createBranch: (name: string) => api().git.branch.create({ name }),
  deleteBranch: (name: string, force: boolean) => api().git.branch.delete({ name, force }),
  deleteRemoteBranch: (branch: string) => api().git.branch.deleteRemote({ branch }),
  createTag: (name: string, hash: string) => api().git.tag.create({ name, hash }),
  push: () => api().git.push(),
  pull: () => api().git.pull(),

  // No muxy.git equivalent — these fall through to exec.
  branchAt: (name: string, hash: string) => run(["git", "branch", name, hash]),
  checkoutNewBranchAt: (name: string, hash: string) => run(["git", "checkout", "-b", name, hash]),
  renameBranch: (from: string, to: string) => run(["git", "branch", "-m", from, to]),
  merge: (ref: string, options: { noFastForward: boolean; squash: boolean; noCommit: boolean }) =>
    run([
      "git", "merge", ref,
      ...(options.squash ? ["--squash"] : options.noFastForward ? ["--no-ff"] : []),
      ...(options.noCommit && !options.squash ? ["--no-commit"] : []),
    ]),
  rebase: (ref: string, interactive: boolean) =>
    run(["git", "rebase", ...(interactive ? ["--interactive"] : []), ref]),
  reset: (hash: string, mode: "soft" | "mixed" | "hard") => run(["git", "reset", `--${mode}`, hash]),
  dropCommit: (hash: string) => run(["git", "rebase", "--onto", `${hash}^`, hash, "HEAD"]),
  fetch: (prune: boolean) => run(["git", "fetch", "--all", ...(prune ? ["--prune"] : [])]),
  pushTag: (name: string, remote: string) => run(["git", "push", remote, name]),
  deleteTag: (name: string) => run(["git", "tag", "-d", name]),
  deleteRemoteTag: (name: string, remote: string) =>
    run(["git", "push", "--delete", remote, `refs/tags/${name}`]),
  stashPush: (message: string, includeUntracked: boolean) =>
    run([
      "git", "stash", "push",
      ...(includeUntracked ? ["--include-untracked"] : []),
      ...(message ? ["--message", message] : []),
    ]),
  stashApply: (ref: string, reinstateIndex: boolean) =>
    run(["git", "stash", "apply", ...(reinstateIndex ? ["--index"] : []), ref]),
  stashPop: (ref: string, reinstateIndex: boolean) =>
    run(["git", "stash", "pop", ...(reinstateIndex ? ["--index"] : []), ref]),
  stashDrop: (ref: string) => run(["git", "stash", "drop", ref]),
  stashBranch: (ref: string, name: string) => run(["git", "stash", "branch", name, ref]),
  cleanUntracked: (directories: boolean) =>
    run(["git", "clean", "-f", ...(directories ? ["-d"] : [])]),
  resetUncommitted: (mode: "mixed" | "hard") => run(["git", "reset", `--${mode}`, "HEAD"]),
  abort: (operation: Exclude<PendingOperation, null>) =>
    run(["git", operation === "cherry-pick" ? "cherry-pick" : operation, "--abort"]),
  continueOperation: (operation: Exclude<PendingOperation, null>) =>
    run(["git", operation === "cherry-pick" ? "cherry-pick" : operation, "--continue"]),
};
