import { UNCOMMITTED } from "../data/repo.ts";
import type { ChangedFile, CommitDetails, FileStatus } from "../data/repo.ts";
import { absoluteTime, copyToClipboard, el, openExternal } from "./dom.ts";
import { openContextMenu } from "./context-menu.ts";

export interface DetailsHandlers {
  openDiff(file: ChangedFile): void;
  close(): void;
  /** Fired while the split divider is dragged, with a 0–1 fraction. */
  resize(fraction: number): void;
  resizeEnd(): void;
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

const STATUS_LABEL: Record<FileStatus, string> = {
  A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", U: "Conflicted", "?": "Untracked",
};

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

  const header = el("div", "details__header");
  const title = el("div", "details__title");
  if (comparison !== null) {
    title.textContent = `Comparing ${comparison.from.slice(0, 8)} … ${comparison.to.slice(0, 8)}`;
  } else if (details.hash === UNCOMMITTED) {
    title.textContent = "Uncommitted Changes";
  } else {
    title.textContent = details.hash.slice(0, 8);
    title.title = details.hash;
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
    const message = splitMessage(details.body);
    if (message.subject !== "") {
      summary.appendChild(el("div", "details__subject", message.subject));
    }

    const meta = el("dl", "details__meta");
    addMeta(meta, "Author", identity(details.authorName, details.authorEmail));
    addMeta(meta, "Date", absoluteTime(details.authorDate));
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
      addMeta(meta, "Parents", details.parents.map((p) => p.slice(0, 8)).join(", "));
    }
    summary.appendChild(meta);

    if (message.body !== "") {
      summary.appendChild(el("pre", "details__body", message.body));
    }
  }

  const filesPane = el("div", "details__files");
  if (filesNote === undefined || details.files.length > 0) {
    filesPane.appendChild(el("div", "details__filecount",
      `${details.files.length} file${details.files.length === 1 ? "" : "s"} changed`));
  }
  if (details.files.length === 0) {
    filesPane.appendChild(el("div", "details__empty", filesNote ?? "No file changes."));
  }
  for (const file of details.files) filesPane.appendChild(fileRow(file, handlers));

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

function fileRow(file: ChangedFile, handlers: DetailsHandlers): HTMLElement {
  const row = el("button", "file");
  row.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;

  const badge = el("span", `file__status file__status--${file.status}`, file.status);
  badge.title = STATUS_LABEL[file.status] ?? file.status;

  const segments = file.path.split("/");
  const name = segments.pop() ?? file.path;
  const dir = segments.join("/");

  row.append(badge, el("span", "file__name", name));
  if (dir !== "") row.appendChild(el("span", "file__dir", dir));

  row.addEventListener("click", () => handlers.openDiff(file));
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openContextMenu(event.clientX, event.clientY, [
      { label: "View Diff", run: () => handlers.openDiff(file) },
      { label: "Copy File Path to Clipboard", run: () => copyToClipboard(file.path) },
    ]);
  });
  return row;
}

/** A Claude-Session URL renders as a short clickable link, not the full URL. */
function sessionValue(session: string): string | HTMLElement {
  if (!/^https?:\/\//i.test(session)) return session;
  const segment = session.replace(/\/+$/, "").split("/").pop() ?? session;
  const short = segment.length > 18 ? `${segment.slice(0, 8)}…${segment.slice(-4)}` : segment;
  const link = el("a", "details__link", short);
  link.href = session;
  link.title = session;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openExternal(session);
  });
  return link;
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
