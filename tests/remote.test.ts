import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  adoptEffectiveConfig,
  effectiveConfigArgv,
  quote,
  quotePath,
  remoteCommand,
  resetMultiplexing,
  wrapArgv,
  wrapShell,
} from "../src/data/remote.ts";

const TARGET = { host: "dev-box", path: "~/projects/gateway" };

test("a host the user already multiplexes is left entirely alone", () => {
  resetMultiplexing();
  // Verbatim `ssh -G` output shape.
  const mode = adoptEffectiveConfig([
    "user dev",
    "controlmaster auto",
    "controlpath /Users/molin/.ssh/control-%C",
    "controlpersist 600",
    "proxycommand ~/.local/bin/ssh-fastest-endpoint %p 10.0.0.1",
  ].join("\n"));

  assert.equal(mode, "inherit");
  const argv = wrapArgv(["git", "status"], TARGET);
  assert.ok(!argv.some((a) => a.startsWith("ControlPath=")),
    "must not override the user's socket — a ProxyCommand host would redial");
  assert.ok(!argv.some((a) => a.startsWith("ControlMaster=")));
  assert.ok(argv.includes("BatchMode=yes"), "never prompts for a password");
});

test("a host with no reuse configured gets a persistent master of ours", () => {
  resetMultiplexing();
  const mode = adoptEffectiveConfig(["user dev", "controlmaster no", "controlpath none"].join("\n"));

  assert.equal(mode, "own");
  const argv = wrapArgv(["git", "status"], TARGET);
  assert.ok(argv.includes("ControlPath=~/.ssh/muxy-git-graph-%C"));
  assert.ok(argv.includes("ControlMaster=auto"));
  assert.ok(argv.includes("ControlPersist=120"),
    "the connection must outlive one command, or every git call redials");
  resetMultiplexing();
});

test("ssh -G is resolved locally, without connecting", () => {
  assert.deepEqual(effectiveConfigArgv("dev-box"), ["ssh", "-G", "dev-box"]);
});

test("a leading ~ stays expandable, the rest is literal", () => {
  assert.equal(quotePath("~"), "~");
  assert.equal(quotePath("~/projects/gateway"), "~/'projects/gateway'");
  assert.equal(quotePath("/srv/repo"), "'/srv/repo'");
  // A path that merely contains a tilde must not be treated as home-relative.
  assert.equal(quotePath("/srv/~weird"), "'/srv/~weird'");
});

test("arguments with shell metacharacters survive intact", () => {
  const nasty = [
    "git", "log", "--format=%H%x1f%P", "--branches",
    "a b", "it's", 'say "hi"', "$(rm -rf /)", "`whoami`", "semi;colon", "pipe|d", "*glob*",
  ];
  const command = remoteCommand(nasty, "~/repo");

  assert.ok(command.startsWith("cd ~/'repo' && "));

  // The proof is behavioural, not textual: /bin/sh must echo each argument back
  // byte for byte, which can only happen if nothing expanded or word-split.
  const script = command.slice(command.indexOf(" && ") + 4);
  const out = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${script}`], { encoding: "utf8" });
  assert.deepEqual(out.split("\n").slice(0, -1), nasty,
    "every argument round-trips through a real shell unchanged");
});

test("the ssh invocation targets the host and passes one remote command", () => {
  resetMultiplexing();
  const argv = wrapArgv(["git", "rev-parse", "HEAD"], TARGET);

  assert.equal(argv[0], "ssh");
  const separator = argv.indexOf("--");
  assert.ok(separator > 0, "options are terminated before the remote command");
  assert.equal(argv[separator - 1], "dev-box", "host sits immediately before --");
  assert.equal(argv.length, separator + 2, "exactly one remote command argument");
  assert.equal(argv[separator + 1], "cd ~/'projects/gateway' && 'git' 'rev-parse' 'HEAD'");
});

test("shell-form commands are tunnelled without double quoting", () => {
  resetMultiplexing();
  const argv = wrapShell("git rev-parse --verify MERGE_HEAD >/dev/null 2>&1 && echo merge", TARGET);
  const command = argv[argv.length - 1];

  assert.ok(command.startsWith("cd ~/'projects/gateway' && "));
  assert.ok(command.includes(">/dev/null 2>&1"),
    "redirection must stay live — the shell form is a script, not an argv");
});

test("quote round-trips awkward values through a real shell", () => {
  assert.equal(quote(""), "''");
  for (const value of ["''", "\\", "a\nb", "  ", "--flag=v'x", "$HOME", "~"]) {
    const out = execFileSync("/bin/sh", ["-c", `printf '%s' ${quote(value)}`], { encoding: "utf8" });
    assert.equal(out, value, `round-trips ${JSON.stringify(value)}`);
  }
});

test("a ~-relative project path becomes a shell command that expands it", () => {
  // The `shellCwd` rung: Muxy passes the project path through with `~` intact,
  // which spawn(2) cannot resolve but a shell can.
  const command = remoteCommand(["git", "rev-parse", "HEAD"], "~/projects/gateway");
  assert.equal(command, "cd ~/'projects/gateway' && 'git' 'rev-parse' 'HEAD'");

  const expanded = execFileSync("/bin/sh", ["-c", "cd ~/ && pwd"], { encoding: "utf8" }).trim();
  assert.ok(expanded.startsWith("/"), "a shell expands ~ where spawn cannot");
});

test("resolves the SSH target from Muxy's own config, so nothing is typed", async () => {
  const { resolveFromMuxyConfig } = await import("../src/data/remote.ts");
  const SEP = String.fromCharCode(0x1e);

  // Verbatim shapes from projects.json / remote-devices.json.
  const projects = JSON.stringify([
    { id: "P1", name: "Home", path: "/Users/molin", worktreesEnabled: false },
    { id: "P2", name: "gateway", path: "~/projects/gateway", remoteDeviceID: "D1" },
  ]);
  const devices = JSON.stringify([
    { id: "D1", name: "afterlife-osaka-dev", kind: "ssh",
      ssh: { host: "afterlife-osaka-dev", remoteRoot: "~" } },
    { id: "D2", name: "afterlife-home", kind: "ssh", ssh: { host: "afterlife-home" } },
  ]);
  const output = `${projects}${SEP}${devices}`;

  assert.deepEqual(resolveFromMuxyConfig(output, "~/projects/gateway"),
    { host: "afterlife-osaka-dev", path: "~/projects/gateway" });

  // A single remote project is unambiguous even when the root does not match.
  assert.deepEqual(resolveFromMuxyConfig(output, null),
    { host: "afterlife-osaka-dev", path: "~/projects/gateway" });

  // Local-only config yields nothing rather than a wrong guess.
  const localOnly = `${JSON.stringify([{ id: "P1", path: "/Users/molin" }])}${SEP}[]`;
  assert.equal(resolveFromMuxyConfig(localOnly, "/Users/molin"), null);

  assert.equal(resolveFromMuxyConfig("not json", null), null, "malformed config is survivable");
  assert.equal(resolveFromMuxyConfig(projects, null), null, "a missing separator is survivable");
});
