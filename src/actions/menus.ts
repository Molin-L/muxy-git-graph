/**
 * Context-menu definitions, following vscode-git-graph's menus item for item.
 * Where `muxy.git` has the operation it is used, for the named consent prompt;
 * otherwise it falls through to `exec` (ADR-0002).
 */

import { UNCOMMITTED, write } from "../data/repo.ts";
import type { Commit, Ref } from "../data/repo.ts";
import { confirmDialog, openDialog } from "../view/dialog.ts";
import type { MenuEntry } from "../view/context-menu.ts";
import { copyToClipboard } from "../view/dom.ts";

export interface ActionContext {
  readonly currentBranch: string;
  readonly headHash: string | null;
  readonly remotes: readonly string[];
  /** Runs the operation, reports failure, and refreshes. */
  perform(label: string, operation: () => Promise<unknown>): Promise<void>;
  refresh(): Promise<void>;
}

const short = (hash: string): string => hash.slice(0, 8);

export function commitMenu(commit: Commit, canDrop: boolean, ctx: ActionContext): MenuEntry[] {
  if (commit.hash === UNCOMMITTED) return uncommittedMenu(ctx);
  if (commit.isStash) return stashMenu(commit, ctx);

  return [
    {
      label: "Add Tag…",
      run: async () => {
        const values = await openDialog({
          title: "Add Tag",
          message: `Tagging commit ${short(commit.hash)}.`,
          fields: [{ kind: "text", id: "name", label: "Name", placeholder: "v1.0.0" }],
          confirmLabel: "Add Tag",
        });
        const name = String(values?.name ?? "").trim();
        if (!name) return;
        await ctx.perform("Add tag", () => write.createTag(name, commit.hash));
      },
    },
    {
      label: "Create Branch…",
      run: async () => {
        const values = await openDialog({
          title: "Create Branch",
          message: `Branching from ${short(commit.hash)}.`,
          fields: [
            { kind: "text", id: "name", label: "Name", placeholder: "feature/thing" },
            { kind: "checkbox", id: "checkout", label: "Check out", value: true },
          ],
          confirmLabel: "Create Branch",
        });
        const name = String(values?.name ?? "").trim();
        if (!name) return;
        await ctx.perform("Create branch", () =>
          values?.checkout === true
            ? write.checkoutNewBranchAt(name, commit.hash)
            : write.branchAt(name, commit.hash));
      },
    },
    "divider",
    {
      label: "Checkout",
      run: async () => {
        if (!(await confirmDialog(
          "Checkout Commit",
          `Check out ${short(commit.hash)}? This leaves you on a detached HEAD.`,
          "Checkout",
        ))) return;
        await ctx.perform("Checkout", () => write.checkoutCommit(commit.hash));
      },
    },
    {
      label: "Cherry Pick…",
      disabled: commit.parents.length > 1,
      run: async () => {
        if (!(await confirmDialog(
          "Cherry Pick",
          `Cherry pick ${short(commit.hash)} onto ${ctx.currentBranch}?`,
          "Cherry Pick",
        ))) return;
        await ctx.perform("Cherry pick", () => write.cherryPick(commit.hash));
      },
    },
    {
      label: "Revert…",
      run: async () => {
        if (!(await confirmDialog(
          "Revert",
          `Revert ${short(commit.hash)}? The result is staged but not committed.`,
          "Revert",
        ))) return;
        await ctx.perform("Revert", () => write.revert(commit.hash));
      },
    },
    {
      label: "Drop…",
      disabled: !canDrop,
      danger: true,
      run: async () => {
        if (!(await confirmDialog(
          "Drop Commit",
          `Drop ${short(commit.hash)} from ${ctx.currentBranch}? This rewrites history.`,
          "Drop",
          true,
        ))) return;
        await ctx.perform("Drop commit", () => write.dropCommit(commit.hash));
      },
    },
    "divider",
    {
      label: `Merge into ${ctx.currentBranch}…`,
      run: () => mergeDialog(commit.hash, short(commit.hash), ctx),
    },
    {
      label: `Rebase ${ctx.currentBranch} on this Commit…`,
      run: () => rebaseDialog(commit.hash, short(commit.hash), ctx),
    },
    {
      label: `Reset ${ctx.currentBranch} to this Commit…`,
      danger: true,
      run: () => resetDialog(commit.hash, short(commit.hash), ctx),
    },
    "divider",
    { label: "Copy Commit Hash to Clipboard", run: () => copyToClipboard(commit.hash) },
    { label: "Copy Commit Subject to Clipboard", run: () => copyToClipboard(commit.subject) },
  ];
}

