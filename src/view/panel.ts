import { computeLayout } from "../graph/layout.ts";
import { canDropCommit } from "../graph/queries.ts";
import type { GraphConfig, GraphLayout } from "../graph/types.ts";
import * as repo from "../data/repo.ts";
import { UNCOMMITTED, write } from "../data/repo.ts";
import type { ChangedFile, Commit, CommitDetails, PendingOperation, Ref, RepoState } from "../data/repo.ts";
import { commitMenu, refMenu } from "../actions/menus.ts";
import type { ActionContext } from "../actions/menus.ts";
import { closeContextMenu, openContextMenu } from "./context-menu.ts";
import { confirmDialog } from "./dialog.ts";
import { renderCommitDetails } from "./commit-details.ts";
import { renderGraph } from "./render-graph.ts";
import { VirtualRows } from "./virtual-rows.ts";
import { absoluteTime, copyToClipboard, el, relativeTime } from "./dom.ts";

const ROW_HEIGHT = 24;
const DETAILS_HEIGHT = 280;
const INITIAL_LOAD = 300;
const LOAD_MORE = 300;
const POLL_MS = 4000;

/** The Graph column never takes more than this share of the panel. */
const MAX_GRAPH_FRACTION = 0.5;
/** Wide enough for the "Graph" column header — a narrower single-lane repo
 *  would otherwise ellipsize the label itself. */
const MIN_GRAPH_WIDTH = 44;

const CONFIG: GraphConfig = {
  grid: { x: 12, y: ROW_HEIGHT, offsetX: 12, offsetY: ROW_HEIGHT / 2, expandY: DETAILS_HEIGHT },
  style: "rounded",
  uncommittedChanges: "openCircleAtUncommitted",
};

type Columns = { date: boolean; author: boolean; hash: boolean };

/** Which refs win the visible chip slots when a commit carries several. */
const REF_ORDER: Record<Ref["kind"], number> = { head: 0, tag: 1, remote: 2, stash: 3 };

export class Panel {
  private readonly root: HTMLElement;

  private readonly branchLabel = el("span", "topbar__title", "Git Graph");
  private readonly statusLabel = el("span", "topbar__repo");
  private readonly banner = el("div", "banner");
  private readonly scroller = el("div", "scroller");
  private readonly head = el("div", "head");
  private readonly content = el("div", "content");
  private readonly rowsHost = el("div", "rows");
  private readonly detailsHost = el("div", "details");
  private readonly graphClip = el("div", "graphclip");
  private readonly notice = el("div", "notice");
  private readonly svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

  private state: RepoState = { commits: [], head: null, headBranch: "", moreAvailable: false };
  private layout: GraphLayout | null = null;
  private rows: VirtualRows | null = null;
  private columns: Columns = { date: true, author: true, hash: true };

  private selected: number | null = null;
  private compareWith: number | null = null;
  private loaded = INITIAL_LOAD;
  private remotes: string[] = [];
  private pending: PendingOperation = null;
  private digest = "";
  private pollTimer: number | undefined;
  private busy = false;
  private splitFraction = 0.5;
  private lastReloadMs = 0;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start(): Promise<void> {
    this.build();
    await Promise.all([this.restoreSplit(), this.restoreDetailsCache()]);
    await this.reload();
    this.subscribe();
  }

  private async restoreSplit(): Promise<void> {
    try {
      const stored = await globalThis.muxy?.storage.get("details.split");
      if (typeof stored === "number" && stored >= 0.2 && stored <= 0.8) {
        this.splitFraction = stored;
      }
    } catch { /* first run */ }
    this.detailsHost.style.setProperty("--cdv-split", `${(this.splitFraction * 100).toFixed(2)}%`);
  }

  /* ------------------------------------------------------------- chrome --- */

