import { describe, expect, it } from 'vitest';
import { applyCredentialsToRunning, syncClaudeCredential, taskContainerName } from './podman-lifecycle.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxConfig } from '../config.ts';

describe('podman lifecycle', () => {
  it('names a container after its run, prefixed so a stray one is obviously cezar\'s', () => {
    expect(taskContainerName('ab57117a-607c-4393-8bfc-b9c99145dac8')).toBe('cez-ab57117a');
    // Stable for the same run: a Continue must find the container the first
    // turn created, not make a second one beside it.
    expect(taskContainerName('ab57117a-607c-4393-8bfc-b9c99145dac8'))
      .toBe(taskContainerName('ab57117a-607c-4393-8bfc-b9c99145dac8'));
  });
});

describe('applying a credential to containers that already exist', () => {
  const REPO = '/Users/k/work/app';
  const OTHER = '/Users/k/work/other';
  // A selection whose file is absent: resolved (so the early return does not
  // fire) but with an empty copy plan, so nothing is executed and the test
  // observes the CHOICE of containers rather than the copying.
  const cfg = {
    credentials: { enabled: { aws: true } },
  } as unknown as SandboxConfig;

  const podman = (mounts: Record<string, string[]>): (args: string[]) => Promise<string> => async (args) => {
    if (args[0] === 'ps') return Object.keys(mounts).join('\n');
    if (args[0] === 'inspect') return (mounts[args[1] as string] ?? []).join('\n');
    throw new Error(`unexpected: ${args.join(' ')}`);
  };

  it('updates this project\'s containers and NOBODY else\'s', async () => {
    // Matched by the workspace a container has mounted, because that is the
    // only statement about which repo it belongs to that cannot drift. Pushing
    // one project's keys into another project's container is the failure this
    // is designed against.
    const updated = await applyCredentialsToRunning(cfg, REPO, 'podman', podman({
      'cez-aaaaaaaa': [REPO, '/Users/k/.claude-agent'],
      'cez-bbbbbbbb': [OTHER],
      'cez-cccccccc': [REPO],
    }));
    expect(updated).toEqual(['cez-aaaaaaaa', 'cez-cccccccc']);
  });

  it('ignores containers that are not cezar\'s', async () => {
    const updated = await applyCredentialsToRunning(cfg, REPO, 'podman', podman({
      'postgres-dev': [REPO],
      'cez-aaaaaaaa': [REPO],
    }));
    expect(updated).toEqual(['cez-aaaaaaaa']);
  });

  it('answers empty when podman is not there — a save must not fail on it', async () => {
    const broken = async (): Promise<string> => { throw new Error('podman: command not found'); };
    await expect(applyCredentialsToRunning(cfg, REPO, 'podman', broken)).resolves.toEqual([]);
  });

  it('does nothing at all when no credentials are selected', async () => {
    const none = { credentials: {} } as unknown as SandboxConfig;
    const updated = await applyCredentialsToRunning(none, REPO, 'podman', podman({ 'cez-aaaaaaaa': [REPO] }));
    expect(updated).toEqual([]);
  });
});

describe('the claude credential in a container from an older cezar', () => {
  // These containers bind-MOUNTED the credential. A relogin on the host
  // rewrites that file atomically, which unlinks the inode the mount holds:
  // `ls` still reports 508 bytes and every read fails with ENOENT. The agent
  // then says "Not logged in — please run /login", which is the one action that
  // cannot help, because doing it rewrites the file and breaks the mount again.
  const calls: string[][] = [];
  // A real file, so the test exercises the same path a logged-in machine does
  // and does not quietly skip itself on a machine that has never logged in.
  const source = join(mkdtempSync(join(tmpdir(), 'cez-cred-test-')), '.credentials.json');
  writeFileSync(source, '{"claudeAiOauth":{"accessToken":"sk-ant-test"}}');
  const podman = (readable: boolean): (args: string[]) => Promise<string> => async (args) => {
    calls.push(args);
    if (args[0] === 'exec' && args[2] === 'head' && !readable) throw new Error('ENOENT');
    return '';
  };

  it('restarts the container when the credential cannot be READ, and copies again', async () => {
    calls.length = 0;
    await syncClaudeCredential('cez-old', 'podman', podman(false), source);
    expect(calls.some((c) => c[0] === 'restart' && c[1] === 'cez-old')).toBe(true);
    // And the copy is redone AFTER the restart, or the container would come
    // back up holding whatever the stale mount resolves to.
    const restartAt = calls.findIndex((c) => c[0] === 'restart');
    expect(calls.slice(restartAt).some((c) => c[0] === 'cp')).toBe(true);
  });

  it('does NOT restart when the credential reads fine — the normal case', async () => {
    calls.length = 0;
    await syncClaudeCredential('cez-new', 'podman', podman(true), source);
    expect(calls.some((c) => c[0] === 'restart')).toBe(false);
  });

  it('checks by READING, never by ls — a deleted inode still stats', async () => {
    calls.length = 0;
    await syncClaudeCredential('cez-new', 'podman', podman(true), source);
    const probe = calls.find((c) => c[0] === 'exec' && c.includes('head'));
    expect(probe).toBeDefined();
    expect(calls.some((c) => c.includes('ls'))).toBe(false);
  });

  it('syncs nothing when the host has no credential — the Keychain case', async () => {
    // The container may hold its own login; overwriting it with nothing, or
    // restarting it in a loop, would be worse than leaving it alone.
    calls.length = 0;
    await syncClaudeCredential('cez-new', 'podman', podman(false), join(tmpdir(), 'cez-absent-credential'));
    expect(calls).toEqual([]);
  });
});