export function refMenu(ref: Ref, commit: Commit, ctx: ActionContext): MenuEntry[] {
  if (ref.kind === "tag") return tagMenu(ref, ctx);
  if (ref.kind === "remote") return remoteBranchMenu(ref, ctx);
  if (ref.kind === "stash") return stashMenu(commit, ctx);
  return localBranchMenu(ref, ctx);
}

function localBranchMenu(ref: Ref, ctx: ActionContext): MenuEntry[] {
  const isCurrent = ref.name === ctx.currentBranch;
  return [
    {
      label: "Checkout Branch",
      disabled: isCurrent,
      run: () => ctx.perform("Checkout branch", () => write.checkoutBranch(ref.name)),
    },
    {
      label: "Rename Branch…",
      run: async () => {
        const values = await openDialog({
          title: "Rename Branch",
          fields: [{ kind: "text", id: "name", label: "New name", value: ref.name }],
          confirmLabel: "Rename",
        });
        const name = String(values?.name ?? "").trim();
        if (!name || name === ref.name) return;
        await ctx.perform("Rename branch", () => write.renameBranch(ref.name, name));
      },
    },
    {
      label: "Delete Branch…",
      disabled: isCurrent,
      danger: true,
      run: async () => {
        const values = await openDialog({
          title: "Delete Branch",
          message: `Delete ${ref.name}?`,
          fields: [{ kind: "checkbox", id: "force", label: "Force delete (discard unmerged commits)" }],
          confirmLabel: "Delete",
          danger: true,
        });
        if (values === null) return;
        await ctx.perform("Delete branch", () => write.deleteBranch(ref.name, values.force === true));
      },
    },
    "divider",
    {
      label: `Merge into ${ctx.currentBranch}…`,
      disabled: isCurrent,
      run: () => mergeDialog(ref.name, ref.name, ctx),
    },
    {
      label: `Rebase ${ctx.currentBranch} on Branch…`,
      disabled: isCurrent,
      run: () => rebaseDialog(ref.name, ref.name, ctx),
    },
    {
      label: "Push Branch…",
      disabled: !isCurrent,
      run: async () => {
        if (!(await confirmDialog("Push Branch", `Push ${ref.name} to its remote?`, "Push"))) return;
        await ctx.perform("Push", () => write.push());
      },
    },
    "divider",
    { label: "Copy Branch Name to Clipboard", run: () => copyToClipboard(ref.name) },
  ];
}

