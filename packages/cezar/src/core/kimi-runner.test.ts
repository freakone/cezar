import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-runner.js';
import { buildChildEnv } from './agent-env.js';
import { detectEnvironment } from './backend-detect.js';
import { kimiModelsFromConfig } from './kimi-model-catalog.js';
import { kimiHome } from './kimi-home.js';
import { KimiRunner, KimiUsageReader, resolveKimiExecutable } from './kimi-runner.js';
import { backendSupportsLauncher, createRunner } from './runner-factory.js';
import type { UiEvent } from './ui-events.js';

const MOCK = join(import.meta.dirname, '..', '..', 'scripts', 'mock-kimi-acp.mjs');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-kimi-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createRunner returns the kimi runner', () => {
  it('maps the "kimi" id to a KimiRunner with backend "kimi"', () => {
    const runner = createRunner('kimi');
    expect(runner).toBeInstanceOf(KimiRunner);
    expect(runner.backend).toBe('kimi');
  });

  it('honours a launcher, so a Kimi task can run isolated', () => {
    expect(backendSupportsLauncher('kimi')).toBe(true);
  });

  it('runs the image’s `kimi` in a container, never the host’s path to it', () => {
    const container = {
      id: 'podman' as const,
      describe: () => 'test container',
      spawn: () => {
        throw new Error('unused');
      },
      signal: async () => undefined,
    };
    expect((new KimiRunner({ launcher: container }) as unknown as { bin: string }).bin).toBe('kimi');
  });
});

describe('resolveKimiExecutable', () => {
  it('prefers CEZ_KIMI_BIN, then the mock under dry run', () => {
    expect(resolveKimiExecutable({ CEZ_KIMI_BIN: '/opt/kimi', CEZ_DRY_RUN: '1' })).toBe('/opt/kimi');
    expect(resolveKimiExecutable({ CEZ_DRY_RUN: '1' })).toMatch(/mock-kimi-acp\.mjs$/);
  });

  it('finds the installer’s ~/.kimi-code/bin/kimi when PATH does not have it (a launchd cockpit)', () => {
    const bin = join(dir, '.kimi-code', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'kimi'), '#!/bin/sh\n');
    expect(resolveKimiExecutable({ HOME: dir, PATH: '/usr/bin' })).toBe(join(bin, 'kimi'));
    expect(resolveKimiExecutable({ HOME: dir, PATH: bin })).toBe('kimi');
    expect(resolveKimiExecutable({ HOME: join(dir, 'nobody'), PATH: '' })).toBe('kimi');
  });
});

