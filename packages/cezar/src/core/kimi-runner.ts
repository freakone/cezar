import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentEvent,
  AgentRunResult,
  AgentRunSpec,
  AgentRunner,
  AgentSession,
  AgentToolCallRecord,
  ContentBlock,
  SessionOptions,
} from './agent-runner.ts';
import { isSignalTerminationExit, prependSystemPrompt, trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { agentKimiHome, kimiHome } from './kimi-home.ts';
import { readNdjson } from './ndjson.ts';
import { localLauncher, type ProcessLauncher } from './process-launcher.ts';
import type { UiEvent, UiToolItem } from './ui-events.ts';
import {
  createKimiUiState,
  kimiSessionStarted,
  kimiTurnStarted,
  mapKimiMessage,
  type KimiUiMapperState,
  type KimiUiMapping,
} from './kimi-ui-mapper.ts';

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 10_000;
const AUTO_END_DELAY_MS = 250;
/**
 * Kimi appends a turn's last `usage.record` around the moment it answers the prompt, so the reader
 * polls until the log's own `turn.ended` marker shows the turn is fully written — bounded, since a
 * missing marker must cost a turn its usage, never hang the session.
 */
const USAGE_POLL_MS = 50;
const USAGE_SETTLE_MAX_MS = 2_000;

/**
 * The tools cezar's `allowedTools` vocabulary names. Kimi uses the same names, so a workflow's
 * allowlist can be enforced at Kimi's permission prompt. Kimi's own tools (Agent, TodoList,
 * FetchURL…) are outside that vocabulary and stay allowed, as every other backend treats them.
 */
const ALLOWLISTABLE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']);

export interface KimiRunnerOptions {
  /** Override the binary name/path; defaults to `kimi` on PATH (`CEZ_KIMI_BIN`). */
  bin?: string;
  /** Wall-clock timeout for a run (ms); per-spec `timeoutMs` still wins. */
  timeoutMs?: number;
  /** WHERE the CLI runs. Kimi is host-only today (see `backendSupportsLauncher`). */
  launcher?: ProcessLauncher;
}

/**
 * `AgentRunner` over Kimi Code's Agent Client Protocol server (`kimi acp`): JSON-RPC 2.0,
 * newline-delimited, over stdin/stdout — the transport Zed and the other ACP editors use.
 * Contract: https://agentclientprotocol.com.
 *
 * One long-lived process per session: `session/new` (or `session/resume` for "Continue"), then one
 * `session/prompt` per turn — its RESPONSE is the end of the turn. ACP has no mid-turn steering,
 * so a follow-up typed during a turn is queued and sent as the next turn. `session/cancel`
 * interrupts.
 *
 * Isolation: under a podman launcher the image's `kimi` runs in the task container, logged in
 * through the credentials directory `podmanRunArgs` mounts, with its home — and so its session
 * log — on the host at `~/.kimi-agent`.
 *
 * Kimi has no system-prompt channel over ACP, so `spec.systemPrompt` rides as a leading block of
 * the opening message (`prependSystemPrompt`), as with codex and opencode. The model is chosen
 * with `session/set_config_option`; an id Kimi does not offer fails the run loudly rather than
 * running on the default.
 *
 * Permissions: ACP asks the client before Kimi runs a mutating tool. cezar's default permission
 * mode is autonomous, so every request is approved — except a tool from cezar's allowlist
 * vocabulary that the step did not allow, and `Bash` whenever a `bashAllowlist` narrows it (the
 * prompt carries a truncated command, so a prefix check could not be trusted — fail closed, as
 * pi does). Read-only tools never prompt, so they cannot be denied this way.
 *
 * Token usage is not on the ACP wire; Kimi writes it to its own session log. See
 * `KimiUsageReader` and the header of `kimi-ui-mapper.ts`.
 */
export class KimiRunner implements AgentRunner {
  readonly backend = 'kimi' as const;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly launcher: ProcessLauncher;
  private lastSession: AgentSession | null = null;

  constructor(opts: KimiRunnerOptions = {}) {
    this.launcher = opts.launcher ?? localLauncher;
    // In a container the host's path to its binary means nothing: the image puts `kimi` on PATH.
    this.bin = opts.bin ?? (this.launcher.id === 'local' ? resolveKimiExecutable() : 'kimi');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }

  async interrupt(): Promise<void> {
    this.lastSession?.interrupt();
  }

  startSession(
    spec: AgentRunSpec,
    onEvent?: (event: AgentEvent) => void,
    opts: SessionOptions = {},
  ): AgentSession {
    const session = new KimiSession(this.bin, this.timeoutMs, spec, onEvent, opts, this.launcher);
    this.lastSession = session;
    return session;
  }
}

/**
 * `CEZ_KIMI_BIN`, else the dry-run mock, else `kimi` — found on PATH or, failing that, where Kimi's
 * installer puts it (`~/.kimi-code/bin/kimi`). The installer adds that directory to the user's
 * shell profile only, so a cockpit started by launchd or a desktop session would otherwise
 * report Kimi missing on a machine where it works in every terminal.
 */
export function resolveKimiExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CEZ_KIMI_BIN) return env.CEZ_KIMI_BIN;
  if (env.CEZ_DRY_RUN === '1') return mockKimiPath();
  if (onPath('kimi', env.PATH)) return 'kimi';
  const installed = join(env.HOME ?? homedir(), '.kimi-code', 'bin', 'kimi');
  return existsSync(installed) ? installed : 'kimi';
}

