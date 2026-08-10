import { UNCOMMITTED } from "../data/repo.ts";
import type { ChangedFile, CommitDetails } from "../data/repo.ts";
import { absoluteTime, copyToClipboard, el, openExternal } from "./dom.ts";
import { md5Hex } from "./md5.ts";
import { openContextMenu } from "./context-menu.ts";
import {
  fileViewIcon, fileViewMode, renderFileView, setFileViewMode,
} from "./file-tree.ts";
import type { FileViewMode } from "./file-tree.ts";

export interface DetailsHandlers {
  openDiff(file: ChangedFile): void;
  /** Jump the details view to another commit, e.g. a parent. */
  openCommit(hash: string): void;
  close(): void;
  /** Fired while the split divider is dragged, with a 0–1 fraction. */
  resize(fraction: number): void;
  resizeEnd(): void;
  /** The user switched the changed files between tree and list. */
  fileViewChanged(mode: FileViewMode): void;
}

export interface ParsedMessage {
  readonly subject: string;
  readonly body: string;
  readonly coAuthors: readonly string[];
  readonly claudeSessions: readonly string[];
}

/**
 * Splits a raw commit message (`%B`) into subject, body and Co-authored-by
 * trailers. The trailers are surfaced as structured fields, so they are removed
 * from the rendered body rather than shown twice.
 */
export function splitMessage(raw: string): ParsedMessage {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text === "") return { subject: "", body: "", coAuthors: [], claudeSessions: [] };

  const newline = text.indexOf("\n");
  const subject = (newline === -1 ? text : text.slice(0, newline)).trim();
  const rest = newline === -1 ? "" : text.slice(newline + 1);

  const coAuthors: string[] = [];
  const claudeSessions: string[] = [];
  const kept: string[] = [];
  for (const line of rest.split("\n")) {
    const coAuthor = /^\s*co-authored-by:\s*(.+)$/i.exec(line);
    if (coAuthor) {
      coAuthors.push(coAuthor[1].trim());
      continue;
    }
    const session = /^\s*claude-session:\s*(.+)$/i.exec(line);
    if (session) {
      claudeSessions.push(session[1].trim());
      continue;
    }
    kept.push(line);
  }
  return { subject, body: kept.join("\n").trim(), coAuthors, claudeSessions };
}

/**
 * Two panes side by side when there is room — summary on the left, changed files on
 * the right, with a draggable divider — collapsing to a single stacked column when
 * the panel is narrow. Mirrors git-graph's cdvSummary / cdvFiles / cdvDivider.
 */
