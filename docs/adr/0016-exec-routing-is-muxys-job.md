# Do not build an SSH transport; exec is Muxy's job

> **Reversed.** An earlier revision of this ADR had the extension construct its own
> `ssh` invocations when `muxy.exec` could not reach a remote worktree. That was
> wrong and has been removed.

Muxy's documentation is explicit: when the active workspace is a remote SSH
workspace, `muxy.exec`, `muxy.execAsync`, `muxy.git.*` and worktree operations run
**on the remote server**, and path arguments including `cwd` are interpreted as
remote paths. Muxy owns the SSH connection, using the system SSH config, keys and
agent. Extensions are not meant to dial their own.

The extension bridge confirms the surface: `buildExecPayload` accepts exactly
`argv`, `shell`, `cwd`, `env`, `stdin` and `timeoutMs`. There is no project or
worktree selector, because `exec` always targets the active workspace.

So the data layer resolves only two transports:

1. **`direct`** — plain `muxy.exec(argv)`.
2. **`shellCwd`** — `muxy.exec({shell: "cd <path> && …"}, {cwd})`. Muxy reports a
   remote project's path as `~/projects/gateway`, tilde intact, and `spawn(2)`
   cannot resolve `~` — so a bare exec fails with `No such file or directory` even
   for `git --version`, which never reads the cwd. A shell can expand it.

If both fail, the workspace is not reachable and there is nothing the extension can
legitimately do. It says so precisely and records the probe to
`storage["diagnostics.lastProbe"]` for a bug report against Muxy.

## Evidence gathered

- On the remote host, `git` is at `/usr/bin/git` and on the default non-interactive
  `PATH`, and `~/projects/gateway` resolves. A correctly routed exec would work.
- The audit log shows `git --version` failing. That command never reads the working
  directory, so the failure is at spawn, not in git.

## Consequences

- `remote.ts` is now only shell quoting: `quote`, `quotePath`, `shellCommand`,
  `shellScript`. Its tests prove arguments round-trip through a real `/bin/sh`.
- Rejected alternatives, recorded so they are not retried: constructing `ssh`
  invocations, reading `remote-devices.json` to resolve a host, and asking the user
  to type a host and path.