function remoteBranchMenu(ref: Ref, ctx: ActionContext): MenuEntry[] {
  const local = ref.name.split("/").slice(1).join("/");
  return [
    {
      label: "Checkout…",
      run: async () => {
        const values = await openDialog({
          title: "Checkout Remote Branch",
          message: `Create a local branch tracking ${ref.name}.`,
          fields: [{ kind: "text", id: "name", label: "Local name", value: local }],
          confirmLabel: "Checkout",
        });
        const name = String(values?.name ?? "").trim();
        if (!name) return;
        await ctx.perform("Checkout remote branch", () => write.checkoutNewBranchAt(name, ref.name));
      },
    },
    {
      label: `Pull into ${ctx.currentBranch}…`,
      run: async () => {
        if (!(await confirmDialog("Pull", `Pull ${ref.name} into ${ctx.currentBranch}?`, "Pull"))) return;
        await ctx.perform("Pull", () => write.pull());
      },
    },
    {
      label: `Merge into ${ctx.currentBranch}…`,
      run: () => mergeDialog(ref.name, ref.name, ctx),
    },
    "divider",
    {
      label: "Delete Remote Branch…",
      danger: true,
      run: async () => {
        if (!(await confirmDialog(
          "Delete Remote Branch", `Delete ${ref.name} from the remote?`, "Delete", true,
        ))) return;
        await ctx.perform("Delete remote branch", () => write.deleteRemoteBranch(ref.name));
      },
    },
    "divider",
    { label: "Copy Branch Name to Clipboard", run: () => copyToClipboard(ref.name) },
  ];
}

function tagMenu(ref: Ref, ctx: ActionContext): MenuEntry[] {
  return [
    {
      label: "Push Tag…",
      disabled: ctx.remotes.length === 0,
      run: async () => {
        const values = await openDialog({
          title: "Push Tag",
          fields: [{
            kind: "select", id: "remote", label: "Remote",
            options: ctx.remotes.map((r) => [r, r] as [string, string]),
          }],
          confirmLabel: "Push",
        });
        if (values === null) return;
        await ctx.perform("Push tag", () => write.pushTag(ref.name, String(values.remote)));
      },
    },
    {
      label: "Delete Tag…",
      danger: true,
      run: async () => {
        const values = await openDialog({
          title: "Delete Tag",
          message: `Delete tag ${ref.name}?`,
          fields: ctx.remotes.length
            ? [{ kind: "checkbox", id: "remote", label: "Also delete on the remote" }]
            : [],
          confirmLabel: "Delete",
          danger: true,
        });
        if (values === null) return;
        await ctx.perform("Delete tag", async () => {
          await write.deleteTag(ref.name);
          if (values.remote === true && ctx.remotes[0]) {
            await write.deleteRemoteTag(ref.name, ctx.remotes[0]);
          }
        });
      },
    },
    "divider",
    { label: "Copy Tag Name to Clipboard", run: () => copyToClipboard(ref.name) },
  ];
}

function stashMenu(commit: Commit, ctx: ActionContext): MenuEntry[] {
  const ref = commit.stashRef ?? "stash@{0}";
  return [
    {
      label: "Apply Stash…",
      run: async () => {
        const values = await openDialog({
          title: "Apply Stash",
          message: `Apply ${ref}?`,
          fields: [{ kind: "checkbox", id: "index", label: "Reinstate the index" }],
          confirmLabel: "Apply",
        });
        if (values === null) return;
        await ctx.perform("Apply stash", () => write.stashApply(ref, values.index === true));
      },
    },
    {
      label: "Pop Stash…",
      run: async () => {
        const values = await openDialog({
          title: "Pop Stash",
          message: `Apply ${ref} and drop it?`,
          fields: [{ kind: "checkbox", id: "index", label: "Reinstate the index" }],
          confirmLabel: "Pop",
        });
        if (values === null) return;
        await ctx.perform("Pop stash", () => write.stashPop(ref, values.index === true));
      },
    },
    {
      label: "Create Branch from Stash…",
      run: async () => {
        const values = await openDialog({
          title: "Branch from Stash",
          fields: [{ kind: "text", id: "name", label: "Branch name" }],
          confirmLabel: "Create Branch",
        });
        const name = String(values?.name ?? "").trim();
        if (!name) return;
        await ctx.perform("Branch from stash", () => write.stashBranch(ref, name));
      },
    },
    "divider",
    {
      label: "Drop Stash…",
      danger: true,
      run: async () => {
        if (!(await confirmDialog("Drop Stash", `Drop ${ref}? This cannot be undone.`, "Drop", true))) return;
        await ctx.perform("Drop stash", () => write.stashDrop(ref));
      },
    },
    "divider",
    { label: "Copy Stash Name to Clipboard", run: () => copyToClipboard(ref) },
  ];
}

