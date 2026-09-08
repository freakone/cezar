import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LaunchOpts, ProcessLauncher } from './process-launcher.ts';
import { containerEnvPairs, guestKillScript, guestScript } from './container-runtime.ts';
import type { SandboxConfig } from '../config.ts';
import { credentialEnvPairs, credentialMountArgs, resolvePassthrough, type ResolvedCredential } from './credential-passthrough.ts';

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

/** The shared base every repo image builds FROM, shipped with cezar itself. */
export const BASE_IMAGE_TAG = 'localhost/cezar-agent/base:latest';

/**
 * The image a repo's containers run. Precedence, highest first:
 *
 *  1. **its Containerfile**, if it has one — the repo's own declared toolchain
 *     is the most specific statement about what its agents need, and a config
 *     key must not silently shadow a file sitting in the repo. An `image` pin
 *     that overrode it produced exactly that: a project with a Containerfile
 *     quietly running the generic base, and a settings page saying so in words
 *     nobody connected to the pin;
 *  2. an explicit `sandbox.image`, for a repo that would rather point at a
 *     prebuilt image than write a Containerfile;
 *  3. the shared base — the only fallback, and only when there is nothing else.
 */
export function imageTag(cfg: SandboxConfig, hasContainerfile = true): string {
  if (hasContainerfile) return `cezar-agent/${cfg.name}:latest`;
  return cfg.image ?? BASE_IMAGE_TAG;
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
  opts: {
    credentialPassthrough: boolean;
    credentials?: ResolvedCredential[];
    /** Forwarded to the host on loopback, for HTTP-speaking backends. */
    publishPort?: number;
    /** Whether the repo has a Containerfile — decides base vs derived tag. */
    hasContainerfile?: boolean;
    /** Injectable for tests; defaults to a real filesystem check. */
    credentialExists?: (path: string) => boolean;
  } = { credentialPassthrough: true },
): string[] {
  const args = [
    'run', '--detach', '--name', containerName,
    // Same absolute path inside — see the header.
    '-v', `${workspace}:${workspace}`,
    // The agent's OWN claude home: conversations land on the host, readable
    // from here and impossible to strand inside a container that is gone.
    '-v', `${agentClaudeHome()}:/root/.claude`,
  ];
  // The Claude credential is deliberately NOT mounted — it is copied in, and
  // re-copied before every agent spawn (`syncClaudeCredential`).
  //
  // A bind mount binds an INODE, not a path. Claude Code refreshes its OAuth
  // token by writing a temp file and renaming over the original, which unlinks
  // the inode the container holds: the directory entry lingers, every read
  // fails with ENOENT, and once the old token expires the agent reports "Not
  // logged in". Observed in practice after ~35 hours. Mounting a single file
  // that its owner rewrites atomically cannot work; copying it can, and
  // re-copying keeps it fresh.
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
  // Loopback only: the agent's HTTP server is cezar's business and nobody
  // else's, so it is reachable from this machine and not from the network.
  if (opts.publishPort) args.push('-p', `127.0.0.1:${opts.publishPort}:${opts.publishPort}`);
  // Resource limits. `--shm-size` is the one that is set by DEFAULT, because
  // podman's 64m default kills any headless browser the agent starts and does
  // so with an error that reads as out-of-memory.
  if (cfg.resources?.shmSize) args.push('--shm-size', cfg.resources.shmSize);
  if (cfg.resources?.memory) args.push('--memory', cfg.resources.memory);
  if (cfg.resources?.cpus) args.push('--cpus', String(cfg.resources.cpus));
  args.push(imageTag(cfg, opts.hasContainerfile ?? true), 'sleep', 'infinity');
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
  // Credentials passed as environment variables (AWS_PROFILE, a custom
  // STRIPE_API_KEY…). Applied per EXEC rather than baked into the container, so
  // a token rotated on the host reaches the next turn of a long task. Read from
  // the host env, not from `opts.env`, which `buildChildEnv` has already
  // filtered — that filtering is why they were absent before.
  const credentialEnv = credentialEnvPairs(resolvePassthrough(cfg.credentials));
  const envArgs = [...containerEnvPairs(env, cfg.tmpdir), ...credentialEnv].flatMap((pair) => ['-e', pair]);
  return [
    'exec',
    // `-i` keeps stdin open for the stream-json conversation. No `-t`: cezar
    // pipes rather than allocating a terminal, and a pty would corrupt the
    // protocol with echo and line editing.
    '-i',
    '-w', opts.cwd,
    ...envArgs,
    containerName,
    // NOT `unsetPlaceholderCredentials`: that exists because *sbx* injects
    // `ANTHROPIC_API_KEY=proxy-managed` and a fake GH_TOKEN into PID 1. Podman
    // injects nothing, and `buildChildEnv` forwards the host's REAL
    // `ANTHROPIC_*` and `GH_TOKEN` in the `-e` pairs above — unsetting them
    // here would delete the only credential an API-key user has.
    'sh', '-c', guestScript([]),
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
    /** The port published when the container was created, if any. */
    readonly publishedPort?: number,
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
