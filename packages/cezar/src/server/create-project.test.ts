import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, type GitRunner } from './create-project.ts';

describe('createProject', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-create-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const noopGit: GitRunner = async () => undefined;

  it('creates a repo cezar can actually branch a task from', async () => {
    // The real git, on purpose: an initialized repo with NO commits has no
    // HEAD, and every task branches a worktree off HEAD. Registering such a
    // project succeeds and then fails on its first task with git's words about
    // an invalid reference — which is why the initial commit is part of
    // creation rather than something a first task discovers.
    const result = await createProject({ name: 'my-app', projectsDir: join(root, 'projects') });
    expect(result).toMatchObject({ ok: true, name: 'my-app' });
    const target = join(root, 'projects', 'my-app');
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# my-app\n');
    // HEAD resolves, which is the whole point.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    // And a worktree can be made from it — the operation every task performs.
    execFileSync('git', ['worktree', 'add', join(root, 'wt'), '-b', 'task-1'], { cwd: target });
    expect(existsSync(join(root, 'wt', 'README.md'))).toBe(true);
  });

  it('refuses a name that is a path, and never touches the disk for one', async () => {
    for (const name of ['../escape', 'a/b', '.', '..', '.ssh', '/abs', '']) {
      const result = await createProject({ name, projectsDir: join(root, 'projects'), git: noopGit });
      expect(result, name).toMatchObject({ ok: false, status: 400 });
    }
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });

  it('409s on an existing folder and does NOT touch what is there', async () => {
    const projects = join(root, 'projects');
    const taken = join(projects, 'taken');
    await createProject({ name: 'taken', projectsDir: projects, git: noopGit });
    writeFileSync(join(taken, 'mine.txt'), 'precious', 'utf8');

    const result = await createProject({ name: 'taken', projectsDir: projects, git: noopGit });
    expect(result).toMatchObject({ ok: false, status: 409 });
    // The existing directory is untouched — the non-recursive mkdir learned it
    // was there without reading or writing anything inside it.
    expect(readFileSync(join(taken, 'mine.txt'), 'utf8')).toBe('precious');
  });

  it('cleans up when git fails, and surfaces git\'s own message', async () => {
    // The commonest real failure: no user.email configured. git says "Please
    // tell me who you are", which is worth far more than a paraphrase.
    const failing: GitRunner = async (args) => {
      if (args[0] !== 'commit') return;
      throw Object.assign(new Error('exit 128'), {
        stderr: '*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"',
      });
    };
    const result = await createProject({ name: 'doomed', projectsDir: join(root, 'projects'), git: failing });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect((result as { error: string }).error).toContain('Please tell me who you are');
    // A half-made project must not be left behind: the next attempt would meet
    // it and get a 409 instead.
    expect(existsSync(join(root, 'projects', 'doomed'))).toBe(false);
  });

  it('creates the checkout root on demand — a fresh install has never had one', async () => {
    const result = await createProject({ name: 'first', projectsDir: join(root, 'never', 'existed') });
    expect(result).toMatchObject({ ok: true });
    expect(existsSync(join(root, 'never', 'existed', 'first', '.git'))).toBe(true);
  });

  it('leaves the default branch to the operator\'s git config', async () => {
    // `git init -b main` would make a project created here look unlike every
    // other repo the same person makes.
    const args: string[][] = [];
    await createProject({
      name: 'x',
      projectsDir: join(root, 'projects'),
      git: async (a) => { args.push(a); },
    });
    expect(args[0]).toEqual(['init']);
  });
});