function uncommittedMenu(ctx: ActionContext): MenuEntry[] {
  return [
    {
      label: "Stash Uncommitted Changes…",
      run: async () => {
        const values = await openDialog({
          title: "Stash Uncommitted Changes",
          fields: [
            { kind: "text", id: "message", label: "Message", placeholder: "optional" },
            { kind: "checkbox", id: "untracked", label: "Include untracked files" },
          ],
          confirmLabel: "Stash",
        });
        if (values === null) return;
        await ctx.perform("Stash", () =>
          write.stashPush(String(values.message ?? ""), values.untracked === true));
      },
    },
    {
      label: "Reset Uncommitted Changes…",
      danger: true,
      run: async () => {
        const values = await openDialog({
          title: "Reset Uncommitted Changes",
          fields: [{
            kind: "select", id: "mode", label: "Mode", value: "mixed",
            options: [["mixed", "Mixed — keep working tree"], ["hard", "Hard — discard everything"]],
          }],
          confirmLabel: "Reset",
          danger: true,
        });
        if (values === null) return;
        await ctx.perform("Reset", () => write.resetUncommitted(values.mode as "mixed" | "hard"));
      },
    },
    {
      label: "Clean Untracked Files…",
      danger: true,
      run: async () => {
        const values = await openDialog({
          title: "Clean Untracked Files",
          message: "Untracked files will be deleted permanently.",
          fields: [{ kind: "checkbox", id: "directories", label: "Include untracked directories" }],
          confirmLabel: "Clean",
          danger: true,
        });
        if (values === null) return;
        await ctx.perform("Clean", () => write.cleanUntracked(values.directories === true));
      },
    },
  ];
}

async function mergeDialog(ref: string, label: string, ctx: ActionContext): Promise<void> {
  const values = await openDialog({
    title: "Merge",
    message: `Merge ${label} into ${ctx.currentBranch}.`,
    fields: [
      { kind: "checkbox", id: "noFastForward", label: "Create a new commit even if fast-forward is possible", value: true },
      { kind: "checkbox", id: "squash", label: "Squash commits" },
      { kind: "checkbox", id: "noCommit", label: "Don't commit" },
    ],
    confirmLabel: "Merge",
  });
  if (values === null) return;
  await ctx.perform("Merge", () => write.merge(ref, {
    noFastForward: values.noFastForward === true,
    squash: values.squash === true,
    noCommit: values.noCommit === true,
  }));
}

async function rebaseDialog(ref: string, label: string, ctx: ActionContext): Promise<void> {
  const values = await openDialog({
    title: "Rebase",
    message: `Rebase ${ctx.currentBranch} onto ${label}. This rewrites history.`,
    fields: [{ kind: "checkbox", id: "interactive", label: "Launch interactive rebase" }],
    confirmLabel: "Rebase",
    danger: true,
  });
  if (values === null) return;
  await ctx.perform("Rebase", () => write.rebase(ref, values.interactive === true));
}

async function resetDialog(hash: string, label: string, ctx: ActionContext): Promise<void> {
  const values = await openDialog({
    title: "Reset",
    message: `Reset ${ctx.currentBranch} to ${label}.`,
    fields: [{
      kind: "select", id: "mode", label: "Mode", value: "mixed",
      options: [
        ["soft", "Soft — keep changes staged"],
        ["mixed", "Mixed — keep changes unstaged"],
        ["hard", "Hard — discard all changes"],
      ],
    }],
    confirmLabel: "Reset",
    danger: true,
  });
  if (values === null) return;
  await ctx.perform("Reset", () => write.reset(hash, values.mode as "soft" | "mixed" | "hard"));
}
