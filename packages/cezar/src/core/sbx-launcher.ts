import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { LaunchOpts, ProcessLauncher } from './process-launcher.ts';
import type { SandboxConfig } from '../config.ts';
import { containerEnvPairs, guestKillScript, guestScript } from './container-runtime.ts';

/**
 * Run the agent inside a Docker Sandboxes sandbox (`sbx`) while cezar itself
 * stays on the host. Kept alongside the podman launcher for hosts already
 * standardised on sbx; podman is the default because it needs no account, no
 * registry login and no macOS keychain, and therefore works over ssh.
 *
 * The mechanics it shares with every container launcher — the host-env filter,
 * the container-local `TMPDIR` override, and the guest shell that records the
 * agent's pid so it can be signalled from outside — live in
 * `container-runtime.ts`; each was learned from a failure, and re-deriving them
 * per provider is how the same bug ships twice.
 *
 * Two things are specific to sbx:
 *  - it bind-mounts the workspace at the SAME absolute path inside, so nothing
 *    here translates paths;
 *  - it injects placeholder credentials into PID 1
 *    (`ANTHROPIC_API_KEY=proxy-managed`, a `gho_sbxproxymanaged…` GH_TOKEN)
 *    which shadow the real logins inside the container.
 *
 * Lifecycle note: sbx stops a sandbox 30s after the last session disconnects.
 * A run holds a session for as long as the agent process lives, so the sandbox
 * stays up for the whole run and is reclaimed shortly after.
 */

/** Placeholder credentials sbx injects into PID 1; they shadow real logins. */
const SANDBOX_PLACEHOLDER_CREDS = ['ANTHROPIC_API_KEY', 'GH_TOKEN'];

/** Full `sbx exec …` argv for one agent process. Pure — the unit tests read it. */
export function sbxExecArgs(
  cfg: SandboxConfig,
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
    // protocol with echo and line-editing.
    '-i',
    // Same absolute path inside — see the header.
    '-w', opts.cwd,
    ...envArgs,
    cfg.name,
    'sh', '-c', guestScript(cfg.unsetPlaceholderCredentials ? SANDBOX_PLACEHOLDER_CREDS : []),
    'cez-sbx', bin, ...args,
  ];
}

/**
 * `sbx create …` argv for a repo's sandbox. Named and reused across tasks: a
 * clean sandbox per task would reinstall the toolchain every time. `image`
 * picks the template it is built from, so a repo can supply one that already
 * carries its dependencies.
 */
export function sbxCreateArgs(cfg: SandboxConfig, workspace: string): string[] {
  return [
    'create',
    '--name', cfg.name,
    ...(cfg.image ? ['--template', cfg.image] : []),
    cfg.agent,
    workspace,
  ];
}

export class SbxLauncher implements ProcessLauncher {
  readonly id = 'sbx' as const;
  /** Per-child pid files, so `signal()` can find the process inside. */
  private readonly pidFiles = new WeakMap<ChildProcessWithoutNullStreams, string>();

  constructor(
    private readonly cfg: SandboxConfig,
    private readonly bin = 'sbx',
  ) {}

  describe(): string {
    return `sandbox "${this.cfg.name}"${this.cfg.image ? ` (image ${this.cfg.image})` : ''}`;
  }

  spawn(bin: string, args: string[], opts: LaunchOpts): ChildProcessWithoutNullStreams {
    const pidFile = `${this.cfg.tmpdir}/cez-${randomUUID()}.pid`;
    const child = nodeSpawn(
      this.bin,
      sbxExecArgs(this.cfg, bin, args, opts, pidFile),
      // The host env is what `sbx` itself needs (its own PATH, Docker config);
      // what the AGENT sees was passed explicitly via `-e` above.
      { cwd: opts.cwd, env: process.env },
    ) as ChildProcessWithoutNullStreams;
    this.pidFiles.set(child, pidFile);
    return child;
  }

  /**
   * Signal the process INSIDE the container. Killing the `sbx exec` client does
   * not propagate — verified: a `sleep` outlived its client — so a host-only
   * kill would leave the agent running and the run hung. The client is killed
   * too, so the runner's stream closes either way.
   */
  async signal(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): Promise<void> {
    const pidFile = this.pidFiles.get(child);
    if (pidFile) {
      await new Promise<void>((resolve) => {
        const killer = nodeSpawn(
          this.bin,
          ['exec', this.cfg.name, 'sh', '-c', guestKillScript(pidFile, sig)],
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
