import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { BASE_IMAGE_TAG, agentClaudeHome, hostClaudeCredential, imageTag, podmanBuildArgs, podmanRunArgs } from './podman-launcher.ts';
import type { SandboxConfig } from '../config.ts';
import {
  credentialCopyPlan,
  resolvePassthrough,
  sanitizeSshConfig,
  type ResolvedCredential,
} from './credential-passthrough.ts';

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
    // An explicit pin is expected to exist already — cezar has nothing to build
    // it from — so only the base is built here.
    if (cfg.image) return;
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
    // Every spawn re-copies, so a token refreshed on the host reaches the next
    // turn of a long task — the property a mount was supposed to give and
    // could not (see `podmanRunArgs`).
    if (cfg.claudeCredentialPassthrough) await syncClaudeCredential(name, bin);
    // And the same for everything else that is COPIED, so a credential ticked
    // after this container started reaches the next turn of the task instead of
    // waiting for a task that does not exist yet. Mounts cannot be refreshed
    // this way — they are fixed at creation — which is the practical argument
    // for copying anything that does not have to be live.
    await applyCredentials(name, resolvePassthrough(cfg.credentials), bin);
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
  if (cfg.claudeCredentialPassthrough) await syncClaudeCredential(name, bin);
  await applyCredentials(name, credentials, bin);
  return { name, publishedPort: publishPort };
}

/**
 * Place the COPIED credentials into a container that already exists.
 *
 * Separate from container creation on purpose, and callable on a running
 * container: a copy can be refreshed at any time, which is the whole practical
 * difference between the two mechanisms. A mount is fixed when the container is
 * created, so changing one means recreating the container and losing the task's
 * running state — that is why narrowed ssh keys are copies, and why ticking a
 * key can take effect in the session you are already in.
 *
 * Every step is best-effort: a credential that fails to land shows up as the
 * tool reporting itself logged out, which is a far clearer symptom than a
 * container that refused to start.
 */
export async function applyCredentials(
  container: string,
  credentials: ResolvedCredential[],
  bin = 'podman',
): Promise<void> {
  const plan = credentialCopyPlan(credentials, container);
  const placing = plan.map((args) => args[2]?.split(':')[1]).filter((p): p is string => Boolean(p));
  // REVOKE before granting. Un-ticking a credential used to change the config
  // and nothing in the container: this function only ever copied, so a revoked
  // ssh key stayed usable in every running container — and in any reused one
  // on later turns — while the settings page said the change applied to the
  // task you are in. The manifest records what cezar itself placed, so only
  // that is ever removed; files the agent made are not cezar's to delete.
  for (const path of await readCredentialManifest(container, bin)) {
    if (placing.includes(path)) continue;
    await run(bin, ['exec', container, 'rm', '-f', path]).catch(() => undefined);
  }
  for (const planned of plan) {
    // A credential that has to be rewritten on the way in is copied from a
    // temp file instead of straight from the operator's own.
    const credential = credentials.find((c) => c.hostPath === planned[1]);
    const staged = credential?.sanitize ? stageSanitized(credential) : undefined;
    const args = staged ? ['cp', staged, planned[2] as string] : planned;
    // `podman cp` fails when the destination's parent is absent, and the base
    // image has no `/root/.config/gh` or `/root/.docker`. Without this the copy
    // failed silently and the agent reported the tool as logged out, with
    // nothing in the run log to explain why.
    const dest = args[2]?.split(':')[1];
    if (dest) await run(bin, ['exec', container, 'mkdir', '-p', dirname(dest)]).catch(() => undefined);
    await run(bin, args).catch(() => undefined);
    // And then the modes, where the credential declares them. An SSH private
    // key that lands group-readable is REFUSED by ssh ("UNPROTECTED PRIVATE KEY
    // FILE") — it does not warn and continue, it declines to use the key, which
    // reads downstream as "permission denied (publickey)" with nothing
    // connecting it to the copy.
    const perms = dest ? permsFor(credentials, dest) : undefined;
    if (dest && perms) {
      await run(bin, ['exec', container, 'chmod', perms.dir, dirname(dest)]).catch(() => undefined);
      await run(bin, ['exec', container, 'chmod', perms.file, dest]).catch(() => undefined);
    }
    if (staged) rmSync(staged, { force: true });
  }
  await writeCredentialManifest(container, placing, bin);
}

