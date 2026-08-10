import type { ChangedFile, FileStatus } from "../data/repo.ts";
import { copyToClipboard, el } from "./dom.ts";
import { openContextMenu } from "./context-menu.ts";

/** Which shape the changed files are drawn in. */
export type FileViewMode = "tree" | "list";

export interface TreeFile {
  readonly kind: "file";
  /** The path's last segment — what the row is labelled with. */
  readonly name: string;
  readonly file: ChangedFile;
}

export interface TreeFolder {
  readonly kind: "folder";
  /** Display name. A chain of single-child folders reads as "src / view". */
  readonly name: string;
  /** Path from the repository root — the identity used to remember a collapse. */
  readonly path: string;
  readonly children: readonly TreeNode[];
}

export type TreeNode = TreeFolder | TreeFile;

export interface FileViewHandlers {
  openDiff(file: ChangedFile): void;
}

interface Draft {
  readonly name: string;
  readonly path: string;
  readonly folders: Map<string, Draft>;
  readonly files: TreeFile[];
}

/**
 * Groups changed files by directory. The returned root is a folder with an empty
 * name and path: it is the container the rows are drawn from, never a row itself.
 */
export function buildFileTree(files: readonly ChangedFile[]): TreeFolder {
  const root: Draft = { name: "", path: "", folders: new Map(), files: [] };

  for (const file of files) {
    const segments = file.path.split("/").filter((segment) => segment !== "");
    const name = segments.pop();
    if (name === undefined) continue;

    let folder = root;
    for (const segment of segments) {
      let next = folder.folders.get(segment);
      if (next === undefined) {
        next = {
          name: segment,
          path: folder.path === "" ? segment : `${folder.path}/${segment}`,
          folders: new Map(),
          files: [],
        };
        folder.folders.set(segment, next);
      }
      folder = next;
    }
    folder.files.push({ kind: "file", name, file });
  }

  return { kind: "folder", name: "", path: "", children: childrenOf(root) };
}