export function renderCommitDetails(
  host: HTMLElement,
  details: CommitDetails,
  handlers: DetailsHandlers,
  comparison: { from: string; to: string } | null,
  /** Shown instead of "No file changes" when files are unavailable, not absent. */
  filesNote?: string,
): void {
  host.replaceChildren();
  const message = splitMessage(details.body);

  const header = el("div", "details__header");
  const title = el("div", "details__title");
  if (comparison !== null) {
    title.textContent = `Comparing ${comparison.from.slice(0, 8)} … ${comparison.to.slice(0, 8)}`;
  } else if (details.hash === UNCOMMITTED) {
    title.textContent = "Uncommitted Changes";
  } else {
    // The subject is the headline; the hash moves down into the metadata.
    title.textContent = message.subject !== "" ? message.subject : details.hash.slice(0, 8);
    title.title = message.subject;
  }
  const close = el("button", "details__close", "✕");
  close.title = "Close (Esc)";
  close.addEventListener("click", handlers.close);
  header.append(title, close);
  host.appendChild(header);

  const summary = el("div", "details__summary");
  if (comparison !== null) {
    summary.appendChild(el("p", "details__note",
      `All changes between ${comparison.from.slice(0, 8)} and ${comparison.to.slice(0, 8)}.`));
  } else if (details.hash === UNCOMMITTED) {
    summary.appendChild(el("p", "details__note", "Changes in the working tree and index."));
  } else {
    const meta = el("dl", "details__meta");

    // Author leads, avatar in the label column, name over date in the value.
    const avatarCell = el("dt", "details__avatarcell");
    avatarCell.appendChild(avatar(details.authorName, details.authorEmail));
    const authorCell = el("dd", "details__author");
    authorCell.append(
      el("div", "details__authorname", identity(details.authorName, details.authorEmail)),
      el("div", "details__authordate", absoluteTime(details.authorDate)),
    );
    meta.append(avatarCell, authorCell);

    addMeta(meta, "Commit", hashValue(details.hash));
    if (details.committerName !== "" || details.committerEmail !== "") {
      addMeta(meta, "Committer", identity(details.committerName, details.committerEmail));
      // A committed date only differs after rebase/cherry-pick/amend — the
      // interesting case, so it is only shown then.
      if (details.committerDate !== "" && details.committerDate !== details.authorDate) {
        addMeta(meta, "Committed", absoluteTime(details.committerDate));
      }
    }
    for (const coAuthor of message.coAuthors) {
      addMeta(meta, "Co-author", coAuthor);
    }
    for (const session of message.claudeSessions) {
      addMeta(meta, "Session", sessionValue(session));
    }
    if (details.parents.length > 0) {
      const parents = el("span", "details__parents");
      details.parents.forEach((parent, index) => {
        if (index > 0) parents.appendChild(document.createTextNode("  "));
        const link = el("a", "details__link details__parent", parent.slice(0, 8));
        link.title = parent;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          handlers.openCommit(parent);
        });
        parents.appendChild(link);
      });
      addMeta(meta, "Parents", parents);
    }
    summary.appendChild(meta);

    if (message.body !== "") {
      summary.appendChild(el("pre", "details__body", message.body));
    }
  }

  const filesPane = el("div", "details__files");
  const fileList = el("div", "details__filelist");
  // Collapsed folders are remembered per commit, and a comparison is its own
  // pair of endpoints rather than either commit.
  const fileKey = comparison !== null
    ? `${comparison.from}..${comparison.to}`
    : details.hash;

  const drawFiles = (): void => {
    fileList.replaceChildren();
    if (details.files.length === 0) {
      fileList.appendChild(el("div", "details__empty", filesNote ?? "No file changes."));
      return;
    }
    renderFileView(fileList, details.files, handlers, fileKey);
  };

  if (filesNote === undefined || details.files.length > 0) {
    // Mirrors the file-row grid: count in the status-badge column, label in the
    // filename column.
    const count = el("div", "details__filecount");
    count.append(
      el("span", "details__filecount-num", String(details.files.length)),
      el("span", "details__filecount-label",
        `file${details.files.length === 1 ? "" : "s"} changed`),
    );
    count.appendChild(fileViewToggle(handlers, drawFiles));
    filesPane.appendChild(count);
  }
  drawFiles();
  filesPane.appendChild(fileList);

  const divider = el("div", "details__divider");
  divider.title = "Drag to resize";
  attachDivider(divider, handlers);

  const panes = el("div", "details__panes");
  panes.append(summary, divider, filesPane);
  host.appendChild(panes);
}

function attachDivider(divider: HTMLElement, handlers: DetailsHandlers): void {
  divider.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const panes = divider.parentElement;
    if (panes === null) return;

    const move = (moveEvent: MouseEvent): void => {
      const rect = panes.getBoundingClientRect();
      if (rect.width === 0) return;
      const fraction = (moveEvent.clientX - rect.left) / rect.width;
      handlers.resize(Math.min(0.8, Math.max(0.2, fraction)));
    };
    const up = (): void => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      handlers.resizeEnd();
    };

    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

/**
 * Tree and list, as two buttons rather than one that flips: which shape the
 * pane is in is then readable without clicking, the way git-graph's pair is.
 */
function fileViewToggle(handlers: DetailsHandlers, redraw: () => void): HTMLElement {
  const group = el("span", "fileview");
  const buttons = new Map<FileViewMode, HTMLElement>();

  const choose = (mode: FileViewMode): void => {
    if (fileViewMode() === mode) return;
    setFileViewMode(mode);
    for (const [each, button] of buttons) {
      button.classList.toggle("fileview__btn--on", each === mode);
    }
    redraw();
    handlers.fileViewChanged(mode);
  };

  for (const [mode, title] of [
    ["tree", "File Tree View"], ["list", "File List View"],
  ] as const) {
    const button = el("button", "fileview__btn");
    button.title = title;
    button.classList.toggle("fileview__btn--on", fileViewMode() === mode);
    button.appendChild(fileViewIcon(mode));
    button.addEventListener("click", () => choose(mode));
    buttons.set(mode, button);
    group.appendChild(button);
  }
  return group;
}

