import type { GraphLayout } from "../graph/types.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Number of lane colour slots defined in global.css. */
export const LANE_COLOURS = 6;

/**
 * Draws the whole loaded range in one SVG (ADR-0007). Colour is applied by class,
 * never as an attribute, so the lanes track the theme without a redraw — SVG
 * presentation attributes do not resolve `var()`, but CSS does.
 */
export function renderGraph(svg: SVGSVGElement, layout: GraphLayout): void {
  const fragment = document.createDocumentFragment();

  for (const spec of layout.paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", spec.d);
    path.setAttribute(
      "class",
      spec.isCommitted ? `line lane-${spec.colour % LANE_COLOURS}` : "line uncommitted",
    );
    fragment.appendChild(path);
  }

  for (const spec of layout.vertices) {
    const lane = spec.isCommitted ? `lane-${spec.colour % LANE_COLOURS}` : "uncommitted";
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(spec.cx));
    circle.setAttribute("cy", String(spec.cy));
    circle.dataset.id = String(spec.id);

    if (spec.isStash) {
      circle.setAttribute("r", "4.5");
      circle.setAttribute("class", `vertex ${lane}`);
      fragment.appendChild(circle);
      const inner = document.createElementNS(SVG_NS, "circle");
      inner.setAttribute("cx", String(spec.cx));
      inner.setAttribute("cy", String(spec.cy));
      inner.setAttribute("r", "2");
      inner.setAttribute("class", "stash-inner");
      fragment.appendChild(inner);
      continue;
    }

    circle.setAttribute("r", "4");
    circle.setAttribute("class", `vertex ${lane}${spec.isCurrent ? " vertex--current" : ""}`);
    fragment.appendChild(circle);
  }

  svg.setAttribute("width", String(layout.width));
  svg.setAttribute("height", String(layout.height));
  svg.replaceChildren(fragment);
}