function onPath(bin: string, path: string | undefined): boolean {
  return (path ?? '').split(delimiter).some((dir) => dir !== '' && existsSync(join(dir, bin)));
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

class KimiSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;

  private readonly child!: ChildProcessWithoutNullStreams;
  private readonly env: NodeJS.ProcessEnv;
  private readonly hasExited: () => boolean;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stdinOpen = true;
  private sessionId: string | undefined;
  private ready!: Promise<void>;
  private promptId: number | undefined;
  /** True once the opening prompt has been sent; until then follow-ups queue behind it. */
  private opened = false;
  private readonly queued: string[] = [];
  private uiState: KimiUiMapperState = createKimiUiState();
  private usage: KimiUsageReader | undefined;
  private readonly toolCalls: AgentToolCallRecord[] = [];
  private readonly announced = new Set<string>();
  private readonly textChunks: string[] = [];
  /** Cost-weighted tokens of the live turn, and of the turns already completed. */
  private tokensUsed = 0;
  private runTokens = 0;
  private lastStopReason: Extract<UiEvent, { type: 'turn.completed' }>['stopReason'] = 'end_turn';
  private autoEndTimer: NodeJS.Timeout | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private spawnFailed: Error | null = null;
  private timedOut = false;
  /** Set when WE signal the child, so its 143 is read as our teardown, not a Kimi failure. */
  private terminatedByCezar = false;

  constructor(
    private readonly bin: string,
    timeoutMs: number,
    private readonly spec: AgentRunSpec,
    private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly opts: SessionOptions,
    private readonly launcher: ProcessLauncher,
  ) {
    this.env = buildChildEnv({ backend: 'kimi', extraEnv: spec.env });
    this.child = launcher.spawn(bin, ['acp'], { cwd: spec.cwd, env: this.env });
    this.hasExited = trackChildExit(this.child);
    this.child.on('error', (err: NodeJS.ErrnoException) => {
      this.spawnFailed = kimiSpawnError(err, bin);
    });
    const stderr: string[] = [];
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => stderr.push(chunk));

    const limitMs = spec.timeoutMs ?? timeoutMs;
    const deadline =
      limitMs > 0
        ? setTimeout(() => {
            this.timedOut = true;
            this.interrupt();
          }, limitMs)
        : undefined;
    deadline?.unref?.();

    this.ready = this.bootstrap();

    this.result = (async (): Promise<AgentRunResult> => {
      let sessionError: unknown;
      try {
        const readLoop = async () => {
          for await (const line of readNdjson(this.child.stdout)) {
            let msg: RpcMessage;
            try {
              msg = JSON.parse(line) as RpcMessage;
            } catch {
              this.emit({ type: 'note', message: `kimi: skipped unparseable ACP line: ${truncate(line)}` });
              continue;
            }
            await this.handle(msg);
          }
        };
        await Promise.all([this.ready, readLoop()]);
      } catch (err) {
        if (!this.timedOut) {
          sessionError = err;
          this.end();
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
        this.stdinOpen = false;
      }

      const exitCode = await waitForExit(this.child);
      if (this.killTimer) clearTimeout(this.killTimer);
      this.rejectPending('kimi acp exited');
      if (this.spawnFailed) throw this.spawnFailed;
      if (sessionError) {
        const message = sessionError instanceof Error ? sessionError.message : String(sessionError);
        this.emit({ type: 'error', message });
        throw sessionError instanceof Error ? sessionError : new Error(message);
      }

      const base: AgentRunResult = {
        text: this.textChunks.join('\n').trim(),
        toolCalls: this.toolCalls,
        tokensUsed: this.runTokens + this.tokensUsed,
        sessionId: this.sessionId ?? spec.sessionId,
      };
      if (this.timedOut) {
        const mins = Math.round((limitMs / 60_000) * 10) / 10;
        this.emit({ type: 'error', message: `kimi acp timed out after ${mins}m and was killed` });
        this.opts.onUiEvent?.({ type: 'session.ended', reason: 'timeout' });
        this.emit({ type: 'done' });
        return base;
      }
      if (exitCode !== 0 && exitCode !== null && !(this.terminatedByCezar && isSignalTerminationExit(exitCode))) {
        const detail = stderr.join('').trim().split('\n').slice(-3).join(' | ');
        const message = `kimi acp exited with code ${exitCode}${detail ? ` — ${detail}` : ''}`;
        this.emit({ type: 'error', message });
        throw new Error(message);
      }
      if (base.tokensUsed === 0) this.emit({ type: 'note', message: 'token usage not found in the kimi session log' });
      this.opts.onUiEvent?.({ type: 'session.ended', reason: this.lastStopReason });
      this.emit({ type: 'done' });
      return base;
    })();
  }

  get open(): boolean {
    return this.stdinOpen;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  sendMessage(content: ContentBlock[]): boolean {
    if (!this.stdinOpen) return false;
    if (this.autoEndTimer) {
      clearTimeout(this.autoEndTimer);
      this.autoEndTimer = undefined;
    }
    const text = content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    if (!text) return true;
    // ACP has no steering: a message typed mid-turn — or before the opening prompt has even gone
    // out — becomes the next turn. Only one `session/prompt` is ever in flight.
    if (this.promptId !== undefined || !this.opened) {
      this.queued.push(text);
      return true;
    }
    void this.prompt([{ type: 'text', text }]);
    return true;
  }

  end(): void {
    if (!this.stdinOpen) return;
    this.stdinOpen = false;
    try {
      this.child.stdin.end();
    } catch {
      // already gone
    }
    this.killTimer = setTimeout(() => {
      if (!this.hasExited()) {
        this.terminatedByCezar = true;
        void this.launcher.signal(this.child, 'SIGTERM');
      }
    }, KILL_GRACE_MS);
    this.killTimer.unref?.();
  }

  interrupt(): void {
    if (this.sessionId && this.promptId !== undefined) {
      this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
    }
    this.stdinOpen = false;
    if (!this.hasExited()) {
      this.terminatedByCezar = true;
      void this.launcher.signal(this.child, 'SIGTERM');
    }
  }

  // ---- protocol -----------------------------------------------------------

  private async bootstrap(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: 1,
      // cezar serves no files or terminals: Kimi uses its own tools in `cwd`.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const base = {
      cwd: this.spec.cwd,
      mcpServers: [],
      ...(this.spec.additionalDirectories?.length ? { additionalDirectories: this.spec.additionalDirectories } : {}),
    };
    let configOptions: unknown;
    if (this.spec.resume && this.spec.sessionId) {
      const res = await this.request('session/resume', { sessionId: this.spec.sessionId, ...base });
      this.sessionId = this.spec.sessionId;
      configOptions = res.configOptions;
    } else {
      const res = await this.request('session/new', base);
      this.sessionId = typeof res.sessionId === 'string' ? res.sessionId : undefined;
      configOptions = res.configOptions;
    }
    const sessionId = this.sessionId;
    if (!sessionId) throw new Error('kimi acp returned no session id');
    this.emit({ type: 'session', sessionId });
    const logHome = kimiLogHome(this.launcher, this.env);
    this.usage = logHome ? new KimiUsageReader(logHome, sessionId) : undefined;

    const model = this.spec.model?.trim();
    if (model && selectValue(configOptions, 'model') !== model) {
      const offered = selectOptions(configOptions, 'model');
      if (offered.length > 0 && !offered.includes(model)) {
        throw new Error(`kimi: model "${model}" is not offered by this Kimi account (available: ${offered.join(', ')})`);
      }
      const res = await this.request('session/set_config_option', { sessionId, configId: 'model', value: model });
      configOptions = res.configOptions ?? configOptions;
    }
    this.emitUi((state) => kimiSessionStarted(state, sessionId, configOptions));

    const images = (this.spec.images ?? []).flatMap((block) =>
      block.type === 'image' ? [{ type: 'image', data: block.source.data, mimeType: block.source.media_type }] : [],
    );
    await this.prompt([
      ...images,
      { type: 'text', text: prependSystemPrompt(this.spec.systemPrompt, this.spec.userPrompt) },
    ]);
  }

  /** Start one turn. Resolves as soon as the prompt is SENT; its response arrives in `handle`. */
  private async prompt(prompt: Array<Record<string, unknown>>): Promise<void> {
    if (!this.sessionId || !this.stdinOpen) return;
    this.opened = true;
    this.emitUi((state) => kimiTurnStarted(state));
    const id = this.nextId++;
    this.promptId = id;
    // Settled in `handle`, which must see the response BEFORE anything else does.
    this.pending.set(id, { resolve: () => undefined, reject: () => undefined });
    this.write({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: this.sessionId, prompt } });
  }

  private async handle(msg: RpcMessage): Promise<void> {
    // Agent → client request: a permission prompt, or something cezar does not serve.
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      this.answerRequest(msg.id, msg.method, msg.params ?? {});
      return;
    }
    if (typeof msg.id === 'number' && msg.id === this.promptId) {
      // The turn is over. Its token usage lives in Kimi's session log, not on this wire: feed it
      // to the mapper first, so `turn.completed` carries the turn's counts.
      this.promptId = undefined;
      this.pending.delete(msg.id);
      for (const record of await this.usageRecords()) this.emitUi((state) => mapKimiMessage(record, state));
      this.emitUi((state) => mapKimiMessage(msg, state));
      this.afterTurn();
      return;
    }
    this.emitUi((state) => mapKimiMessage(msg, state));
    this.dispatchResponse(msg);
  }

  private async usageRecords(): Promise<unknown[]> {
    if (!this.usage) return [];
    const records: unknown[] = [];
    const deadline = Date.now() + USAGE_SETTLE_MAX_MS;
    for (;;) {
      const read = this.usage.read();
      records.push(...read.records);
      if (read.turnEnded || Date.now() >= deadline) return records;
      await new Promise((resolve) => setTimeout(resolve, USAGE_POLL_MS));
    }
  }

  private afterTurn(): void {
    if (!this.stdinOpen) return;
    if (this.queued.length > 0) {
      const text = this.queued.splice(0).join('\n\n');
      void this.prompt([{ type: 'text', text }]);
      return;
    }
    if (this.opts.autoEndAfterFirstTurn && !this.autoEndTimer) {
      this.autoEndTimer = setTimeout(() => this.end(), AUTO_END_DELAY_MS);
      this.autoEndTimer.unref?.();
    }
  }

  private answerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method !== 'session/request_permission') {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `cezar does not serve ${method}` } });
      return;
    }
    const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const tool = typeof toolCall.title === 'string' ? toolCall.title : '';
    const denied = this.deniedReason(tool);
    const pick = denied
      ? options.find((o) => o.kind === 'reject_once') ?? options.find((o) => String(o.kind).startsWith('reject'))
      : options.find((o) => o.kind === 'allow_once') ?? options.find((o) => String(o.kind).startsWith('allow'));
    if (denied) this.emit({ type: 'note', message: `kimi: denied ${tool} — ${denied}` });
    const outcome =
      pick && typeof pick.optionId === 'string' ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' };
    this.write({ jsonrpc: '2.0', id, result: { outcome } });
  }

  private deniedReason(tool: string): string | undefined {
    if (!ALLOWLISTABLE_TOOLS.has(tool)) return undefined;
    const allowed = this.spec.allowedTools;
    if (allowed && allowed.length > 0 && !allowed.includes(tool)) return 'not in this step\'s allowedTools';
    if (tool === 'Bash' && this.spec.bashAllowlist && this.spec.bashAllowlist.length > 0) {
      return 'Kimi cannot enforce a bashAllowlist prefix, so Bash is off for this step';
    }
    return undefined;
  }

  private request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  private dispatchResponse(msg: RpcMessage): void {
    if (typeof msg.id !== 'number') return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error !== undefined) pending.reject(new Error(`kimi: ${errorText(msg.error)}`));
    else pending.resolve(isRecord(msg.result) ? msg.result : {});
  }

  private rejectPending(message: string): void {
    for (const request of this.pending.values()) request.reject(new Error(message));
    this.pending.clear();
  }

  private write(message: unknown): void {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // the read/exit path owns settlement
    }
  }

  // ---- emission -----------------------------------------------------------

  private emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  /** Map into v2, and derive the v1 stream from the same mapped events so the two cannot drift. */
  private emitUi(step: (state: KimiUiMapperState) => KimiUiMapping): void {
    const mapped = step(this.uiState);
    this.uiState = mapped.state;
    for (const event of mapped.events) {
      this.opts.onUiEvent?.(event);
      this.emitV1(event);
    }
  }

  private emitV1(event: UiEvent): void {
    switch (event.type) {
      case 'item.updated':
        if (event.item.kind === 'tool' && event.item.input !== undefined) this.announceTool(event.item);
        return;
      case 'item.completed':
        if (event.item.kind === 'message' && event.item.text.trim()) {
          this.textChunks.push(event.item.text);
          this.emit({ type: 'text', text: event.item.text });
        } else if (event.item.kind === 'tool') {
          this.announceTool(event.item);
          this.emit({
            type: 'tool-result',
            toolCallId: event.item.id,
            result: event.item.output ?? event.item.error ?? '',
            isError: event.item.status === 'failed',
          });
        }
        return;
      case 'usage.updated': {
        const u = event.usage;
        // Cost-weighted like every backend: cache reads are cheap, cache writes dearer.
        this.tokensUsed = Math.round(u.input + u.output + (u.cacheRead ?? 0) * 0.1 + (u.cacheWrite ?? 0) * 1.25);
        this.emit({ type: 'token-usage', tokensUsed: this.runTokens + this.tokensUsed });
        return;
      }
      case 'turn.completed':
        this.lastStopReason = event.stopReason;
        this.runTokens += this.tokensUsed;
        this.tokensUsed = 0;
        this.emit({ type: 'turn-end' });
        return;
      case 'session.error':
        this.emit({ type: 'error', message: event.message });
        return;
      default:
        return;
    }
  }

  private announceTool(item: UiToolItem): void {
    if (this.announced.has(item.id)) return;
    this.announced.add(item.id);
    this.toolCalls.push({ id: item.id, name: item.name, input: item.input });
    this.emit({ type: 'tool-call', id: item.id, tool: item.name, input: item.input });
  }
}

