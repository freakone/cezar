import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchBase, resolveBaseRef } from './git-worktree.ts';

/**
 * A task must fork from the base as it is ON THE REMOTE, not as this checkout
 * last saw it. `resolveBaseRef` already prefers `origin/<base>` over a stale
 * local branch — but only as of the last fetch, and nothing ran one, so a
 * checkout that had not fetched in a week started every task a week behind and
 * the task then "changed" everything that had landed since.
 *
 * Exercised against a real local remote: no network, but a genuine `git fetch`.
 */
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@l'];
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scenario(): { clone: string; origin: string } {
  const origin = mkdtempSync(join(tmpdir(), 'cez-origin-'));
  const work = mkdtempSync(join(tmpdir(), 'cez-work-'));
  const clone = mkdtempSync(join(tmpdir(), 'cez-clone-'));
  made.push(origin, work, clone);
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  writeFileSync(join(work, 'a.txt'), 'one');
  execFileSync('git', [...ID, 'add', '-A'], { cwd: work });
  execFileSync('git', [...ID, 'commit', '-q', '-m', 'first'], { cwd: work });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: work });
  execFileSync('git', ['clone', '-q', origin, clone]);
  // Someone else pushes while this checkout is not looking.
  writeFileSync(join(work, 'b.txt'), 'two');
  execFileSync('git', [...ID, 'add', '-A'], { cwd: work });
  execFileSync('git', [...ID, 'commit', '-q', '-m', 'landed since'], { cwd: work });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: work });
  return { clone, origin };
}

describe('taking the latest base from the remote', () => {
  it('moves origin/<base> forward, and says how far', async () => {
    const { clone } = scenario();
    const stale = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: clone, encoding: 'utf8' }).trim();

    const result = await fetchBase(clone, 'main');

    expect(result.ok).toBe(true);
    expect(result.remote).toBe('origin');
    const fresh = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: clone, encoding: 'utf8' }).trim();
    expect(fresh).not.toBe(stale);
    // Reported, so the run log can say the base moved rather than leaving the
    // operator to wonder why the diff looks different from yesterday's.
    expect(result.moved).toEqual({ from: stale.slice(0, 8), to: fresh.slice(0, 8) });
  }, 20_000);

  it('is what makes the task fork from the NEW tip', async () => {
    const { clone } = scenario();
    // Before fetching, the resolver can only choose between two stale refs.
    expect(await resolveBaseRef(clone, 'main')).toBe('main');
    const before = execFileSync('git', ['rev-parse', 'main'], { cwd: clone, encoding: 'utf8' }).trim();

    await fetchBase(clone, 'main');

    // Now the local branch is behind origin, so the resolver picks origin —
    // which is the whole point of fetching first.
    expect(await resolveBaseRef(clone, 'main')).toBe('origin/main');
    const forkPoint = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: clone, encoding: 'utf8' }).trim();
    expect(forkPoint).not.toBe(before);
  }, 20_000);

  it('reports git\'s own words when the remote cannot be reached, and never throws', async () => {
    const { clone } = scenario();
    execFileSync('git', ['remote', 'set-url', 'origin', '/nonexistent/repo.git'], { cwd: clone });
    const result = await fetchBase(clone, 'main');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    // Non-fatal: cezar has to work on a plane, and the task forks from disk.
    expect(await resolveBaseRef(clone, 'main')).toBe('main');
  }, 20_000);

  it('skips a repo with no remote at all', async () => {
    const solo = mkdtempSync(join(tmpdir(), 'cez-solo-'));
    made.push(solo);
    execFileSync('git', ['init', '-q', '-b', 'main', solo]);
    execFileSync('git', [...ID, 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: solo });
    expect(await fetchBase(solo, 'main')).toMatchObject({ ok: false, reason: 'no remote named "origin"' });
  }, 20_000);

  it('refuses an option-like base rather than passing it to git', async () => {
    const { clone } = scenario();
    expect(await fetchBase(clone, '--upload-pack=touch /tmp/pwned')).toMatchObject({ ok: false });
  });

  it('never waits on an ssh prompt, and keeps the operator\'s own ssh command', async () => {
    // `GIT_TERMINAL_PROMPT=0` does not reach ssh: a passphrase or an unseen
    // host key made it open the terminal and wait out the whole timeout at
    // every task start. The command is recorded by a fake ssh that exits.
    const { clone } = scenario();
    const log = join(clone, 'ssh-args.log');
    const fakeSsh = join(clone, 'fake-ssh.sh');
    writeFileSync(fakeSsh, `#!/bin/sh\necho "$@" > ${log}\nexit 255\n`, { mode: 0o755 });
    execFileSync('git', ['remote', 'set-url', 'origin', 'git@example.invalid:x/y.git'], { cwd: clone });
    // A repo whose sshCommand names a key relies on it to authenticate at all.
    execFileSync('git', ['config', 'core.sshCommand', `${fakeSsh} -i /keys/deploy`], { cwd: clone });

    const result = await fetchBase(clone, 'main');

    expect(result.ok).toBe(false);
    const args = readFileSync(log, 'utf8');
    expect(args).toContain('BatchMode=yes');
    // Extended, not replaced — the key is still there.
    expect(args).toContain('-i /keys/deploy');
  }, 20_000);
});
