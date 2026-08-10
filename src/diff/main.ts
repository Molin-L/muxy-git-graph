import "../styles/global.css";
import "./diff.css";
import * as log from "../log.ts";
import { comparisonDiff, fileDiff } from "../data/repo.ts";
import { parseUnifiedDiff, toSplitRows } from "./parse.ts";
import type { DiffFile, DiffRow } from "./parse.ts";
import { el } from "../view/dom.ts";

interface DiffTabData {
  readonly path?: string;
  readonly oldPath?: string;
  readonly hash?: string;
  readonly shortHash?: string;
  readonly from?: string;
  readonly to?: string;
}

type Style = "unified" | "split";

log.useSurface("diff");

const root = document.getElementById("root");
if (root) void start(root);

async function start(host: HTMLElement): Promise<void> {
  // The tab shares the panel's toggle: it is one extension, logging to one place.
  await log.restoreVerbose();
  let style: Style = (await readStyle()) ?? "unified";
  let data = (globalThis.muxy?.data ?? {}) as DiffTabData;
  let files: DiffFile[] = [];

  const title = el("span", "topbar__title");
  const source = el("span", "topbar__repo");
  const toggle = el("button", "");
  const topbar = el("div", "topbar");
  topbar.append(title, source, el("span", "topbar__spacer"), toggle);

  const body = el("div", "diff");
  host.append(topbar, body);

  const draw = (): void => {
    toggle.textContent = style === "split" ? "Unified" : "Split";
    body.replaceChildren();
    if (files.length === 0 || files.every((f) => f.rows.length === 0)) {
      body.appendChild(el("div", "diff__empty", "No changes to show for this file."));
      return;
    }
    for (const file of files) body.appendChild(renderFile(file, style));
  };

  const load = async (next: DiffTabData): Promise<void> => {
    data = next;
    title.textContent = data.path ?? "Diff";
    title.title = data.path ?? "";
    source.textContent = data.from && data.to
      ? `${data.from.slice(0, 8)} … ${data.to.slice(0, 8)}`
      : data.shortHash ?? data.hash?.slice(0, 8) ?? "working tree";

    if (!data.path) {
      files = [];
      body.replaceChildren(el("div", "diff__empty", "No file was passed to this tab."));
      return;
    }

    body.replaceChildren(el("div", "diff__empty", "Loading…"));
    const started = Date.now();
    log.info("diff opening", {
      path: data.path,
      at: data.from && data.to ? `${data.from}..${data.to}` : data.hash,
    });
    try {
      const patch = data.from && data.to
        ? await comparisonDiff(data.from, data.to, data.path, data.oldPath)
        : await fileDiff(data.hash ?? "*", data.path, data.oldPath);
      files = parseUnifiedDiff(patch);
      log.info("diff loaded", { path: data.path, bytes: patch.length, ms: Date.now() - started });
      draw();
    } catch (err) {
      log.error("diff failed", { path: data.path, error: log.reason(err) });
      files = [];
      body.replaceChildren(
        el("div", "diff__empty", err instanceof Error ? err.message : String(err)));
    }
  };

  toggle.addEventListener("click", () => {
    style = style === "split" ? "unified" : "split";
    void globalThis.muxy?.storage.set("diff.style", style);
    draw();
  });

  // The tab is a singleton, so clicking another file reuses this page and pushes
  // the new payload in rather than creating a second tab.
  globalThis.muxy?.onDataChange((next) => void load((next ?? {}) as DiffTabData));

  await load(data);
}

async function readStyle(): Promise<Style | null> {
  try {
    const value = await globalThis.muxy?.storage.get("diff.style");
    return value === "split" || value === "unified" ? value : null;
  } catch {
    return null;
  }
}

function renderFile(file: DiffFile, style: Style): HTMLElement {
  const wrapper = el("div", "diff__file");
  const header = el("div", "diff__fileheader");
  header.append(
    el("span", "diff__filepath", file.oldPath ? `${file.oldPath} → ${file.path}` : file.path),
    el("span", "diff__stat diff__stat--add", `+${file.additions}`),
    el("span", "diff__stat diff__stat--del", `−${file.deletions}`),
  );
  wrapper.appendChild(header);

  if (file.isBinary) {
    wrapper.appendChild(el("div", "diff__empty", "Binary file not shown."));
    return wrapper;
  }

  const table = el("div", `diff__table diff__table--${style}`);
  if (style === "unified") {
    for (const row of file.rows) table.appendChild(unifiedRow(row));
  } else {
    for (const pair of toSplitRows(file.rows)) {
      if (pair.left?.kind === "hunk") {
        table.appendChild(unifiedRow(pair.left));
        continue;
      }
      const line = el("div", "diff__row");
      line.append(side(pair.left, "old"), side(pair.right, "new"));
      table.appendChild(line);
    }
  }
  wrapper.appendChild(table);
  return wrapper;
}

function unifiedRow(row: DiffRow): HTMLElement {
  const line = el("div", `diff__row diff__row--${row.kind}`);
  line.append(
    el("span", "diff__num", row.oldLine === null ? "" : String(row.oldLine)),
    el("span", "diff__num", row.newLine === null ? "" : String(row.newLine)),
    el("span", "diff__sign", sign(row.kind)),
    el("span", "diff__text", row.text),
  );
  return line;
}

function side(row: DiffRow | null, which: "old" | "new"): HTMLElement {
  const kind = row === null ? "empty" : row.kind;
  const cell = el("div", `diff__side diff__row--${kind}`);
  cell.append(
    el("span", "diff__num",
      row === null ? "" : String((which === "old" ? row.oldLine : row.newLine) ?? "")),
    el("span", "diff__text", row?.text ?? ""),
  );
  return cell;
}

function sign(kind: DiffRow["kind"]): string {
  if (kind === "addition") return "+";
  if (kind === "deletion") return "−";
  return " ";
}
