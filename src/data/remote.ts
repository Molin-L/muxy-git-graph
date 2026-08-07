/**
 * Running git on a remote (SSH) workspace.
 *
 * `muxy.exec` spawns on the machine running Muxy, so for a project on a remote
 * device the worktree path does not exist locally and every command fails with
 * "spawn process: No such file or directory". Rather than degrade, we run the same
 * git commands over SSH ourselves.
 *
 * Connections are never dialled per command. By default we pass no control
 * options at all, so the user's own `ControlMaster`/`ControlPath`/`ControlPersist`
 * apply — `ssh -G <host>` tells us locally whether they have them. Only when a host
 * is not already set up for reuse do we impose our own persistent master.
 */

export interface RemoteTarget {
  readonly host: string;
  /** Worktree path on the remote host; may be `~`-relative. */
  readonly path: string;
}

/** BatchMode only: a hung password prompt would be worse than a clean failure. */
const SSH_BASE = ["-o", "BatchMode=yes"];

/** Imposed only on hosts the user has not already set up for reuse. */
const OWN_MASTER = [
  "-o", "ControlMaster=auto",
  "-o", "ControlPath=~/.ssh/muxy-git-graph-%C",
  "-o", "ControlPersist=120",
];

/**
 * `inherit` passes no control options, so the user's own `ControlMaster` /
 * `ControlPath` / `ControlPersist` apply. That is strictly better than anything we
 * could impose — a host may sit behind a `ProxyCommand` that probes several
 * endpoints, where forcing a different socket would redial an expensive path.
 */
export type Multiplexing = "inherit" | "own";

let multiplexing: Multiplexing = "inherit";

export function currentMultiplexing(): Multiplexing {
  return multiplexing;
}

export function fallBackToOwnMaster(): void {
  multiplexing = "own";
}

export function resetMultiplexing(): void {
  multiplexing = "inherit";
}

/** `ssh -G` resolves the effective config locally, without connecting. */
export function effectiveConfigArgv(host: string): string[] {
  return ["ssh", "-G", host];
}

/** Decides from `ssh -G` output whether the host already reuses connections. */
export function adoptEffectiveConfig(output: string): Multiplexing {
  const master = /^controlmaster[ \t]+(\S+)/im.exec(output)?.[1]?.toLowerCase();
  const path = /^controlpath[ \t]+(\S+)/im.exec(output)?.[1]?.toLowerCase();
  const reuses =
    master !== undefined && master !== "no" && master !== "false" &&
    path !== undefined && path !== "none";
  multiplexing = reuses ? "inherit" : "own";
  return multiplexing;
}

function controlOptions(): string[] {
  return multiplexing === "own" ? OWN_MASTER : [];
}

/** POSIX single-quoting: everything is literal inside '…', and '\'' closes,
 *  escapes a quote, and reopens. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Quotes a path while leaving a leading `~` expandable — the remote home is not
 * knowable from here, so `~/projects/x` must reach the remote shell as
 * `~/'projects/x'` rather than a fully quoted literal.
 */
export function quotePath(path: string): string {
  if (path === "~") return "~";
  if (path.startsWith("~/")) return `~/${quote(path.slice(2))}`;
  return quote(path);
}

export function remoteCommand(argv: readonly string[], path: string): string {
  return `cd ${quotePath(path)} && ${argv.map(quote).join(" ")}`;
}

/** Builds the local argv that runs `argv` inside `target.path` on `target.host`. */
export function wrapArgv(argv: readonly string[], target: RemoteTarget): string[] {
  return ["ssh", ...SSH_BASE, ...controlOptions(), target.host, "--",
    remoteCommand(argv, target.path)];
}

/** Wraps a `{shell}` command, which is already a shell string. */
export function wrapShell(script: string, target: RemoteTarget): string[] {
  return [
    "ssh", ...SSH_BASE, ...controlOptions(), target.host, "--",
    `cd ${quotePath(target.path)} && ${script}`,
  ];
}

/* ----------------------------------------------------------- discovery --- */

/**
 * Muxy already knows the SSH host: `projects.json` carries `remoteDeviceID` and
 * the remote `path`, and `remote-devices.json` maps that id to `ssh.host`. The
 * extension cannot read those with `muxy.files` (sandboxed to the worktree), but
 * `muxy.exec` runs on the machine holding them, so it can simply `cat` them.
 * Nothing needs to be typed.
 */
export const MUXY_CONFIG_COMMAND =
  'cat "$HOME/Library/Application Support/Muxy/projects.json" && ' +
  'printf "\\036" && ' +
  'cat "$HOME/Library/Application Support/Muxy/remote-devices.json"';

