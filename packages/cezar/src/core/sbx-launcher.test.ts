import { describe, expect, it } from 'vitest';
import { sbxCreateArgs, sbxExecArgs } from './sbx-launcher.ts';
import { containerEnvPairs as sandboxEnvPairs, guestScript } from './container-runtime.ts';
import { createLauncher } from './launcher-factory.ts';
import { localLauncher } from './process-launcher.ts';
import type { SandboxConfig } from '../config.ts';

const cfg = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({
  enabled: true,
  provider: 'sbx',
  containerfile: '.ai/cezar/Containerfile',
  claudeCredentialPassthrough: true,
  resources: { shmSize: '1g' },
  name: 'textbook',
  agent: 'shell',
  createIfMissing: true,
  tmpdir: '/tmp/cez-agent',
  unsetPlaceholderCredentials: true,
  ...over,
});

const opts = {
  cwd: '/Users/k/work/app/.ai/cezar/worktrees/abc',
  env: { CEZ_TASK_ID: 'abc', CEZ_HANDOFF_FILE: '/Users/k/work/app/.ai/cezar/runs/abc.handoff.md' },
};

describe('sbx launcher', () => {
  it('runs the agent at the SAME path inside — sbx bind-mounts it there', () => {
    const args = sbxExecArgs(cfg(), 'claude', ['--verbose'], opts, '/tmp/cez-agent/p.pid');
    expect(args.slice(0, 4)).toEqual(['exec', '-i', '-w', opts.cwd]);
    // No `-t`: a pty would echo and line-edit the stream-json protocol.
    expect(args).not.toContain('-t');
    // The agent argv is passed verbatim after the guest shell.
    expect(args.slice(-3)).toEqual(['cez-sbx', 'claude', '--verbose']);
    expect(args).toContain('textbook');
  });

  it('forwards cezar run variables but never host-shaped ones', () => {
    const pairs = sandboxEnvPairs(
      { CEZ_TASK_ID: 'abc', PATH: '/opt/homebrew/bin', HOME: '/Users/k', SHELL: '/bin/zsh', ANTHROPIC_MODEL: 'opus' },
      '/tmp/cez-agent',
    );
    expect(pairs).toContain('CEZ_TASK_ID=abc');
    expect(pairs).toContain('ANTHROPIC_MODEL=opus');
    // A host PATH inside a Linux container resolves to nothing; HOME would
    // point the agent at a directory that does not exist there.
    expect(pairs.some((p) => p.startsWith('PATH='))).toBe(false);
    expect(pairs.some((p) => p.startsWith('HOME='))).toBe(false);
    expect(pairs.some((p) => p.startsWith('SHELL='))).toBe(false);
  });

  it('forces TMPDIR off the bind mount — the ENOENT/fstat crash', () => {
    // cezar hands the agent <repo>/.ai/cezar/tmp/<runId>; on the macOS bind
    // mount the native claude binary dies there before it logs anything.
    const pairs = sandboxEnvPairs({ TMPDIR: '/Users/k/work/app/.ai/cezar/tmp/abc' }, '/tmp/cez-agent');
    expect(pairs).toContain('TMPDIR=/tmp/cez-agent');
    expect(pairs).toContain('TEMP=/tmp/cez-agent');
    expect(pairs).toContain('TMP=/tmp/cez-agent');
    expect(pairs.filter((p) => p.startsWith('TMPDIR='))).toHaveLength(1);
  });

  it('the guest shell records the agent pid and unsets the placeholder creds', () => {
    const script = guestScript(['ANTHROPIC_API_KEY', 'GH_TOKEN']);
    // `exec` replaces the shell in place, so the recorded pid IS the agent's.
    expect(script).toContain('echo $$ > "$CEZ_PID_FILE"');
    expect(script).toContain('exec "$@"');
    expect(script.indexOf('echo $$')).toBeLessThan(script.indexOf('exec "$@"'));
    expect(script).toContain('unset ANTHROPIC_API_KEY GH_TOKEN');
    expect(script).toContain('mkdir -p "$TMPDIR"');
  });

  it('keeps the sandbox credentials when the sandbox has real ones bound', () => {
    expect(guestScript([])).not.toContain('unset ');
  });

  it('creates a NAMED sandbox from the repo image so tasks are not handed a clean one', () => {
    expect(sbxCreateArgs(cfg({ image: 'node:22-bookworm' }), '/Users/k/work/app')).toEqual([
      'create', '--name', 'textbook', '--template', 'node:22-bookworm', 'shell', '/Users/k/work/app',
    ]);
    // No image = the agent kind's default template.
    expect(sbxCreateArgs(cfg(), '/Users/k/work/app')).toEqual([
      'create', '--name', 'textbook', 'shell', '/Users/k/work/app',
    ]);
  });

  it('isolation is opt-in: absent or disabled config stays local', () => {
    expect(createLauncher(undefined)).toBe(localLauncher);
    expect(createLauncher(cfg({ enabled: false }))).toBe(localLauncher);
    expect(createLauncher(cfg()).id).toBe('sbx');
    expect(createLauncher(cfg()).describe()).toContain('textbook');
  });
});