  private build(): void {
    const fetchButton = iconButton("Fetch from remotes", "↓", () =>
      this.perform("Fetch", () => write.fetch(true)));
    const refreshButton = iconButton("Refresh (⌘R)", "⟳", () => {
      // A manual refresh must also re-test the transport: the workspace may have
      // become remote-capable (or lost it) without any project-switch event.
      repo.resetCapabilities();
      void this.reload();
    });

    const topbar = el("div", "topbar");
    topbar.append(this.branchLabel, this.statusLabel, el("span", "topbar__spacer"),
      fetchButton, refreshButton);

    this.banner.hidden = true;
    this.svg.setAttribute("class", "graph");
    this.detailsHost.hidden = true;

    for (const [label, className] of [
      ["Graph", "cell--graph"], ["Description", "cell--desc"],
      ["Date", "cell--date"], ["Author", "cell--author"], ["Commit", "cell--hash"],
    ]) {
      this.head.appendChild(el("span", `cell ${className}`, label));
    }

    // The graph is clipped to its column, matching git-graph's limitGraphWidth.
    this.graphClip.appendChild(this.svg);
    this.content.append(this.graphClip, this.rowsHost, this.detailsHost);
    this.scroller.append(this.head, this.content);

    this.notice.hidden = true;
    this.root.append(topbar, this.banner, this.notice, this.scroller);

    this.rows = new VirtualRows({
      scroller: this.scroller,
      container: this.rowsHost,
      rowHeight: ROW_HEIGHT,
      overscan: 8,
      createRow: () => this.createRow(),
      renderRow: (element, index) => this.renderRow(element, index),
    });

    this.scroller.addEventListener("scroll", () => {
      if (this.state.moreAvailable && !this.busy &&
        this.scroller.scrollTop + this.scroller.clientHeight > this.scroller.scrollHeight - 400) {
        void this.loadMore();
      }
    }, { passive: true });

    new ResizeObserver(() => this.applyColumns()).observe(this.root);
    window.addEventListener("keydown", (event) => this.onKeyDown(event));
  }

  /**
   * Sizes the five columns. Hidden columns collapse to 0px rather than being
   * removed, so the header and every recycled row keep the same track count.
   */
  private applyColumns(): void {
    const width = this.root.clientWidth;
    this.columns = { date: width >= 620, author: width >= 480, hash: width >= 360 };

    const contentWidth = this.layout?.width ?? MIN_GRAPH_WIDTH;
    const graph = Math.max(
      MIN_GRAPH_WIDTH,
      Math.min(contentWidth, Math.floor(width * MAX_GRAPH_FRACTION)),
    );

    // Summary and files sit side by side only when there is room for both.
    this.detailsHost.classList.toggle("details--split", width >= 520);

    const style = this.root.style;
    style.setProperty("--col-graph", `${graph}px`);
    style.setProperty("--col-date", this.columns.date ? "84px" : "0px");
    style.setProperty("--col-author", this.columns.author ? "116px" : "0px");
    style.setProperty("--col-hash", this.columns.hash ? "60px" : "0px");
  }

  /* --------------------------------------------------------------- data --- */

  private async reload(): Promise<void> {
    this.busy = true;
    if (this.state.commits.length === 0) this.showNotice("Loading history…");
    const started = Date.now();
    try {
      const [state, remotes, pending, digest] = await Promise.all([
        repo.loadCommits(this.loaded),
        repo.remotes(),
        repo.pendingOperation(),
        repo.refDigest(),
      ]);
      this.state = state;
      this.remotes = remotes;
      this.pending = pending;
      this.digest = digest;
      this.statusLabel.textContent = "";
      this.detailsCache.delete(UNCOMMITTED);
      this.reselect();
      this.render();
      this.renderBanner();

      if (state.commits.length === 0) {
        this.showNotice(state.head === null
          ? "This repository has no commits yet."
          : "No commits matched. The repository may be empty or unreachable.");
      } else if (repo.isDegraded()) {
        // Reading through muxy.git, as Muxy's own git extension does on a remote.
        this.statusLabel.textContent = "read-only · no shell on this workspace";
        this.statusLabel.title =
          "muxy.exec runs on the machine hosting Muxy, so it cannot reach this " +
          "worktree. History comes from muxy.git; diffs and write actions need a " +
          "local workspace.";
        this.hideNotice();
      } else {
        this.hideNotice();
      }
    } catch (err) {
      // A remote workspace makes every read a round trip, so surface the actual
      // failing command rather than leaving a blank panel.
      this.showNotice(err instanceof Error ? err.message : String(err), true);
    } finally {
      this.busy = false;
      this.lastReloadMs = Date.now() - started;
      this.updatePolling();
    }
  }

  private statusFlashTimer: number | undefined;

