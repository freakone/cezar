/**
 * Pieces every container launcher needs, independent of the runtime driving it
 * (`sbx`, `podman`, whatever comes next). They are here rather than in one
 * launcher because each was learned from a failure, and re-deriving them per
 * provider is how the same bug ships twice.
 */

/**
 * Variables that describe the HOST and must never cross into a container: a
 * macOS `PATH` resolves to nothing inside Linux, `HOME` points at a directory
 * that is not there, and TMPDIR/TEMP/TMP are replaced with container-local
 * scratch (see `containerEnvPairs`).
 */
export const HOST_ONLY_ENV: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'SHLVL', '_',
  'TMPDIR', 'TEMP', 'TMP',
  // Host paths to an agent's home (an agent account sets them). Inside the container the agent's
  // home is the mounted one, logged in with the SELECTED account's credential; a Mac path would
  // send it looking for a login — and a place to keep its conversation — that is not there.
  'KIMI_CODE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  // Host paths that mean nothing in Linux and change how tools behave: gh reads its config from
  // XDG_CONFIG_HOME (so the copied hosts.yml was ignored), NODE_OPTIONS can `--require` a Mac
  // file, and the ssh variables point at a socket or a command on the host.
  'XDG_CONFIG_HOME', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_SSH_COMMAND', 'GIT_SSH',
]);

/** A proxy on the host's loopback is the CONTAINER's loopback inside it: nothing listens there. */
const PROXY_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']);
function isLoopbackProxy(value: string): boolean {
  return /\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(value);
}

/**
 * `KEY=VALUE` pairs to hand a container runtime's `-e`. Everything cezar set
 * for this run (`CEZ_HANDOFF_FILE`, `CEZ_TASK_ID`, model knobs the agent reads)
 * crosses; host-shaped values do not.
 *
 * `guestTmp` overrides TMPDIR/TEMP/TMP unconditionally. cezar points those at
 * `<repo>/.ai/cezar/tmp/<runId>` (#785), which inside a container is the host
 * bind mount — and the native `claude` binary does a startup temp-file
 * operation that such a mount cannot serve, dying with an opaque
 * `ENOENT: no such file or directory, fstat` before it logs a single line.
 */
export function containerEnvPairs(env: NodeJS.ProcessEnv, guestTmp: string): string[] {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || HOST_ONLY_ENV.has(k)) continue;
    if (PROXY_NAMES.has(k) && isLoopbackProxy(v)) continue;
    pairs.push(`${k}=${v}`);
  }
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) pairs.push(`${name}=${guestTmp}`);
  return pairs.sort();
}

/**
 * The shell wrapped around the agent inside the container.
 *
 * It records its own pid BEFORE `exec`, and `exec` replaces the shell in place
 * — so the recorded pid IS the agent's. That file is the only way to signal a
 * process no host signal can reach: killing an `exec` client (sbx or podman)
 * leaves the process inside running, which was measured, not assumed.
 *
 * `unsetCredentials` drops placeholder credentials a runtime injects into the
 * container (sbx sets `ANTHROPIC_API_KEY=proxy-managed` and a fake `GH_TOKEN`
 * in PID 1) so a real login mounted into the container wins.
 */
export function guestScript(unsetCredentials: readonly string[] = []): string {
  const unset = unsetCredentials.length > 0 ? `unset ${unsetCredentials.join(' ')}; ` : '';
  return `${unset}mkdir -p "$TMPDIR"; echo $$ > "$CEZ_PID_FILE"; exec "$@"`;
}

/** `kill` the recorded pid inside the container; never fails the caller. */
export function guestKillScript(pidFile: string, sig: NodeJS.Signals): string {
  return `kill -${sig.replace(/^SIG/, '')} "$(cat ${pidFile})" 2>/dev/null || true`;
}
