import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Which of the operator's credentials an isolated agent may use.
 *
 * Isolation without any credentials is useless — an agent that cannot reach
 * GitHub or a cloud project cannot do the work. Isolation with ALL of them is
 * pointless — the container would hold everything the host does. So this is the
 * dial in between, and it is per credential, on purpose.
 *
 * Two mechanisms, because they protect different things:
 *
 *  - **mount** — the container reads the live file. Refreshed tokens keep
 *    working, which is required for anything the tool rewrites (a cloud CLI
 *    refreshing an OAuth token). The cost is that the container can also WRITE
 *    it, and revoking means revoking for the host too.
 *  - **copy** — the container gets a snapshot at start. Nothing it does reaches
 *    the host's file, and the copy dies with the container. The cost is that a
 *    refresh inside does not persist, and a credential rotated on the host is
 *    stale in a long-running container.
 *
 * Mount is right for things that refresh, copy for static keys. Neither is
 * right for everything, which is why the choice is exposed rather than decided.
 *
 * One rule constrains the catalog, learned the hard way: **never file-mount
 * something its owner rewrites atomically.** A bind mount binds an inode, and a
 * temp-file-plus-rename unlinks it — the container is left holding a deleted
 * file, reads fail with ENOENT, and the tool reports itself logged out. Mount
 * the containing DIRECTORY (stable inode) or copy the file; both survive.
 */

export type PassthroughMode = 'mount' | 'copy';

export interface CredentialSource {
  /** Stable id — what the config names and the UI checkboxes. */
  id: string;
  /** What a human calls it. */
  label: string;
  /** Host path, `~`-relative. */
  hostPath?: string;
  /**
   * Whether `hostPath` is a file or a directory. Declared rather than sniffed:
   * `.ssh` and `.npmrc` are indistinguishable as strings, and this is what the
   * mount rule below is enforced against.
   */
  kind?: 'file' | 'dir';
  /** Where it lands in the container. Defaults to the same path under /root. */
  guestPath?: string;
  /** Environment variables to forward instead of (or besides) a path. */
  env?: string[];
  /** Default mechanism for this source; the user may override. */
  defaultMode: PassthroughMode;
  /** Why this one needs mount, when it does — shown in the UI. */
  note?: string;
}

/**
 * The tools people actually hit this with. Each entry is the credential ONLY —
 * never a whole home directory, and never a tool's history or cache alongside
 * its key, for the same reason cezar mounts `.credentials.json` rather than all
 * of `~/.claude`.
 */
