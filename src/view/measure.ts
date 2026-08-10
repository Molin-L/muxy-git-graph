import { el } from "./dom.ts";

/**
 * Measures how wide a column's text actually is, so Date, Author and Commit can
 * be sized to their content instead of to a guess. Everything the panel gains
 * beyond that then belongs to Description, which is the column with something
 * to do with the room.
 *
 * Canvas only ranks the candidates — cheap enough to run over every author in
 * the repository. The winner is then measured in the DOM, inside a real `.row`,
 * so the cell's own font, size and weight are the ones that decide the answer.
 */
export class ColumnRuler {
  private readonly host = el("div", "row");
  private readonly probes = new Map<string, HTMLElement>();
  private readonly pen = document.createElement("canvas").getContext("2d");

  constructor(root: HTMLElement) {
    // Out of flow, out of the a11y tree, but still inside the panel: the fonts
    // and custom properties have to resolve exactly as they do for a real row.
    this.host.setAttribute("aria-hidden", "true");
    this.host.style.cssText =
      "position:absolute;top:0;left:0;right:auto;width:auto;height:auto;" +
      "display:block;visibility:hidden;pointer-events:none;padding:0;";
    root.appendChild(this.host);
  }

  /** Width in px of the widest of `values`, rendered as `cell <className>`. */
  widthOf(className: string, values: Iterable<string>): number {
    const probe = this.probe(className);
    let widest = "";

    if (this.pen === null) {
      // No 2D context (a headless or hardened webview): fall back to character
      // count. Wrong for proportional text, but only ever by a few pixels.
      for (const value of values) if (value.length > widest.length) widest = value;
    } else {
      const style = getComputedStyle(probe);
      this.pen.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      let best = -1;
      for (const value of values) {
        const width = this.pen.measureText(value).width;
        if (width > best) {
          best = width;
          widest = value;
        }
      }
    }

    probe.textContent = widest;
    return Math.ceil(probe.getBoundingClientRect().width);
  }

  private probe(className: string): HTMLElement {
    const found = this.probes.get(className);
    if (found !== undefined) return found;

    const probe = el("span", `cell ${className}`);
    // Undoes .cell's clamp — a probe has to report its natural width, not the
    // width of whatever box it happens to be sitting in.
    probe.style.cssText =
      "position:absolute;display:inline-block;width:max-content;" +
      "overflow:visible;text-overflow:clip;white-space:pre;";
    this.host.appendChild(probe);
    this.probes.set(className, probe);
    return probe;
  }
}
