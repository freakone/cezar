import type { AgentBackend, AgentRunner, RunnerId } from './agent-runner.ts';
import type { ProcessLauncher } from './process-launcher.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { JunieRunner } from './junie-runner.ts';
import { CopilotAcpRunner } from './copilot-acp-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { CursorAgentRunner } from './cursor-agent-runner.ts';
import { PiRunner } from './pi-runner.ts';

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
    case 'claude':
    case 'claude-cli':
    default:
      return new ClaudeCliRunner({ launcher: opts.launcher });
  }
}

/**
 * True when `backend` honours a launcher. The engine must never claim isolation
 * on a backend that would ignore it, so this is an allowlist of the runners that
 * take one — a runner added without a launcher (Cursor, Junie and Copilot
 * arrived that way) runs on the host and is reported as such, not as isolated.
 */
const LAUNCHER_BACKENDS: ReadonlySet<string> = new Set(['claude', 'claude-cli', 'codex', 'opencode', 'pi']);

export function backendSupportsLauncher(backend: AgentBackend | RunnerId | undefined): boolean {
  return LAUNCHER_BACKENDS.has(backend ?? 'claude');
}
