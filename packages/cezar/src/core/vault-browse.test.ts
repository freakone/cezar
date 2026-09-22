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
    const { fields } = await listFields('secret', 'dev/api', exec);
    expect(fields).toEqual(['other', 'stripe']);
    expect(JSON.stringify(fields)).not.toContain('sk_live');
    expect(JSON.stringify(fields)).not.toContain('also-secret');
  });

  it('reads KV v1 too, where the secret is not nested', async () => {
    const exec = async (): Promise<string> => JSON.stringify({ data: { token: 'v1-value' } });
    expect((await listFields('kv', 'app', exec)).fields).toEqual(['token']);
  });

  it('offers only KV mounts — cubbyhole and identity are not browsable like this', async () => {
    const exec = async (): Promise<string> => JSON.stringify({
      'secret/': { type: 'kv' },
      'kv2/': { type: 'kv' },
      'cubbyhole/': { type: 'cubbyhole' },
      'identity/': { type: 'identity' },
    });
    expect((await listMounts(exec)).mounts).toEqual(['kv2', 'secret']);
  });

  it('says WHY a level is empty — "nothing here" and "denied" are different answers', async () => {
    // Measured against a real token: its policy granted `list` but not `read`,
    // so the path appeared and its fields did not. Collapsing that to "nothing
    // here" made a policy problem look like an empty Vault — and hid that no
    // task would have been able to fetch the value either.
    const denied = async (): Promise<string> => {
      throw Object.assign(new Error('exit 2'), { stderr: 'Code: 403. Errors:\n\n* permission denied' });
    };
    const fields = await listFields('kv', 'paynow_sandbox', denied);
    expect(fields.fields).toEqual([]);
    expect(fields.error).toMatch(/permission denied/);

    const missing = async (): Promise<string> => { throw new Error('No value found at secret/nope'); };
    const paths = await listPaths('secret', 'nope', missing);
    expect(paths.entries).toEqual([]);
    expect(paths.error).toBeTruthy();
  });

  it('a token that cannot enumerate mounts is the NORMAL case, not a failure', async () => {
    // `sys/mounts` needs privileges a sensibly-scoped token does not have —
    // verified against a real one, whose policy covered its own KV paths and
    // nothing else. The picker lets the operator type the mount instead, so
    // this has to come back as a reason rather than an exception.
    const denied = async (): Promise<string> => {
      throw Object.assign(new Error('exit 2'), { stderr: 'Code: 403. Errors:\n\n* permission denied' });
    };
    const listed = await listMounts(denied);
    expect(listed.mounts).toEqual([]);
    expect(listed.error).toMatch(/permission denied/);
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
