/**
 * The extension's log, which is Muxy's **Extension Output** panel.
 *
 * Muxy wraps `console.log`, `console.warn` and `console.error` in every surface it
 * runs — webviews through a `muxyConsole` message handler, `background.js` through
 * a `console` shim — and tails them into that panel, along with uncaught errors and
 * unhandled rejections. So `console` *is* the channel: there is no log API to call
 * and nothing to open. `console.debug` is **not** wrapped, which is why debug lines
 * below go out over `console.log`.
 * See docs/adr/0020-log-to-muxys-extension-output.md.
 *
 * Two volumes. `info`/`warn`/`error` are milestones — a project bound, a transport
 * rung settled, a reload finished, an action failed — and are always on, because
 * the panel is shared with every other extension and a line every poll would drown
 * it. `debug` is per-command chatter (every exec, every relay round trip) and stays
 * off until someone asks for it with ⌘⌥L.
 */

const TAG = "git-graph";

/** Whether the verbose toggle survives a panel reload. */
const STORAGE_KEY = "log.verbose";

export type Fields = Record<string, unknown>;

type Level = "debug" | "info" | "warn" | "error";

/** Which surface is writing. The panel, the diff tab and the relay all land in
 *  one panel, so a line that does not name its origin is barely a line. */
let surface = "?";

let verbose = false;

export function useSurface(name: string): void {
  surface = name;
}

export function isVerbose(): boolean {
  return verbose;
}

/** Read before the surface starts, so a debugging session survives a reload. */
export async function restoreVerbose(): Promise<void> {
  try {
    verbose = (await globalThis.muxy?.storage.get(STORAGE_KEY)) === true;
  } catch { /* first run */ }
}

export function setVerbose(on: boolean): void {
  verbose = on;
  // Announced at info so the panel shows why it just got noisy — or quiet.
  info(on ? "verbose logging on" : "verbose logging off");
  void Promise.resolve(globalThis.muxy?.storage.set(STORAGE_KEY, on)).catch(() => undefined);
}

export function debug(message: string, fields?: Fields): void {
  emit("debug", message, fields);
}

export function info(message: string, fields?: Fields): void {
  emit("info", message, fields);
}

export function warn(message: string, fields?: Fields): void {
  emit("warn", message, fields);
}

export function error(message: string, fields?: Fields): void {
  emit("error", message, fields);
}

/** Commands and git output are unbounded; the panel's line is not. */
export function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function format(level: Level, message: string, fields?: Fields): string {
  // Only `debug` names its level: Muxy already labels warn and err lines, and
  // info is the unremarkable case.
  const head = `[${TAG}:${surface}]${level === "debug" ? " debug" : ""} ${message}`;
  if (fields === undefined) return head;
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    pairs.push(`${key}=${render(value)}`);
  }
  return pairs.length === 0 ? head : `${head} ${pairs.join(" ")}`;
}

function emit(level: Level, message: string, fields?: Fields): void {
  if (level === "debug" && !verbose) return;
  const line = format(level, message, fields);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** `key=value`, quoted only when the value would otherwise run into the next pair. */
function render(value: unknown): string {
  if (value instanceof Error) return render(value.message);
  if (typeof value === "string") return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The message of whatever was thrown — every catch site here wants this. */
export function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
