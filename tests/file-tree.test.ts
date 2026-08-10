import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFileTree } from "../src/view/file-tree.ts";
import type { TreeFolder, TreeNode } from "../src/view/file-tree.ts";
import type { ChangedFile } from "../src/data/repo.ts";

function changed(path: string): ChangedFile {
  return { path, status: "M" };
}

/** "folder:name" / "file:name" per child, so a shape is one readable line. */
function shape(nodes: readonly TreeNode[]): string[] {
  return nodes.map((node) => `${node.kind}:${node.name}`);
}

function folder(node: TreeNode | undefined): TreeFolder {
  assert.ok(node !== undefined && node.kind === "folder", "expected a folder");
  return node;
}

test("files at the root become children of the root folder", () => {
  const tree = buildFileTree([changed("README.md"), changed("LICENSE")]);
  assert.equal(tree.path, "");
  assert.deepEqual(shape(tree.children), ["file:LICENSE", "file:README.md"]);
});

test("folders sort before files, each alphabetically", () => {
  const tree = buildFileTree([
    changed("z.ts"), changed("src/b.ts"), changed("a.ts"), changed("src/a.ts"),
    changed("docs/x.md"), changed("docs/y.md"),
  ]);
  assert.deepEqual(shape(tree.children), ["folder:docs", "folder:src", "file:a.ts", "file:z.ts"]);
  assert.deepEqual(shape(folder(tree.children[1]).children), ["file:a.ts", "file:b.ts"]);
});

test("a folder path is its full path from the repository root", () => {
  const tree = buildFileTree([changed("src/view/a.ts"), changed("src/data/b.ts")]);
  const src = folder(tree.children[0]);
  assert.equal(src.path, "src");
  assert.deepEqual(src.children.map((child) => (child as TreeFolder).path),
    ["src/data", "src/view"]);
});

test("a chain of single-child folders is compacted into one row", () => {
  const tree = buildFileTree([changed("src/view/deep/a.ts")]);
  const compacted = folder(tree.children[0]);
  assert.equal(compacted.name, "src / view / deep");
  // The path stays the real one, so the row's identity survives compaction.
  assert.equal(compacted.path, "src/view/deep");
  assert.deepEqual(shape(compacted.children), ["file:a.ts"]);
});

test("a folder is not compacted into a child that holds a file too", () => {
  const tree = buildFileTree([changed("src/view/a.ts"), changed("src/b.ts")]);
  const src = folder(tree.children[0]);
  assert.equal(src.name, "src");
  assert.deepEqual(shape(src.children), ["folder:view", "file:b.ts"]);
});

test("compaction stops where the tree branches", () => {
  const tree = buildFileTree([changed("a/b/c/one.ts"), changed("a/b/d/two.ts")]);
  const ab = folder(tree.children[0]);
  assert.equal(ab.name, "a / b");
  assert.deepEqual(shape(ab.children), ["folder:c", "folder:d"]);
});

test("the same folder is shared by every file under it", () => {
  const tree = buildFileTree([
    changed("src/a.ts"), changed("src/b.ts"), changed("src/nested/c.ts"),
  ]);
  assert.equal(tree.children.length, 1);
  assert.deepEqual(shape(folder(tree.children[0]).children),
    ["folder:nested", "file:a.ts", "file:b.ts"]);
});
