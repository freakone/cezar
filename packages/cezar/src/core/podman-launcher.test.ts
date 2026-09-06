import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { agentClaudeHome, imageTag, podmanBuildArgs, podmanExecArgs, podmanRunArgs } from './podman-launcher.ts';
import { createLauncher } from './launcher-factory.ts';
import { localLauncher } from './process-launcher.ts';
import type { SandboxConfig } from '../config.ts';

const cfg = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
  enabled: true,
  provider: 'podman',
  name: 'textbook',
  agent: 'shell',
  createIfMissing: true,
  tmpdir: '/tmp/cez-agent',
  unsetPlaceholderCredentials: true,
  containerfile: '.ai/cezar/Containerfile',
  claudeCredentialPassthrough: true,
  ...over,
});

const REPO = '/Users/k/work/app';

describe('podman launcher', () => {
  it('mounts the repo at its own absolute path — nothing translates paths', () => {
    const args = podmanRunArgs(cfg(), 'cez-run1', REPO);
    expect(args).toContain(`${REPO}:${REPO}`);
  });

  it('passes ONLY the credential through — conversations stay on the host', () => {
    const args = podmanRunArgs(cfg(), 'cez-run1', REPO).join(' ');
    // The agent gets its own claude home, on a host volume so transcripts can
    // never be stranded inside a container that is gone.
    expect(args).toContain(`${agentClaudeHome()}:/root/.claude`);
    // Tier 1: the credential file, and nothing else.
    expect(args).toContain(`${homedir()}/.claude/.credentials.json:/root/.claude/.credentials.json`);
    // Never the conversation stores.
    expect(args).not.toContain('/.claude/projects');
    expect(args).not.toContain('/.claude/sessions');
    expect(args).not.toContain('history.jsonl');
  });

  it('read-write on the credential: claude rewrites it when the token refreshes', () => {
    const mount = podmanRunArgs(cfg(), 'cez-run1', REPO)
      .find((a) => a.includes('.credentials.json'));
    // A `:ro` suffix here works until the OAuth token expires, then fails
    // inscrutably — so it must be absent.
    expect(mount?.endsWith(':ro')).toBe(false);
  });

  it('credential passthrough can be declined (log in inside the container instead)', () => {
    const args = podmanRunArgs(cfg(), 'cez-run1', REPO, { credentialPassthrough: false }).join(' ');
    expect(args).not.toContain('.credentials.json');
    // The agent's own store is still mounted — that is where its login lands.
    expect(args).toContain(`${agentClaudeHome()}:/root/.claude`);
  });

  it('cache volumes survive the per-task container, so installs stay warm', () => {
    const args = podmanRunArgs(cfg({ cacheVolumes: { 'cez-npm': '/root/.npm' } }), 'cez-run1', REPO);
    expect(args).toContain('cez-npm:/root/.npm');
  });

  it('ephemeral paths get a fresh anonymous volume, shadowing the slow bind mount', () => {
    const args = podmanRunArgs(
      cfg({ ephemeralPaths: ['/Users/k/work/app/web/node_modules'] }),
      'cez-run1',
      REPO,
    );
    // A bare target with no source = anonymous volume: VM-native speed, never
    // on the host, discarded with the container.
    expect(args).toContain('/Users/k/work/app/web/node_modules');
    expect(args).not.toContain(`/Users/k/work/app/web/node_modules:/Users/k/work/app/web/node_modules`);
  });

  it('the image is per repo and prepared once, not built per task', () => {
    expect(imageTag(cfg())).toBe('cezar-agent/textbook:latest');
    expect(imageTag(cfg({ image: 'my/toolchain:v3' }))).toBe('my/toolchain:v3');
    expect(podmanBuildArgs(cfg(), `${REPO}/.ai/cezar/Containerfile`, REPO)).toEqual([
      'build', '-t', 'cezar-agent/textbook:latest', '-f', `${REPO}/.ai/cezar/Containerfile`, REPO,
    ]);
  });

  it('exec keeps stdin open, sets the worktree cwd, and never allocates a pty', () => {
    const args = podmanExecArgs(cfg(), 'cez-run1', 'claude', ['--verbose'], {
      cwd: `${REPO}/.ai/cezar/worktrees/abc`,
      env: { CEZ_TASK_ID: 'abc' },
    }, '/tmp/cez-agent/p.pid');
    expect(args.slice(0, 4)).toEqual(['exec', '-i', '-w', `${REPO}/.ai/cezar/worktrees/abc`]);
    expect(args).not.toContain('-t');
    expect(args).toContain('-e');
    expect(args).toContain('CEZ_TASK_ID=abc');
    expect(args.slice(-3)).toEqual(['cez-podman', 'claude', '--verbose']);
    // The TMPDIR fix applies to podman exactly as it did to sbx.
    expect(args).toContain('TMPDIR=/tmp/cez-agent');
  });

  it('podman without a container falls back to local rather than faking isolation', () => {
    // A misconfigured run must not silently exec into nothing.
    expect(createLauncher(cfg())).toBe(localLauncher);
    expect(createLauncher(cfg(), 'cez-run1').id).toBe('podman');
    expect(createLauncher(cfg(), 'cez-run1').describe()).toContain('cez-run1');
  });
});
