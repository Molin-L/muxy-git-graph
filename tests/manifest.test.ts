import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Guards the manifest rules that only fail at load time inside Muxy — the class of
 * bug that made the topbar button a no-op: `manifest.name` must equal the directory
 * name, or Muxy registers the extension under a different identity than its panels,
 * commands and topbar items refer to.
 */

const root = path.join(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = pkg.muxy;

/** From the published manifest schema's `permission` enum. */
const PERMISSIONS = new Set([
  "panes:read", "panes:write", "tabs:read", "tabs:write", "browser:read", "browser:write",
  "projects:read", "projects:write", "projects:delete", "worktrees:read", "worktrees:write",
  "agents:read", "git:read", "git:write", "gh:read", "files:read", "files:write",
  "storage:read", "storage:write", "notifications:write", "panels:write",
  "commands:run-script", "commands:exec", "shortcuts:register", "remote:serve",
]);

/**
 * Muxy keys extension identity off `manifest.name`, NOT the directory — Load
 * Unpacked from a folder of any name works fine. The schema's "must equal the
 * directory name" wording is a marketplace packaging rule: the sync script places
 * this at `extensions/<manifest.name>/`, so the name is what that directory must be
 * called. Changing the name mints a *new* extension identity in Muxy, orphaning the
 * previous one's topbar item, shortcut and exec grants — which looks exactly like a
 * dead button.
 */
test("manifest.name is a valid extension identifier", () => {
  assert.match(pkg.name, /^(?!\.)[A-Za-z0-9._-]+$/);
  assert.ok(pkg.name.length <= 64);
});

test("tabs.open uses the runtime extension id and the required kind", () => {
  const source = fs.readFileSync(path.join(root, "src/view/panel.ts"), "utf8");

  assert.match(source, /id:\s*muxy\.extensionID/,
    "take the id from the runtime so it cannot drift from manifest.name");
  assert.doesNotMatch(source, new RegExp(`id:\\s*"${pkg.name}"`),
    "the extension id must not be hardcoded — it drifted from manifest.name once already");
  assert.match(source, /kind:\s*"extensionWebView"/,
    "tabs.open requires kind; omitting it silently fails to open the tab");
});

test("every declared permission is a real one", () => {
  for (const permission of manifest.permissions) {
    assert.ok(PERMISSIONS.has(permission), `unknown permission: ${permission}`);
  }
});

test("permission-gated events declare their permission", () => {
  const required: Record<string, string> = {
    "worktree.headChanged": "worktrees:read",
    "file.changed": "files:read",
    "projects.changed": "projects:read",
    "agent.status": "agents:read",
  };
  for (const event of manifest.events ?? []) {
    const permission = required[event];
    if (permission === undefined) continue;
    assert.ok(manifest.permissions.includes(permission),
      `event ${event} requires ${permission}`);
  }
});

/**
 * `panels:write` gates `panel.open` / `panel.toggle` / `panel.close`. It is a
 * manifest-only check with no runtime prompt, so omitting it makes a togglePanel
 * command fail silently — the topbar button renders and does nothing.
 */
test("declaring a togglePanel command requires panels:write", () => {
  const togglesPanel = (manifest.commands ?? [])
    .some((c: { action?: { kind: string } }) => c.action?.kind === "togglePanel");
  if (!togglesPanel) return;
  assert.ok(manifest.permissions.includes("panels:write"),
    "togglePanel is gated by panels:write and fails silently without it");
});

test("commands, panels and tab types cross-reference correctly", () => {
  const panels = new Set((manifest.panels ?? []).map((p: { id: string }) => p.id));
  const tabTypes = new Set((manifest.tabTypes ?? []).map((t: { id: string }) => t.id));
  const commands = new Set((manifest.commands ?? []).map((c: { id: string }) => c.id));

  for (const command of manifest.commands ?? []) {
    const action = command.action;
    if (action?.kind === "togglePanel") {
      assert.ok(panels.has(action.panel), `command ${command.id} targets missing panel`);
    }
    if (action?.kind === "openTab") {
      assert.ok(tabTypes.has(action.tabType), `command ${command.id} targets missing tab type`);
    }
  }
  for (const item of manifest.topbarItems ?? []) {
    assert.ok(commands.has(item.command), `topbar item ${item.id} targets missing command`);
  }
});

test("every referenced file exists in the source tree", () => {
  const exists = (relative: string): boolean =>
    fs.existsSync(path.join(root, relative)) || fs.existsSync(path.join(root, "public", relative));

  for (const panel of manifest.panels ?? []) {
    assert.ok(exists(panel.entry), `panel entry missing: ${panel.entry}`);
  }
  for (const tabType of manifest.tabTypes ?? []) {
    assert.ok(exists(tabType.entry), `tab entry missing: ${tabType.entry}`);
  }
  assert.ok(exists(manifest.marketplace.icon), "listing icon missing");
  for (const shot of manifest.marketplace.screenshots) {
    assert.ok(exists(shot), `screenshot missing: ${shot}`);
  }
});

test("the marketplace block carries an icon and at least one screenshot", () => {
  assert.ok(manifest.marketplace.icon, "icon required");
  assert.ok(manifest.marketplace.screenshots.length >= 1,
    "the schema sets minItems: 1 — an empty array fails validation");
});

test("the background exec relay is declared and shipped", () => {
  assert.equal(manifest.background, "background.js",
    "without background.js there is no context whose exec can reach a remote workspace");
  assert.ok(fs.existsSync(path.join(root, "public/background.js")),
    "public/ files are copied verbatim into dist, which is what the manifest references");
});
