/*
 * Lane geometry, ported from web/graph.ts of mhutchie/vscode-git-graph (MIT).
 * See docs/adr/0001-rewrite-not-port.md and docs/adr/0010-licence-and-attribution.md.
 *
 * The one structural change from upstream: upstream's Branch.draw and Vertex.draw
 * append directly to an SVGElement. Here they return plain data, so the algorithm
 * is pure and can be snapshot-tested outside a browser (ADR-0012).
 */

import { UNCOMMITTED } from "./types.ts";
import type {
  CommitInput,
  GraphConfig,
  GraphLayout,
  LayoutOptions,
  PathSpec,
  UncommittedStyle,
  VertexSpec,
} from "./types.ts";

const NULL_VERTEX_ID = -1;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Line {
  readonly p1: Point;
  readonly p2: Point;
  /** true => locked to p1, false => locked to p2. */
  readonly lockedFirst: boolean;
}

interface Pixel {
  x: number;
  y: number;
}

interface PlacedLine {
  p1: Pixel;
  p2: Pixel;
  isCommitted: boolean;
  lockedFirst: boolean;
}

interface UnavailablePoint {
  readonly connectsTo: Vertex | null;
  readonly onBranch: Branch;
}

class Branch {
  private readonly colour: number;
  private end = 0;
  private readonly lines: Line[] = [];
  private numUncommitted = 0;

  constructor(colour: number) {
    this.colour = colour;
  }

  addLine(p1: Point, p2: Point, isCommitted: boolean, lockedFirst: boolean): void {
    this.lines.push({ p1, p2, lockedFirst });
    if (isCommitted) {
      if (p2.x === 0 && p2.y < this.numUncommitted) this.numUncommitted = p2.y;
    } else {
      this.numUncommitted++;
    }
  }

  getColour(): number {
    return this.colour;
  }

  getEnd(): number {
    return this.end;
  }

  setEnd(end: number): void {
    this.end = end;
  }

