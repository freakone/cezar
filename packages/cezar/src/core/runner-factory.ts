import type { AgentBackend, AgentRunner, RunnerId } from './agent-runner.ts';
import type { ProcessLauncher } from './process-launcher.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { PiRunner } from './pi-runner.ts';

/**
 * The single place that maps a backend id onto a concrete runner. Everything
 * that used to `new ClaudeCliRunner()` (the planner and the workflow engine)
 * goes through here so switching the agent backend is one function call.
 * `claude-cli` is the legacy id for `claude`.
 *
 * `launcher` is the orthogonal axis — WHERE the agent runs (this machine, or a
 * sandbox). It is threaded in rather than read from config here so the factory
 * stays pure and the caller owns the config read. Only the claude runner honours
 * it so far; the other three still spawn locally, and passing a launcher they
 * ignore would be a silent isolation lie, so they say so out loud instead.
 */
export function createRunner(
  backend: AgentBackend | RunnerId | undefined,
  opts: { launcher?: ProcessLauncher } = {},
): AgentRunner {
  switch (backend) {
    case 'codex':
      return new CodexAppServerRunner();
    case 'opencode':
      return new OpencodeServerRunner();
    case 'pi':
      return new PiRunner();
    case 'claude':
    case 'claude-cli':
    default:
      return new ClaudeCliRunner({ launcher: opts.launcher });
  }
}

/** True when `backend` would ignore a launcher — the caller must not claim isolation. */
export function backendSupportsLauncher(backend: AgentBackend | RunnerId | undefined): boolean {
  return backend === undefined || backend === 'claude' || backend === 'claude-cli';
}