/**
 * Where cezar records, INSIDE a container, the credential files it copied in.
 *
 * In the container rather than on the host so it lives and dies with the thing
 * it describes, and survives a cockpit restart between turns. Mounts are not in
 * it: a bind mount is fixed at creation and cannot be withdrawn from a running
 * container — a revoked MOUNTED credential stays until the container is
 * recreated, which is why copies are the default for anything narrowed.
 */
const CREDENTIAL_MANIFEST = '/root/.cezar-credentials.json';

async function readCredentialManifest(container: string, bin: string): Promise<string[]> {
  try {
    const { stdout } = await run(bin, ['exec', container, 'cat', CREDENTIAL_MANIFEST]);
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    // Only paths cezar could have placed: absolute, and no way out of /root.
    return parsed.filter((p): p is string =>
      typeof p === 'string' && p.startsWith('/root/') && !p.split('/').includes('..'));
  } catch {
    return []; // first apply, or a container from before the manifest existed
  }
}

async function writeCredentialManifest(container: string, paths: string[], bin: string): Promise<void> {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'cez-manifest-'));
    const file = join(dir, 'manifest.json');
    writeFileSync(file, JSON.stringify(paths), { mode: 0o600 });
    await run(bin, ['cp', file, `${container}:${CREDENTIAL_MANIFEST}`]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: without it the next apply cannot revoke, which is the old
    // behaviour rather than a new failure.
  }
}

/**
 * Push the project's COPIED credentials into every running container of that
 * project, and answer the ones that were updated.
 *
 * This is what makes ticking a key in Settings take effect in the task you are
 * already in, rather than in some future one. It is possible at all only
 * because narrowed credentials are copies: a mount is fixed when the container
 * is created, so the same change to a mounted credential could only be applied
 * by destroying the container and the running task with it.
 *
 * Containers are matched by the workspace they have mounted, not by a name or a
 * label we maintain: a container's own mount list is the only statement about
 * which repo it belongs to that cannot drift. Pushing one project's credentials
 * into another project's container is the failure worth designing against here.
 */
export async function applyCredentialsToRunning(
  cfg: SandboxConfig,
  repoRoot: string,
  bin = 'podman',
  /** Injectable for tests; defaults to running the real `podman`. */
  ask: PodmanQuery = (args) => run(bin, args).then(({ stdout }) => stdout),
): Promise<string[]> {
  let names: string[];
  try {
    names = (await ask(['ps', '--format', '{{.Names}}']))
      .split('\n').map((n) => n.trim()).filter((n) => n.startsWith('cez-'));
  } catch {
    return []; // no podman, or no VM — nothing to update and nothing to report
  }
  if (names.length === 0) return [];
  // No early return on an empty grant list: "revoke everything" is exactly
  // the change that must reach running containers.
  const credentials = resolvePassthrough(cfg.credentials);
  const updated: string[] = [];
  for (const name of names) {
    if (!(await mountsWorkspace(name, repoRoot, ask))) continue;
    await applyCredentials(name, credentials, bin);
    updated.push(name);
  }
  return updated;
}

/** Reads something from podman. Answers its stdout; throws as `podman` does. */
export type PodmanQuery = (args: string[]) => Promise<string>;

/** Does this container have `repoRoot` bind-mounted — i.e. is it this project's? */
async function mountsWorkspace(container: string, repoRoot: string, ask: PodmanQuery): Promise<boolean> {
  try {
    const mounts = await ask(['inspect', container, '--format', '{{range .Mounts}}{{.Source}}\n{{end}}']);
    return mounts.split('\n').some((line) => line.trim() === repoRoot);
  } catch {
    return false;
  }
}