  /** Transient confirmation in the topbar, e.g. after copying a ref name. */
  private flashStatus(message: string): void {
    window.clearTimeout(this.statusFlashTimer);
    this.statusLabel.textContent = message;
    this.statusFlashTimer = window.setTimeout(() => {
      if (this.statusLabel.textContent === message) this.statusLabel.textContent = "";
    }, 1500);
  }

  private showNotice(message: string, isError = false): void {
    this.notice.hidden = false;
    this.notice.classList.toggle("notice--error", isError);
    this.notice.replaceChildren(el("span", "notice__text", message));
    if (isError) {
      const retry = el("button", "", "Retry");
      retry.addEventListener("click", () => void this.reload());
      this.notice.appendChild(retry);
    }
  }

  private hideNotice(): void {
    this.notice.hidden = true;
  }

  private async loadMore(): Promise<void> {
    this.loaded += LOAD_MORE;
    await this.reload();
  }

  /** Keep the selection pinned to the same commit hash across a refresh. */
  private reselect(): void {
    if (this.selected === null) return;
    const previous = this.selectedHash;
    const index = this.state.commits.findIndex((c) => c.hash === previous);
    this.selected = index === -1 ? null : index;
    if (this.selected === null) {
      this.compareWith = null;
      this.detailsHost.hidden = true;
    }
  }

  private selectedHash: string | null = null;

  /**
   * A commit's hash is its content, so its details never change — a cache entry
   * is correct forever and renders with zero round trips, which matters on a
   * remote workspace where a fetch is two SSH round trips. The uncommitted entry
   * is the one mutable case; it renders from cache instantly and refreshes in
   * the background.
   */
  private readonly detailsCache = new Map<string, CommitDetails>();

  /** Invalidates in-flight detail renders when the selection moves on. */
  private detailsToken = 0;

  private readonly detailsInflight = new Map<string, Promise<CommitDetails>>();
  private prefetchTimer: number | undefined;

  /** Cache hit, or join the in-flight fetch, or start one. */
  private fetchDetails(commit: Commit): Promise<CommitDetails> {
    if (commit.hash !== UNCOMMITTED) {
      const cached = this.detailsCache.get(commit.hash);
      if (cached !== undefined) return Promise.resolve(cached);
    }
    const existing = this.detailsInflight.get(commit.hash);
    if (existing !== undefined) return existing;
    const fetch = repo.commitDetails(commit.hash, commit)
      .then((details) => {
        this.cacheDetails(commit.hash, details);
        return details;
      })
      .finally(() => {
        this.detailsInflight.delete(commit.hash);
      });
    this.detailsInflight.set(commit.hash, fetch);
    return fetch;
  }

  /** Fire-and-forget cache warmer; never competes with a click for bandwidth. */
  private prefetchDetails(commit: Commit | undefined): void {
    if (!commit || commit.hash === UNCOMMITTED) return;
    if (this.detailsCache.has(commit.hash)) return;
    if (this.detailsInflight.size >= 3) return;
    void this.fetchDetails(commit).catch(() => undefined);
  }

  private persistTimer: number | undefined;

