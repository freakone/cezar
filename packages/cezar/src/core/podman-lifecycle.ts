import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { agentClaudeHome, imageTag, podmanBuildArgs, podmanRunArgs } from './podman-launcher.ts';
import type { SandboxConfig } from '../config.ts';

const run = promisify(execFile);

/**
 * Per-task container lifecycle: the piece that turns `sandbox.enabled` into an
 * actually isolated run.
 *
 * The split is deliberate and is the answer to "each task must not start from a
 * clean image":
 *
 *  - the **image** is built once per repo from its `Containerfile` and holds the
 *    toolchain, so no task ever reinstalls it;
 *  - the **container** is per task, so one task cannot leave state that another
 *    inherits — which is most of what isolation is for;
 *  - **cache volumes** are shared and permanent, so package installs stay warm
 *    even though the container is new. That is what makes per-task affordable.
 *
 * Everything here is best-effort in one specific sense: a failure must be LOUD.
 * If the container cannot be prepared, the caller runs the task locally and says
 * so — a silent fallback would run model-authored shell commands on the host
 * while the config promised a sandbox.
 */

export class PodmanUnavailable extends Error {}

/** Container name for a run. Prefixed so a stray one is obviously cezar's. */
export function taskContainerName(runId: string): string {
  return `cez-${runId.slice(0, 8)}`;
}

async function podman(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(bin, args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new PodmanUnavailable((e.stderr || e.message || 'podman failed').trim());
  }
}

/**
 * Build the repo's image if it is not present. A missing Containerfile is not
 * an error: the repo simply has no image of its own and the configured (or
 * default) tag is expected to exist already — pulled, or built by hand.
 */
export async function ensureImage(
  cfg: SandboxConfig,
  repoRoot: string,
  bin = 'podman',
): Promise<void> {
  const tag = imageTag(cfg);
  const exists = await run(bin, ['image', 'exists', tag]).then(() => true).catch(() => false);
  if (exists) return;
  const containerfile = join(repoRoot, cfg.containerfile);
  const hasFile = await run('test', ['-f', containerfile]).then(() => true).catch(() => false);
  if (!hasFile) {
    throw new PodmanUnavailable(
      `image ${tag} is not present and ${cfg.containerfile} does not exist — ` +
        'build the image or point `sandbox.image` at one that exists',
    );
  }
  await podman(bin, podmanBuildArgs(cfg, containerfile, repoRoot));
}

/**
 * Start this task's container, building the image first if needed. Returns the
 * container name for `createLauncher`. Idempotent: an existing container with
 * the same name is reused, which is what makes a Continue land in the same
 * place as the run it resumes.
 */
export async function startTaskContainer(
  cfg: SandboxConfig,
  repoRoot: string,
  runId: string,
  bin = 'podman',
): Promise<string> {
  const name = taskContainerName(runId);
  const running = await run(bin, ['container', 'exists', name]).then(() => true).catch(() => false);
  if (running) {
    // A stopped container from an earlier turn still has to be woken.
    await run(bin, ['start', name]).catch(() => undefined);
    return name;
  }
  await ensureImage(cfg, repoRoot, bin);
  // The agent's own claude home must exist before it is mounted, or podman
  // creates it root-owned inside the VM and the agent cannot write its
  // transcripts.
  mkdirSync(agentClaudeHome(), { recursive: true });
  await podman(bin, podmanRunArgs(cfg, name, repoRoot, {
    credentialPassthrough: cfg.claudeCredentialPassthrough,
  }));
  return name;
}

/** Remove this task's container. Never throws — teardown must not fail a run. */
export async function removeTaskContainer(runId: string, bin = 'podman'): Promise<void> {
  // `-v` so the anonymous volumes (node_modules and friends) go with it —
  // without it every task would leak a multi-hundred-MB volume.
  await run(bin, ['rm', '-f', '-v', taskContainerName(runId)]).catch(() => undefined);
}
