import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { defaultSandboxFor, type SandboxConfig } from '../config.ts';
import type { TaskContainer } from '../core/podman-lifecycle.ts';

/**
 * What a task records about WHERE its agent ran.
 *
 * The request (`isolated`) and the outcome (`isolation`) are two different
 * facts, and the cockpit's indicator reads the second. They disagree whenever a
 * container was wanted and not obtained — a stopped VM, a runner with no
 * launcher, a build that fails — which is the one case where reporting the
 * request would actively mislead: someone reads "isolated" and gives the task
 * work they would not give an agent running on their laptop.
 *
 * Exercised at `prepareSandbox`, the seam that makes the decision. The decision
 * lives in the agent-step path, so a workflow of shell commands never reaches
 * it and records nothing — correctly, since no agent ran there.
 *
 * Every case here returns BEFORE `startTaskContainer`. That is deliberate: this
 * suite must not talk to a real podman, and an earlier draft that let one case
 * through left four containers running on the developer's machine. The
 * container-failure reason is covered by `podman-lifecycle`'s own tests.
 */

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

type Seam = {
  prepareSandbox(
    runId: string,
    sandbox: SandboxConfig | undefined,
    backend: 'claude' | 'codex' | undefined,
    stepId: string,
    override?: boolean,
  ): Promise<TaskContainer | undefined>;
};

function harness(): { store: RunStore; seam: Seam; runId: (isolated?: boolean) => string } {
  const root = mkdtempSync(join(tmpdir(), 'cez-isolation-record-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root);
  return {
    store,
    seam: manager as unknown as Seam,
    runId: (isolated?: boolean) =>
      store.createRun({
        title: 't',
        workflow: 'w',
        task: 't',
        steps: [{ id: 'step', command: 'noop' }],
        ...(isolated === undefined ? {} : { isolated }),
      }).id,
  };
}

const podman = (): SandboxConfig => ({
  enabled: true,
  provider: 'podman',
  name: 'x',
  agent: 'shell',
  createIfMissing: true,
  tmpdir: '/tmp/cez-agent',
  unsetPlaceholderCredentials: false,
  containerfile: '.ai/cezar/Containerfile',
  claudeCredentialPassthrough: false,
  resources: { shmSize: '1g' },
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('what a run records about where it ran', () => {
  it('records "not isolated" with no reason when nobody asked', async () => {
    const { store, seam, runId } = harness();
    const id = runId();
    await seam.prepareSandbox(id, undefined, 'claude', 'step');
    // `effective: false` and NO reason is the ordinary host run, which the
    // cockpit renders differently from a fallback — and differently again from
    // a run so old that nothing was recorded at all.
    expect(store.getRun(id)?.isolation).toEqual({ effective: false });
  });

  it('records WHY a wanted container did not happen, and keeps the request intact', async () => {
    const { store, seam, runId } = harness();
    const id = runId(true);
    await seam.prepareSandbox(id, { ...podman(), provider: 'sbx' } as SandboxConfig, 'claude', 'step', true);

    const run = store.getRun(id);
    expect(run?.isolation?.effective).toBe(false);
    expect(run?.isolation?.reason).toMatch(/no container provider/);
    // The REQUEST survives: a Continue reads `isolated` as its override, so
    // overwriting it with the outcome would pin a task to the host forever
    // after one bad turn.
    expect(run?.isolated).toBe(true);
  });

  it('an explicit request in an UNCONFIGURED repo gets the default sandbox', async () => {
    // The override is documented as winning in both directions. Before this it
    // could only ever turn isolation OFF: a repo with no `sandbox` block has no
    // provider, so the request fell through to the host with the task marked
    // isolated. Every project made through "New project" starts that way.
    //
    // Asserted through `defaultSandboxFor` rather than by running a container:
    // reaching podman is what this suite must not do.
    const sandbox = defaultSandboxFor('commetria');
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.provider).toBe('podman');
    expect(sandbox.name).toBe('commetria');
    // The same configuration the Settings switch would have written — the
    // shm default included, since podman's 64m kills a headless browser.
    expect(sandbox.resources?.shmSize).toBe('1g');
  });

  it('a name that is not a legal container name is cleaned, never passed through', () => {
    // It becomes an image tag (`cezar-agent/<name>:latest`); a directory called
    // "My Repo (v2)" would produce one podman refuses.
    expect(defaultSandboxFor('My Repo (v2)').name).toBe('my-repo-v2');
    expect(defaultSandboxFor('...').name).toBe('cezar');
  });

  it('a task that opts OUT records the host outcome even where the project isolates', async () => {
    const { store, seam, runId } = harness();
    const id = runId(false);
    await seam.prepareSandbox(id, podman(), 'claude', 'step', false);
    // No reason: nothing failed, the task simply did not want a container. That
    // distinction is the point — this row must not wear a warning.
    expect(store.getRun(id)?.isolation).toEqual({ effective: false });
  });
});
