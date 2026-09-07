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
  resources: { shmSize: '1g' },
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

  it('NEVER mounts a credential that is absent — podman would create a directory', () => {
    // On a host where Claude Code keeps its token in the Keychain, that file
    // legitimately does not exist. Mounting blindly leaves a DIRECTORY named
    // `.credentials.json` inside the operator's real ~/.claude.
    const args = podmanRunArgs(cfg(), 'c', REPO, {
      credentialPassthrough: true,
      credentialExists: () => false,
    }).join(' ');
    expect(args).not.toContain('.credentials.json');
  });

  it('a repo with no Containerfile runs the BASE image, not a tag that cannot exist', () => {
    // The derived tag is only buildable when there is a Containerfile to build
    // it from; naming it anyway made the default configuration unable to run.
    expect(imageTag(cfg(), false)).toBe('localhost/cezar-agent/base:latest');
    expect(imageTag(cfg(), true)).toBe('cezar-agent/textbook:latest');
    // An explicit pin still wins over both.
    expect(imageTag(cfg({ image: 'my/img:1' }), false)).toBe('my/img:1');
    expect(podmanRunArgs(cfg(), 'c', REPO, { credentialPassthrough: false, hasContainerfile: false }))
      .toContain('localhost/cezar-agent/base:latest');
  });

  it('does NOT unset ANTHROPIC_API_KEY/GH_TOKEN — that is an sbx quirk', () => {
    // sbx injects placeholders into PID 1; podman injects nothing, and
    // buildChildEnv forwards the host's REAL keys. Unsetting them here deleted
    // the only credential an API-key user has.
    const args = podmanExecArgs(cfg(), 'c', 'claude', [], { cwd: REPO, env: {} }, '/tmp/p.pid');
    expect(args.join(' ')).not.toContain('unset ANTHROPIC_API_KEY');
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

  it('shm defaults to 1g — podman\'s 64m kills any headless browser the agent starts', () => {
    // And it fails as an out-of-memory error, not a shared-memory one, which is
    // why the default is set here rather than left to whoever debugs it.
    const args = podmanRunArgs(cfg(), 'cez-run1', REPO);
    expect(args).toContain('--shm-size');
    expect(args[args.indexOf('--shm-size') + 1]).toBe('1g');
  });

  it('memory and cpu limits are passed when set, and omitted when not', () => {
    const limited = podmanRunArgs(cfg({ resources: { shmSize: '2g', memory: '6g', cpus: 4 } }), 'c', REPO);
    expect(limited).toContain('--memory');
    expect(limited).toContain('6g');
    expect(limited).toContain('--cpus');
    expect(limited).toContain('4');
    // Unset means "whatever the VM has" — NOT a guessed cap.
    expect(podmanRunArgs(cfg(), 'c', REPO)).not.toContain('--memory');
  });

  it('publishes a loopback port for HTTP-speaking backends only when asked', () => {
    const withPort = podmanRunArgs(cfg(), 'c', REPO, { credentialPassthrough: true, publishPort: 41234 });
    expect(withPort).toContain('-p');
    expect(withPort).toContain('127.0.0.1:41234:41234');
    expect(podmanRunArgs(cfg(), 'c', REPO)).not.toContain('-p');
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
    expect(createLauncher(cfg(), { name: 'cez-run1' }).id).toBe('podman');
    expect(createLauncher(cfg(), { name: 'cez-run1' }).describe()).toContain('cez-run1');
  });
});
