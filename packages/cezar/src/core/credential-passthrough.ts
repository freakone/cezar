import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
  /**
   * This source can be narrowed to individual files, which the UI lists and the
   * operator ticks. Only `~/.ssh` has this today, and it is the one credential
   * where all-or-nothing is genuinely dangerous: a single `~/.ssh` mount hands
   * the container every host every key reaches, production included, when the
   * task needed one deploy key.
   */
  selectable?: 'ssh';
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
    // Whole-directory is the fallback, not the recommendation: see `selectable`.
    selectable: 'ssh',
    note: 'Pick individual keys — the whole directory hands the container every host your keys reach.',
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

/**
 * One file inside `~/.ssh` the operator can pass through on its own.
 *
 * Discovery reads the FILE, not its name: a private key is "starts with
 * `-----BEGIN`", because these are called `id_ed25519`, `github`, `work-deploy`
 * and anything else a person felt like, and a name-based guess would miss
 * exactly the keys someone bothered to name well.
 */
export interface SshEntry {
  /** File name inside `~/.ssh`. */
  name: string;
  kind: 'private-key' | 'config' | 'known-hosts';
  /** `ed25519 · kamil@mac`, read from the matching `.pub` when there is one. */
  detail?: string;
}

/** Injectable filesystem, so discovery is testable without a real `~/.ssh`. */
export interface SshFs {
  readdir(dir: string): string[];
  isFile(path: string): boolean;
  head(path: string, bytes: number): string;
}

const realSshFs: SshFs = {
  readdir: (dir) => readdirSync(dir),
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  head: (path, bytes) => {
    try {
      return readFileSync(path, 'utf8').slice(0, bytes);
    } catch {
      return '';
    }
  },
};

/**
 * What is in `~/.ssh` that an agent could use, as a list the UI can offer.
 *
 * Deliberately NOT listed:
 *  - `authorized_keys` — that is who may log in to THIS machine. It grants the
 *    container nothing, and it is a list of other people's keys.
 *  - `*.pub` — a public key rides along with its private key automatically
 *    (see `resolvePassthrough`); as its own checkbox it is a decision with no
 *    consequence, and the point of this list is that every tick is a real one.
 *  - `*.old` backups, sockets, and directories (`~/.ssh/agent`).
 */
export function listSshEntries(home = homedir(), fs: SshFs = realSshFs): SshEntry[] {
  const dir = join(home, '.ssh');
  let names: string[];
  try {
    names = fs.readdir(dir);
  } catch {
    return []; // no ~/.ssh at all — the caller shows "not on this machine"
  }
  const entries: SshEntry[] = [];
  for (const name of names.sort()) {
    if (name === 'authorized_keys' || name.endsWith('.pub') || name.endsWith('.old')) continue;
    const path = join(dir, name);
    if (!fs.isFile(path)) continue;
    if (name === 'config') {
      entries.push({ name, kind: 'config' });
      continue;
    }
    if (name === 'known_hosts') {
      entries.push({ name, kind: 'known-hosts' });
      continue;
    }
    // The content test. 64 bytes covers every OpenSSH and PEM header.
    if (!fs.head(path, 64).startsWith('-----BEGIN')) continue;
    const pub = fs.head(`${path}.pub`, 4096).trim();
    entries.push({ name, kind: 'private-key', ...(describeKey(pub) ? { detail: describeKey(pub) } : {}) });
  }
  return entries;
}

/** `ssh-ed25519 AAAA… kamil@mac` → `ed25519 · kamil@mac`. */
function describeKey(pub: string): string | undefined {
  if (pub === '') return undefined;
  const [algorithm, , ...comment] = pub.split(/\s+/);
  const kind = algorithm?.replace(/^ssh-/, '').replace(/^ecdsa-sha2-/, '') ?? '';
  const who = comment.join(' ').trim();
  return [kind, who].filter(Boolean).join(' · ') || undefined;
}

/** A selected file name is one segment of `~/.ssh` — never a path out of it. */
const SSH_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The `~/.ssh` files that are settings rather than keys, so no `.pub` pairing. */
const SSH_NON_KEY = new Set(['config', 'known_hosts']);

/**
 * Options only Apple's OpenSSH understands. `UseKeychain` is the one that
 * matters: Apple's own documentation tells Mac users to put it in `~/.ssh/config`,
 * so it is in a great many of them.
 */
const MACOS_ONLY_SSH_OPTIONS = ['usekeychain'];

