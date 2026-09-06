import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LaunchOpts, ProcessLauncher } from './process-launcher.ts';
import { containerEnvPairs, guestKillScript, guestScript } from './container-runtime.ts';
import type { SandboxConfig } from '../config.ts';
import { credentialMountArgs, resolvePassthrough, type ResolvedCredential } from './credential-passthrough.ts';

/**
 * Run the agent in a Podman container while cezar stays on the host.
 *
 * Chosen over Docker Sandboxes because nothing here needs an account: no
 * registry login, no OAuth token in the macOS keychain, and therefore no
 * dependence on a GUI session — which is what made `sbx` unusable over ssh.
 * Containers also live exactly as long as we say, instead of being reclaimed
 * 30s after the last client disconnects.
 *
 * The layout, and why each part is the way it is:
 *
 *  - **The repo is mounted at its own absolute path** (`-v /Users/x:/Users/x`).
 *    cwd, `--add-dir`, the task worktree and `CEZ_HANDOFF_FILE` are then the
 *    same strings on both sides, so nothing translates paths — the single
 *    largest source of bugs in this kind of feature simply cannot occur.
 *  - **Tools live in the image, not in a setup step.** A repo builds its own
 *    image once (`Containerfile`); every task starts from it with the toolchain
 *    already present. Reinstalling per task is the thing this exists to avoid.
 *  - **Containers are per task, caches are shared.** A fresh container per task
 *    keeps tasks from polluting each other; named cache volumes (npm, pnpm)
 *    keep package installs warm anyway. Isolation without the cold start.
 *  - **Auth is passed through at file granularity.** Claude Code keeps its
 *    credential in `~/.claude/.credentials.json` and its conversations in
 *    `projects/`, `sessions/`, `history.jsonl`. Mounting only the credential
 *    gives the agent a working login while your conversation history stays
 *    invisible to it. The mount is read-WRITE on purpose: Claude Code refreshes
 *    the OAuth token and rewrites that file, so a read-only mount works right
 *    up until the token expires and then fails inscrutably.
 */

/** Where the agent's own `~/.claude` lives on the host — its conversations, not yours. */
export function agentClaudeHome(): string {
  return join(homedir(), '.claude-agent');
}

/** The host credential passed through to the container (Tier 1 passthrough). */
export function hostClaudeCredential(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

/** Image tag for a repo's prepared image. Derived, so it is stable per repo. */
export function imageTag(cfg: SandboxConfig): string {
  return cfg.image ?? `cezar-agent/${cfg.name}:latest`;
}

/** `podman build` argv for a repo's image. Run once per Containerfile change. */
export function podmanBuildArgs(cfg: SandboxConfig, containerfile: string, contextDir: string): string[] {
  return ['build', '-t', imageTag(cfg), '-f', containerfile, contextDir];
}

/**
 * `podman run` argv for one task's container. Detached and idle (`sleep
 * infinity`): cezar `exec`s the agent into it, possibly several times across a
 * multi-turn session, and tears it down when the task ends.
 */
export function podmanRunArgs(
  cfg: SandboxConfig,
  containerName: string,
  workspace: string,
  opts: { credentialPassthrough: boolean; credentials?: ResolvedCredential[] } = { credentialPassthrough: true },
): string[] {
  const args = [
    'run', '--detach', '--name', containerName,
    // Same absolute path inside — see the header.
    '-v', `${workspace}:${workspace}`,
    // The agent's OWN claude home: conversations land on the host, readable
    // from here and impossible to strand inside a container that is gone.
    '-v', `${agentClaudeHome()}:/root/.claude`,
  ];
  if (opts.credentialPassthrough) {
    // Only the credential file — never `projects/`, `sessions/` or history.
    args.push('-v', `${hostClaudeCredential()}:/root/.claude/.credentials.json`);
  }
  // Package caches survive the per-task container, so a fresh container still
  // installs fast. This is what makes "container per task" affordable.
  for (const [volume, target] of Object.entries(cfg.cacheVolumes ?? {})) {
    args.push('-v', `${volume}:${target}`);
  }
  // Anonymous volumes: a bare target with no source. Podman creates one per
  // container and drops it on `rm -v`, which is exactly the lifetime build
  // output should have — and it shadows the slow bind mount at that path.
  for (const target of cfg.ephemeralPaths ?? []) {
    args.push('-v', target);
  }
  // Credentials the operator explicitly passed through. Mounts only — the
  // copies happen after the container exists (`credentialCopyPlan`).
  args.push(...credentialMountArgs(opts.credentials ?? resolvePassthrough(cfg.credentials)));
  args.push(imageTag(cfg), 'sleep', 'infinity');
  return args;
}

/** `podman exec` argv for one agent process inside an existing container. */
export function podmanExecArgs(
  cfg: SandboxConfig,
  containerName: string,
  bin: string,
  args: string[],
  opts: LaunchOpts,
  pidFile: string,
): string[] {
  const env = { ...opts.env, CEZ_PID_FILE: pidFile };
  const envArgs = containerEnvPairs(env, cfg.tmpdir).flatMap((pair) => ['-e', pair]);
  return [
    'exec',
    // `-i` keeps stdin open for the stream-json conversation. No `-t`: cezar
    // pipes rather than allocating a terminal, and a pty would corrupt the
    // protocol with echo and line editing.
    '-i',
    '-w', opts.cwd,
    ...envArgs,
    containerName,
    'sh', '-c', guestScript(cfg.unsetPlaceholderCredentials ? ['ANTHROPIC_API_KEY', 'GH_TOKEN'] : []),
    'cez-podman', bin, ...args,
  ];
}

export class PodmanLauncher implements ProcessLauncher {
  readonly id = 'podman' as const;
  private readonly pidFiles = new WeakMap<ChildProcessWithoutNullStreams, string>();

  constructor(
    private readonly cfg: SandboxConfig,
    /** The container to exec into; the engine creates it per task. */
    private readonly containerName: string,
    private readonly bin = 'podman',
  ) {}

  describe(): string {
    return `podman container "${this.containerName}" (image ${imageTag(this.cfg)})`;
  }

  spawn(bin: string, args: string[], opts: LaunchOpts): ChildProcessWithoutNullStreams {
    const pidFile = `${this.cfg.tmpdir}/cez-${randomUUID()}.pid`;
    const child = nodeSpawn(
      this.bin,
      podmanExecArgs(this.cfg, this.containerName, bin, args, opts, pidFile),
      // The host env is what `podman` itself needs; what the AGENT sees was
      // passed explicitly via `-e` above.
      { cwd: opts.cwd, env: process.env },
    ) as ChildProcessWithoutNullStreams;
    this.pidFiles.set(child, pidFile);
    return child;
  }

  /**
   * Signal the process INSIDE the container. Killing the `podman exec` client
   * does not propagate, so a host-only kill would leave the agent running and
   * the run hung. The client is killed too, so the runner's stream closes
   * either way.
   */
  async signal(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): Promise<void> {
    const pidFile = this.pidFiles.get(child);
    if (pidFile) {
      await new Promise<void>((resolve) => {
        const killer = nodeSpawn(
          this.bin,
          ['exec', this.containerName, 'sh', '-c', guestKillScript(pidFile, sig)],
          { stdio: 'ignore' },
        );
        killer.on('error', () => resolve());
        killer.on('close', () => resolve());
      });
    }
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}
