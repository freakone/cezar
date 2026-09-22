import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { putWorkspaceConfig } from '@/api/client'
import { queryKeys, useIsolationStatus, useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type { SetWorkspaceConfigInput } from '@open-mercato/cezar-api-client'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { CredentialMatrix, type Choice } from './credential-matrix'
import { SecretPicker, type SecretEntry } from './secret-picker'
import { SettingsField } from './settings-field'

/**
 * Settings → Isolation defaults: what a project inherits when it has not
 * configured isolation itself.
 *
 * Machine-scoped because the questions are about this machine, not about any
 * one checkout: which of the operator's credentials its agents may use, how
 * much of it one container may take, which package caches they share. Answered
 * per repo, they had to be re-answered on every new project — so a fresh
 * project's isolated agent had no ssh key and a cold npm cache while the
 * operator had configured both, next door.
 *
 * A project's own Isolation page still wins, key by key. Nothing here overrules
 * a repo that made a choice; it only fills in the ones that never did.
 */
export function IsolationDefaultsSection() {
  const workspace = useWorkspaceConfig()
  // The catalog (what this machine HAS, and which ssh keys are on it) is the
  // same everywhere, so the project-scoped status endpoint is the right source
  // for it — only the selection being edited here is machine-wide.
  const status = useIsolationStatus()
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.config })
      // The project pages read the merged answer, so they are stale after this.
      void queryClient.invalidateQueries({ queryKey: queryKeys.isolation })
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (workspace.isPending || !workspace.data) {
    return (
      <p data-slot="isolation-defaults-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Reading this machine’s defaults…
      </p>
    )
  }

  const defaults = workspace.data.agentDefaults
  const template = defaults.sandbox ?? {}
  const credentials = (template.credentials?.enabled ?? {}) as Record<string, Choice>
  const isolation = defaults.isolation

  return (
    <div
      data-slot="isolation-defaults-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 md:p-6 md:pb-6"
    >
      <SettingsField
        title="Isolate by default"
        hint={
          'Applies to a project that has said nothing. A project that chose — either way — is never '
          + 'overruled, so turning this on does not reach into one that opted out.'
        }
      >
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={isolation === true}
            disabled={save.isPending}
            aria-label="Isolate by default"
            onCheckedChange={(next) => save.mutate({ agentDefaults: { isolation: next ? true : null } })}
          />
          <span className="text-muted-foreground">
            {isolation === true
              ? 'New projects isolate their agents.'
              : 'New projects run agents on this machine until they say otherwise.'}
          </span>
        </label>
      </SettingsField>

      <SettingsField
        title="Container resources"
        hint={
          'The ceiling one container may take, inherited by any project that has not set its own. On macOS '
          + 'these cap a container within the podman VM’s allocation, not the host’s.'
        }
      >
        <ResourceInputs
          value={template.resources ?? {}}
          busy={save.isPending}
          onChange={(resources) => save.mutate({ agentDefaults: { sandbox: { resources } } })}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Chromium and other headless browsers need roughly 1g of <code>/dev/shm</code>; the container default of 64m
          crashes them with what looks like an out-of-memory error.
        </p>
      </SettingsField>

      <SettingsField
        title="Secrets from Vault"
        hint={
          'Picked here, fetched on this machine when a task\u2019s container starts, and injected as environment '
          + 'variables. The container never gets a Vault token \u2014 it receives the values it was granted, not '
          + 'the ability to read more. Only the reference is stored.'
        }
      >
        {/* The address lives HERE, not in the cockpit's launch agent: under
            launchd the process environment is the plist's, so exporting
            VAULT_ADDR in a shell never reaches the running cockpit — and
            editing a plist to name a server is a workaround, not a setting.
            The token is not here and never will be: `vault login` writes it to
            ~/.vault-token and the CLI reads it. */}
        <VaultAddress
          address={defaults.vault?.address ?? ''}
          namespace={defaults.vault?.namespace ?? ''}
          busy={save.isPending}
          onChange={(vault) => save.mutate({ agentDefaults: { vault } })}
        />
        <SecretPicker
          value={(template.credentials?.custom ?? []) as SecretEntry[]}
          busy={save.isPending}
          onChange={(next) => save.mutate({
            agentDefaults: { sandbox: { credentials: { custom: next as never } } },
          })}
        />
      </SettingsField>

      <SettingsField
        title="Credentials agents may use"
        hint={
          'Picked once here instead of per project. A project’s own Isolation page overrides this per '
          + 'credential; anything it does not mention is inherited.'
        }
      >
        {status.data ? (
          <CredentialMatrix
            catalog={status.data.credentials.catalog}
            value={credentials}
            busy={save.isPending}
            onChange={(next) => save.mutate({
              agentDefaults: { sandbox: { credentials: { enabled: next as never } } },
            })}
          />
        ) : (
          <p className="text-xs text-muted-foreground">Checking this machine for credentials…</p>
        )}
      </SettingsField>
    </div>
  )
}

