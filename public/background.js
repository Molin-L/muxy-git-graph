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

  /*
   * Muxy shims `console` in this context too, so log lines land in the same
   * Extension Output panel as the panel's (see src/log.ts). This half cannot read
   * the verbose toggle — nothing tells a background script that a webview flipped
   * a setting — so each request carries it, and per-command lines are printed
   * only when the panel that asked was itself verbose.
   */
  function log(message) {
    try {
      console.log("[git-graph:bg] " + message);
    } catch (error) {
      // A context without the shim; the relay still works.
    }
  }

  /** Per-command chatter, printed only for a request that asked for it. */
  function debug(request, message) {
    if (request && request.verbose) log("debug " + message);
  }

  function clip(text) {
    var flat = String(text).replace(/\s+/g, " ").trim();
    return flat.length <= 120 ? flat : flat.slice(0, 119) + "…";
  }

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

    var command = payload.argv ? payload.argv.join(" ") : payload.shell;
    debug(payload, "exec " + payload.id + " cmd=" + clip(command));

    var result;
    try {
      // Synchronous in this context; Muxy owns where it runs.
      result = payload.argv
        ? muxy.exec(payload.argv.map(String))
        : muxy.exec({ shell: String(payload.shell || "") });
    } catch (error) {
      var message = String((error && error.message) || error);
      // Always: this is the relay refusing to run, which is what a panel showing
      // nothing on a remote workspace looks like from the inside.
      log("exec threw id=" + payload.id + " cmd=" + clip(command) + " error=" + clip(message));
      send({ kind: "exec-error", id: payload.id, message: message });
      return;
    }

    var stdout = String(result.stdout || "");
    var outChunks = sendChunks(payload.id, "out", stdout);
    var errChunks = sendChunks(payload.id, "err", String(result.stderr || ""));
    send({
      kind: "exec-done",
      id: payload.id,
      exitCode: Number(result.exitCode || 0),
      outChunks: outChunks,
      errChunks: errChunks,
    });
    debug(payload, "done " + payload.id + " exit=" + Number(result.exitCode || 0) +
      " bytes=" + stdout.length + " chunks=" + (outChunks + errChunks));
  });

  log("relay ready");
})();
