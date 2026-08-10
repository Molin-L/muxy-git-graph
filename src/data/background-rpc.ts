/**
 * Client half of the background exec relay (see public/background.js and
 * docs/adr/0017-background-exec-relay.md). The webview's own `muxy.exec` spawns
 * on the machine running Muxy; the background script's exec is the context Muxy
 * documents as running on the remote server for a remote SSH workspace. Commands
 * go over the same-extension event channel and come back chunked, because event
 * payloads are capped at 64 KiB.
 */

import * as log from "../log.ts";
import type { ExecResult } from "../muxy.d.ts";

const CHANNEL = "extension.git-graph";
const DEFAULT_TIMEOUT_MS = 60_000;

interface Pending {
  resolve(result: ExecResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  out: string[];
  err: string[];
}

interface ResponseMessage {
  kind?: string;
  id?: string;
  stream?: "out" | "err";
  seq?: number;
  data?: string;
  exitCode?: number;
  outChunks?: number;
  errChunks?: number;
  message?: string;
}

const pending = new Map<string, Pending>();
let subscribedTo: unknown = null;
let counter = 0;

/** Each surface gets its own prefix so the panel and the diff tab, which share
 *  the channel, ignore one another's responses. */
const SURFACE = Math.random().toString(36).slice(2, 10);

function finish(id: string): Pending | undefined {
  const entry = pending.get(id);
  if (entry !== undefined) {
    pending.delete(id);
    clearTimeout(entry.timer);
  }
  return entry;
}

function onMessage(raw: unknown): void {
  const message = raw as ResponseMessage;
  if (typeof message?.id !== "string") return;
  const entry = pending.get(message.id);
  if (entry === undefined) return;

  switch (message.kind) {
    case "exec-chunk": {
      const target = message.stream === "err" ? entry.err : entry.out;
      if (typeof message.seq === "number" && typeof message.data === "string") {
        target[message.seq] = message.data;
      }
      return;
    }
    case "exec-done": {
      const complete = finish(message.id);
      if (complete === undefined) return;
      const filled = (parts: string[], expected: number): string | null => {
        if (parts.length !== expected) return null;
        for (let i = 0; i < expected; i++) if (typeof parts[i] !== "string") return null;
        return parts.join("");
      };
      const stdout = filled(complete.out, message.outChunks ?? 0);
      const stderr = filled(complete.err, message.errChunks ?? 0);
      if (stdout === null || stderr === null) {
        complete.reject(new Error("background exec reply was missing chunks"));
        return;
      }
      complete.resolve({ stdout, stderr, exitCode: message.exitCode ?? 0 });
      return;
    }
    case "exec-error": {
      finish(message.id)?.reject(new Error(message.message ?? "background exec failed"));
      return;
    }
    default:
      // "exec" requests (ours or another surface's) and unknown kinds.
  }
}

function ensureSubscribed(): void {
  const events = globalThis.muxy?.events;
  if (!events) throw new Error("muxy.events is unavailable on this surface");
  // Keyed on identity, not a boolean: if the bridge is ever re-injected the old
  // subscription is on a dead bus and every request would time out.
  if (subscribedTo === events) return;
  events.subscribe(CHANNEL, onMessage);
  subscribedTo = events;
}

export function execViaBackground(
  command: string[] | { shell: string },
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ExecResult> {
  ensureSubscribed();
  const id = `${SURFACE}-${++counter}`;
  const label = Array.isArray(command) ? command.join(" ") : command.shell;
  const started = Date.now();

  return new Promise<ExecResult>((resolve, reject) => {
    pending.set(id, {
      resolve: (result) => {
        log.debug("relay done", {
          id, exit: result.exitCode, bytes: result.stdout.length, ms: Date.now() - started,
        });
        resolve(result);
      },
      reject: (error) => {
        log.debug("relay failed", { id, ms: Date.now() - started, error: log.reason(error) });
        reject(error);
      },
      out: [],
      err: [],
      timer: setTimeout(() => {
        finish(id)?.reject(
          new Error(`Timed out after ${timeoutMs / 1000}s waiting for background exec: ${label}`),
        );
      }, timeoutMs),
    });

    // `verbose` travels with the request because the background context cannot
    // read the toggle: its bridge has storage, but nothing tells it the panel
    // flipped one. Carrying it per request keeps both halves of the relay on the
    // same setting without a second channel.
    const verbose = log.isVerbose();
    log.debug("relay exec", { id, cmd: log.clip(label) });
    const request = Array.isArray(command)
      ? { kind: "exec", id, argv: command, verbose }
      : { kind: "exec", id, shell: command.shell, verbose };

    // A webview emit is relayed through background.js and rejects when no
    // background script is running — which is exactly the failure we want here.
    Promise.resolve(globalThis.muxy?.events.emit(CHANNEL, request)).catch((error: unknown) => {
      finish(id)?.reject(new Error(
        `background relay unavailable: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
  });
}
