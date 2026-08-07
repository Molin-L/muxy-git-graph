export const UNCOMMITTED = "*";

export interface CommitInput {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly isStash?: boolean;
}

export interface GridConfig {
  /** Horizontal pitch between lanes, in px. */
  readonly x: number;
  /** Row height, in px. */
  readonly y: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** Extra vertical space inserted for an expanded commit's details. */
  readonly expandY: number;
}

export type GraphStyle = "rounded" | "angular";

/** Which row gets the hollow "you are here" vertex when uncommitted changes are shown. */
export type UncommittedStyle = "openCircleAtUncommitted" | "openCircleAtHead";

export interface GraphConfig {
  readonly grid: GridConfig;
  readonly style: GraphStyle;
  readonly uncommittedChanges: UncommittedStyle;
}

export interface PathSpec {
  readonly d: string;
  /** Index into the lane palette; the renderer maps it to a CSS variable. */
  readonly colour: number;
  readonly isCommitted: boolean;
}

export interface VertexSpec {
  readonly id: number;
  readonly cx: number;
  readonly cy: number;
  readonly colour: number;
  readonly isCurrent: boolean;
  readonly isStash: boolean;
  readonly isCommitted: boolean;
}

export interface GraphLayout {
  readonly paths: readonly PathSpec[];
  readonly vertices: readonly VertexSpec[];
  readonly width: number;
  readonly height: number;
  /** Per commit, the x offset at which row content may start. */
  readonly widthsAtVertices: readonly number[];
  /** Per commit, its lane palette index. */
  readonly coloursAtVertices: readonly number[];
}

export interface LayoutOptions {
  readonly commitHead?: string | null;
  readonly onlyFollowFirstParent?: boolean;
  /** Index of the commit whose details are expanded, or -1. */
  readonly expandAt?: number;
}
