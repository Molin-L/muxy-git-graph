/*
 * Exec relay. Webview exec spawns on the machine running Muxy, so it can never
 * reach a remote worktree. This background context is the one place Muxy
 * documents exec as running "on the remote server" for a remote SSH workspace
 * (docs/extensions/scripts), so the panel sends commands here when its own exec
 * cannot reach the repository. See docs/adr/0017-background-exec-relay.md.
 *
 * Protocol, on the "extension.git-graph" channel:
 *   request:  { kind: "exec", id, argv? | shell? }
 *   response: { kind: "exec-chunk", id, stream: "out"|"err", seq, data } ...
 *             { kind: "exec-done", id, exitCode, outChunks, errChunks }
 *   failure:  { kind: "exec-error", id, message }
 *
 * Responses are chunked because extension event payloads are capped at 64 KiB.
 * Chunks are 8 KiB of raw text: JSON escaping can inflate control-character-heavy
 * git output (the \x1f/\x1e record separators) up to 6x, and 48 KiB plus the
 * envelope still fits.
 */

(function () {
  "use strict";
  if (typeof muxy === "undefined" || !muxy.events || !muxy.exec) return;

  var CHANNEL = "extension.git-graph";
  var CHUNK = 8 * 1024;

  function send(message) {
    try {
      muxy.events.emit(CHANNEL, message);
    } catch (error) {
      // The requesting webview is gone; nothing useful to do.
    }
  }

  function sendChunks(id, stream, text) {
    var count = 0;
    for (var i = 0; i < text.length; i += CHUNK) {
      send({ kind: "exec-chunk", id: id, stream: stream, seq: count, data: text.slice(i, i + CHUNK) });
      count += 1;
    }
    return count;
  }

  muxy.events.subscribe(CHANNEL, function (payload) {
    if (!payload || payload.kind !== "exec" || typeof payload.id !== "string") return;

    var result;
    try {
      // Synchronous in this context; Muxy owns where it runs.
      result = payload.argv
        ? muxy.exec(payload.argv.map(String))
        : muxy.exec({ shell: String(payload.shell || "") });
    } catch (error) {
      send({
        kind: "exec-error",
        id: payload.id,
        message: String((error && error.message) || error),
      });
      return;
    }

    var outChunks = sendChunks(payload.id, "out", String(result.stdout || ""));
    var errChunks = sendChunks(payload.id, "err", String(result.stderr || ""));
    send({
      kind: "exec-done",
      id: payload.id,
      exitCode: Number(result.exitCode || 0),
      outChunks: outChunks,
      errChunks: errChunks,
    });
  });
})();
