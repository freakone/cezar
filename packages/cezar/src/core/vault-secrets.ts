import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Where this machine's Vault is, as cezar stores it.
 *
 * A SETTING rather than an environment variable, because the alternative is
 * editing the cockpit's launch agent: under launchd the process environment is
 * the plist's, not the shell's, so `export VAULT_ADDR` in a terminal never
 * reaches the cockpit. An address is not a secret — the token still comes from
 * `~/.vault-token`, written by `vault login` — so it belongs in config.
 *
 * The setting WINS over the environment when both exist. Anything else and the
 * setting would be the one that silently does nothing on the machine it was
 * added for.
 */
export interface VaultSettings {
  address?: string | undefined;
  namespace?: string | undefined;
}

/** The environment a `vault` invocation runs with. */
function vaultEnv(settings: VaultSettings = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    ...(settings.address ? { VAULT_ADDR: settings.address } : {}),
    ...(settings.namespace ? { VAULT_NAMESPACE: settings.namespace } : {}),
  };
}

/** The address in force: the setting, else whatever the process was given. */
export function effectiveVaultAddress(
  settings: VaultSettings = {},
  base: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return settings.address || base.VAULT_ADDR || undefined;
}

/**
 * Resolve development secrets from HashiCorp Vault, on the HOST, so an isolated
 * agent receives values and never access.
 *
 * The container is deliberately never given `VAULT_TOKEN`. Handing it one would
 * grant the agent everything the operator's token reaches, and Vault's audit
 * log would then record "the agent read the vault" rather than "this task read
 * these three secrets" — the same narrowing argument as picking individual ssh
 * keys instead of mounting `~/.ssh`.
 *
 * Auth is the CLI's, not ours: `vault login` writes `~/.vault-token` and the
 * binary reads it, along with `VAULT_ADDR` and `VAULT_NAMESPACE` from the
 * cockpit's own environment. cezar storing a Vault credential in order to fetch
 * credentials would just move the problem, and shelling out is the same call
 * this codebase already makes for `gh` and `glab`: let the vendor's tool own
 * auth, namespaces, and the KV v1-vs-v2 path difference that is easy to get
 * subtly wrong.
 */

/** `vault://<mount>/<path>#<field>` — e.g. `vault://secret/dev/api#STRIPE_KEY`. */
export interface VaultRef {
  mount: string;
  path: string;
  field: string;
}

/** Is this a Vault reference at all? Cheap enough to call on every value. */
export function isVaultRef(value: string): boolean {
  return value.startsWith('vault://');
}

/**
 * Parse a reference, or `null` when it is not one this can fetch.
 *
 * Strict on purpose: every part becomes an argv entry, and a reference that
 * parses loosely would send a malformed path to `vault` and surface as its
 * error rather than as a bad reference the operator can see and fix.
 */
export function parseVaultRef(value: string): VaultRef | null {
  if (!isVaultRef(value)) return null;
  const rest = value.slice('vault://'.length);
  const hash = rest.lastIndexOf('#');
  if (hash <= 0 || hash === rest.length - 1) return null;
  const location = rest.slice(0, hash);
  const field = rest.slice(hash + 1);
  const slash = location.indexOf('/');
  if (slash <= 0 || slash === location.length - 1) return null;
  const mount = location.slice(0, slash);
  const path = location.slice(slash + 1);
  // No traversal, no flag smuggling, no empty segments.
  for (const part of [mount, field]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(path) || path.includes('//') || path.split('/').includes('..')) {
    return null;
  }
  return { mount, path, field };
}

/** Fetches one field. Injectable so tests never need a Vault. */
export type VaultReader = (ref: VaultRef) => Promise<string>;

export class VaultUnavailable extends Error {}

/** How long a resolved value is reused before Vault is asked again. */
const CACHE_TTL_MS = 60_000;

/**
 * The real reader: `vault kv get -field=…`, which prints the value alone.
 *
 * `-field` rather than `-format=json`: one value crosses the process boundary
 * instead of the whole secret, so a sibling field never lands in a buffer, an
 * error message, or a crash dump.
 */
export const vaultCliReader: VaultReader = (ref) => readWith({})(ref);

/** The real reader, bound to the machine's Vault settings. */
export function readWith(settings: VaultSettings): VaultReader {
  return async (ref) => {
  try {
    const { stdout } = await run(
      'vault',
      ['kv', 'get', `-mount=${ref.mount}`, `-field=${ref.field}`, ref.path],
      { timeout: 15_000, maxBuffer: 1024 * 1024, env: vaultEnv(settings) },
    );
    // `-field` prints the raw value; Vault adds no trailing newline for it, but
    // a shell wrapper on PATH might.
    return stdout.replace(/\n$/, '');
  } catch (err) {
    const e = err as { stderr?: string; message?: string; code?: string };
    if (e.code === 'ENOENT') {
      throw new VaultUnavailable('the `vault` CLI is not installed or not on cezar\'s PATH');
    }
    const detail = (e.stderr || e.message || 'vault failed').trim().split('\n')[0] ?? 'vault failed';
    throw new VaultUnavailable(detail);
  }
  };
}

interface CacheEntry {
  value: string;
  at: number;
}

/**
 * A reader with a short TTL cache.
 *
 * Credentials are resolved per agent spawn so a rotated secret reaches the next
 * turn of a long task — the same property the file-backed ones have. Without a
 * cache a five-step workflow pays five round trips for the same value; with a
 * minute of TTL a rotation still lands within a turn or two.
 */
export function cachingVaultReader(inner: VaultReader = vaultCliReader, ttlMs = CACHE_TTL_MS): VaultReader {
  const cache = new Map<string, CacheEntry>();
  return async (ref) => {
    const key = `${ref.mount}/${ref.path}#${ref.field}`;
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs) return hit.value;
    const value = await inner(ref);
    cache.set(key, { value, at: now });
    return value;
  };
}

