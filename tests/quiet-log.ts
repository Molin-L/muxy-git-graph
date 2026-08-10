/**
 * Side-effect import that keeps `src/log.ts` out of the test runner's output.
 *
 * The logger writes through `console`, which is exactly what makes it visible in
 * Muxy's Extension Output panel — and exactly what makes a data-layer test that
 * walks the transport ladder print seventy lines of its own. Only our own lines
 * are dropped; anything else a test prints still gets through.
 *
 * `tests/log.test.ts` deliberately does not import this: it asserts on the lines.
 */

const PREFIX = "[git-graph";
const original = { log: console.log, warn: console.warn, error: console.error };

for (const level of ["log", "warn", "error"] as const) {
  console[level] = (...args: unknown[]): void => {
    if (typeof args[0] === "string" && args[0].startsWith(PREFIX)) return;
    original[level](...args);
  };
}
