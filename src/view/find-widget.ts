import { el } from "./dom.ts";
import type { FindOptions } from "./find.ts";

export interface FindWidgetHandlers {
  /** The query or the options changed; already debounced. */
  search(query: string, options: FindOptions): void;
  /** Move to the previous (-1) or next (+1) match. */
  navigate(delta: -1 | 1): void;
  close(): void;
  /** Options changed and are worth persisting. */
  optionsChanged(options: FindOptions): void;
}

const DEBOUNCE_MS = 180;

/**
 * The find bar. It owns its own chrome and nothing else — matching, match
 * ordering and scrolling all live in the Panel, because they are properties of
 * the Commit Feed rather than of this input (ADR-0018).
 */
export class FindWidget {
  readonly element = el("div", "find");

  private readonly input = el("input", "find__input");
  private readonly caseToggle: HTMLElement;
  private readonly regexToggle: HTMLElement;
  private readonly status = el("span", "find__status");
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;

  private readonly handlers: FindWidgetHandlers;
  private options: FindOptions;
  private debounce: number | undefined;
  private open = false;

  constructor(handlers: FindWidgetHandlers, options: FindOptions) {
    this.handlers = handlers;
    this.options = options;

    this.input.type = "text";
    this.input.placeholder = "Find commits";
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
    const dismiss = stepButton("✕", "Close (Esc)", () => this.handlers.close());
    dismiss.classList.add("find__close");

    const field = el("div", "find__field");
    field.append(this.input, this.caseToggle, this.regexToggle);
    this.element.append(field, this.status, this.prev, this.next, dismiss);
    this.element.hidden = true;
    this.setStatus(0, 0, null);
  }

  get isOpen(): boolean {
    return this.open;
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

  show(): void {
    this.open = true;
    this.element.hidden = false;
    this.input.focus();
    this.input.select();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.element.hidden = true;
    window.clearTimeout(this.debounce);
    // The query is kept, so reopening resumes the last search; the Panel is told
    // the search is empty so no highlights survive a close.
    this.handlers.search("", this.options);
  }

  /**
   * @param position 1-based index of the current match, or 0 for none.
   * @param total Total matches.
   * @param error Why the query could not be run, if it could not.
   */
  setStatus(position: number, total: number, error: string | null): void {
    this.element.classList.toggle("find--error", error !== null);
    this.input.title = error ?? "";

    if (error !== null) {
      this.status.textContent = "Bad pattern";
      this.status.title = error;
    } else if (this.input.value === "") {
      this.status.textContent = "";
      this.status.title = "";
    } else {
      this.status.textContent = total === 0 ? "No results" : `${position} of ${total}`;
      this.status.title = "";
    }

    const idle = total === 0;
    this.prev.disabled = idle;
    this.next.disabled = idle;
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
