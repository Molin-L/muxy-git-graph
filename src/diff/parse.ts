export type RowKind = "hunk" | "context" | "addition" | "deletion" | "meta";

export interface DiffRow {
  readonly kind: RowKind;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
}

export interface DiffFile {
  readonly path: string;
  readonly oldPath: string | null;
  readonly isBinary: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly rows: readonly DiffRow[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses `git diff` / `git show` unified output into per-file row lists. */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let path: string | null = null;
  let oldPath: string | null = null;
  let isBinary = false;
  let rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  let oldLine = 0;
  let newLine = 0;

  const flush = (): void => {
    if (path === null) return;
    files.push({ path, oldPath, isBinary, additions, deletions, rows });
    path = null;
    oldPath = null;
    isBinary = false;
    rows = [];
    additions = 0;
    deletions = 0;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (match) {
        oldPath = match[1] === match[2] ? null : match[1];
        path = match[2];
      } else {
        path = line.slice("diff --git ".length);
      }
      continue;
    }
    if (path === null) continue;

    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      isBinary = true;
      continue;
    }
    if (
      line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") ||
      line.startsWith("new file mode") || line.startsWith("deleted file mode") ||
      line.startsWith("old mode") || line.startsWith("new mode") ||
      line.startsWith("similarity index") || line.startsWith("rename from") ||
      line.startsWith("rename to") || line.startsWith("copy from") || line.startsWith("copy to")
    ) {
      continue;
    }

    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      rows.push({ kind: "hunk", oldLine: null, newLine: null, text: line });
      continue;
    }

    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: line.slice(1).trim() });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "addition", oldLine: null, newLine, text: line.slice(1) });
      newLine++;
      additions++;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "deletion", oldLine, newLine: null, text: line.slice(1) });
      oldLine++;
      deletions++;
      continue;
    }
    if (line.startsWith(" ")) {
      rows.push({ kind: "context", oldLine, newLine, text: line.slice(1) });
      oldLine++;
      newLine++;
    }
  }

  flush();
  return files;
}

export interface SplitRow {
  readonly left: DiffRow | null;
  readonly right: DiffRow | null;
}

/** Pairs deletions against additions so they sit side by side. */
export function toSplitRows(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (row.kind === "deletion") {
      const deletions: DiffRow[] = [];
      while (index < rows.length && rows[index].kind === "deletion") deletions.push(rows[index++]);
      const additions: DiffRow[] = [];
      while (index < rows.length && rows[index].kind === "addition") additions.push(rows[index++]);
      for (let i = 0; i < Math.max(deletions.length, additions.length); i++) {
        out.push({ left: deletions[i] ?? null, right: additions[i] ?? null });
      }
      continue;
    }
    if (row.kind === "addition") {
      out.push({ left: null, right: row });
    } else {
      out.push({ left: row, right: row });
    }
    index++;
  }
  return out;
}
