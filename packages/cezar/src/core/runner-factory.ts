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
    case 'pi':
      return new PiRunner({ launcher: opts.launcher });
    case 'claude':
    case 'claude-cli':
    default:
      return new ClaudeCliRunner({ launcher: opts.launcher });
  }
}

/**
 * True when `backend` honours a launcher. Every backend does now; the predicate
 * stays because the engine must never claim isolation on a backend that would
 * ignore it, and a fifth runner would arrive spawning locally.
 */
export function backendSupportsLauncher(_backend: AgentBackend | RunnerId | undefined): boolean {
  return true;
}