/**
 * Reads new `usage.record` lines from Kimi's own session log:
 * `<KIMI_CODE_HOME>/sessions/<workdir-key>/<sessionId>/agents/<agent>/wire.jsonl`, one file per
 * agent (`main`, plus one per sub-agent — their tokens are spent on this run too). The workdir
 * key is Kimi's private hash of the cwd, so the session dir is FOUND by its id rather than
 * derived. Each file is read from where the last read stopped; on a resumed session the first
 * read starts at the current end, so earlier turns are not billed again.
 *
 * Never throws: a missing or unreadable log means a turn without usage, not a failed run.
 */
export class KimiUsageReader {
  private sessionDir: string | undefined;
  private readonly offsets = new Map<string, number>();
  private primed = false;

  constructor(
    private readonly home: string,
    private readonly sessionId: string,
  ) {
    this.prime();
  }

  /** New usage records since the last read, and whether the main agent's turn has ended. */
  read(): { records: unknown[]; turnEnded: boolean } {
    const records: unknown[] = [];
    let turnEnded = false;
    try {
      const dir = this.locate();
      // No log at all (another home, a mock): nothing will arrive by waiting for it.
      if (!dir) return { records, turnEnded: true };
      const agentsDir = join(dir, 'agents');
      for (const agent of readdirSync(agentsDir)) {
        const file = join(agentsDir, agent, 'wire.jsonl');
        if (!existsSync(file)) continue;
        const text = readFileSync(file, 'utf8');
        const from = this.offsets.get(file) ?? 0;
        // Only whole lines: a half-written trailing record is read next time.
        const end = text.lastIndexOf('\n') + 1;
        if (end <= from) continue;
        for (const line of text.slice(from, end).split('\n')) {
          if (agent === 'main' && line.includes('"type":"turn.ended"')) turnEnded = true;
          if (!line.includes('"usage.record"')) continue;
          try {
            const value = JSON.parse(line) as unknown;
            if (isRecord(value) && value.type === 'usage.record') records.push(value);
          } catch {
            // a torn line is skipped, never fatal
          }
        }
        this.offsets.set(file, end);
      }
    } catch {
      // degrade: no usage for this turn
    }
    return { records, turnEnded };
  }