/** A Claude-Session URL renders as a named link; the URL itself lives in the
 *  tooltip and behind right-click → copy. */
function sessionValue(session: string): string | HTMLElement {
  if (!/^https?:\/\//i.test(session)) return session;
  const link = el("a", "details__link", "Claude Session");
  link.href = session;
  link.title = session;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openExternal(session);
  });
  link.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openContextMenu(event.clientX, event.clientY, [
      { label: "Open", run: () => openExternal(session) },
      { label: "Copy URL to Clipboard", run: () => copyToClipboard(session) },
    ]);
  });
  return link;
}

/**
 * One avatar element per email, reused across renders. The details pane renders
 * twice per click (skeleton, then full data); a fresh element each time would
 * re-run the initials-then-image swap and blink even with the image cached.
 * Moving the same node into the new tree keeps whatever it already shows.
 */
const avatarElements = new Map<string, HTMLElement>();

/**
 * Where a real avatar image might live for this email, in order of preference:
 * GitHub noreply addresses carry the user id or login outright; GitHub also
 * resolves plain commit emails via its by-email endpoint; Gravatar (keyed by
 * MD5) is the long tail. `d=404` makes an unset Gravatar fail over cleanly.
 */
function avatarCandidates(email: string): string[] {
  const cleaned = email.trim().toLowerCase();
  if (cleaned === "") return [];
  const noreply = /^(?:(\d+)\+)?([a-z0-9-]+)@users\.noreply\.github\.com$/.exec(cleaned);
  if (noreply) {
    return [noreply[1] !== undefined
      ? `https://avatars.githubusercontent.com/u/${noreply[1]}?s=64`
      : `https://github.com/${noreply[2]}.png?size=64`];
  }
  return [
    `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(cleaned)}&s=64`,
    `https://gravatar.com/avatar/${md5Hex(cleaned)}?s=64&d=404`,
  ];
}

/**
 * Initials render immediately; a real avatar replaces them if any source loads.
 * Each email resolves exactly once for the session.
 */
function avatar(name: string, email: string): HTMLElement {
  const existing = avatarElements.get(email);
  if (existing !== undefined) return existing;

  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = words.length === 0
    ? "?"
    : words.length === 1
      ? words[0].slice(0, 2).toUpperCase()
      : (words[0][0] + words[words.length - 1][0]).toUpperCase();
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const badge = el("span", "details__avatar", initials);
  badge.style.background = `var(--lane-${hash % 6})`;
  badge.title = name;
  avatarElements.set(email, badge);

  const candidates = avatarCandidates(email);
  const tryLoad = (index: number): void => {
    if (index >= candidates.length) return;
    const img = new Image();
    img.onload = () => {
      img.className = "details__avatarimg";
      img.alt = name;
      badge.textContent = "";
      badge.style.background = "transparent";
      badge.appendChild(img);
    };
    img.onerror = () => tryLoad(index + 1);
    img.src = candidates[index];
  };
  tryLoad(0);
  return badge;
}

/** Short hash in mono, with a copy button for the full hash. */
function hashValue(hash: string): HTMLElement {
  const wrap = el("span", "details__hash");
  const text = el("span", "details__hashtext", hash.slice(0, 8));
  text.title = hash;
  const copy = el("button", "details__copy", "⧉");
  copy.title = "Copy full hash";
  copy.addEventListener("click", () => {
    void copyToClipboard(hash);
    copy.textContent = "✓";
    setTimeout(() => { copy.textContent = "⧉"; }, 1200);
  });
  wrap.append(text, copy);
  return wrap;
}

function identity(name: string, email: string): string {
  if (name !== "" && email !== "") return `${name} <${email}>`;
  return name !== "" ? name : email;
}

function addMeta(list: HTMLElement, label: string, value: string | HTMLElement): void {
  list.appendChild(el("dt", undefined, label));
  const dd = el("dd");
  if (typeof value === "string") dd.textContent = value;
  else dd.appendChild(value);
  list.appendChild(dd);
}
