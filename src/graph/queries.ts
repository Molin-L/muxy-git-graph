import type { Commit } from "../data/repo.ts";

/**
 * Whether a commit can be dropped with `rebase --onto`. Ported from
 * `Graph.dropCommitPossible` in vscode-git-graph: the commit must not be a merge,
 * and every commit between it and HEAD must form an unbranched chain.
 */
export function canDropCommit(
  commits: readonly Commit[],
  index: number,
  headHash: string | null,
): boolean {
  const commit = commits[index];
  if (!commit || commit.isStash || commit.parents.length === 0 || headHash === null) return false;

  const indexOf = new Map<string, number>();
  commits.forEach((c, i) => indexOf.set(c.hash, i));

  const children = new Map<number, number[]>();
  commits.forEach((c, i) => {
    for (const parent of c.parents) {
      const parentIndex = indexOf.get(parent);
      if (parentIndex === undefined) continue;
      const list = children.get(parentIndex);
      if (list) list.push(i);
      else children.set(parentIndex, [i]);
    }
  });

  const visit = (at: number): boolean | null => {
    if (commits[at].parents.length > 1) return null;
    const kids = children.get(at) ?? [];
    if (kids.length > 1) return null;
    if (kids.length === 1) {
      const result = visit(kids[0]);
      if (result !== false) return result;
    }
    return commits[at].hash === headHash;
  };

  return visit(index) === true;
}
