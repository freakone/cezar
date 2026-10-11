import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, LOCAL_CONFIG_FILE } from '../config.ts';
import type { SandboxConfig } from '../config.ts';
import { ingestTodos, readTodos } from '../todos.ts';
import { acceptSuggestions } from './containerfile-store.ts';
import { renderContainerfile } from './containerfile-suggest.ts';
import { parseMachines } from './container-probe.ts';
import { isGuestPath, isVolumeName, refusedHostPath } from './credential-passthrough.ts';
import { podmanExec, repoMounts, type RepoFs } from './podman-launcher.ts';
import { isUnderMount } from './podman-lifecycle.ts';
import { secretFragments } from './secret-redaction.ts';

/**
 * The isolation hardening: what an agent inside a task container can and cannot reach on the
 * host. Each case pins one guarantee from the review that produced it.
 */

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
};

/** A fake filesystem: `dirs` are directories, `files` are files, everything else is absent. */
function fakeFs(dirs: string[], files: string[] = []): RepoFs {
  return {
    exists: (path) => dirs.includes(path) || files.includes(path),
    isDir: (path) => dirs.includes(path),
  };
}

/** `-v a:b[:ro]` pairs → `{ path: 'ro' | 'rw' }`. */
function mountTable(args: string[]): Record<string, 'ro' | 'rw'> {
  const out: Record<string, 'ro' | 'rw'> = {};
  args.forEach((arg, i) => {
    if (args[i - 1] !== '-v') return;
    const [source, , options] = arg.split(':');
    out[source!] = options === 'ro' ? 'ro' : 'rw';
  });
  return out;
}

describe('the repo as an isolated task sees it', () => {
  const R = '/Users/k/app';
  const wt = `${R}/.ai/cezar/worktrees/run1`;

  it('worktree task: the checkout is read-only; only its own worktree and git’s object stores are writable', () => {
    const fs = fakeFs(
      [R, `${R}/.git`, `${R}/.git/objects`, `${R}/.git/refs`, `${R}/.git/logs`, `${R}/.git/hooks`,
        `${R}/.git/worktrees/run1`, wt, `${R}/.ai/cezar`, `${R}/.ai/cezar/tmp/run1`, `${R}/.ai/cezar/runs`],
      [`${wt}/.git`, `${R}/.git/worktrees/run1/commondir`, `${R}/.git/worktrees/run1/gitdir`, `${R}/.git/config`],
    );
    const table = mountTable(repoMounts(R, 'run1', fs));
    expect(table).toEqual({
      [R]: 'ro',
      [wt]: 'rw',
      [`${wt}/.git`]: 'ro',
      [`${R}/.git/objects`]: 'rw',
      [`${R}/.git/refs`]: 'rw',
      [`${R}/.git/logs`]: 'rw',
      [`${R}/.git/worktrees/run1`]: 'rw',
      [`${R}/.git/worktrees/run1/commondir`]: 'ro',
      [`${R}/.git/worktrees/run1/gitdir`]: 'ro',
      [`${R}/.ai/cezar/tmp/run1`]: 'rw',
      [`${R}/.ai/cezar/runs`]: 'rw',
    });
    // The two that turned a container into host code execution: hooks and config run on the
    // operator's next `git` command, outside any container.
    expect(table[`${R}/.git/hooks`]).toBeUndefined();
    expect(table[`${R}/.git/config`]).toBeUndefined();
  });

  it('in-place task: the checkout is writable, but git’s config, hooks and cezar’s own data are not', () => {
    const fs = fakeFs(
      [R, `${R}/.git`, `${R}/.git/hooks`, `${R}/.git/info`, `${R}/.ai/cezar`, `${R}/.ai/cezar/runs`],
      [`${R}/.git/config`],
    );
    expect(mountTable(repoMounts(R, 'run1', fs))).toEqual({
      [R]: 'rw',
      [`${R}/.git/config`]: 'ro',
      [`${R}/.git/hooks`]: 'ro',
      [`${R}/.git/info`]: 'ro',
      [`${R}/.ai/cezar`]: 'ro',
      [`${R}/.ai/cezar/runs`]: 'rw',
    });
  });
});

describe('podman exec environment', () => {
  const cfg = {
    enabled: true, provider: 'podman', name: 'app', agent: 'shell', createIfMissing: true,
    tmpdir: '/tmp/cez-agent', unsetPlaceholderCredentials: true, containerfile: '.ai/cezar/Containerfile',
    claudeCredentialPassthrough: false, resources: { shmSize: '1g' },
  } as unknown as SandboxConfig;

  it('points the follow-up inbox into the run’s writable scratch dir, and leaves "off" off', () => {
    const on = podmanExec(cfg, 'c', 'claude', [], {
      cwd: '/r', env: { CEZ_TODOS_FILE: '/r/.ai/cezar/todos.json', TMPDIR: '/r/.ai/cezar/tmp/run1' },
    }, '/tmp/p');
    expect(on.env.CEZ_TODOS_FILE).toBe('/r/.ai/cezar/tmp/run1/todos.json');
    const off = podmanExec(cfg, 'c', 'claude', [], { cwd: '/r', env: { CEZ_TODOS_FILE: '', TMPDIR: '/r/.ai/cezar/tmp/run1' } }, '/tmp/p');
    expect(off.env.CEZ_TODOS_FILE).toBe('');
  });
});