/**
 * Comment out the macOS-only options in a copied `~/.ssh/config`.
 *
 * Linux OpenSSH does not ignore an option it does not know — it refuses to
 * start: `Bad configuration option: usekeychain` / `terminating, 1 bad
 * configuration options`, for EVERY host, including the ones the option had
 * nothing to do with. So a Mac operator who ticks `config` gets an ssh that
 * cannot connect anywhere, and an error that names a line they wrote years ago
 * on the advice of Apple's documentation. (Found by running it, not by reading
 * about it.)
 *
 * Commented rather than deleted, with the reason inline: the file is the
 * operator's, and it shows up in a container they can read.
 */
export function sanitizeSshConfig(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const option = line.trim().split(/[\s=]+/)[0]?.toLowerCase() ?? '';
      if (!MACOS_ONLY_SSH_OPTIONS.includes(option)) return line;
      return `# ${line.trim()}  # cezar: macOS-only option, rejected by OpenSSH here`;
    })
    .join('\n');
}

/** A credential the operator defined themselves — a path, some env, or both. */
export interface CustomCredential {
  id: string;
  label?: string;
  hostPath?: string;
  guestPath?: string;
  env?: string[];
  mode?: PassthroughMode;
}

/** What the operator chose for one catalog credential. */
export interface CredentialChoice {
  mode?: PassthroughMode;
  /**
   * For a `selectable` source: the individual files to pass, instead of the
   * whole directory. Empty or absent means the whole directory — which is what
   * every existing config says, so nothing changes underneath anyone.
   */
  keys?: string[];
}

export interface PassthroughSelection {
  /** Catalog ids that are on, with an optional mode override and file picks. */
  enabled?: Record<string, CredentialChoice | boolean>;
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
  /**
   * Modes to set inside the container after a copy. SSH refuses a private key
   * it considers world-readable ("UNPROTECTED PRIVATE KEY FILE") and simply
   * does not authenticate, so a copy that lands 0644 is a silent failure.
   */
  perms?: { file: string; dir: string };
  /** Rewrite the file's CONTENT on the way in; see `sanitizeSshConfig`. */
  sanitize?: 'ssh-config';
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
    const keys = typeof choice === 'object' ? choice.keys ?? [] : [];
    // A narrowed `selectable` source passes the named files instead of the
    // directory. This is the whole point of picking keys: the container gets
    // the deploy key it needs and not the one that reaches production.
    if (source.selectable === 'ssh' && keys.length > 0) {
      out.push(...resolveSshKeys(keys, home, exists, source.env ?? []));
      continue;
    }
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

/**
 * One selected `~/.ssh` file becomes one COPIED credential.
 *
 * Always copy, never mount, whatever mode the source carries — for two reasons
 * that both point the same way:
 *
 *  - a key file is exactly the thing the module warns about mounting: static
 *    until something rewrites it (`ssh-keygen -p`, a rotation script), and a
 *    file bind mount does not survive that;
 *  - narrowing is a containment feature. "The container may use this key" and
 *    "the container may overwrite this key on my disk" are different grants,
 *    and someone ticking one key out of five is plainly asking for the first.
 *
 * A private key brings its `.pub` along when there is one. That is not a
 * widening — a public key is public — and some tooling still expects the pair.
 */
function resolveSshKeys(
  keys: string[],
  home: string,
  exists: (p: string) => boolean,
  env: string[],
): ResolvedCredential[] {
  const dir = join(home, '.ssh');
  const out: ResolvedCredential[] = [];
  const perms = { file: '600', dir: '700' };
  for (const name of keys) {
    // The name comes from config, which a person edits by hand. One segment,
    // no traversal: this string becomes both a host path and a guest path.
    if (!SSH_FILE.test(name)) continue;
    const hostPath = join(dir, name);
    const resolved: ResolvedCredential = {
      id: `ssh:${name}`,
      mode: 'copy',
      guestPath: `/root/.ssh/${name}`,
      env,
      perms,
      ...(name === 'config' ? { sanitize: 'ssh-config' as const } : {}),
    };
    if (exists(hostPath)) resolved.hostPath = hostPath;
    else resolved.skipped = `${hostPath} does not exist on this machine`;
    out.push(resolved);
    const pub = `${hostPath}.pub`;
    if (resolved.hostPath && !SSH_NON_KEY.has(name) && !name.endsWith('.pub') && exists(pub)) {
      out.push({
        id: `ssh:${name}.pub`,
        mode: 'copy',
        hostPath: pub,
        guestPath: `/root/.ssh/${name}.pub`,
        env: [],
        perms: { file: '644', dir: '700' },
      });
    }
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
