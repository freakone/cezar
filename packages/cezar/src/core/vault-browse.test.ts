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

    // No address anywhere: the fix is the SETTING, not a plist. Under launchd
    // the cockpit's environment is the launch agent's, so telling someone to
    // export a variable would send them somewhere that cannot work.
    const noAddr = await vaultStatus(async () => '', {});
    expect(noAddr).toMatchObject({ reason: 'no Vault address configured', fix: 'set it in Settings → Isolation defaults' });

    const loggedOut = await vaultStatus(async (args) => {
      if (args[0] === 'token') throw new Error('permission denied');
      return '';
    }, {}, { address: 'https://vault.example.com' });
    expect(loggedOut).toMatchObject({ authenticated: false, fix: 'vault login' });

    const ready = await vaultStatus(async () => '', {}, { address: 'https://vault.example.com' });
    expect(ready).toMatchObject({ installed: true, authenticated: true, reason: '', address: 'https://vault.example.com' });
  });

  it('the SETTING wins over the environment', async () => {
    // Otherwise the setting would be the one that silently does nothing on the
    // machine it was added for — a cockpit started with a stale VAULT_ADDR in
    // its plist would keep using it forever.
    const { effectiveVaultAddress } = await import('./vault-secrets.ts');
    expect(effectiveVaultAddress({ address: 'https://configured' }, { VAULT_ADDR: 'http://inherited' }))
      .toBe('https://configured');
    // And an inherited one still works for a machine that never set it.
    expect(effectiveVaultAddress({}, { VAULT_ADDR: 'http://inherited' })).toBe('http://inherited');
    expect(effectiveVaultAddress({}, {})).toBeUndefined();
  });

  it('formats the reference the resolver parses', async () => {
    const { parseVaultRef } = await import('./vault-secrets.ts');
    const ref = formatVaultRef('secret', 'dev/api', 'stripe');
    expect(ref).toBe('vault://secret/dev/api#stripe');
    expect(parseVaultRef(ref)).toEqual({ mount: 'secret', path: 'dev/api', field: 'stripe' });
  });
});
