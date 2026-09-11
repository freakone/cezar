import { describe, expect, it } from 'vitest';
import { applyCredentialsToRunning, taskContainerName } from './podman-lifecycle.ts';
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
