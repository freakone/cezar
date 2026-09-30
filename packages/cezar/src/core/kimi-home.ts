import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Kimi Code keeps its per-user state, on this machine.
 *
 * Its own module because both sides of the isolation boundary need it — the runner reads token
 * usage from the session log under it, and the container launcher mounts parts of it — and those
 * two must not import each other.
 */

/** Kimi's per-user home: `KIMI_CODE_HOME` when set (an agent profile sets it), else `~/.kimi-code`. */
export function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KIMI_CODE_HOME?.trim();
  return override ? override : join(env.HOME ?? homedir(), '.kimi-code');
}

/**
 * The home an ISOLATED Kimi agent uses, on the host: mounted at `/root/.kimi-code` in its
 * container. The agent's sessions land here — readable by cezar for token usage and resumable by
 * the next turn — while your own `~/.kimi-code` history stays out of its reach. The Claude
 * equivalent is `~/.claude-agent`.
 */
export function agentKimiHome(): string {
  return join(homedir(), '.kimi-agent');
}
