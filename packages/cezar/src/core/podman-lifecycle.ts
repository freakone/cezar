import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { BASE_IMAGE_TAG, agentClaudeHome, imageTag, podmanBuildArgs, podmanRunArgs } from './podman-launcher.ts';
import type { SandboxConfig } from '../config.ts';
import { credentialCopyPlan, resolvePassthrough } from './credential-passthrough.ts';

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
/** `containers/agent-base.Containerfile`, in the installed package or the checkout. */
export function baseContainerfilePath(): string {
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  const here = fileURLToPath(new URL('.', import.meta.url));
  return join(here, '..', '..', 'containers', 'agent-base.Containerfile');
}

/**
 * Build the shared base image if this machine does not have it yet.
 *
 * Without this, isolation works only on a machine where someone built the base
 * by hand — and fails everywhere else with "image is not present", naming a tag
 * the user has never heard of. The base is cezar's own artifact, so cezar
 * builds it.
 */
export async function ensureBaseImage(bin = 'podman'): Promise<void> {
  const exists = await run(bin, ['image', 'exists', BASE_IMAGE_TAG]).then(() => true).catch(() => false);
  if (exists) return;
  const file = baseContainerfilePath();
  if (!existsSync(file)) {
    throw new PodmanUnavailable(
      `the cezar agent base image is missing and ${file} was not found — reinstall cezar, or set ` +
        '`sandbox.image` to an image that exists',
    );
  }
  await podman(bin, ['build', '-t', BASE_IMAGE_TAG, '-f', file, dirname(file)]);
}

export async function ensureImage(
  cfg: SandboxConfig,
  repoRoot: string,
  bin = 'podman',
): Promise<void> {
  const containerfile = join(repoRoot, cfg.containerfile);
  const hasFile = existsSync(containerfile);
  const tag = imageTag(cfg, hasFile);
  const exists = await run(bin, ['image', 'exists', tag]).then(() => true).catch(() => false);
  // An existing image is reused UNLESS its Containerfile has changed since it
  // was built. That is what makes an accepted suggestion take effect on the
  // NEXT task rather than never: without this check a stale tag would be
  // reused forever, and rebuilding unconditionally would pay a full image
  // build before every task, which is exactly the cost this design avoids.
  if (exists && !(hasFile && (await containerfileIsNewer(containerfile, tag, bin)))) return;
  if (!hasFile) {
    // No repo Containerfile: the base IS the image for this project. A repo
    // with no toolchain of its own is the ordinary case, not a
    // misconfiguration — and the settings page promises exactly this ("tasks
    // run on the generic base image"). Throwing here made the DEFAULT config
    // unable to isolate at all.
    await ensureBaseImage(bin);
    return;
  }
  // A repo Containerfile builds FROM the base, so the base has to exist first.
  await ensureBaseImage(bin);
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
    hasContainerfile: existsSync(join(repoRoot, cfg.containerfile)),
  }));
  // Copies happen after the container exists, because `podman cp` needs a
  // target. Failing to place one is not fatal to the run: the agent will report
  // the tool being logged out, which is a far clearer symptom than a container
  // that refused to start.
  for (const args of credentialCopyPlan(credentials, name)) {
    // `podman cp` fails when the destination's parent is absent, and the base
    // image has no `/root/.config/gh` or `/root/.docker`. Without this the copy
    // failed silently and the agent reported the tool as logged out, with
    // nothing in the run log to explain why.
    const dest = args[2]?.split(':')[1];
    if (dest) await run(bin, ['exec', name, 'mkdir', '-p', dirname(dest)]).catch(() => undefined);
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


/** Remove this task's container. Never throws — teardown must not fail a run. */
export async function removeTaskContainer(runId: string, bin = 'podman'): Promise<void> {
  // `-v` so the anonymous volumes (node_modules and friends) go with it —
  // without it every task would leak a multi-hundred-MB volume.
  await run(bin, ['rm', '-f', '-v', taskContainerName(runId)]).catch(() => undefined);
}
