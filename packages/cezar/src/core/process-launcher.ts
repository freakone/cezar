import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * WHERE an agent process runs, as a seam separate from WHICH agent runs.
 *
 * Every runner (`claude`, `codex`, `opencode`, `pi`) spawns its CLI the same
 * way — `spawn(bin, args, { cwd, env })` — so isolation is not a property of
 * the backend and must not become a fifth `RunnerId`. It is a property of the
 * launcher: `local` runs the CLI on this machine, `sbx` runs the identical
 * argv inside a Docker Sandboxes sandbox.
 *
 * The seam carries `signal()` as well as `spawn()` because the two diverge:
 * locally, killing the child kills the agent; through `sbx exec`, killing the
 * client leaves the agent running inside the container (measured, not assumed).
 * Every runner arms a SIGTERM→SIGKILL watchdog on teardown and signals on
 * `interrupt()`, so a launcher that cannot reach its own process would silently
 * lose both.
 */
export interface LaunchOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ProcessLauncher {
  /** Stable id for logs, run records and config. */
  readonly id: 'local' | 'sbx' | 'podman';
  /** One line naming where this launcher puts the agent — shown in run notes. */
  describe(): string;
  spawn(bin: string, args: string[], opts: LaunchOpts): ChildProcessWithoutNullStreams;
  /**
   * Deliver `sig` to the agent process. Resolves once the signal has been
   * *sent*, never waiting for the process to die — callers layer their own
   * escalation timers on top.
   */
  signal(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): Promise<void>;
}

/** The launcher cezar has always used: spawn on this machine. */
export class LocalLauncher implements ProcessLauncher {
  readonly id = 'local' as const;

  describe(): string {
    return 'this machine';
  }

  spawn(bin: string, args: string[], opts: LaunchOpts): ChildProcessWithoutNullStreams {
    return nodeSpawn(bin, args, { cwd: opts.cwd, env: opts.env }) as ChildProcessWithoutNullStreams;
  }

  async signal(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): Promise<void> {
    // `kill` throws only for an already-reaped pid, which is the outcome we want.
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}

/** The default launcher, so existing call sites keep their exact behaviour. */
export const localLauncher = new LocalLauncher();
