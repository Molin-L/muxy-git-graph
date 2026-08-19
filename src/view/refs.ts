import type { Ref } from "../data/repo.ts";

/**
 * One chip's worth of refs: a ref, plus the remote-tracking branches that are
 * the same branch on a remote and are therefore drawn inside its chip rather
 * than beside it.
 */
export interface RefLabel {
  readonly ref: Ref;
  /** Non-empty only for a local head whose remotes are at this commit. */
  readonly remotes: readonly Ref[];
}

/**
 * Folds `origin/master` into the `master` chip when both are at the same commit,
 * as `vscode-git-graph` does with `combineLocalAndRemoteBranchLabels`.
 *
 * A branch that is pushed and unchanged is one branch to the person reading the
 * graph, and drawing it as two chips spends the width of the whole name to say
 * "and it is pushed". Folded, the chip reads `origin │ main`: the remotes that
 * agree with it, then the name once.
 *
 * `remotes` is the repository's remote names, which is what makes
 * `origin/feature/x` splittable — the prefix before the first `/` is only the
 * remote by convention, and a branch called `feature/x` on a remote called
 * `origin` would otherwise be read as remote `origin`, branch `feature/x` only
 * by luck. The longest matching remote wins, so a remote named `origin/mirror`
 * is preferred over `origin` for its own branches.
 */
export function combineRefs(refs: readonly Ref[], remotes: readonly string[]): RefLabel[] {
  const byHead = new Map<string, Ref[]>();
  for (const ref of refs) {
    if (ref.kind === "head") byHead.set(ref.name, []);
  }

  const folded = new Set<Ref>();
  for (const ref of refs) {
    if (ref.kind !== "remote") continue;
    const branch = branchOf(ref.name, remotes);
    const into = branch === null ? undefined : byHead.get(branch);
    if (into === undefined) continue;
    into.push(ref);
    folded.add(ref);
  }

  const labels: RefLabel[] = [];
  for (const ref of refs) {
    if (folded.has(ref)) continue;
    labels.push({ ref, remotes: ref.kind === "head" ? byHead.get(ref.name) ?? [] : [] });
  }
  return labels;
}

/** The remote name a remote-tracking ref belongs to, or null if it has none. */
export function remoteOf(name: string, remotes: readonly string[]): string | null {
  let best: string | null = null;
  for (const remote of remotes) {
    if (!name.startsWith(`${remote}/`)) continue;
    if (best === null || remote.length > best.length) best = remote;
  }
  if (best !== null) return best;
  // No remote list to go on — a fetch may have failed, or the snapshot came
  // from muxy.git. Fall back to the convention the name almost always follows.
  const slash = name.indexOf("/");
  return slash > 0 ? name.slice(0, slash) : null;
}

/** The branch part of a remote-tracking ref: `origin/feature/x` → `feature/x`. */
function branchOf(name: string, remotes: readonly string[]): string | null {
  const remote = remoteOf(name, remotes);
  return remote === null ? null : name.slice(remote.length + 1);
}