interface MuxyProject {
  name?: string;
  path?: string;
  remoteDeviceID?: string;
}

interface MuxyDevice {
  id?: string;
  name?: string;
  ssh?: { host?: string };
}

/**
 * Resolves an SSH target from Muxy's own config. `activeRoot` is the worktree path
 * as `muxy.git.repoInfo()` reports it; when it does not match, a single remote
 * project is unambiguous enough to use.
 */
export function resolveFromMuxyConfig(
  output: string,
  activeRoot: string | null,
): RemoteTarget | null {
  const [projectsRaw, devicesRaw] = output.split("\u001e");
  if (projectsRaw === undefined || devicesRaw === undefined) return null;

  let projects: MuxyProject[];
  let devices: MuxyDevice[];
  try {
    const parsedProjects: unknown = JSON.parse(projectsRaw);
    const parsedDevices: unknown = JSON.parse(devicesRaw);
    projects = Array.isArray(parsedProjects) ? parsedProjects as MuxyProject[] : [];
    devices = Array.isArray(parsedDevices) ? parsedDevices as MuxyDevice[] : [];
  } catch {
    return null;
  }

  const remotes = projects.filter(
    (p) => typeof p.remoteDeviceID === "string" && typeof p.path === "string",
  );
  if (remotes.length === 0) return null;

  const match =
    remotes.find((p) => activeRoot !== null && samePath(p.path ?? "", activeRoot)) ??
    (remotes.length === 1 ? remotes[0] : undefined);
  if (match === undefined) return null;

  const device = devices.find((d) => d.id === match.remoteDeviceID);
  const host = device?.ssh?.host ?? device?.name;
  if (host === undefined || host.trim() === "" || match.path === undefined) return null;

  return { host: host.trim(), path: match.path };
}

/** Field names Muxy might plausibly use for the SSH host of a remote project. */
const HOST_KEYS = [
  "sshHost", "remoteHost", "host", "hostname",
  "remoteDeviceName", "deviceName", "device", "remoteDevice",
];

const PATH_KEYS = ["remotePath", "path", "root", "worktreePath"];

function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    // A nested object, e.g. { ssh: { host } } or { remoteDevice: { name } }.
    if (value !== null && typeof value === "object") {
      const nested = readString(value as Record<string, unknown>, keys);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function looksRemote(record: Record<string, unknown>): boolean {
  return record.isRemote === true ||
    record.isRemoteWorkspace === true ||
    typeof record.remoteDeviceID === "string";
}

/**
 * Best-effort extraction of an SSH target from whatever `muxy.projects.list()`
 * returns. The payload shape is undocumented, so this probes a range of plausible
 * field names rather than assuming one; when nothing matches we ask the user.
 */
export function discoverTarget(
  projects: unknown,
  activeRoot: string | null,
): { target: RemoteTarget | null; path: string | null } {
  const list = Array.isArray(projects) ? projects : [];
  const records = list.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === "object",
  );

  const remotes = records.filter(looksRemote);
  const match =
    remotes.find((record) => {
      const path = readString(record, PATH_KEYS);
      return activeRoot !== null && path !== null && samePath(path, activeRoot);
    }) ?? (remotes.length === 1 ? remotes[0] : undefined);

  if (match === undefined) return { target: null, path: activeRoot };

  const path = readString(match, PATH_KEYS) ?? activeRoot;
  const host = readString(match, HOST_KEYS);
  if (host === null || path === null) return { target: null, path };
  return { target: { host, path }, path };
}

function samePath(a: string, b: string): boolean {
  const trim = (value: string): string => value.replace(/\/+$/, "");
  return trim(a) === trim(b);
}

/* ------------------------------------------------------------- storage --- */

const KEY_PREFIX = "remote:";

function storageKey(workspace: string): string {
  return `${KEY_PREFIX}${workspace}`;
}

export async function loadTarget(workspace: string): Promise<RemoteTarget | null> {
  try {
    const value = await globalThis.muxy?.storage.get(storageKey(workspace));
    if (value !== null && typeof value === "object") {
      const record = value as Partial<RemoteTarget>;
      if (typeof record.host === "string" && typeof record.path === "string") {
        return { host: record.host, path: record.path };
      }
    }
  } catch { /* first run */ }
  return null;
}

export async function saveTarget(workspace: string, target: RemoteTarget): Promise<void> {
  await globalThis.muxy?.storage.set(storageKey(workspace), target).catch(() => undefined);
}

export async function forgetTarget(workspace: string): Promise<void> {
  await globalThis.muxy?.storage.set(storageKey(workspace), null).catch(() => undefined);
}