// ---- browsing, for the picker ------------------------------------------------
//
// Everything below answers NAMES only. Values are fetched by `vaultCliReader`
// at container start and go straight into a container; none of this is allowed
// to put one on the wire, because it is served to a browser. `listFields` is
// where that could go wrong — `vault kv get` returns the whole secret — so it
// reads the keys and drops the rest before returning.

export interface VaultStatus {
  /** The CLI is installed and cezar can run it. */
  installed: boolean;
  /** `VAULT_ADDR`, when the cockpit has one. */
  address?: string;
  /** A usable token — `vault token lookup` succeeded. */
  authenticated: boolean;
  /** One actionable sentence. Empty when ready. */
  reason: string;
  /** The command that fixes `reason`, when one does. */
  fix?: string;
}

/** Runs a vault subcommand and answers stdout; injectable for tests. */
export type VaultRunner = (args: string[]) => Promise<string>;

/** A runner bound to the machine's Vault settings. */
export function vaultCli(settings: VaultSettings = {}): VaultRunner {
  return async (args) => {
    const { stdout } = await run('vault', args, {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      env: vaultEnv(settings),
    });
    return stdout;
  };
}

const cli: VaultRunner = vaultCli();

/** Can cezar read secrets right now, and if not, what fixes it? */
export async function vaultStatus(
  exec: VaultRunner = cli,
  env: NodeJS.ProcessEnv = process.env,
  settings: VaultSettings = {},
): Promise<VaultStatus> {
  const address = effectiveVaultAddress(settings, env);
  try {
    await exec(['version']);
  } catch {
    return {
      installed: false,
      authenticated: false,
      reason: 'the `vault` CLI is not installed, or not on the PATH cezar was started with',
      fix: 'brew install vault',
    };
  }
  if (!address) {
    return {
      installed: true,
      authenticated: false,
      reason: 'no Vault address configured',
      fix: 'set it in Settings → Isolation defaults',
    };
  }
  try {
    await exec(['token', 'lookup']);
  } catch {
    return {
      installed: true,
      address,
      authenticated: false,
      reason: `no usable Vault token for ${address}`,
      fix: 'vault login',
    };
  }
  return { installed: true, address, authenticated: true, reason: '' };
}

/** The KV mounts this token can see. */
export async function listMounts(exec: VaultRunner = cli): Promise<{ mounts: string[]; error?: string }> {
  try {
    const raw = await exec(['secrets', 'list', '-format=json']);
    const parsed = JSON.parse(raw) as Record<string, { type?: string }>;
    return {
      mounts: Object.entries(parsed)
        .filter(([, info]) => info.type === 'kv')
        .map(([path]) => path.replace(/\/$/, ''))
        .sort(),
    };
  } catch (err) {
    // `sys/mounts` needs privileges a sensibly-scoped token does not have, so
    // this 403s for most REAL tokens — measured against one whose policy
    // covered its own KV paths and nothing else. It is not an error state: the
    // operator knows their mount name, so the picker lets them type it.
    return { mounts: [], error: vaultMessage(err) };
  }
}

/** What a KV path holds: child paths (ending `/`) and leaf secrets. */
export async function listPaths(
  mount: string,
  path: string,
  exec: VaultRunner = cli,
): Promise<{ entries: string[]; error?: string }> {
  try {
    const raw = await exec(['kv', 'list', '-format=json', `-mount=${mount}`, path || '/']);
    return { entries: (JSON.parse(raw) as string[]).sort() };
  } catch (err) {
    // An empty path and a FORBIDDEN one are not the same answer. Collapsing
    // both to "nothing here" is what makes a policy problem look like an empty
    // Vault — measured against a real token whose policy granted list but not
    // read, where the picker said "Nothing here" about a secret that was there.
    return { entries: [], error: vaultMessage(err) };
  }
}

/**
 * The FIELD NAMES in one secret. Never their values.
 *
 * `vault kv get` returns the whole secret, so the values exist in this
 * process for as long as it takes to read the keys — they are not returned,
 * not logged, and not stored.
 */
export async function listFields(
  mount: string,
  path: string,
  exec: VaultRunner = cli,
): Promise<{ fields: string[]; error?: string }> {
  try {
    const raw = await exec(['kv', 'get', '-format=json', `-mount=${mount}`, path]);
    const parsed = JSON.parse(raw) as { data?: { data?: Record<string, unknown> } | Record<string, unknown> };
    const outer = parsed.data ?? {};
    // KV v2 nests the secret under `data.data`; v1 puts it directly on `data`.
    const inner = (outer as { data?: Record<string, unknown> }).data ?? outer;
    return { fields: Object.keys(inner as Record<string, unknown>).sort() };
  } catch (err) {
    // The common one is a policy that grants `list` but not `read`: the path
    // shows up, the fields do not, and without the reason it reads as an empty
    // secret. It also means the value could not be fetched at task start
    // either, which is worth knowing BEFORE picking it.
    return { fields: [], error: vaultMessage(err) };
  }
}

/** The useful line out of a vault CLI failure. */
function vaultMessage(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const text = (e.stderr || e.message || 'vault failed').trim();
  const denied = /permission denied/i.test(text);
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => /error|denied|\*/i.test(l));
  if (denied) return 'permission denied — this token\'s policy does not allow it';
  return (line ?? text).replace(/^\*\s*/, '').slice(0, 200);
}

/** `vault://<mount>/<path>#<field>` for a picked field. */
export function formatVaultRef(mount: string, path: string, field: string): string {
  return `vault://${mount}/${path}#${field}`;
}
