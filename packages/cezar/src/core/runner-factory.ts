import type { AgentBackend, AgentRunner, RunnerId } from './agent-runner.ts';
import type { ProcessLauncher } from './process-launcher.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { JunieRunner } from './junie-runner.ts';
import { CopilotAcpRunner } from './copilot-acp-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { CursorAgentRunner } from './cursor-agent-runner.ts';
import { PiRunner } from './pi-runner.ts';
import { KimiRunner } from './kimi-runner.ts';

/**
 * The single place that maps a backend id onto a concrete runner. Everything
 * that used to `new ClaudeCliRunner()` (the planner and the workflow engine)
 * goes through here so switching the agent backend is one function call.
 * `claude-cli` is the legacy id for `claude`.
 *
 * `launcher` is the orthogonal axis — WHERE the agent runs (this machine, or a
 * sandbox). It is threaded in rather than read from config here so the factory
 * stays pure and the caller owns the config read. Every backend honours it:
 * three speak stdio and only needed the spawn swapped, while opencode talks
 * HTTP to its own process and additionally binds the port the launcher
 * published.
 */
export function createRunner(
  backend: AgentBackend | RunnerId | undefined,
  opts: { launcher?: ProcessLauncher } = {},
): AgentRunner {
  switch (backend) {
    case 'codex':
      return new CodexAppServerRunner({ launcher: opts.launcher });
    case 'opencode':
      return new OpencodeServerRunner({ launcher: opts.launcher });
    case 'cursor':
      return new CursorAgentRunner();
    case 'pi':
      return new PiRunner({ launcher: opts.launcher });
    case 'junie':
      return new JunieRunner();
    case 'copilot':
      return new CopilotAcpRunner();
    case 'kimi':
      return new KimiRunner({ launcher: opts.launcher });
    case 'claude':
    case 'claude-cli':
    default:
      return new ClaudeCliRunner({ launcher: opts.launcher });
  }
}

/**
 * True when `backend` can really run in a task container. The engine must never claim isolation
 * on a backend that would ignore it — or that cannot work there — so this is an allowlist.
 *
 * Taking a launcher is necessary, not sufficient: the agent's CLI must be IN the image and its
 * login must reach the container. Only Claude Code and Kimi Code meet both (the base image
 * installs them; `syncClaudeCredential` / the mounted Kimi login carry them). Codex, OpenCode and
 * pi take a launcher, but the image has no binary for them and nothing passes their login — an
 * isolated task with them failed with `exec: codex: not found` while its record said isolated.
 * They run on this machine, reported as such, until the image and their logins exist. Runners
 * without a launcher at all (Cursor, Junie, Copilot) likewise.
 */
const LAUNCHER_BACKENDS: ReadonlySet<string> = new Set(['claude', 'claude-cli', 'kimi']);

export function backendSupportsLauncher(backend: AgentBackend | RunnerId | undefined): boolean {
  return LAUNCHER_BACKENDS.has(backend ?? 'claude');
}