describe('follow-ups from an isolated task', () => {
  it('moves valid entries into the inbox and removes the file before returning', async () => {
    const dataDir = temp('cez-todos-');
    const file = join(dataDir, 'tmp', 'run1', 'todos.json');
    mkdirSync(join(dataDir, 'tmp', 'run1'), { recursive: true });
    writeFileSync(file, JSON.stringify([{ summary: 'rotate the key' }, { nope: true }]));
    const pending = ingestTodos(dataDir, file);
    // Synchronous read + remove: a scratch-dir delete right after cannot lose it.
    expect(existsSync(file)).toBe(false);
    await pending;
    const inbox = await readTodos(dataDir);
    expect(inbox.map((t) => t.summary)).toEqual(['rotate the key']);
  });

  it('is a no-op when the agent wrote nothing', async () => {
    const dataDir = temp('cez-todos-');
    await ingestTodos(dataDir, join(dataDir, 'absent.json'));
    expect(existsSync(join(dataDir, 'todos.json'))).toBe(false);
  });
});

describe('what a credential grant may name', () => {
  it('refuses a host path that would expose the whole home or smuggle mount options', () => {
    const home = '/Users/k';
    expect(refusedHostPath('/', home)).toBeDefined();
    expect(refusedHostPath('/Users', home)).toBeDefined();
    expect(refusedHostPath('/Users/k/', home)).toBeDefined();
    expect(refusedHostPath('/Users/k/.aws:/root/x', home)).toBeDefined();
    expect(refusedHostPath('/Users/k/.aws', home)).toBeUndefined();
  });

  it('takes only named volumes and absolute guest paths for cache volumes', () => {
    expect(isVolumeName('npm-cache')).toBe(true);
    expect(isVolumeName('/Users/k')).toBe(false);
    expect(isGuestPath('/root/.npm')).toBe(true);
    expect(isGuestPath('/root/../etc')).toBe(false);
    expect(isGuestPath('/x,rw')).toBe(false);
  });

  it('revokes copied credentials only outside a mount — never through a bind into the host', () => {
    expect(isUnderMount('/root/.ssh/id_work', ['/root/.ssh'])).toBe(true);
    expect(isUnderMount('/root/.sshx', ['/root/.ssh'])).toBe(false);
    // An unreadable mount table counts as mounted: touch nothing rather than guess.
    expect(isUnderMount('/root/.ssh/id_work', undefined)).toBe(true);
  });
});

describe('who may grant credentials', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  const grant = { sandbox: { enabled: true, credentials: { enabled: { 'github-cli': true } } } };

  function repoWith(config: object, { tracked }: { tracked: boolean }): string {
    const root = temp('cez-trust-');
    git(root, 'init', '-q');
    mkdirSync(join(root, '.ai', 'cezar'), { recursive: true });
    writeFileSync(join(root, '.ai', 'cezar', 'config.json'), JSON.stringify(config));
    if (tracked) {
      git(root, 'add', '-f', '.ai/cezar/config.json');
      git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'config');
    }
    return root;
  }

  it('ignores a COMMITTED config’s grants — a clone cannot grant itself the operator’s credentials', async () => {
    const config = await loadConfig(repoWith(grant, { tracked: true }));
    expect(config.sandbox?.enabled).toBe(true);
    expect(config.sandbox?.credentials?.enabled?.['github-cli']).toBeUndefined();
  });

  it('honours an untracked config’s grants, and config.local.json’s for a tracked one', async () => {
    expect((await loadConfig(repoWith(grant, { tracked: false }))).sandbox?.credentials?.enabled?.['github-cli']).toBe(true);
    const root = repoWith({ sandbox: { enabled: true } }, { tracked: true });
    writeFileSync(join(root, '.ai', 'cezar', LOCAL_CONFIG_FILE), JSON.stringify({ sandbox: grant.sandbox }));
    expect((await loadConfig(root)).sandbox?.credentials?.enabled?.['github-cli']).toBe(true);
  });
});

describe('accepting a Containerfile suggestion', () => {
  it('appends to a file the user wrote instead of rewriting it', () => {
    const repo = temp('cez-cf-');
    const dataDir = join(repo, '.ai', 'cezar');
    mkdirSync(dataDir, { recursive: true });
    const own = 'FROM localhost/cezar-agent/base:latest\n# my tools\nRUN apt-get install -y jq\n';
    writeFileSync(join(dataDir, 'Containerfile'), own);
    writeFileSync(join(dataDir, 'container-suggestions.json'), JSON.stringify({
      pending: [{ command: 'npm install -g pnpm', manager: 'npm' }, { command: 'apt-get install -y jq', manager: 'apt' }],
    }));
    acceptSuggestions(dataDir, repo, '.ai/cezar/Containerfile', ['npm install -g pnpm', 'apt-get install -y jq'], (all) => renderContainerfile(all));
    expect(readFileSync(join(dataDir, 'Containerfile'), 'utf8')).toBe(`${own}RUN npm install -g pnpm\n`);
  });
});

describe('secret redaction fragments', () => {
  it('scrubs a multi-line secret line by line, without its PEM armour', () => {
    const pem = '-----BEGIN KEY-----\nMIIEabcdef\nQWERTYuiop\n-----END KEY-----';
    expect(secretFragments(pem)).toEqual([pem, 'MIIEabcdef', 'QWERTYuiop']);
  });

  it('keeps a short chosen secret, but not noise', () => {
    expect(secretFragments('hunter2')).toEqual(['hunter2']);
    expect(secretFragments('ab')).toEqual([]);
  });
});

describe('which podman machine to start', () => {
  it('prefers the default machine over the first row', () => {
    const rows = JSON.stringify([{ Name: 'scratch', Running: false }, { Name: 'main', Running: false, Default: true }]);
    expect(parseMachines(rows)).toEqual({ running: false, name: 'main' });
  });
});