/** Folders before files, each alphabetical — the order every file explorer uses. */
function childrenOf(draft: Draft): TreeNode[] {
  const folders = [...draft.folders.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((child) => compact({
      kind: "folder", name: child.name, path: child.path, children: childrenOf(child),
    }));
  const files = [...draft.files].sort((a, b) => a.name.localeCompare(b.name));
  return [...folders, ...files];
}

/**
 * A folder holding nothing but one folder is drawn as a single row, so a change
 * buried deep in the tree does not cost one row — and one indent — per segment.
 * Children are compacted before their parent, which folds a whole chain in one
 * pass.
 */
function compact(folder: TreeFolder): TreeFolder {
  const only = folder.children[0];
  if (folder.children.length !== 1 || only === undefined || only.kind !== "folder") {
    return folder;
  }
  return {
    kind: "folder",
    name: `${folder.name} / ${only.name}`,
    path: only.path,
    children: only.children,
  };
}

/* ------------------------------------------------------------- view state --- */

/**
 * The files pane is re-rendered whenever its commit's details arrive, and again
 * on every toggle, so what the user has chosen has to outlive a render. The mode
 * is global to the pane; collapsed folders belong to one commit, and are dropped
 * on the move to another — the same path there is a different set of changes.
 */
let mode: FileViewMode = "tree";
let collapsedKey = "";
let collapsed = new Set<string>();

export function fileViewMode(): FileViewMode {
  return mode;
}

export function setFileViewMode(next: FileViewMode): void {
  mode = next;
}

/* ---------------------------------------------------------------- render --- */

const STATUS_LABEL: Record<FileStatus, string> = {
  A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", U: "Conflicted", "?": "Untracked",
};

/**
 * Fills `host` with the changed files, as a flat list or as a folder tree.
 * `key` identifies the commit (or comparison) the files belong to, and scopes
 * which folders are remembered as collapsed.
 */
export function renderFileView(
  host: HTMLElement,
  files: readonly ChangedFile[],
  handlers: FileViewHandlers,
  key: string,
): void {
  if (key !== collapsedKey) {
    collapsedKey = key;
    collapsed = new Set();
  }

  if (mode === "list") {
    // Git's own ordering, which is already sorted by path — the flat list is a
    // reading order, not a hierarchy, so folders are not hoisted above files.
    for (const file of files) host.appendChild(fileRow(file, handlers, true));
    return;
  }

  host.appendChild(folderContents(buildFileTree(files).children, handlers, true));
}

function folderContents(
  nodes: readonly TreeNode[], handlers: FileViewHandlers, root: boolean,
): HTMLElement {
  const list = el("ul", root ? "tree" : "tree__children");
  for (const node of nodes) {
    const item = el("li");
    if (node.kind === "file") {
      item.appendChild(fileRow(node.file, handlers, false));
    } else {
      const children = folderContents(node.children, handlers, false);
      item.append(folderRow(node, children), children);
    }
    list.appendChild(item);
  }
  return list;
}

function folderRow(folder: TreeFolder, children: HTMLElement): HTMLElement {
  const row = el("button", "file file--folder");
  row.title = folder.path;

  const twisty = el("span", "file__twisty");
  twisty.appendChild(chevron());
  const name = el("span", "file__name", folder.name);
  row.append(twisty, name);

  const apply = (isCollapsed: boolean): void => {
    twisty.classList.toggle("file__twisty--closed", isCollapsed);
    children.classList.toggle("tree__children--hidden", isCollapsed);
    row.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  };
  apply(collapsed.has(folder.path));

  row.addEventListener("click", () => {
    const isCollapsed = !collapsed.has(folder.path);
    if (isCollapsed) collapsed.add(folder.path);
    else collapsed.delete(folder.path);
    apply(isCollapsed);
  });
  return row;
}

/**
 * One changed file. The directory only rides along in the flat list, where
 * nothing else says where the file lives; in the tree its folder is the row above.
 */
function fileRow(file: ChangedFile, handlers: FileViewHandlers, showDir: boolean): HTMLElement {
  const row = el("button", "file");
  row.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;

  const badge = el("span", `file__status file__status--${file.status}`, file.status);
  badge.title = STATUS_LABEL[file.status] ?? file.status;

  const segments = file.path.split("/");
  const name = segments.pop() ?? file.path;
  const dir = segments.join("/");

  const text = el("span", "file__text");
  text.appendChild(el("span", "file__name", name));
  if (showDir && dir !== "") text.appendChild(el("span", "file__dir", dir));
  row.append(badge, text);
  if (file.additions !== undefined || file.deletions !== undefined) {
    const stats = el("span", "file__stats");
    stats.append(
      el("span", "file__add", `+${file.additions ?? 0}`),
      el("span", "file__del", `−${file.deletions ?? 0}`),
    );
    row.appendChild(stats);
  }

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

/* ----------------------------------------------------------------- icons --- */

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The folder's disclosure marker, pointing down. Collapsed, it is turned a
 * quarter turn by CSS — one glyph for both states, so the two can never drift.
 */
function chevron(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("class", "file__chevron");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M2 4l3 3 3-3z");
  svg.appendChild(path);
  return svg;
}

/**
 * Four rows of marker-plus-bar. Indenting the markers is the whole difference
 * between the two icons: flush left reads as a list, staggered as a tree.
 */
function viewIcon(indents: readonly number[], barWidth: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("class", "fileview__icon");
  indents.forEach((indent, row) => {
    const y = 3 + row * 4;
    svg.append(bar(indent, y, 2), bar(indent + 3.5, y, barWidth));
  });
  return svg;
}

function bar(x: number, y: number, width: number): SVGRectElement {
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("x", String(x));
  rect.setAttribute("y", String(y));
  rect.setAttribute("width", String(width));
  rect.setAttribute("height", "1.5");
  return rect;
}

export function fileViewIcon(forMode: FileViewMode): SVGSVGElement {
  return forMode === "list"
    ? viewIcon([2, 2, 2, 2], 12.5)
    : viewIcon([2, 4, 6, 4], 8.5);
}