  /** Records what already exists, so a resumed session counts only its new turns. */
  private prime(): void {
    if (this.primed) return;
    this.primed = true;
    try {
      const dir = this.locate();
      if (!dir) return;
      const agentsDir = join(dir, 'agents');
      for (const agent of readdirSync(agentsDir)) {
        const file = join(agentsDir, agent, 'wire.jsonl');
        if (existsSync(file)) this.offsets.set(file, statSync(file).size);
      }
    } catch {
      // nothing to prime
    }
  }

  private locate(): string | undefined {
    if (this.sessionDir) return this.sessionDir;
    const sessions = join(this.home, 'sessions');
    if (!existsSync(sessions)) return undefined;
    for (const workdir of readdirSync(sessions)) {
      const candidate = join(sessions, workdir, this.sessionId);
      if (existsSync(candidate)) {
        this.sessionDir = candidate;
        return candidate;
      }
    }
    return undefined;
  }
}


/**
 * Where THIS session's log lands, seen from the host. Locally that is Kimi's own home; in a podman
 * container it is the agent home mounted at `/root/.kimi-code`. Any other launcher has no host
 * view of the log, so its turns simply carry no usage.
 */
function kimiLogHome(launcher: ProcessLauncher, env: NodeJS.ProcessEnv): string | undefined {
  if (launcher.id === 'local') return kimiHome(env);
  if (launcher.id === 'podman') return agentKimiHome();
  return undefined;
}

function selectOptions(configOptions: unknown, id: string): string[] {
  if (!Array.isArray(configOptions)) return [];
  const option = configOptions.find((o) => isRecord(o) && o.id === id);
  if (!isRecord(option) || !Array.isArray(option.options)) return [];
  return option.options.flatMap((o) => (isRecord(o) && typeof o.value === 'string' ? [o.value] : []));
}

function selectValue(configOptions: unknown, id: string): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const option = configOptions.find((o) => isRecord(o) && o.id === id);
  return isRecord(option) && typeof option.currentValue === 'string' ? option.currentValue : undefined;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('close', resolve));
}

export function kimiSpawnError(error: unknown, bin: string): Error {
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return new Error(`\`${bin}\` not found on PATH — install Kimi Code and run \`kimi login\``);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function errorText(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/** Path to the bundled mock (`scripts/mock-kimi-acp.mjs`), for CEZ_DRY_RUN=1. */
function mockKimiPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/core (built) or <pkg>/src/core (tsx dev).
  return resolvePath(here, '..', '..', 'scripts', 'mock-kimi-acp.mjs');
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
