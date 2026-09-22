import { describe, expect, it } from 'vitest';
import { formatVaultRef, listFields, listMounts, listPaths, vaultStatus } from './vault-secrets.ts';

describe('what the secret picker is allowed to see', () => {
  it('returns field NAMES and never their values', async () => {
    // The picker is served to a browser. `vault kv get` returns the whole
    // secret, so the values exist in the process for as long as it takes to
    // read the keys — and must go no further.
    const exec = async (): Promise<string> => JSON.stringify({
      data: { data: { stripe: 'sk_live_REAL_SECRET_VALUE', other: 'also-secret' }, metadata: {} },
    });
    const fields = await listFields('secret', 'dev/api', exec);
    expect(fields).toEqual(['other', 'stripe']);
    expect(JSON.stringify(fields)).not.toContain('sk_live');
    expect(JSON.stringify(fields)).not.toContain('also-secret');
  });

  it('reads KV v1 too, where the secret is not nested', async () => {
    const exec = async (): Promise<string> => JSON.stringify({ data: { token: 'v1-value' } });
    expect(await listFields('kv', 'app', exec)).toEqual(['token']);
  });

  it('offers only KV mounts — cubbyhole and identity are not browsable like this', async () => {
    const exec = async (): Promise<string> => JSON.stringify({
      'secret/': { type: 'kv' },
      'kv2/': { type: 'kv' },
      'cubbyhole/': { type: 'cubbyhole' },
      'identity/': { type: 'identity' },
    });
    expect(await listMounts(exec)).toEqual(['kv2', 'secret']);
  });

  it('an empty or missing path is "nothing here", not an error', async () => {
    const exec = async (): Promise<string> => { throw new Error('No value found at secret/nope'); };
    await expect(listPaths('secret', 'nope', exec)).resolves.toEqual([]);
  });

  it('names what is wrong and the command that fixes it', async () => {
    const missing = await vaultStatus(async () => { throw new Error('ENOENT'); }, {});
    expect(missing).toMatchObject({ installed: false, authenticated: false, fix: 'brew install vault' });

    // The launchd trap: the cockpit's environment is the plist's, not the
    // shell's, so "it works in my terminal" is the expected confusion.
    const noAddr = await vaultStatus(async () => '', {});
    expect(noAddr.reason).toMatch(/VAULT_ADDR is not set in the environment cezar was started with/);

    const loggedOut = await vaultStatus(async (args) => {
      if (args[0] === 'token') throw new Error('permission denied');
      return '';
    }, { VAULT_ADDR: 'http://127.0.0.1:8200' });
    expect(loggedOut).toMatchObject({ authenticated: false, fix: 'vault login' });

    const ready = await vaultStatus(async () => '', { VAULT_ADDR: 'http://127.0.0.1:8200' });
    expect(ready).toMatchObject({ installed: true, authenticated: true, reason: '' });
  });

  it('formats the reference the resolver parses', async () => {
    const { parseVaultRef } = await import('./vault-secrets.ts');
    const ref = formatVaultRef('secret', 'dev/api', 'stripe');
    expect(ref).toBe('vault://secret/dev/api#stripe');
    expect(parseVaultRef(ref)).toEqual({ mount: 'secret', path: 'dev/api', field: 'stripe' });
  });
});
