import { before, test } from "node:test";
import assert from "node:assert/strict";

/**
 * Integration of both halves of the exec relay: the REAL public/background.js
 * (plain script, subscribes on import) wired to the REAL client over a loopback
 * event bus, with a background-style synchronous muxy.exec underneath. This is
 * the path a remote workspace depends on, so the two sides are tested together,
 * not against hand-written imitations of each other.
 */

type Handler = (payload: unknown) => void;
const handlers: Handler[] = [];

/** What the background-side sync exec should return, keyed by argv[1]. */
let execBehaviour: (command: string[] | { shell: string }) => {
  stdout: string; stderr: string; exitCode: number;
};

before(async () => {
  (globalThis as Record<string, unknown>).muxy = {
    events: {
      subscribe: (_channel: string, handler: Handler) => {
        handlers.push(handler);
        return () => {};
      },
      // Deliver to every subscriber, like the relay does; async like the webview.
      emit: (_channel: string, payload: unknown) => {
        for (const handler of [...handlers]) handler(payload);
        return Promise.resolve();
      },
    },
    // Background-style: synchronous, returns the result object directly.
    exec: (command: string[] | { shell: string }) => execBehaviour(command),
  };

  // Side-effect import: subscribes exactly as it does inside Muxy.
  await import("../public/background.js" as string);
});

test("small results round-trip through the real background script", async () => {
  execBehaviour = (command) => {
    assert.ok(Array.isArray(command));
    assert.deepEqual(command, ["git", "rev-parse", "--show-toplevel"]);
    return { stdout: "/home/dev/projects/gateway\n", stderr: "", exitCode: 0 };
  };

  const { execViaBackground } = await import("../src/data/background-rpc.ts");
  const result = await execViaBackground(["git", "rev-parse", "--show-toplevel"]);
  assert.equal(result.stdout, "/home/dev/projects/gateway\n");
  assert.equal(result.exitCode, 0);
});

test("output far beyond the 64 KiB event cap reassembles byte for byte", async () => {
  // Control-character-heavy, like the real log format — the worst case for the
  // JSON inflation the 8 KiB chunk size exists to absorb.
  const record = `abcdef0123456789Molinfix: something\n`;
  const big = record.repeat(20_000); // ~700 KB
  execBehaviour = () => ({ stdout: big, stderr: "warning: something\n", exitCode: 0 });

  const { execViaBackground } = await import("../src/data/background-rpc.ts");
  const result = await execViaBackground(["git", "log"]);
  assert.equal(result.stdout.length, big.length);
  assert.equal(result.stdout, big, "no chunk lost, duplicated, or reordered");
  assert.equal(result.stderr, "warning: something\n");
});

test("a failing command carries its exit code and stderr", async () => {
  execBehaviour = () => ({ stdout: "", stderr: "fatal: not a git repository\n", exitCode: 128 });

  const { execViaBackground } = await import("../src/data/background-rpc.ts");
  const result = await execViaBackground(["git", "status"]);
  assert.equal(result.exitCode, 128);
  assert.match(result.stderr, /not a git repository/);
});

test("a throwing exec surfaces as a rejection, not a hang", async () => {
  execBehaviour = () => {
    throw new Error("exec failed to launch: spawn process: No such file or directory");
  };

  const { execViaBackground } = await import("../src/data/background-rpc.ts");
  await assert.rejects(() => execViaBackground(["git", "status"]), /failed to launch/);
});

test("shell-form commands pass through as scripts", async () => {
  execBehaviour = (command) => {
    assert.ok(!Array.isArray(command));
    assert.match(command.shell, /MERGE_HEAD/);
    return { stdout: "merge", stderr: "", exitCode: 0 };
  };

  const { execViaBackground } = await import("../src/data/background-rpc.ts");
  const result = await execViaBackground({ shell: "git rev-parse -q --verify MERGE_HEAD && printf merge" });
  assert.equal(result.stdout, "merge");
});

test("concurrent commands do not cross their streams", async () => {
  let call = 0;
  execBehaviour = () => {
    call += 1;
    return { stdout: `result-${call}`.repeat(3_000), stderr: "", exitCode: call };
  };

  const { execViaBackground } = await import("../src/data/background-rpc.ts");
  const [a, b, c] = await Promise.all([
    execViaBackground(["git", "one"]),
    execViaBackground(["git", "two"]),
    execViaBackground(["git", "three"]),
  ]);
  for (const [result, n] of [[a, 1], [b, 2], [c, 3]] as const) {
    assert.equal(result.exitCode, n);
    assert.ok(result.stdout.startsWith(`result-${n}`));
    assert.ok(!result.stdout.includes(`result-${n === 3 ? 1 : n + 1}`));
  }
});

test("no background script means a clean rejection", async () => {
  const muxy = (globalThis as Record<string, unknown>).muxy as {
    events: { emit: (channel: string, payload: unknown) => Promise<void> };
  };
  const realEmit = muxy.events.emit;
  muxy.events.emit = () => Promise.reject(new Error("no background script is running"));
  try {
    const { execViaBackground } = await import("../src/data/background-rpc.ts");
    await assert.rejects(() => execViaBackground(["git", "status"]), /background relay unavailable/);
  } finally {
    muxy.events.emit = realEmit;
  }
});
