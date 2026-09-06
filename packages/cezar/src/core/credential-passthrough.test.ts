import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_CATALOG,
  credentialCopyPlan,
  credentialEnvPairs,
  credentialMountArgs,
  resolvePassthrough,
} from './credential-passthrough.ts';

const HOME = '/Users/k';
const allExist = () => true;
const noneExist = () => false;

describe('credential passthrough', () => {
  it('passes nothing unless asked — isolation is the default', () => {
    expect(resolvePassthrough(undefined, HOME, allExist)).toEqual([]);
    expect(resolvePassthrough({}, HOME, allExist)).toEqual([]);
  });

  it('each catalog entry is the credential alone, never a whole home directory', () => {
    // The same rule as mounting `.credentials.json` instead of all of ~/.claude:
    // a tool's key is not its history, its cache, or its other projects.
    for (const source of CREDENTIAL_CATALOG) {
      expect(source.hostPath === '.' || source.hostPath === '').toBe(false);
      expect(source.hostPath?.startsWith('..')).not.toBe(true);
    }
  });

  it('mount vs copy is per credential, with a default that fits the tool', () => {
    // gcloud refreshes its OAuth token in place, so a copy goes stale.
    expect(CREDENTIAL_CATALOG.find((c) => c.id === 'gcloud')?.defaultMode).toBe('mount');
    // A gh token is static — a copy keeps the container from rewriting yours.
    expect(CREDENTIAL_CATALOG.find((c) => c.id === 'github-cli')?.defaultMode).toBe('copy');
  });

  it('the operator can override the mode per credential', () => {
    const resolved = resolvePassthrough(
      { enabled: { gcloud: { mode: 'copy' } } }, HOME, allExist,
    );
    expect(resolved[0]?.mode).toBe('copy');
  });

  it('a missing file is SKIPPED with a reason, never mounted', () => {
    // podman would create an empty directory there, and an empty ~/.aws reads
    // to every tool as "logged out" — a worse failure than "not found".
    const resolved = resolvePassthrough({ enabled: { aws: true } }, HOME, noneExist);
    expect(resolved[0]?.skipped).toMatch(/does not exist/);
    expect(credentialMountArgs(resolved)).toEqual([]);
    expect(credentialCopyPlan(resolved, 'cez-1')).toEqual([]);
  });

  it('mounts and copies land in the right mechanism', () => {
    const resolved = resolvePassthrough(
      { enabled: { gcloud: true, 'github-cli': true } }, HOME, allExist,
    );
    expect(credentialMountArgs(resolved)).toEqual([
      '-v', `${HOME}/.config/gcloud:/root/.config/gcloud`,
    ]);
    expect(credentialCopyPlan(resolved, 'cez-1')).toEqual([
      ['cp', `${HOME}/.config/gh/hosts.yml`, 'cez-1:/root/.config/gh/hosts.yml'],
    ]);
  });

  it('forwards env vars that are set, and never empty ones', () => {
    const resolved = resolvePassthrough({ enabled: { aws: true } }, HOME, allExist);
    const pairs = credentialEnvPairs(resolved, { AWS_PROFILE: 'dev', AWS_REGION: '' });
    expect(pairs).toContain('AWS_PROFILE=dev');
    // An empty value would SHADOW a credential the container already has —
    // exactly how sbx's ANTHROPIC_API_KEY placeholder broke the claude login.
    expect(pairs.some((p) => p.startsWith('AWS_REGION'))).toBe(false);
  });

  it('supports credentials that are not in the catalog at all', () => {
    const resolved = resolvePassthrough({
      custom: [
        { id: 'vault', hostPath: '.vault-token', guestPath: '/root/.vault-token', mode: 'copy' },
        { id: 'stripe', env: ['STRIPE_API_KEY'] },
      ],
    }, HOME, allExist);
    expect(credentialCopyPlan(resolved, 'c')).toEqual([
      ['cp', `${HOME}/.vault-token`, 'c:/root/.vault-token'],
    ]);
    expect(credentialEnvPairs(resolved, { STRIPE_API_KEY: 'sk_test' })).toEqual(['STRIPE_API_KEY=sk_test']);
  });

  it('a custom credential defaults to copy — the safer of the two', () => {
    const resolved = resolvePassthrough({ custom: [{ id: 'x', hostPath: '.x', guestPath: '/root/.x' }] }, HOME, allExist);
    expect(resolved[0]?.mode).toBe('copy');
  });
});
