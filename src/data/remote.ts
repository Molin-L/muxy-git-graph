/**
 * Shell-command construction for running git through `muxy.exec`.
 *
 * Muxy routes `exec` to the remote server itself when the active workspace is a
 * remote SSH workspace, using the system SSH config. Extensions are not meant to
 * construct SSH invocations of their own, and this module deliberately does not.
 *
 * What it does provide is safe quoting for the one thing Muxy's spawn cannot
 * handle: a project path like `~/projects/gateway`, whose tilde `spawn(2)` cannot
 * resolve. Running the command through a shell lets the shell expand it.
 */

/** POSIX single-quoting: everything is literal inside '…', and '\'' closes,
 *  escapes a quote, and reopens. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Quotes a path while leaving a leading `~` expandable — the home directory of
 * whichever machine runs the command is not knowable from here, so `~/projects/x`
 * must reach the shell as `~/'projects/x'`.
 */
export function quotePath(path: string): string {
  if (path === "~") return "~";
  if (path.startsWith("~/")) return `~/${quote(path.slice(2))}`;
  return quote(path);
}

/** `cd <path> && <argv…>`, with every argument quoted so nothing expands. */
export function shellCommand(argv: readonly string[], path: string): string {
  return `cd ${quotePath(path)} && ${argv.map(quote).join(" ")}`;
}

/** `cd <path> && <script>`, for commands that are already shell scripts. */
export function shellScript(script: string, path: string): string {
  return `cd ${quotePath(path)} && ${script}`;
}
