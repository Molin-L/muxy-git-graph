/**
 * The state machine behind ⌘/Ctrl-click, kept out of the panel so the gesture can
 * be tested without a DOM.
 *
 * A comparison needs two commits, so the first ⌘-click on a cold panel only marks
 * an end: expanding the details of one end says nothing about a range, and the
 * pane opening and then re-opening somewhere else reads as a misfire. The second
 * ⌘-click supplies the other end, and the pane opens under it. When a commit is
 * already expanded that row is an end already, so one ⌘-click is enough — the
 * gesture the panel has always had.
 */

export interface CompareSelection {
  /** The row the details pane expands under, or null when nothing is expanded. */
  readonly selected: number | null;
  /** The other end of a comparison: marked, never expanded. */
  readonly compareWith: number | null;
}

export type CompareStep =
  | (CompareSelection & { readonly load: false })
  | {
    readonly load: true;
    /** The pane moved to a row that had none, so the layout has to reflow. */
    readonly expanded: boolean;
    readonly selected: number;
    readonly compareWith: number;
  };

export function nextComparison(current: CompareSelection, index: number): CompareStep {
  const anchor = current.selected ?? current.compareWith;

  // Nothing to compare against yet: arm this row.
  if (anchor === null) return { load: false, selected: null, compareWith: index };

  if (anchor === index) {
    // ⌘-clicking the armed row again disarms it; ⌘-clicking the expanded row is
    // a no-op, since dropping the pane the user is reading would be a surprise.
    return current.selected === null
      ? { load: false, selected: null, compareWith: null }
      : { load: false, ...current };
  }

  return current.selected === null
    ? { load: true, expanded: true, selected: index, compareWith: anchor }
    : { load: true, expanded: false, selected: current.selected, compareWith: index };
}
