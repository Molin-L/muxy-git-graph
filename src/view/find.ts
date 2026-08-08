import { UNCOMMITTED } from "../graph/types.ts";
import type { Commit } from "../data/repo.ts";

export interface FindOptions {
  readonly caseSensitive: boolean;
  readonly regex: boolean;
}

/** A compiled query, or the reason it could not be compiled. */
export type Pattern =
  | { readonly ok: true; readonly test: RegExp; readonly all: RegExp }
  | { readonly ok: false; readonly error: string };

/** One run of text, flagged as a hit or as the plain text between hits. */
export interface Segment {
  readonly text: string;
  readonly hit: boolean;
}

const ESCAPE = /[\\[\](){}|.*+?^$]/g;

/**
 * Compiles the user's query. A literal query is escaped so that a subject
 * containing `(` is searchable without turning on regex mode.
 *
 * Zero-length matches are rejected here rather than discovered mid-render: a
 * pattern like `.*` matches every commit while highlighting nothing, so the
 * result would be "300 results" over an unchanged view. The probe catches the
 * cases people actually type by accident — `*`, `?`, `|`, `.*`. A pattern that
 * only matches empty at some *interior* position (`\b`) slips through, and
 * `segment` skips those matches instead.
 */
export function compile(query: string, options: FindOptions): Pattern | null {
  if (query === "") return null;
  const source = options.regex ? query : query.replace(ESCAPE, "\\$&");
  const flags = `u${options.caseSensitive ? "" : "i"}`;
  let test: RegExp;
  try {
    test = new RegExp(source, flags);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (test.test("")) {
    return { ok: false, error: "That pattern matches empty text, so it matches everything." };
  }
  return { ok: true, test, all: new RegExp(source, `g${flags}`) };
}

/**
 * The commit indices matching the pattern, newest first — the order they appear
 * in the Commit Feed.
 *
 * Matching runs over the commit data, never the DOM. Rows are virtualised
 * (ADR-0007), so at most a few dozen of them exist at any moment; the feed is
 * the only complete copy of the history (ADR-0018).
 */
export function search(commits: readonly Commit[], pattern: RegExp): number[] {
  const found: number[] = [];
  for (let index = 0; index < commits.length; index++) {
    if (matches(commits[index], pattern)) found.push(index);
  }
  return found;
}

/**
 * Everything shown on the row, plus the two fields whose displayed form is
 * lossy: the row shows an abbreviated hash and a relative date, so the full
 * hash and the ISO date are searched too. Those two match without highlighting,
 * because the text they matched is not the text on screen.
 *
 * Unlike git-graph, a hidden column is still searched. Its columns drop only in
 * a narrow editor pane; ours drop at widths a right panel sits at every day
 * (author below 480px), and a search for a name that silently returns nothing
 * is worse than a match the user has to open the commit to see.
 */
function matches(commit: Commit, pattern: RegExp): boolean {
  if (commit.hash === UNCOMMITTED) return false;
  return pattern.test(commit.subject)
    || pattern.test(commit.authorName)
    || pattern.test(commit.hash)
    || pattern.test(commit.authorDate)
    || commit.refs.some((ref) => pattern.test(ref.name))
    || (commit.stashRef !== undefined && pattern.test(commit.stashRef));
}

/**
 * Splits text into alternating plain and matched runs, for highlighting. Returns
 * a single plain segment when nothing matches, so callers can fall back to
 * `textContent` and skip building nodes for the common case.
 */
export function segment(text: string, pattern: RegExp): Segment[] {
  pattern.lastIndex = 0;
  const segments: Segment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // An interior zero-length match cannot be highlighted, and leaving lastIndex
    // alone would spin forever.
    if (match[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index), hit: false });
    }
    segments.push({ text: match[0], hit: true });
    cursor = match.index + match[0].length;
  }

  if (segments.length === 0) return [{ text, hit: false }];
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}
