import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { agentClaudeHome, imageTag, podmanBuildArgs, podmanRunArgs } from './podman-launcher.ts';
import type { SandboxConfig } from '../config.ts';
import { credentialCopyPlan, credentialEnvPairs, resolvePassthrough } from './credential-passthrough.ts';

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
  const containerfile = join(repoRoot, cfg.containerfile);
  const hasFile = existsSync(containerfile);
  const exists = await run(bin, ['image', 'exists', tag]).then(() => true).catch(() => false);
  // An existing image is reused UNLESS its Containerfile has changed since it
  // was built. That is what makes an accepted suggestion take effect on the
  // NEXT task rather than never: without this check a stale tag would be
  // reused forever, and rebuilding unconditionally would pay a full image
  // build before every task, which is exactly the cost this design avoids.
  if (exists && !(hasFile && (await containerfileIsNewer(containerfile, tag, bin)))) return;
  if (!hasFile) {
    throw new PodmanUnavailable(
      `image ${tag} is not present and ${cfg.containerfile} does not exist — ` +
        'build the image or point `sandbox.image` at one that exists',
    );
  }
  await podman(bin, podmanBuildArgs(cfg, containerfile, repoRoot));
}

/**
 * Was the Containerfile edited after the image was built? Compares the file's
 * mtime with the image's creation stamp. Unreadable either way answers `false`:
 * a probe that cannot tell must not trigger a rebuild before every task.
 */
async function containerfileIsNewer(containerfile: string, tag: string, bin: string): Promise<boolean> {
  try {
    const { stdout } = await run(bin, ['image', 'inspect', tag, '--format', '{{.Created}}']);
    const built = Date.parse(stdout.trim());
    if (Number.isNaN(built)) return false;
    return statSync(containerfile).mtimeMs > built;
  } catch {
    return false;
  }
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
): Promise<TaskContainer> {
  const name = taskContainerName(runId);
  const running = await run(bin, ['container', 'exists', name]).then(() => true).catch(() => false);
  if (running) {
    // A stopped container from an earlier turn still has to be woken.
    await run(bin, ['start', name]).catch(() => undefined);
    return { name, publishedPort: await publishedPortOf(name, bin) };
  }
  // Allocated BEFORE the container exists, because publishing is a
  // creation-time property: an HTTP-speaking backend that discovers it needs a
  // port later would have nowhere to put it.
  const publishPort = await freePort();
  await ensureImage(cfg, repoRoot, bin);
  // The agent's own claude home must exist before it is mounted, or podman
  // creates it root-owned inside the VM and the agent cannot write its
  // transcripts.
  mkdirSync(agentClaudeHome(), { recursive: true });
  const credentials = resolvePassthrough(cfg.credentials);
  await podman(bin, podmanRunArgs(cfg, name, repoRoot, {
    credentialPassthrough: cfg.claudeCredentialPassthrough,
    credentials,
    publishPort,
  }));
  // Copies happen after the container exists, because `podman cp` needs a
  // target. Failing to place one is not fatal to the run: the agent will report
  // the tool being logged out, which is a far clearer symptom than a container
  // that refused to start.
  for (const args of credentialCopyPlan(credentials, name)) {
    await run(bin, args).catch(() => undefined);
  }
  return { name, publishedPort: publishPort };
}

/** What `startTaskContainer` hands back: where to exec, and the forwarded port. */
export interface TaskContainer {
  name: string;
  /** Host port forwarded to the same port inside, for HTTP-speaking backends. */
  publishedPort?: number;
}

/** An unused loopback port, asked of the OS rather than guessed. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** Re-read the published port of a container we did not just create. */
async function publishedPortOf(name: string, bin: string): Promise<number | undefined> {
  try {
    const { stdout } = await run(bin, ['port', name]);
    // "40123/tcp -> 127.0.0.1:40123"
    const match = /^(\d+)\/tcp/m.exec(stdout.trim());
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `KEY=VALUE` pairs for credentials passed through as environment variables.
 * Applied per exec rather than baked into the container, so a token rotated on
 * the host reaches the next turn of a long-running task.
 */
export function credentialEnvFor(cfg: SandboxConfig): string[] {
  return credentialEnvPairs(resolvePassthrough(cfg.credentials));
}

/** Remove this task's container. Never throws — teardown must not fail a run. */
export async function removeTaskContainer(runId: string, bin = 'podman'): Promise<void> {
  // `-v` so the anonymous volumes (node_modules and friends) go with it —
  // without it every task would leak a multi-hundred-MB volume.
  await run(bin, ['rm', '-f', '-v', taskContainerName(runId)]).catch(() => undefined);
}