describe('backend-detect handles an absent kimi CLI', () => {
  const saved = { bin: process.env.CEZ_KIMI_BIN, dry: process.env.CEZ_DRY_RUN };
  afterEach(() => {
    if (saved.bin === undefined) delete process.env.CEZ_KIMI_BIN;
    else process.env.CEZ_KIMI_BIN = saved.bin;
    if (saved.dry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved.dry;
  });

  it('reports kimi as unavailable with a hint, and never rejects', async () => {
    delete process.env.CEZ_DRY_RUN;
    process.env.CEZ_KIMI_BIN = join(tmpdir(), 'cez-kimi-does-not-exist-xyz');
    const kimi = (await detectEnvironment()).find((c) => c.name === 'kimi');
    expect(kimi).toMatchObject({ available: false });
    expect(kimi!.hint).toContain('kimi login');
  });
});

describe('kimi child env', () => {
  it('carries KIMI_* (its home and API key) and nothing of another vendor’s', () => {
    const saved = { ...process.env };
    try {
      process.env.KIMI_CODE_HOME = '/profiles/work';
      process.env.KIMI_API_KEY = 'k';
      process.env.OPENAI_API_KEY = 'o';
      process.env.ANTHROPIC_API_KEY = 'a';
      const env = buildChildEnv({ backend: 'kimi' });
      expect(env.KIMI_CODE_HOME).toBe('/profiles/work');
      expect(env.KIMI_API_KEY).toBe('k');
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });
});

describe('a KimiRunner session over the ACP mock', () => {
  function run(spec: Partial<Parameters<KimiRunner['run']>[0]> & { env?: Record<string, string> } = {}) {
    const events: AgentEvent[] = [];
    const ui: UiEvent[] = [];
    const runner = new KimiRunner({ bin: MOCK });
    const session = runner.startSession(
      { userPrompt: 'investigate the login redirect bug', cwd: dir, timeoutMs: 20_000, ...spec },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true, onUiEvent: (event) => ui.push(event) },
    );
    return { session, events, ui };
  }

  it('streams both protocols, bills usage from the session log, and terminates with one done', async () => {
    const home = join(dir, 'kimi-home');
    const { session, events, ui } = run({ env: { KIMI_CODE_HOME: home }, model: 'kimi-code/k3' });
    const result = await session.result;

    const types = events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['session', 'tool-call', 'tool-result', 'text', 'token-usage', 'turn-end']));
    expect(types.filter((t) => t === 'done')).toHaveLength(1);
    expect(result.sessionId).toBe('session_00000000-0000-4000-8000-00000000kimi');
    expect(result.text).toContain('Investigating: investigate the login redirect bug');
    expect(result.toolCalls).toEqual([{ id: '1:tool_mock', name: 'Read', input: { path: 'README.md' } }]);
    expect(result.tokensUsed).toBe(15);

    expect(ui[0]).toEqual({
      type: 'session.started',
      sessionId: 'session_00000000-0000-4000-8000-00000000kimi',
      backend: 'kimi',
      model: 'kimi-code/k3',
    });
    const completed = ui.find((e) => e.type === 'turn.completed');
    expect(completed).toMatchObject({ stopReason: 'end_turn', usage: { input: 10, output: 5, total: 15 } });
    expect(ui.at(-1)).toEqual({ type: 'session.ended', reason: 'end_turn' });
  });

  it('switches to the requested model before the first prompt', async () => {
    const { session, ui } = run({ model: 'kimi-code/k3-256k' });
    await session.result;
    expect(ui.find((e) => e.type === 'session.started')).toMatchObject({ model: 'kimi-code/k3-256k' });
  });

  it('fails loud on a model the account does not offer, instead of running on the default', async () => {
    const { session, events } = run({ model: 'kimi-code/k9' });
    await expect(session.result).rejects.toThrow(/kimi-code\/k9.*not offered.*kimi-code\/k3/);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('delivers the system prompt as a leading block of the opening message', async () => {
    const { session } = run({ systemPrompt: 'Rules first.' });
    const result = await session.result;
    // The mock echoes the prompt's last line, and its first when a system block leads it.
    expect(result.text).toContain('Investigating: investigate the login redirect bug [rules: Rules first.]');
  });

  it('approves a permission prompt by default, and denies a tool the step did not allow', async () => {
    const open = run({ userPrompt: 'go ask:Bash' });
    expect((await open.session.result).text).toContain('permission Bash: approve_once');

    const narrowed = run({ userPrompt: 'go ask:Bash', allowedTools: ['Read', 'Edit'] });
    expect((await narrowed.session.result).text).toContain('permission Bash: reject');
    expect(narrowed.events).toContainEqual({ type: 'note', message: "kimi: denied Bash — not in this step's allowedTools" });

    // A bashAllowlist cannot be checked against Kimi's truncated command, so Bash fails closed.
    const prefixed = run({ userPrompt: 'go ask:Bash', allowedTools: ['Bash'], bashAllowlist: ['npm test'] });
    expect((await prefixed.session.result).text).toContain('permission Bash: reject');

    // Kimi's own tools are outside cezar's allowlist vocabulary and stay allowed.
    const own = run({ userPrompt: 'go ask:Agent', allowedTools: ['Read'] });
    expect((await own.session.result).text).toContain('permission Agent: approve_once');
  });

  it('queues a message typed mid-turn and sends it as the next turn', async () => {
    const events: AgentEvent[] = [];
    const runner = new KimiRunner({ bin: MOCK });
    let sent = false;
    const session = runner.startSession({ userPrompt: 'first', cwd: dir, timeoutMs: 20_000 }, (event) => {
      events.push(event);
      if (event.type === 'session' && !sent) {
        sent = true;
        expect(session.sendMessage([{ type: 'text', text: 'second' }])).toBe(true);
      }
      if (event.type === 'turn-end' && events.filter((e) => e.type === 'turn-end').length === 2) session.end();
    });
    const result = await session.result;
    expect(result.text).toContain('Investigating: first');
    expect(result.text).toContain('Investigating: second');
  });
});

describe('KimiUsageReader', () => {
  const record = (input: number) =>
    `${JSON.stringify({ type: 'usage.record', agentId: 'main', usage: { inputOther: input, output: 1 } })}\n`;
  const ended = `${JSON.stringify({ type: 'turn.ended', agentId: 'main' })}\n`;

  it('reads every agent’s new records once, and reports when the main turn has ended', () => {
    const session = join(dir, 'sessions', 'wd_repo_abc', 'session_1', 'agents');
    mkdirSync(join(session, 'main'), { recursive: true });
    mkdirSync(join(session, 'agent-0'), { recursive: true });
    const reader = new KimiUsageReader(dir, 'session_1');
    writeFileSync(join(session, 'main', 'wire.jsonl'), record(1));
    writeFileSync(join(session, 'agent-0', 'wire.jsonl'), record(2));
    const first = reader.read();
    expect(first.records).toHaveLength(2);
    expect(first.turnEnded).toBe(false);
    writeFileSync(join(session, 'main', 'wire.jsonl'), record(1) + record(3) + ended);
    const second = reader.read();
    expect(second.records).toEqual([expect.objectContaining({ usage: { inputOther: 3, output: 1 } })]);
    expect(second.turnEnded).toBe(true);
  });

  it('does not re-bill a resumed session’s earlier turns', () => {
    const main = join(dir, 'sessions', 'wd_repo_abc', 'session_2', 'agents', 'main');
    mkdirSync(main, { recursive: true });
    writeFileSync(join(main, 'wire.jsonl'), record(100) + ended);
    const reader = new KimiUsageReader(dir, 'session_2');
    expect(reader.read().records).toEqual([]);
  });

  it('leaves a half-written trailing line for the next read', () => {
    const main = join(dir, 'sessions', 'wd', 'session_3', 'agents', 'main');
    mkdirSync(main, { recursive: true });
    const reader = new KimiUsageReader(dir, 'session_3');
    const line = record(7);
    writeFileSync(join(main, 'wire.jsonl'), line.slice(0, 20));
    expect(reader.read().records).toEqual([]);
    writeFileSync(join(main, 'wire.jsonl'), line);
    expect(reader.read().records).toHaveLength(1);
  });

  it('degrades to "nothing to wait for" when the log cannot be found or read', () => {
    expect(new KimiUsageReader(join(dir, 'missing'), 'session_x').read()).toEqual({ records: [], turnEnded: true });
    const agents = join(dir, 'sessions', 'wd', 'session_4', 'agents');
    mkdirSync(agents, { recursive: true });
    chmodSync(agents, 0o000);
    try {
      expect(new KimiUsageReader(dir, 'session_4').read().records).toEqual([]);
    } finally {
      chmodSync(agents, 0o700);
    }
  });

  it('honours KIMI_CODE_HOME for the home it reads', () => {
    expect(kimiHome({ KIMI_CODE_HOME: '/p/work', HOME: '/h' })).toBe('/p/work');
    expect(kimiHome({ HOME: '/h' })).toBe('/h/.kimi-code');
  });
});

describe('kimi model catalog', () => {
  it('lists every [models."<alias>"] table under the alias Kimi selects with', () => {
    const models = kimiModelsFromConfig({
      default_model: 'kimi-code/k3',
      models: {
        'kimi-code/k3': { display_name: 'K3', max_context_size: 262_144 },
        'kimi-code/kimi-for-coding': { display_name: 'K2.8 Preview', max_context_size: 1_048_576 },
        broken: 'not a table',
      },
    });
    expect(models).toEqual([
      { id: 'kimi-code/k3', label: 'K3', description: 'kimi-code/k3 · 256K context · your Kimi default' },
      { id: 'kimi-code/kimi-for-coding', label: 'K2.8 Preview', description: 'kimi-code/kimi-for-coding · 1M context' },
    ]);
  });

  it('answers nothing, not a guess, for a config without models', () => {
    expect(kimiModelsFromConfig({})).toEqual([]);
    expect(kimiModelsFromConfig(null)).toEqual([]);
  });
});