/**
 * Write the rewritten form of a credential to a temp file, and answer its path.
 * `undefined` when anything goes wrong — the caller then copies the original,
 * which is the pre-existing behaviour rather than a new failure.
 */
function stageSanitized(credential: ResolvedCredential): string | undefined {
  if (!credential.hostPath) return undefined;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'cez-cred-'));
    const staged = join(dir, basename(credential.hostPath));
    writeFileSync(staged, sanitizeSshConfig(readFileSync(credential.hostPath, 'utf8')), { mode: 0o600 });
    return staged;
  } catch {
    return undefined;
  }
}

/** The modes declared for whichever credential landed at `dest`, if any. */
function permsFor(credentials: ResolvedCredential[], dest: string): { file: string; dir: string } | undefined {
  return credentials.find((c) => c.guestPath === dest)?.perms;
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
 * Put the host's current Claude credential into the container.
 *
 * Copied rather than mounted, and re-copied before every spawn: Claude Code
 * rewrites that file atomically when it refreshes the token, which breaks a
 * file bind mount permanently (the container keeps the unlinked inode). A copy
 * has the opposite failure — it goes stale — and re-copying is what removes it.
 *
 * Silent when the host has no credential: that is the Keychain case, and the
 * container may hold its own login.
 */
export async function syncClaudeCredential(
  container: string,
  bin = 'podman',
  /** Injectable for tests; defaults to running the real `podman`. */
  ask: PodmanQuery = (args) => run(bin, args).then(({ stdout }) => stdout),
  /** The host file to sync; injectable so this is testable off a real login. */
  source = hostClaudeCredential(),
): Promise<void> {
  if (!existsSync(source)) return;
  await ask(['exec', container, 'mkdir', '-p', GUEST_CREDENTIAL_DIR]).catch(() => undefined);
  await ask(['cp', source, `${container}:${GUEST_CREDENTIAL}`]).catch(() => undefined);
  if (await credentialReadable(container, ask)) return;
  // Unreadable after a successful copy means a container from an older cezar,
  // which BIND-MOUNTED this file. The mount holds an inode; Claude Code
  // rewrites the credential with temp-file-plus-rename when it refreshes or
  // when the operator logs in again, which unlinks it. The container is then
  // left holding a deleted file: `ls` still shows 508 bytes and every read
  // fails with ENOENT.
  //
  // The agent reports this as "Not logged in — please run /login", which sends
  // the operator to do the one thing that CANNOT help: logging in again on the
  // host rewrites the file once more and breaks the mount again. Seen twice.
  //
  // Restarting re-resolves the mount to the file that exists now. It is safe
  // here because this runs between turns, and it is narrow: only when the host
  // HAS a credential and the container still cannot read it.
  await ask(['restart', container]).catch(() => undefined);
  await ask(['cp', source, `${container}:${GUEST_CREDENTIAL}`]).catch(() => undefined);
}

const GUEST_CREDENTIAL_DIR = '/root/.claude';
const GUEST_CREDENTIAL = `${GUEST_CREDENTIAL_DIR}/.credentials.json`;

/**
 * Can the agent actually READ the credential?
 *
 * `ls` is not the question and never was: a bind mount of an unlinked inode
 * still stats, with the right size and date. Only a read tells the truth.
 */
async function credentialReadable(container: string, ask: PodmanQuery): Promise<boolean> {
  try {
    await ask(['exec', container, 'head', '-c', '1', GUEST_CREDENTIAL]);
    return true;
  } catch {
    return false;
  }
}

/** Remove this task's container. Never throws — teardown must not fail a run. */
export async function removeTaskContainer(runId: string, bin = 'podman'): Promise<void> {
  // `-v` so the anonymous volumes (node_modules and friends) go with it —
  // without it every task would leak a multi-hundred-MB volume.
  await run(bin, ['rm', '-f', '-v', taskContainerName(runId)]).catch(() => undefined);
}