export const CREDENTIAL_CATALOG: CredentialSource[] = [
  {
    id: 'github-cli',
    kind: 'file',
    label: 'GitHub CLI (gh)',
    hostPath: '.config/gh/hosts.yml',
    guestPath: '/root/.config/gh/hosts.yml',
    env: ['GH_TOKEN', 'GITHUB_TOKEN'],
    defaultMode: 'copy',
    note: 'A token, not a session — a copy is enough and keeps the container from rewriting it.',
  },
  {
    id: 'git-config',
    kind: 'file',
    label: 'Git identity (.gitconfig)',
    hostPath: '.gitconfig',
    guestPath: '/root/.gitconfig',
    defaultMode: 'copy',
    note: 'So commits the agent makes carry your name and email.',
  },
  {
    id: 'ssh',
    kind: 'dir',
    label: 'SSH keys',
    hostPath: '.ssh',
    guestPath: '/root/.ssh',
    defaultMode: 'mount',
    note: 'Grants the container everything your keys reach, including production. Enable deliberately.',
  },
  {
    id: 'gcloud',
    kind: 'dir',
    label: 'Google Cloud (gcloud)',
    hostPath: '.config/gcloud',
    guestPath: '/root/.config/gcloud',
    env: ['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CORE_PROJECT'],
    defaultMode: 'mount',
    note: 'gcloud refreshes its OAuth token in place, so a copy goes stale.',
  },
  {
    id: 'aws',
    kind: 'dir',
    label: 'AWS CLI',
    hostPath: '.aws',
    guestPath: '/root/.aws',
    env: ['AWS_PROFILE', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
    defaultMode: 'mount',
    note: 'SSO sessions are refreshed in place; static keys would be fine as a copy.',
  },
  {
    id: 'kube',
    kind: 'dir',
    label: 'Kubernetes (kubeconfig)',
    // The DIRECTORY, not `config` itself. Exec-based auth plugins rewrite the
    // kubeconfig to cache tokens, and they rewrite it atomically — which
    // permanently breaks a bind mount of the file (the container keeps the
    // unlinked inode and every read fails). A directory mount survives that
    // because the directory's own inode is stable. The same trap cost us the
    // Claude credential, which is now copied instead.
    hostPath: '.kube',
    guestPath: '/root/.kube',
    env: ['KUBECONFIG'],
    defaultMode: 'mount',
    note: 'The whole ~/.kube: exec auth plugins rewrite the config to cache tokens.',
  },
  {
    id: 'docker',
    kind: 'file',
    label: 'Container registry logins',
    hostPath: '.docker/config.json',
    guestPath: '/root/.docker/config.json',
    defaultMode: 'copy',
  },
  {
    id: 'npm',
    kind: 'file',
    label: 'npm registry token (.npmrc)',
    hostPath: '.npmrc',
    guestPath: '/root/.npmrc',
    env: ['NPM_TOKEN'],
    defaultMode: 'copy',
  },
  {
    id: 'pypi',
    kind: 'file',
    label: 'PyPI token (.pypirc)',
    hostPath: '.pypirc',
    guestPath: '/root/.pypirc',
    defaultMode: 'copy',
  },
];

/** A credential the operator defined themselves — a path, some env, or both. */
export interface CustomCredential {
  id: string;
  label?: string;
  hostPath?: string;
  guestPath?: string;
  env?: string[];
  mode?: PassthroughMode;
}

export interface PassthroughSelection {
  /** Catalog ids that are on, with an optional mode override. */
  enabled?: Record<string, { mode?: PassthroughMode } | boolean>;
  /** Anything not in the catalog. */
  custom?: CustomCredential[];
}

/** Resolve `~`-relative catalog paths against the real home. */
export function hostPathOf(source: { hostPath?: string }, home = homedir()): string | undefined {
  if (!source.hostPath) return undefined;
  return source.hostPath.startsWith('/') ? source.hostPath : join(home, source.hostPath);
}

export interface ResolvedCredential {
  id: string;
  mode: PassthroughMode;
  /** Absent when the source is env-only, or the file simply is not there. */
  hostPath?: string;
  guestPath?: string;
  /** Env names to forward, with the value read from the host environment. */
  env: string[];
  /** Why it was skipped, when it was. */
  skipped?: string;
}

/**
 * Turn the selection into concrete work for the launcher.
 *
 * A selected credential whose file does not exist is SKIPPED with a reason
 * rather than mounted: podman would happily create an empty directory at that
 * path, and an empty `~/.aws` inside the container looks to every tool like
 * "logged out" — a far more confusing failure than "we did not find it".
 */
export function resolvePassthrough(
  selection: PassthroughSelection | undefined,
  home = homedir(),
  exists: (p: string) => boolean = existsSync,
): ResolvedCredential[] {
  const out: ResolvedCredential[] = [];
  if (!selection) return out;

  for (const source of CREDENTIAL_CATALOG) {
    const choice = selection.enabled?.[source.id];
    if (!choice) continue;
    const mode = (typeof choice === 'object' && choice.mode) || source.defaultMode;
    const hostPath = hostPathOf(source, home);
    const resolved: ResolvedCredential = {
      id: source.id,
      mode,
      guestPath: source.guestPath,
      env: source.env ?? [],
    };
    if (hostPath && exists(hostPath)) resolved.hostPath = hostPath;
    else if (hostPath) resolved.skipped = `${hostPath} does not exist on this machine`;
    out.push(resolved);
  }

  for (const custom of selection.custom ?? []) {
    const hostPath = custom.hostPath ? hostPathOf({ hostPath: custom.hostPath }, home) : undefined;
    const resolved: ResolvedCredential = {
      id: custom.id,
      mode: custom.mode ?? 'copy',
      guestPath: custom.guestPath,
      env: custom.env ?? [],
    };
    if (hostPath && exists(hostPath)) resolved.hostPath = hostPath;
    else if (hostPath) resolved.skipped = `${hostPath} does not exist on this machine`;
    out.push(resolved);
  }
  return out;
}

/** `-v host:guest` arguments for the credentials that are MOUNTED. */
export function credentialMountArgs(resolved: ResolvedCredential[]): string[] {
  const args: string[] = [];
  for (const c of resolved) {
    if (c.mode !== 'mount' || !c.hostPath || !c.guestPath || c.skipped) continue;
    args.push('-v', `${c.hostPath}:${c.guestPath}`);
  }
  return args;
}

/** `podman cp` invocations for the credentials that are COPIED, in order. */
export function credentialCopyPlan(resolved: ResolvedCredential[], container: string): string[][] {
  const plan: string[][] = [];
  for (const c of resolved) {
    if (c.mode !== 'copy' || !c.hostPath || !c.guestPath || c.skipped) continue;
    plan.push(['cp', c.hostPath, `${container}:${c.guestPath}`]);
  }
  return plan;
}

/** `KEY=VALUE` pairs for every forwarded variable that is actually set. */
export function credentialEnvPairs(
  resolved: ResolvedCredential[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const pairs: string[] = [];
  for (const c of resolved) {
    for (const name of c.env) {
      const value = env[name];
      // Only forward what the host actually has. Passing an empty value would
      // SHADOW a credential the container already holds — the exact failure
      // mode of sbx's `ANTHROPIC_API_KEY=proxy-managed` placeholder.
      if (value) pairs.push(`${name}=${value}`);
    }
  }
  return pairs;
}
