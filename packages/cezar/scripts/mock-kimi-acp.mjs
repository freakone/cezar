#!/usr/bin/env node
// A stand-in `kimi acp` for CEZ_DRY_RUN=1: the ACP JSON-RPC shapes Kimi Code 0.39 sends, with
// canned content. Token usage goes to a session log ONLY under an explicit KIMI_CODE_HOME, so a
// dry run never writes into the real ~/.kimi-code.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';

const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } });
let model = 'kimi-code/k3';
let turn = 0;
// A prompt containing `ask:<Tool>` asks the client's permission for that tool first — the
// `session/request_permission` round-trip Kimi makes before a mutating tool runs.
const waiting = new Map();
let nextRequest = 1000;
const askPermission = (sessionId, tool) =>
  new Promise((resolve) => {
    const id = nextRequest++;
    waiting.set(id, resolve);
    send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        options: [
          { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
          { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
        toolCall: { toolCallId: `perm-${id}`, title: tool, content: [] },
      },
    });
  });
const configOptions = () => [
  {
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: model,
    options: ['kimi-code/kimi-for-coding', 'kimi-code/kimi-for-coding-highspeed', 'kimi-code/k3-256k', 'kimi-code/k3'].map(
      (value) => ({ value, name: value }),
    ),
  },
];

readline.createInterface({ input: process.stdin }).on('line', (line) => void handle(line));

async function handle(line) {
  const msg = JSON.parse(line);
  const { id, method, params = {} } = msg;
  if (!method && waiting.has(id)) {
    waiting.get(id)(msg.result?.outcome?.optionId ?? 'cancelled');
    waiting.delete(id);
  } else if (method === 'initialize') {
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'mock kimi', version: '0.0.0' } } });
  } else if (method === 'session/new') {
    send({ id, result: { sessionId: 'session_00000000-0000-4000-8000-00000000kimi', configOptions: configOptions() } });
  } else if (method === 'session/resume') {
    send({ id, result: { configOptions: configOptions() } });
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'model') model = params.value;
    send({ id, result: { configOptions: configOptions() } });
  } else if (method === 'session/prompt') {
    turn += 1;
    const sid = params.sessionId;
    const text = (params.prompt ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const tool = `${turn}:tool_mock`;
    const asked = /ask:(\w+)/.exec(text)?.[1];
    if (asked) {
      const outcome = await askPermission(sid, asked);
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission ${asked}: ${outcome}\n` } });
    }
    update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reading the README first.' } });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: tool, title: 'Read', status: 'pending', kind: 'read', content: [] });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'in_progress', title: 'Reading README.md', kind: 'read', rawInput: { path: 'README.md' } });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'mock file' } }] });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Investigating: ${text.split('\n').pop()}${text.includes('\n---\n') ? ` [rules: ${text.split('\n')[0]}]` : ''}` } });
    if (process.env.KIMI_CODE_HOME) {
      const dir = join(process.env.KIMI_CODE_HOME, 'sessions', 'wd_mock', sid, 'agents', 'main');
      mkdirSync(dir, { recursive: true });
      const usage = { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 };
      appendFileSync(
        join(dir, 'wire.jsonl'),
        `${JSON.stringify({ type: 'usage.record', agentId: 'main', model, usage, usageScope: 'turn' })}\n` +
          `${JSON.stringify({ type: 'turn.ended', agentId: 'main', turnId: turn - 1, reason: 'completed' })}\n`,
      );
    }
    send({ id, result: { stopReason: 'end_turn' } });
  } else if (id !== undefined && method) {
    send({ id, error: { code: -32601, message: `mock kimi does not implement ${method}` } });
  }
}
