import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * What a runner other than Claude and Kimi needs inside a task container: its CLI in the image,
 * a home that outlives the container, and a login.
 *
 * Logins follow the rule Claude's does (`containerClaudeLogin`): a login file is copied in per
 * turn with every REFRESH token blanked. Refresh tokens are single-use, so a container that
 * refreshed its copy would leave the host holding a spent one — and log the operator out. A runner
 * whose stored login cezar cannot read safely (Cursor, Junie, Copilot) gets its static key from
 * the environment instead, and the task log names the variable when there is none.
 */
export type ContainerAgentId = 'codex' | 'opencode' | 'pi' | 'cursor' | 'junie' | 'copilot';

export interface ContainerAgent {
  id: ContainerAgentId;
  /** The CLI as the image installs it (`agent-base.Containerfile`). */
  bin: string;
  /** Where the CLI keeps conversations and config inside the container: a per-project host dir. */
  guestHome: string;
  /** A login FILE copied in each turn, refresh tokens stripped. */
  login?: {
    /** The host file, honouring the account's relocation variable when one is selected. */
    host: (env: NodeJS.ProcessEnv, home: string) => string;
    /** The file's path inside `guestHome`. */
    inHome: string;
  };
  /** Static credentials the CLI reads from its environment — what reaches a container instead. */
  envKeys: readonly string[];
}

export const CONTAINER_AGENTS: Readonly<Record<ContainerAgentId, ContainerAgent>> = {
  codex: {
    id: 'codex',
    bin: 'codex',
    guestHome: '/root/.codex',
    login: { host: (env, home) => join(env.CODEX_HOME || join(home, '.codex'), 'auth.json'), inHome: 'auth.json' },
    envKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  },
  opencode: {
    id: 'opencode',
    bin: 'opencode',
    guestHome: '/root/.local/share/opencode',
    login: {
      host: (env, home) => join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode', 'auth.json'),
      inHome: 'auth.json',
    },
    envKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'],
  },
  pi: {
    id: 'pi',
    bin: 'pi',
    guestHome: '/root/.pi',
    login: { host: (_env, home) => join(home, '.pi', 'agent', 'auth.json'), inHome: join('agent', 'auth.json') },
    envKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'],
  },
  cursor: { id: 'cursor', bin: 'agent', guestHome: '/root/.cursor', envKeys: ['CURSOR_API_KEY'] },
  junie: { id: 'junie', bin: 'junie', guestHome: '/root/.junie', envKeys: ['JUNIE_API_KEY'] },
  copilot: { id: 'copilot', bin: 'copilot', guestHome: '/root/.copilot', envKeys: ['COPILOT_GITHUB_TOKEN'] },
};

export function containerAgent(backend: string | undefined): ContainerAgent | undefined {
  return backend !== undefined && Object.hasOwn(CONTAINER_AGENTS, backend)
    ? CONTAINER_AGENTS[backend as ContainerAgentId]
    : undefined;
}

/**
 * A JSON login with every refresh token BLANKED (`refresh_token`, `refreshToken`, `refresh`). The
 * key stays, empty: Codex and OpenCode require it, and reject a login file without it.
 */
export function withoutRefreshTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRefreshTokens);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = REFRESH_KEY.test(key) && typeof inner === 'string' ? '' : withoutRefreshTokens(inner);
  }
  return out;
}

const REFRESH_KEY = /^refresh(_?token)?$/i;

/** Ids the base image can install on demand: the runners above, and tools a credential needs. */
export const IMAGE_TOOLS = ['azure-cli'] as const;

export function isImageExtra(id: string): boolean {
  return containerAgent(id) !== undefined || (IMAGE_TOOLS as readonly string[]).includes(id);
}

/**
 * Put this turn's login for `agent` into its per-project home (a host dir mounted in the
 * container), refresh tokens stripped. Answers whether a login is now in place — from the file,
 * or a static key in `env`. Never throws.
 */
export function syncContainerAgentLogin(
  agent: ContainerAgent,
  hostHome: string,
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): boolean {
  const viaEnv = agent.envKeys.some((key) => Boolean(env[key]?.trim()));
  if (!agent.login) return viaEnv;
  const target = join(hostHome, agent.login.inHome);
  let raw: string;
  try {
    raw = readFileSync(agent.login.host(env, home), 'utf8');
  } catch {
    return viaEnv;
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(withoutRefreshTokens(JSON.parse(raw)), null, 2), { mode: 0o600 });
    return true;
  } catch {
    // Unparsable: never copy a file whose refresh tokens cannot be removed.
    return viaEnv;
  }
}

/** The task-log line for a turn whose runner has no login in its container. */
export function missingLoginNote(agent: ContainerAgent): string {
  const keys = agent.envKeys.join(' or ');
  const file = agent.login ? ' and its login file on this machine was not found' : ' (its stored login is not passed into containers)';
  return `⚠ ${agent.id} has no login inside this task's container${file} — set ${keys} in cezar's environment `
    + 'for isolated tasks, or run the task without isolation.';
}
