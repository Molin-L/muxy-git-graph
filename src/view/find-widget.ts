import { el } from "./dom.ts";
import type { FindOptions } from "./find.ts";

export interface FindWidgetHandlers {
  /** The query or the options changed; already debounced. */
  search(query: string, options: FindOptions): void;
  /** Move to the previous (-1) or next (+1) match. */
  navigate(delta: -1 | 1): void;
  /** Options changed and are worth persisting. */
  optionsChanged(options: FindOptions): void;
  /** The widget opened or closed, so the topbar's Find button can show which. */
  visibilityChanged(open: boolean): void;
}

const DEBOUNCE_MS = 180;

/** Stepping is keys only, so the keys have to be discoverable from the field
 *  itself rather than from a pair of buttons standing for them. */
const INPUT_TITLE = "Find commits — ⏎ next match, ⇧⏎ previous";

/**
 * The find widget. Summoned by the topbar's Find button (or ⌘F), it drops over
 * the top-right corner of the graph and slides back out on Escape or a second
 * press of the button, as it does in `vscode-git-graph`. Upstream lands it over
 * its control bar; here it clears the topbar and the column header instead,
 * because a right panel is narrow enough that covering the topbar would take
 * the branch name and Refresh with it.
 *
 * Being summoned rather than permanent is what lets the input be readable, with
 * both modifiers and the match count beside it, because it borrows the corner
 * instead of sharing the topbar with the branch name and the status. It spends
 * no width on chrome the user already has elsewhere: the topbar's Find button
 * closes it as well as opens it, and `⏎`/`⇧⏎` walk the matches, so there is
 * neither a ✕ nor a pair of arrows in here.
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

  private readonly handlers: FindWidgetHandlers;
  private options: FindOptions;
  private debounce: number | undefined;
  private open = false;

  constructor(handlers: FindWidgetHandlers, options: FindOptions) {
    this.handlers = handlers;
    this.options = options;

    this.input.type = "text";
    this.input.placeholder = "Find commits";
    this.input.title = INPUT_TITLE;
    this.input.spellcheck = false;
    this.input.addEventListener("input", () => this.schedule());
    this.input.addEventListener("keydown", (event) => this.onKeyDown(event));

    this.caseToggle = this.modifier("Aa", "Match case", options.caseSensitive, (on) => {
      this.options = { ...this.options, caseSensitive: on };
    });
    this.regexToggle = this.modifier(".*", "Use regular expression", options.regex, (on) => {
      this.options = { ...this.options, regex: on };
    });

    // Count and modifiers live inside the field, as they do in a browser's find
    // bar, so the widget is one control rather than a row of parts.
    const field = el("div", "find__field");
    field.append(this.input, this.status, this.caseToggle, this.regexToggle);
    this.element.append(field);
    this.element.hidden = true;
    this.setStatus(0, 0, null);
  }

  get query(): string {
    return this.open ? this.input.value : "";
  }

  get currentOptions(): FindOptions {
    return this.options;
  }

  /** True while the widget is on screen, so the Panel knows what Escape means. */
  get isOpen(): boolean {
    return this.open;
  }

  /** True when the event came from the find input, so the Panel can stand down. */
  owns(target: EventTarget | null): boolean {
    return target === this.input;
  }

  /** What the topbar's Find button does: the button that opened the widget is
   *  also what closes it, which is why there is no ✕ inside. */
  toggle(): void {
    if (this.open) {
      this.close();
    } else {
      this.show();
    }
  }

  /**
   * Slides the widget in and takes the keyboard. Called again while already
   * open — a second ⌘F — it selects the query instead, so the next keystroke
   * replaces the search rather than extending it.
   */
  show(): void {
    if (!this.open) {
      this.open = true;
      this.element.hidden = false;
      // The widget is `display: none` while hidden, so the browser has no start
      // position to animate from until it has laid the element out. Reading a
      // geometric property forces that, and the slide is honoured.
      void this.element.offsetHeight;
      this.element.classList.add("find--open");
      this.handlers.visibilityChanged(true);
    }
    this.input.focus();
    this.input.select();
  }

  /**
   * Slides the widget out, dropping the query with it. Reports whether there
   * was anything to close, which is how the Panel decides what Escape means:
   * dismissing a search first, closing the details pane only once there is no
   * search left. Escape and the Find button are the only ways out — with the
   * panel this narrow, a ✕ would cost a fifth of the widget's width to do what
   * the button the user just pressed already does.
   */
  close(): boolean {
    if (!this.open) return false;
    this.open = false;
    this.element.classList.remove("find--open");
    this.input.value = "";
    this.flush();
    this.setStatus(0, 0, null);
    // Kept in the layout until the slide finishes; `hidden` only after, so the
    // widget is out of the tab order while it is off screen.
    const done = (): void => {
      if (!this.open) this.element.hidden = true;
    };
    this.element.addEventListener("transitionend", done, { once: true });
    window.setTimeout(done, 400);
    this.handlers.visibilityChanged(false);
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
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    // Enter before the debounce has fired would navigate the previous query's
    // matches, so run the pending search first.
    this.flush();
    this.handlers.navigate(event.shiftKey ? -1 : 1);
  }

  /** One of the two in-field modifiers, Aa and `.*`. */
  private modifier(
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
