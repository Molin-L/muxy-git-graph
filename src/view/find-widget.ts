import { el } from "./dom.ts";
import type { FindOptions } from "./find.ts";

export interface FindWidgetHandlers {
  /** The query or the options changed; already debounced. */
  search(query: string, options: FindOptions): void;
  /** Move to the previous (-1) or next (+1) match. */
  navigate(delta: -1 | 1): void;
  /** Options changed and are worth persisting. */
  optionsChanged(options: FindOptions): void;
}

const DEBOUNCE_MS = 180;

/** The steppers are hidden on a narrow panel, so the keys they stand for have to
 *  be discoverable from the field itself. */
const INPUT_TITLE = "Find commits — ⏎ next match, ⇧⏎ previous";

/**
 * The find bar. Always present, and it lives in the topbar alongside Refresh
 * rather than taking a row of its own.
 *
 * It does not open or close. ⌘F is a chord a panel webview competes with the
 * host for, and a find that only exists once that chord lands is a find that
 * some users never see at all. A field that is simply always there makes the
 * shortcut a convenience rather than the entrance.
 *
 * It owns its own chrome and nothing else — matching, match ordering and
 * scrolling all live in the Panel, because they are properties of the Commit
 * Feed rather than of this input (ADR-0018).
 */
export class FindWidget {
  readonly element = el("div", "find");

  private readonly input = el("input", "find__input");
  private readonly caseToggle: HTMLElement;
  private readonly regexToggle: HTMLElement;
  private readonly status = el("span", "find__status");
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;

  private readonly handlers: FindWidgetHandlers;
  private options: FindOptions;
  private debounce: number | undefined;

  constructor(handlers: FindWidgetHandlers, options: FindOptions) {
    this.handlers = handlers;
    this.options = options;

    this.input.type = "text";
    this.input.placeholder = "Find commits";
    this.input.title = INPUT_TITLE;
    this.input.spellcheck = false;
    this.input.addEventListener("input", () => this.schedule());
    this.input.addEventListener("keydown", (event) => this.onKeyDown(event));

    this.caseToggle = this.toggle("Aa", "Match case", options.caseSensitive, (on) => {
      this.options = { ...this.options, caseSensitive: on };
    });
    this.regexToggle = this.toggle(".*", "Use regular expression", options.regex, (on) => {
      this.options = { ...this.options, regex: on };
    });

    this.prev = stepButton("↑", "Previous match (⇧⏎)", () => this.handlers.navigate(-1));
    this.next = stepButton("↓", "Next match (⏎)", () => this.handlers.navigate(1));
    this.clearButton = stepButton("✕", "Clear (Esc)", () => {
      this.clear();
      this.input.focus();
    });
    this.clearButton.className = "find__toggle find__clear";

    // Count and clear live inside the field, as they do in a browser's find bar.
    // The topbar has room for one flexible slot, not five fixed ones.
    const field = el("div", "find__field");
    field.append(this.input, this.status, this.caseToggle, this.regexToggle, this.clearButton);
    this.element.append(field, this.prev, this.next);
    this.setStatus(0, 0, null);
  }

  get query(): string {
    return this.input.value;
  }

  get currentOptions(): FindOptions {
    return this.options;
  }

  /** True when the event came from the find input, so the Panel can stand down. */
  owns(target: EventTarget | null): boolean {
    return target === this.input;
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  /**
   * Empties the query and reports whether there was one. The Panel uses that to
   * decide what Escape means: clearing a search first, closing the details pane
   * only once there is no search left to clear.
   */
  clear(): boolean {
    if (this.input.value === "") return false;
    this.input.value = "";
    this.flush();
    return true;
  }

  /**
   * @param position 1-based index of the current match, or 0 for none.
   * @param total Total matches.
   * @param error Why the query could not be run, if it could not.
   */
  setStatus(position: number, total: number, error: string | null): void {
    const empty = this.input.value === "";
    this.element.classList.toggle("find--error", error !== null);
    this.input.title = error ?? INPUT_TITLE;

    if (error !== null) {
      this.status.textContent = "Bad pattern";
      this.status.title = error;
    } else if (empty) {
      this.status.textContent = "";
      this.status.title = "";
    } else {
      this.status.textContent = total === 0 ? "No results" : `${position} of ${total}`;
      this.status.title = "";
    }

    this.prev.disabled = total === 0;
    this.next.disabled = total === 0;
    this.clearButton.disabled = empty;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    // Enter before the debounce has fired would navigate the previous query's
    // matches, so run the pending search first.
    this.flush();
    this.handlers.navigate(event.shiftKey ? -1 : 1);
  }

  private toggle(
    glyph: string, title: string, initial: boolean, apply: (on: boolean) => void,
  ): HTMLElement {
    const button = el("button", "find__toggle", glyph);
    button.title = title;
    button.classList.toggle("find__toggle--on", initial);
    button.addEventListener("click", () => {
      const on = !button.classList.contains("find__toggle--on");
      button.classList.toggle("find__toggle--on", on);
      apply(on);
      this.handlers.optionsChanged(this.options);
      this.flush();
      // The input loses nothing by keeping focus, and the next keystroke is
      // almost always meant for it.
      this.input.focus();
    });
    return button;
  }

  private schedule(): void {
    window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  private flush(): void {
    window.clearTimeout(this.debounce);
    this.handlers.search(this.input.value, this.options);
  }
}

function stepButton(glyph: string, title: string, run: () => void): HTMLButtonElement {
  const button = el("button", "iconbutton find__step", glyph);
  button.title = title;
  button.addEventListener("click", run);
  return button;
}
