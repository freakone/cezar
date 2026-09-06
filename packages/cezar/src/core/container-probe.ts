import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Can this machine actually run isolated agents, and if not, why not?
 *
 * Settings asks this to decide what to show, and the task composer asks it to
 * decide whether the isolation toggle is offered at all. Both need more than a
 * boolean: "podman is installed but its VM is stopped" is a different problem
 * from "podman is not installed", and only the first has a one-command fix.
 *
 * Deliberately non-throwing and fast. It runs on a settings page load, so a
 * missing binary or a hung VM must produce an answer, not an error page.
 */

export interface ContainerRuntimeStatus {
  /** Isolation can be used right now. */
  ready: boolean;
  /** The runtime this host would use. */
  provider: 'podman';
  /** Present on PATH. */
  installed: boolean;
  version?: string;
  /**
   * macOS/Windows run containers in a VM, which has to be running. On Linux
   * this is true whenever the runtime is installed — there is no VM.
   */
  machineRunning: boolean;
  /** Machine name, when there is one to name. */
  machineName?: string;
  /** One sentence a human can act on. Empty when `ready`. */
  reason: string;
  /** The exact command that fixes `reason`, when a single command does. */
  fix?: string;
}

const NOT_INSTALLED: Omit<ContainerRuntimeStatus, 'provider'> = {
  ready: false,
  installed: false,
  machineRunning: false,
  reason: 'podman is not installed, so agents cannot be isolated on this machine.',
  fix: 'brew install podman && podman machine init && podman machine start',
};

/** `podman machine list --format json` → is any machine running? */
export function parseMachines(stdout: string): { running: boolean; name?: string } {
  try {
    const rows = JSON.parse(stdout) as Array<{ Name?: string; Running?: boolean; LastUp?: string }>;
    if (!Array.isArray(rows) || rows.length === 0) return { running: false };
    const up = rows.find((r) => r.Running === true);
    return up ? { running: true, name: up.Name } : { running: false, name: rows[0]?.Name };
  } catch {
    return { running: false };
  }
}

export async function detectContainerRuntime(
  bin = 'podman',
  platform: NodeJS.Platform = process.platform,
): Promise<ContainerRuntimeStatus> {
  let version: string;
  try {
    const { stdout } = await run(bin, ['--version'], { timeout: 5_000 });
    // "podman version 6.1.1"
    version = stdout.trim().split(/\s+/).pop() ?? stdout.trim();
  } catch {
    return { provider: 'podman', ...NOT_INSTALLED };
  }

  // Linux runs containers directly; there is no machine to be stopped.
  if (platform === 'linux') {
    return {
      provider: 'podman', ready: true, installed: true, version,
      machineRunning: true, reason: '',
    };
  }

  let machines: { running: boolean; name?: string };
  try {
    const { stdout } = await run(bin, ['machine', 'list', '--format', 'json'], { timeout: 10_000 });
    machines = parseMachines(stdout);
  } catch {
    machines = { running: false };
  }

  if (!machines.running) {
    return {
      provider: 'podman', ready: false, installed: true, version,
      machineRunning: false, machineName: machines.name,
      reason: machines.name
        ? `podman is installed but its VM "${machines.name}" is not running.`
        : 'podman is installed but has no VM yet — containers run inside one on this platform.',
      fix: machines.name ? 'podman machine start' : 'podman machine init && podman machine start',
    };
  }

  return {
    provider: 'podman', ready: true, installed: true, version,
    machineRunning: true, machineName: machines.name, reason: '',
  };
}