  toPaths(config: GraphConfig, expandAt: number): PathSpec[] {
    const { grid } = config;
    const d = grid.y * (config.style === "angular" ? 0.38 : 0.8);
    const placed: PlacedLine[] = [];
    const out: PathSpec[] = [];

    // Convert lines into pixel coordinates, respecting expanded commit extensions.
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      let x1 = line.p1.x * grid.x + grid.offsetX;
      let y1 = line.p1.y * grid.y + grid.offsetY;
      const x2 = line.p2.x * grid.x + grid.offsetX;
      let y2 = line.p2.y * grid.y + grid.offsetY;
      const isCommitted = i >= this.numUncommitted;

      if (expandAt > -1) {
        if (line.p1.y > expandAt) {
          // The line starts after the expansion; move the whole line lower.
          y1 += grid.expandY;
          y2 += grid.expandY;
        } else if (line.p2.y > expandAt) {
          // The line crosses the expansion.
          if (x1 === x2) {
            // Vertical: extend the endpoint past the expansion.
            y2 += grid.expandY;
          } else if (line.lockedFirst) {
            // Locked to p1: the transition stays put, then extend past it.
            placed.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, isCommitted, lockedFirst: line.lockedFirst });
            placed.push({
              p1: { x: x2, y: y1 + grid.y },
              p2: { x: x2, y: y2 + grid.expandY },
              isCommitted,
              lockedFirst: line.lockedFirst,
            });
            continue;
          } else {
            // Locked to p2: the transition moves to after the expansion.
            placed.push({
              p1: { x: x1, y: y1 },
              p2: { x: x1, y: y2 - grid.y + grid.expandY },
              isCommitted,
              lockedFirst: line.lockedFirst,
            });
            y1 += grid.expandY;
            y2 += grid.expandY;
          }
        }
      }
      placed.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, isCommitted, lockedFirst: line.lockedFirst });
    }

    // Collapse consecutive collinear vertical segments.
    let i = 0;
    while (i < placed.length - 1) {
      const line = placed[i];
      const next = placed[i + 1];
      if (
        line.p1.x === line.p2.x &&
        line.p2.x === next.p1.x &&
        next.p1.x === next.p2.x &&
        line.p2.y === next.p1.y &&
        line.isCommitted === next.isCommitted
      ) {
        line.p2.y = next.p2.y;
        placed.splice(i + 1, 1);
      } else {
        i++;
      }
    }

    let curPath = "";
    for (i = 0; i < placed.length; i++) {
      const line = placed[i];
      const { x: x1, y: y1 } = line.p1;
      const { x: x2, y: y2 } = line.p2;

      // A change of committed-ness starts a new path.
      if (curPath !== "" && i > 0 && line.isCommitted !== placed[i - 1].isCommitted) {
        out.push({ d: curPath, colour: this.colour, isCommitted: placed[i - 1].isCommitted });
        curPath = "";
      }

      if (curPath === "" || (i > 0 && (x1 !== placed[i - 1].p2.x || y1 !== placed[i - 1].p2.y))) {
        curPath += "M" + x1.toFixed(0) + "," + y1.toFixed(1);
      }

      if (x1 === x2) {
        curPath += "L" + x2.toFixed(0) + "," + y2.toFixed(1);
      } else if (config.style === "angular") {
        curPath +=
          "L" +
          (line.lockedFirst
            ? x2.toFixed(0) + "," + (y2 - d).toFixed(1)
            : x1.toFixed(0) + "," + (y1 + d).toFixed(1)) +
          "L" +
          x2.toFixed(0) +
          "," +
          y2.toFixed(1);
      } else {
        curPath +=
          "C" +
          x1.toFixed(0) +
          "," +
          (y1 + d).toFixed(1) +
          " " +
          x2.toFixed(0) +
          "," +
          (y2 - d).toFixed(1) +
          " " +
          x2.toFixed(0) +
          "," +
          y2.toFixed(1);
      }
    }

    if (curPath !== "") {
      out.push({ d: curPath, colour: this.colour, isCommitted: placed[placed.length - 1].isCommitted });
    }
    return out;
  }
}

class Vertex {
  readonly id: number;
  readonly isStash: boolean;

  private x = 0;
  private readonly children: Vertex[] = [];
  private readonly parents: Vertex[] = [];
  private nextParent = 0;
  private onBranch: Branch | null = null;
  private isCommitted = true;
  private isCurrent = false;
  private nextX = 0;
  private readonly connections: UnavailablePoint[] = [];

  constructor(id: number, isStash: boolean) {
    this.id = id;
    this.isStash = isStash;
  }

  addChild(vertex: Vertex): void {
    this.children.push(vertex);
  }

  getChildren(): readonly Vertex[] {
    return this.children;
  }

  addParent(vertex: Vertex): void {
    this.parents.push(vertex);
  }

  getParents(): readonly Vertex[] {
    return this.parents;
  }

  hasParents(): boolean {
    return this.parents.length > 0;
  }

  getNextParent(): Vertex | null {
    return this.nextParent < this.parents.length ? this.parents[this.nextParent] : null;
  }

  registerParentProcessed(): void {
    this.nextParent++;
  }

  isMerge(): boolean {
    return this.parents.length > 1;
  }

  addToBranch(branch: Branch, x: number): void {
    if (this.onBranch === null) {
      this.onBranch = branch;
      this.x = x;
    }
  }

  isNotOnBranch(): boolean {
    return this.onBranch === null;
  }

  isOnThisBranch(branch: Branch): boolean {
    return this.onBranch === branch;
  }

  getBranch(): Branch | null {
    return this.onBranch;
  }

  getPoint(): Point {
    return { x: this.x, y: this.id };
  }

  getNextPoint(): Point {
    return { x: this.nextX, y: this.id };
  }

  getPointConnectingTo(vertex: Vertex | null, onBranch: Branch): Point | null {
    for (let i = 0; i < this.connections.length; i++) {
      if (this.connections[i].connectsTo === vertex && this.connections[i].onBranch === onBranch) {
        return { x: i, y: this.id };
      }
    }
    return null;
  }

