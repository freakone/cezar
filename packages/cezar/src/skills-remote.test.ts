import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bareDirFor, isPinnedSha, materializeSkillDirs, shouldPassiveFetch } from './skills-remote.ts';
import type { Skill } from './skills.ts';

const TTL = 6 * 60 * 60 * 1_000;

describe('shouldPassiveFetch', () => {
  it('fetches on the first passive touch this process', () => {
    // A clone left by an earlier run must be refreshed on first read, else a
    // long-running server serves whatever ref that old clone happened to have.
    expect(shouldPassiveFetch({ attempted: false, fetchedAt: 0, now: 1_000, ttlMs: TTL })).toBe(true);
  });

  it('does not re-fetch within the TTL once touched', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - 60_000, now, ttlMs: TTL })).toBe(false);
  });

  it('re-fetches once the last fetch is older than the TTL', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - TTL - 1, now, ttlMs: TTL })).toBe(true);
  });

  it('treats exactly-TTL as still fresh (strictly greater re-fetches)', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - TTL, now, ttlMs: TTL })).toBe(false);
  });
});

describe('bareDirFor', () => {
  it('keys the global cache on owner__name regardless of URL shape', () => {
    const expected = bareDirFor('open-mercato/skills');
    expect(bareDirFor('https://github.com/open-mercato/skills.git')).toBe(expected);
    expect(bareDirFor('git@github.com:open-mercato/skills')).toBe(expected);
    expect(expected.endsWith('open-mercato__skills')).toBe(true);
  });
});

describe('isPinnedSha', () => {
  it('accepts 40- and 64-hex, rejects branch names', () => {
    expect(isPinnedSha('a'.repeat(40))).toBe(true);
    expect(isPinnedSha('b'.repeat(64))).toBe(true);
    expect(isPinnedSha('main')).toBe(false);
  });
});

describe('materializing a whole imported collection', () => {
  const saved = process.env.CEZ_HOME;
  const made: string[] = [];
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = saved;
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: string[], cwd: string): void => { execFileSync('git', args, { cwd, stdio: 'ignore' }); };

  it('writes every team directory skill with its references, and skips the rest', async () => {
    // A collection's skills delegate to each other, so the run needs the SET on
    // disk — the selected skill alone is what made the agent report the whole
    // collection as "not installed". Local skills are already where the agent
    // looks, so they are untouched.
    const home = mkdtempSync(join(tmpdir(), 'cez-skills-home-'));
    const source = mkdtempSync(join(tmpdir(), 'cez-skills-src-'));
    const repo = mkdtempSync(join(tmpdir(), 'cez-skills-repo-'));
    made.push(home, source, repo);
    process.env.CEZ_HOME = home;

    // A skills repo shaped like the real one: SKILL.md plus references/.
    mkdirSync(join(source, 'skills/om-a/references'), { recursive: true });
    mkdirSync(join(source, 'skills/om-b'), { recursive: true });
    writeFileSync(join(source, 'skills/om-a/SKILL.md'), '# A\nStop and run om-b.\n');
    writeFileSync(join(source, 'skills/om-a/references/rules.md'), '# verdict rules\n');
    writeFileSync(join(source, 'skills/om-b/SKILL.md'), '# B\n');
    run(['init', '-q', '-b', 'main'], source);
    run(['-c', 'user.name=t', '-c', 'user.email=t@l', 'add', '-A'], source);
    run(['-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-q', '-m', 'skills'], source);
    // The bare clone where `bareDirFor` will look — now under CEZ_HOME.
    const bare = bareDirFor('acme/skills');
    mkdirSync(dirname(bare), { recursive: true });
    execFileSync('git', ['clone', '--bare', '-q', source, bare], { stdio: 'ignore' });
    run(['init', '-q'], repo);

    const team = (name: string): Skill => ({
      name,
      body: '',
      path: `${name}/SKILL.md`,
      source: 'team',
      team: { repo: 'acme/skills', ref: 'main', path: `skills/${name}/SKILL.md`, dir: true },
    });
    const local: Skill = { name: 'local-one', body: '', path: '.ai/skills/local-one.md', source: 'ai' };

    const done = await materializeSkillDirs(repo, [team('om-a'), team('om-b'), local]);

    expect(done.sort()).toEqual(['om-a', 'om-b']);
    // The companion files come too: they are what the skill delegates its
    // actual mechanics to, and their absence is what read as "not installed".
    expect(readFileSync(join(repo, '.claude/skills/om-a/references/rules.md'), 'utf8')).toContain('verdict rules');
    expect(existsSync(join(repo, '.claude/skills/om-b/SKILL.md'))).toBe(true);
    // A non-team skill is not a directory in a bare clone; nothing is invented.
    expect(existsSync(join(repo, '.claude/skills/local-one'))).toBe(false);
  }, 20_000)
})
