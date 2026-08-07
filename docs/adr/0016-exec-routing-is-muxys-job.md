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

## Measured: exec runs locally, always

The docs say exec runs on the remote server for a remote workspace. It does not.
With `cwd` finally reaching the payload, the shell rung produced:

```
/bin/sh: line 0: cd: /home/dev/projects/gateway: No such file or directory
```

`sh` launched and then failed to `cd`. That can only happen if the shell ran on the
Mac. So `muxy.exec` is local regardless of workspace, and no cwd or shell
arrangement can reach a remote worktree.

**`muxy.git` is therefore the primary data source, not a fallback** — which is what
Muxy's own git extension relies on, and why it works on a remote. On such a
workspace the panel reads history through `muxy.git.log` and `muxy.git.status`, and
says "read-only · no shell on this workspace" in the status line rather than showing
an error. The graph, refs, branches, tags and the uncommitted row are all real.
Commit details render from the log entry the panel already holds; file lists and
diffs are unavailable because `muxy.git` has no commit-diff method, and the pane
says so instead of claiming there were no changes.

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