/** The three container limits, committed on blur so a keystroke is not a write. */
function ResourceInputs({
  value,
  busy,
  onChange,
}: {
  value: { memory?: string; cpus?: number; shmSize?: string }
  busy: boolean
  onChange: (next: { memory?: string | null; cpus?: number | null; shmSize?: string | null }) => void
}) {
  const [memory, setMemory] = useState(value.memory ?? '')
  const [cpus, setCpus] = useState(value.cpus === undefined ? '' : String(value.cpus))
  const [shm, setShm] = useState(value.shmSize ?? '')

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="grid gap-1.5 text-xs text-muted-foreground">
        Memory
        <Input
          data-slot="defaults-memory"
          placeholder="whatever the VM has"
          value={memory}
          disabled={busy}
          onChange={(e) => setMemory(e.target.value)}
          // Empty CLEARS back to "no ceiling" — a blank field cannot mean
          // "leave the old value", or a limit could never be removed.
          onBlur={() => onChange({ memory: memory.trim() === '' ? null : memory.trim() })}
        />
      </label>
      <label className="grid gap-1.5 text-xs text-muted-foreground">
        CPUs
        <Input
          data-slot="defaults-cpus"
          placeholder="all"
          value={cpus}
          disabled={busy}
          onChange={(e) => setCpus(e.target.value)}
          onBlur={() => {
            const parsed = Number(cpus.trim())
            onChange({ cpus: cpus.trim() === '' || !Number.isFinite(parsed) || parsed <= 0 ? null : parsed })
          }}
        />
      </label>
      <label className="grid gap-1.5 text-xs text-muted-foreground">
        /dev/shm
        <Input
          data-slot="defaults-shm"
          placeholder="1g"
          value={shm}
          disabled={busy}
          onChange={(e) => setShm(e.target.value)}
          onBlur={() => onChange({ shmSize: shm.trim() === '' ? null : shm.trim() })}
        />
      </label>
    </div>
  )
}

/** Where this machine's Vault is. Committed on blur, so a keystroke is not a write. */
function VaultAddress({
  address,
  namespace,
  busy,
  onChange,
}: {
  address: string
  namespace: string
  busy: boolean
  onChange: (next: { address?: string | null; namespace?: string | null }) => void
}) {
  const [addr, setAddr] = useState(address)
  const [ns, setNs] = useState(namespace)
  return (
    <div className="mb-3 grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1.5 text-xs text-muted-foreground">
        Vault address
        <Input
          data-slot="vault-address"
          className="font-mono text-xs"
          placeholder="https://vault.example.com:8200"
          value={addr}
          disabled={busy}
          onChange={(e) => setAddr(e.target.value)}
          // Empty CLEARS, so an address can be removed; a blank field cannot
          // mean "keep the old one" or it could never be unset.
          onBlur={() => onChange({ address: addr.trim() === '' ? null : addr.trim() })}
        />
      </label>
      <label className="grid gap-1.5 text-xs text-muted-foreground">
        Namespace (optional)
        <Input
          data-slot="vault-namespace"
          className="font-mono text-xs"
          placeholder="admin/team"
          value={ns}
          disabled={busy}
          onChange={(e) => setNs(e.target.value)}
          onBlur={() => onChange({ namespace: ns.trim() === '' ? null : ns.trim() })}
        />
      </label>
    </div>
  )
}