  registerUnavailablePoint(x: number, connectsToVertex: Vertex | null, onBranch: Branch): void {
    if (x === this.nextX) {
      this.nextX = x + 1;
      this.connections[x] = { connectsTo: connectsToVertex, onBranch };
    }
  }

  getColour(): number {
    return this.onBranch !== null ? this.onBranch.getColour() : 0;
  }

  getIsCommitted(): boolean {
    return this.isCommitted;
  }

  setNotCommitted(): void {
    this.isCommitted = false;
  }

  setCurrent(): void {
    this.isCurrent = true;
  }

  toSpec(config: GraphConfig, expandOffset: boolean): VertexSpec | null {
    if (this.onBranch === null) return null;
    const { grid } = config;
    return {
      id: this.id,
      cx: this.x * grid.x + grid.offsetX,
      cy: this.id * grid.y + grid.offsetY + (expandOffset ? grid.expandY : 0),
      colour: this.onBranch.getColour(),
      isCurrent: this.isCurrent,
      isStash: this.isStash,
      isCommitted: this.isCommitted,
    };
  }
}

class GraphBuilder {
  private readonly vertices: Vertex[] = [];
  private readonly branches: Branch[] = [];
  private readonly availableColours: number[] = [];

  private readonly onlyFollowFirstParent: boolean;

  constructor(
    commits: readonly CommitInput[],
    commitHead: string | null,
    onlyFollowFirstParent: boolean,
    uncommittedStyle: UncommittedStyle,
  ) {
    this.onlyFollowFirstParent = onlyFollowFirstParent;
    if (commits.length === 0) return;

    const commitLookup: { [hash: string]: number } = {};
    for (let i = 0; i < commits.length; i++) commitLookup[commits[i].hash] = i;

    const nullVertex = new Vertex(NULL_VERTEX_ID, false);
    for (let i = 0; i < commits.length; i++) {
      this.vertices.push(new Vertex(i, commits[i].isStash === true));
    }
    for (let i = 0; i < commits.length; i++) {
      const parents = commits[i].parents;
      for (let j = 0; j < parents.length; j++) {
        const parentIndex = commitLookup[parents[j]];
        if (typeof parentIndex === "number") {
          this.vertices[i].addParent(this.vertices[parentIndex]);
          this.vertices[parentIndex].addChild(this.vertices[i]);
        } else if (!this.onlyFollowFirstParent || j === 0) {
          this.vertices[i].addParent(nullVertex);
        }
      }
    }

    if (commits[0].hash === UNCOMMITTED) this.vertices[0].setNotCommitted();

    if (commits[0].hash === UNCOMMITTED && uncommittedStyle === "openCircleAtUncommitted") {
      this.vertices[0].setCurrent();
    } else if (commitHead !== null && typeof commitLookup[commitHead] === "number") {
      this.vertices[commitLookup[commitHead]].setCurrent();
    }

    let i = 0;
    while (i < this.vertices.length) {
      if (this.vertices[i].getNextParent() !== null || this.vertices[i].isNotOnBranch()) {
        this.determinePath(i);
      } else {
        i++;
      }
    }
  }

  build(config: GraphConfig, expandAt: number): GraphLayout {
    const paths: PathSpec[] = [];
    for (const branch of this.branches) paths.push(...branch.toPaths(config, expandAt));

    const vertices: VertexSpec[] = [];
    for (let i = 0; i < this.vertices.length; i++) {
      const spec = this.vertices[i].toSpec(config, expandAt > -1 && i > expandAt);
      if (spec !== null) vertices.push(spec);
    }

    const { grid } = config;
    const widthsAtVertices: number[] = [];
    const coloursAtVertices: number[] = [];
    for (let i = 0; i < this.vertices.length; i++) {
      widthsAtVertices[i] = grid.offsetX + this.vertices[i].getNextPoint().x * grid.x - 2;
      coloursAtVertices[i] = this.vertices[i].getColour();
    }

    return {
      paths,
      vertices,
      width: this.getContentWidth(config),
      height:
        this.vertices.length * grid.y + grid.offsetY - grid.y / 2 + (expandAt > -1 ? grid.expandY : 0),
      widthsAtVertices,
      coloursAtVertices,
    };
  }

