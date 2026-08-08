export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RepoInfo {
  root: string;
  gitDir: string;
  isWorktree: boolean;
  currentBranch: string;
}

export interface MuxyTheme {
  colorScheme: "light" | "dark";
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorDate: string;
  isMerge: boolean;
  parentHashes?: string[];
  refs?: Array<{ name: string; kind: string }>;
}

export interface GitStatusFile {
  path: string;
  oldPath?: string;
  status: string;
  isStaged: boolean;
  isUnstaged: boolean;
  additions?: number;
  deletions?: number;
}

export interface GitStatus {
  branch: string;
  stagedFiles: GitStatusFile[];
  unstagedFiles: GitStatusFile[];
}

/** Only the subset this extension calls. See docs/adr/0002-data-layer-split.md. */
export interface MuxyGit {
  repoInfo(options?: { fresh?: boolean }): Promise<RepoInfo>;
  log(options?: { maxCount?: number; skip?: number; fresh?: boolean }): Promise<GitLogEntry[]>;
  status(options?: { local?: boolean; fresh?: boolean }): Promise<GitStatus>;
  /** Working tree only — the bridge accepts no ref, so a commit cannot be diffed. */
  diff(options: {
    filePath?: string;
    raw?: boolean;
    staged?: boolean;
    lineLimit?: number;
    fresh?: boolean;
  }): Promise<{ diff: string; truncated: boolean }>;
  checkout(args: { hash: string }): Promise<void>;
  cherryPick(args: { hash: string }): Promise<void>;
  revert(args: { hash: string }): Promise<void>;
  push(args?: { setUpstream?: boolean }): Promise<void>;
  pull(): Promise<void>;
  branch: {
    create(args: { name: string }): Promise<void>;
    switchTo(args: { branch: string }): Promise<void>;
    delete(args: { name: string; force?: boolean }): Promise<void>;
    deleteRemote(args: { branch: string }): Promise<void>;
  };
  tag: {
    create(args: { name: string; hash?: string }): Promise<void>;
  };
}

export interface MuxyApi {
  /**
   * The object form carries its own options: Muxy builds the payload from the
   * first argument alone and discards a second one, so `{shell}` must include
   * `cwd` inline rather than beside it.
   */
  exec(
    command: string[] | { shell: string; cwd?: string; env?: Record<string, string> },
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<ExecResult>;
  git: MuxyGit;
  extensionID: string;
  tabs: {
    open(args: {
      kind: "extensionWebView";
      extension: {
        id: string;
        tabType: string;
        singleton?: boolean;
        data?: unknown;
      };
    }): Promise<unknown>;
    setTitle(title: string): Promise<void>;
  };
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  browser?: {
    /** Positional URL string — the bridge coerces its first argument with
     *  String(), so an options object would become "[object Object]". */
    open(url: string, opts?: { split?: boolean }): Promise<unknown>;
  };
  notifications?: {
    post(args: { title: string; body?: string }): Promise<void>;
  };
  events: {
    subscribe(event: string, handler: (payload: unknown) => void): () => void;
    /** `extension.*` only. A webview emit relays through background.js and
     *  rejects when no background script is running. */
    emit(event: string, payload: unknown): Promise<void>;
  };
  theme: MuxyTheme;
  /** The payload this surface was opened with, or its manifest defaultData. */
  data?: unknown;
  /** Fires when a singleton tab is reopened with a new payload. */
  onDataChange(handler: (data: unknown) => void): () => void;
  onThemeChange(handler: (theme: MuxyTheme) => void): () => void;
}

declare global {
  // `var` rather than `const` so it also lands on the type of `globalThis`.
  // Absent when the page is opened outside Muxy (e.g. `npm run dev`).
  // eslint-disable-next-line no-var
  var muxy: MuxyApi | undefined;
  interface Window {
    muxy?: MuxyApi;
  }
}