  private cacheDetails(key: string, details: CommitDetails): void {
    this.detailsCache.delete(key);
    this.detailsCache.set(key, details);
    if (this.detailsCache.size > 200) {
      const oldest = this.detailsCache.keys().next().value;
      if (oldest !== undefined) this.detailsCache.delete(oldest);
    }
    // Details are immutable, so persisting them is free correctness: the cache
    // survives panel reloads and app restarts. Debounced; the uncommitted entry
    // is skipped because the working tree does not survive anything.
    window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => void this.persistDetailsCache(), 2000);
  }

  private async persistDetailsCache(): Promise<void> {
    try {
      const entries = [...this.detailsCache.entries()].filter(([key]) => key !== UNCOMMITTED);
      let payload = JSON.stringify(entries);
      // Storage caps a value at 1 MB; stay far under it.
      while (payload.length > 600_000 && entries.length > 0) {
        entries.shift();
        payload = JSON.stringify(entries);
      }
      await globalThis.muxy?.storage.set("details.cache", entries);
    } catch { /* cache persistence must never break the panel */ }
  }

  private async restoreDetailsCache(): Promise<void> {
    try {
      const stored = await globalThis.muxy?.storage.get("details.cache");
      if (!Array.isArray(stored)) return;
      for (const entry of stored as Array<[string, CommitDetails]>) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0] !== UNCOMMITTED) {
          this.detailsCache.set(entry[0], entry[1]);
        }
      }
    } catch { /* first run */ }
  }

  /* ------------------------------------------------------------- render --- */

  private render(): void {
    this.branchLabel.textContent = this.state.headBranch || "Git Graph";

    const expandAt = this.selected;
    this.layout = computeLayout(this.state.commits, CONFIG, {
      commitHead: this.state.head,
      expandAt: expandAt ?? -1,
    });
    renderGraph(this.svg, this.layout);
    this.applyColumns();

    this.rows?.setCount(
      this.state.commits.length,
      expandAt === null ? null : { afterIndex: expandAt, amount: DETAILS_HEIGHT },
    );
    this.content.style.height = `${this.rows?.totalHeight ?? 0}px`;
    this.positionDetails();
  }

  private positionDetails(): void {
    if (this.selected === null || this.rows === null) {
      this.detailsHost.hidden = true;
      return;
    }
    this.detailsHost.hidden = false;
    this.detailsHost.style.top = `${(this.selected + 1) * ROW_HEIGHT}px`;
    this.detailsHost.style.height = `${DETAILS_HEIGHT}px`;
  }

  private renderBanner(): void {
    if (this.pending === null) {
      this.banner.hidden = true;
      return;
    }
    const operation = this.pending;
    this.banner.hidden = false;
    this.banner.replaceChildren(
      el("span", "banner__text", `A ${operation} is in progress. Resolve conflicts, then continue.`),
      textButton("Continue", () => this.perform("Continue", () => write.continueOperation(operation))),
      textButton("Abort", () => this.perform("Abort", () => write.abort(operation))),
    );
  }

  private createRow(): HTMLElement {
    const row = el("div", "row");
    const description = el("span", "cell cell--desc");
    description.append(el("span", "row__refs"), el("span", "row__subject"));
    row.append(
      el("span", "cell cell--graph"),
      description,
      el("span", "cell cell--date"),
      el("span", "cell cell--author"),
      el("span", "cell cell--hash"),
    );

    row.addEventListener("click", (event) => {
      const index = Number(row.dataset.index);
      if (Number.isNaN(index)) return;
      if (event.metaKey || event.ctrlKey) void this.selectComparison(index);
      else void this.select(index);
    });

    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const index = Number(row.dataset.index);
      if (Number.isNaN(index)) return;
      const commit = this.state.commits[index];
      openContextMenu(event.clientX, event.clientY,
        commitMenu(commit, canDropCommit(this.state.commits, index, this.state.head), this.actionContext()));
    });

    row.addEventListener("pointerenter", () => {
      const index = Number(row.dataset.index);
      if (Number.isNaN(index)) return;
      window.clearTimeout(this.prefetchTimer);
      // Debounced so sweeping the cursor down the list doesn't fetch every row.
      this.prefetchTimer = window.setTimeout(
        () => this.prefetchDetails(this.state.commits[index]),
        80,
      );
    });

    return row;
  }

  private renderRow(element: HTMLElement, index: number): void {
    const commit = this.state.commits[index];
    const [, description, date, author, hash] = element.children as unknown as HTMLElement[];
    const [refs, subject] = description.children as unknown as HTMLElement[];
    element.dataset.index = String(index);
    element.classList.toggle("row--selected", index === this.selected);
    element.classList.toggle("row--compare", index === this.compareWith);
    element.classList.toggle("row--head", commit.hash === this.state.head);

    refs.replaceChildren(...this.refChips(commit));
    subject.textContent = commit.subject;
    subject.title = commit.subject;
    date.textContent = commit.hash === UNCOMMITTED ? "" : relativeTime(commit.authorDate);
    date.title = absoluteTime(commit.authorDate);
    author.textContent = commit.authorName;
    hash.textContent = commit.hash === UNCOMMITTED ? "" : commit.hash.slice(0, 7);
  }

  /**
   * Shows the most relevant refs and collapses the rest behind a `+N` chip, which
   * opens a picker so the hidden ones stay actionable rather than just visible.
   */
  private refChips(commit: Commit): HTMLElement[] {
    if (commit.refs.length === 0) return [];

    const ordered = [...commit.refs].sort((a, b) => REF_ORDER[a.kind] - REF_ORDER[b.kind]);
    const limit = this.columns.date ? 3 : this.columns.author ? 2 : 1;
    if (ordered.length <= limit + 1) return ordered.map((ref) => this.refChip(ref, commit));

    const visible = ordered.slice(0, limit);
    const hidden = ordered.slice(limit);
    const chips = visible.map((ref) => this.refChip(ref, commit));

    const more = el("span", "ref ref--more", `+${hidden.length}`);
    more.title = hidden.map((ref) => ref.name).join("\n");
    const openHidden = (x: number, y: number): void => {
      openContextMenu(x, y, hidden.map((ref) => ({
        label: ref.name,
        run: () => {
          const rect = more.getBoundingClientRect();
          openContextMenu(rect.left, rect.bottom + 2, refMenu(ref, commit, this.actionContext()));
        },
      })));
    };
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = more.getBoundingClientRect();
      openHidden(rect.left, rect.bottom + 2);
    });
    more.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openHidden(event.clientX, event.clientY);
    });

    chips.push(more);
    return chips;
  }

  private refChip(ref: Ref, commit: Commit): HTMLElement {
    const chip = el("span", `ref ref--${ref.kind}`, ref.name);
    chip.title = `${ref.name} — click to copy, right-click for actions`;
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      void copyToClipboard(ref.name);
      this.flashStatus(`Copied ${ref.name}`);
    });
    chip.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openContextMenu(event.clientX, event.clientY, refMenu(ref, commit, this.actionContext()));
    });
    return chip;
  }

  /* ---------------------------------------------------------- selection --- */

  private async select(index: number): Promise<void> {
    if (this.selected === index && this.compareWith === null) {
      this.closeDetails();
      return;
    }
    this.selected = index;
    this.compareWith = null;
    this.selectedHash = this.state.commits[index].hash;
    this.render();
    this.rows?.refresh();

    const commit = this.state.commits[index];
    const token = ++this.detailsToken;
    const handlers = this.detailsHandlers(commit.hash, null);
    const degradedNote = repo.isDegraded() && commit.hash !== UNCOMMITTED
      ? "Per-commit file changes need a shell. muxy.git can only diff the working " +
        "tree — no Muxy extension can list a commit's files on this workspace."
      : undefined;

    const cached = this.detailsCache.get(commit.hash);
    if (cached !== undefined) {
      renderCommitDetails(this.detailsHost, cached, handlers, null, degradedNote);
      // Immutable content — the cached copy is final. Only the working tree moves.
      if (commit.hash !== UNCOMMITTED) return;
    } else {
      // Instant skeleton from the log entry already in hand, so the pane never
      // lingers on the previously selected commit while the fetch runs.
      renderCommitDetails(this.detailsHost, skeletonDetails(commit), handlers, null,
        degradedNote ?? "Loading changes…");
    }

    // The likely next clicks: up/down neighbours warm while this one renders.
    this.prefetchDetails(this.state.commits[index + 1]);
    this.prefetchDetails(this.state.commits[index - 1]);

    try {
      const details = await this.fetchDetails(commit);
      if (token !== this.detailsToken) return;
      const unchanged = cached !== undefined &&
        JSON.stringify(cached) === JSON.stringify(details);
      if (!unchanged) renderCommitDetails(this.detailsHost, details, handlers, null, degradedNote);
    } catch (err) {
      if (token !== this.detailsToken) return;
      this.detailsHost.replaceChildren(
        el("div", "details__empty", err instanceof Error ? err.message : String(err)));
    }
  }

  private async selectComparison(index: number): Promise<void> {
    if (this.selected === null || this.selected === index) return;
    this.compareWith = index;
    this.rows?.refresh();

    const from = this.state.commits[Math.max(this.selected, index)];
    const to = this.state.commits[Math.min(this.selected, index)];
    const token = ++this.detailsToken;
    const handlers = this.detailsHandlers(to.hash, { from: from.hash, to: to.hash });
    const comparison = { from: from.hash, to: to.hash };
    const empty: CommitDetails = {
      hash: to.hash, parents: [], authorName: "", authorEmail: "", authorDate: "",
      committerName: "", committerEmail: "", committerDate: "", body: "", files: [],
    };

    // Two fixed hashes — as immutable as a single commit.
    const key = `cmp:${from.hash}..${to.hash}`;
    const cached = this.detailsCache.get(key);
    if (cached !== undefined) {
      renderCommitDetails(this.detailsHost, cached, handlers, comparison);
      return;
    }
    renderCommitDetails(this.detailsHost, empty, handlers, comparison, "Loading changes…");

    try {
      const files = await repo.comparisonFiles(from.hash, to.hash);
      if (token !== this.detailsToken) return;
      const details = { ...empty, files };
      this.cacheDetails(key, details);
      renderCommitDetails(this.detailsHost, details, handlers, comparison);
    } catch (err) {
      if (token !== this.detailsToken) return;
      this.detailsHost.replaceChildren(
        el("div", "details__empty", err instanceof Error ? err.message : String(err)));
    }
  }

  /** Select a commit by hash — a parent link — and keep its row in view. */
  private jumpToCommit(hash: string): void {
    const index = this.state.commits.findIndex((c) => c.hash === hash);
    if (index === -1) {
      this.flashStatus(`${hash.slice(0, 8)} is not in the loaded range`);
      return;
    }
    void this.select(index);
    if (this.rows !== null) {
      const top = this.rows.topOf(index);
      const viewTop = this.scroller.scrollTop;
      const viewBottom = viewTop + this.scroller.clientHeight - DETAILS_HEIGHT;
      if (top < viewTop || top > viewBottom) {
        this.scroller.scrollTop = Math.max(0, top - 3 * ROW_HEIGHT);
      }
    }
  }

  private closeDetails(): void {
    this.detailsToken++;
    this.selected = null;
    this.compareWith = null;
    this.selectedHash = null;
    this.render();
    this.rows?.refresh();
  }

  private detailsHandlers(hash: string, comparison: { from: string; to: string } | null) {
    return {
      close: () => this.closeDetails(),
      openCommit: (target: string) => this.jumpToCommit(target),
      openDiff: (file: ChangedFile) => void this.openDiff(hash, file, comparison),
      resize: (fraction: number) => {
        this.splitFraction = fraction;
        this.detailsHost.style.setProperty("--cdv-split", `${(fraction * 100).toFixed(2)}%`);
      },
      resizeEnd: () => {
        void globalThis.muxy?.storage.set("details.split", this.splitFraction).catch(() => undefined);
      },
    };
  }

  private async openDiff(
    hash: string, file: ChangedFile, comparison: { from: string; to: string } | null,
  ): Promise<void> {
    const muxy = globalThis.muxy;
    if (!muxy) return;
    try {
      await muxy.tabs.open({
        // `kind` is required, and the id comes from the runtime rather than a
        // literal so it can never drift from manifest.name.
        kind: "extensionWebView",
        extension: {
          id: muxy.extensionID,
          tabType: "diff-viewer",
          singleton: true,
          data: comparison !== null
            ? { path: file.path, oldPath: file.oldPath, from: comparison.from, to: comparison.to }
            : { path: file.path, oldPath: file.oldPath, hash, shortHash: hash.slice(0, 8) },
        },
      });
    } catch (err) {
      this.statusLabel.textContent = "Could not open diff";
      this.statusLabel.title = err instanceof Error ? err.message : String(err);
    }
  }

  /* ------------------------------------------------------------ actions --- */

  private actionContext(): ActionContext {
    return {
      currentBranch: this.state.headBranch,
      headHash: this.state.head,
      remotes: this.remotes,
      perform: (label, operation) => this.perform(label, operation),
      refresh: () => this.reload(),
    };
  }

  private async perform(label: string, operation: () => Promise<unknown>): Promise<void> {
    this.statusLabel.textContent = `${label}…`;
    try {
      await operation();
      this.statusLabel.textContent = "";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.statusLabel.textContent = `${label} failed`;
      this.statusLabel.title = message;
      await confirmDialog(`${label} failed`, message, "Dismiss");
    }
    await this.reload();
  }

  /* --------------------------------------------------------- freshness --- */

  private subscribe(): void {
    const muxy = globalThis.muxy;
    if (muxy) {
      for (const event of ["project.switched", "worktree.switched", "worktree.headChanged"]) {
        try {
          muxy.events.subscribe(event, () => {
            // The new workspace may be remote where the old one was local, or the
            // reverse, so re-probe rather than trusting the cached answer.
            if (event !== "worktree.headChanged") repo.resetCapabilities();
            void this.reload();
          });
        } catch { /* event not granted */ }
      }
      try {
        let debounce: number | undefined;
        muxy.events.subscribe("file.changed", () => {
          window.clearTimeout(debounce);
          debounce = window.setTimeout(() => void this.pollNow(), 400);
        });
      } catch { /* event not granted */ }
    }

    // Poll only while the panel is visible — an unfocused panel costs nothing.
    document.addEventListener("visibilitychange", () => {
      // A panel that probed during app startup can hold a stale "no shell"
      // verdict: the workspace context syncs after the stores load, and no event
      // reaches a webview for that. Re-probe whenever a degraded panel comes back.
      if (document.visibilityState === "visible" && repo.isDegraded()) {
        repo.resetCapabilities();
        void this.reload();
      }
      this.updatePolling();
    });
    window.addEventListener("focus", () => this.updatePolling());
    window.addEventListener("blur", () => this.updatePolling());
    this.updatePolling();
  }

  private updatePolling(): void {
    window.clearInterval(this.pollTimer);
    if (document.visibilityState !== "visible") return;
    // On a remote workspace a reload costs seconds of round trips; a fixed 4s tick
    // would queue work faster than it completes. Back off to a multiple of the
    // observed cost so a slow host is polled proportionally less.
    const interval = Math.max(POLL_MS, this.lastReloadMs * 4);
    this.pollTimer = window.setInterval(() => void this.pollNow(), interval);
  }

  private probeRetryAt = 0;
  private probeRetryDelay = 8_000;

  private async pollNow(): Promise<void> {
    if (this.busy) return;

    // Degraded is often transient: Muxy's workspace context flips back to remote
    // when the SSH workspace is re-selected, and no event announces that to a
    // webview. Retry the transport with backoff so the panel recovers on its own
    // instead of sitting in read-only mode until someone presses refresh.
    if (repo.isDegraded()) {
      const now = Date.now();
      if (now >= this.probeRetryAt) {
        this.probeRetryAt = now + this.probeRetryDelay;
        this.probeRetryDelay = Math.min(this.probeRetryDelay * 2, 120_000);
        repo.resetCapabilities();
        await this.reload();
        if (!repo.isDegraded()) this.probeRetryDelay = 8_000;
        return;
      }
    }

    try {
      const digest = await repo.refDigest();
      if (digest !== this.digest) await this.reload();
    } catch { /* transient */ }
  }

  /* -------------------------------------------------------- keyboard --- */

  private onKeyDown(event: KeyboardEvent): void {
    const meta = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      closeContextMenu();
      if (this.selected !== null) this.closeDetails();
      return;
    }
    if (meta && event.key.toLowerCase() === "r") {
      event.preventDefault();
      repo.resetCapabilities();
      void this.reload();
      return;
    }
    if (meta && event.key.toLowerCase() === "h") {
      event.preventDefault();
      this.scrollToHead();
      return;
    }
    if (this.selected !== null && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const next = this.selected + (event.key === "ArrowDown" ? 1 : -1);
      if (next >= 0 && next < this.state.commits.length) void this.select(next);
    }
  }

  private scrollToHead(): void {
    const index = this.state.commits.findIndex((c) => c.hash === this.state.head);
    if (index === -1 || this.rows === null) return;
    this.scroller.scrollTop = Math.max(0, this.rows.topOf(index) - this.scroller.clientHeight / 2);
  }
}

/** Everything the log entry already knows, shown while the file list loads.
 *  Committer mirrors author so the pane does not render a blank committer row. */
function skeletonDetails(commit: Commit): CommitDetails {
  return {
    hash: commit.hash,
    parents: commit.parents,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    authorDate: commit.authorDate,
    committerName: commit.authorName,
    committerEmail: commit.authorEmail,
    committerDate: commit.authorDate,
    body: commit.subject,
    files: [],
  };
}

function iconButton(title: string, glyph: string, run: () => void): HTMLElement {
  const button = el("button", "iconbutton", glyph);
  button.title = title;
  button.addEventListener("click", run);
  return button;
}

function textButton(label: string, run: () => void): HTMLElement {
  const button = el("button", "", label);
  button.addEventListener("click", run);
  return button;
}