  private getContentWidth(config: GraphConfig): number {
    let x = 0;
    for (const vertex of this.vertices) {
      const p = vertex.getNextPoint();
      if (p.x > x) x = p.x;
    }
    return 2 * config.grid.offsetX + (x - 1) * config.grid.x;
  }

  private determinePath(startAt: number): void {
    let i = startAt;
    let vertex = this.vertices[i];
    let parentVertex = this.vertices[i].getNextParent();
    let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint();
    let curPoint: Point | null;

    if (
      parentVertex !== null &&
      parentVertex.id !== NULL_VERTEX_ID &&
      vertex.isMerge() &&
      !vertex.isNotOnBranch() &&
      !parentVertex.isNotOnBranch()
    ) {
      // A merge between two vertices that are already on branches.
      let foundPointToParent = false;
      const parentBranch = parentVertex.getBranch()!;
      for (i = startAt + 1; i < this.vertices.length; i++) {
        const curVertex = this.vertices[i];
        curPoint = curVertex.getPointConnectingTo(parentVertex, parentBranch);
        if (curPoint !== null) {
          foundPointToParent = true;
        } else {
          curPoint = curVertex.getNextPoint();
        }
        parentBranch.addLine(
          lastPoint,
          curPoint,
          vertex.getIsCommitted(),
          !foundPointToParent && curVertex !== parentVertex ? lastPoint.x < curPoint.x : true,
        );
        curVertex.registerUnavailablePoint(curPoint.x, parentVertex, parentBranch);
        lastPoint = curPoint;

        if (foundPointToParent) {
          vertex.registerParentProcessed();
          break;
        }
      }
    } else {
      const branch = new Branch(this.getAvailableColour(startAt));
      vertex.addToBranch(branch, lastPoint.x);
      vertex.registerUnavailablePoint(lastPoint.x, vertex, branch);
      for (i = startAt + 1; i < this.vertices.length; i++) {
        const curVertex = this.vertices[i];
        curPoint =
          parentVertex === curVertex && !parentVertex.isNotOnBranch()
            ? curVertex.getPoint()
            : curVertex.getNextPoint();
        branch.addLine(lastPoint, curPoint, vertex.getIsCommitted(), lastPoint.x < curPoint.x);
        curVertex.registerUnavailablePoint(curPoint.x, parentVertex, branch);
        lastPoint = curPoint;

        if (parentVertex === curVertex) {
          vertex.registerParentProcessed();
          const parentVertexOnBranch = !parentVertex.isNotOnBranch();
          parentVertex.addToBranch(branch, curPoint.x);
          vertex = parentVertex;
          parentVertex = vertex.getNextParent();
          if (parentVertex === null || parentVertexOnBranch) break;
        }
      }
      if (i === this.vertices.length && parentVertex !== null && parentVertex.id === NULL_VERTEX_ID) {
        vertex.registerParentProcessed();
      }
      branch.setEnd(i);
      this.branches.push(branch);
      this.availableColours[branch.getColour()] = i;
    }
  }

  private getAvailableColour(startAt: number): number {
    for (let i = 0; i < this.availableColours.length; i++) {
      if (startAt > this.availableColours[i]) return i;
    }
    this.availableColours.push(0);
    return this.availableColours.length - 1;
  }
}

export function computeLayout(
  commits: readonly CommitInput[],
  config: GraphConfig,
  options: LayoutOptions = {},
): GraphLayout {
  const builder = new GraphBuilder(
    commits,
    options.commitHead ?? null,
    options.onlyFollowFirstParent === true,
    config.uncommittedChanges,
  );
  return builder.build(config, options.expandAt ?? -1);
}
