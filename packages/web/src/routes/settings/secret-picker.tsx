import { KeyRoundIcon, ChevronRightIcon, FolderIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'

import { useVaultBrowse, useVaultStatus } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/**
 * Pick a Vault key and hand the agent its value.
 *
 * The picker browses NAMES only — mounts, paths, field names. A secret's value
 * is fetched on the host when a container starts and goes straight into it, so
 * no value ever reaches this page. What gets saved is a reference,
 * `vault://<mount>/<path>#<field>`, which is also all that is ever persisted.
 *
 * The container never receives `VAULT_TOKEN` either: it gets the values it was
 * granted, not the ability to read more.
 */
export interface SecretEntry {
  id: string
  label?: string
  env?: string[]
  valueFrom?: string
  required?: boolean
}

export function SecretPicker({
  value,
  onChange,
  busy = false,
}: {
  value: SecretEntry[]
  onChange: (next: SecretEntry[]) => void
  busy?: boolean
}) {
  const status = useVaultStatus()
  const [picking, setPicking] = useState(false)

  if (status.isPending) {
    return <p className="text-xs text-muted-foreground">Checking Vault…</p>
  }

  const ready = status.data?.authenticated === true

  return (
    <div data-slot="secret-picker" className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1.5">
        {value.map((entry) => (
          <li
            key={entry.id}
            data-slot="secret-row"
            className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2.5 py-2 text-sm"
          >
            <KeyRoundIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <code className="text-[12.5px]">{entry.env?.[0] ?? entry.id}</code>
            {/* The reference, not the value — there is no value to show. */}
            <code className="min-w-0 flex-1 truncate text-[11px] text-soft-foreground" title={entry.valueFrom}>
              {entry.valueFrom}
            </code>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                checked={entry.required === true}
                disabled={busy}
                aria-label={`${entry.env?.[0] ?? entry.id} is required`}
                onCheckedChange={(next) => onChange(
                  value.map((e) => (e.id === entry.id ? { ...e, required: next } : e)),
                )}
              />
              required
            </label>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              disabled={busy}
              aria-label={`Remove ${entry.env?.[0] ?? entry.id}`}
              onClick={() => onChange(value.filter((e) => e.id !== entry.id))}
            >
              <Trash2Icon className="size-3.5" aria-hidden="true" />
            </Button>
            {entry.required ? (
              <span className="basis-full text-xs text-muted-foreground">
                A task refuses to start when this one cannot be fetched, instead of failing later at something
                that names neither the secret nor Vault.
              </span>
            ) : null}
          </li>
        ))}
        {value.length === 0 ? (
          <li className="text-xs text-muted-foreground">Nothing passed yet.</li>
        ) : null}
      </ul>

      {/* Vault's own state, in its own words, with the command that fixes it.
          Under launchd the cockpit's environment is the plist's, not the
          shell's — so "it works in my terminal" is the expected confusion here
          and the reason `reason` names the environment explicitly. */}
      {!ready ? (
        <p data-slot="vault-unavailable" className="text-xs text-warning">
          {status.data?.reason || 'Vault is not reachable'}
          {status.data?.fix ? <> — <code>{status.data.fix}</code></> : null}
        </p>
      ) : null}

      {ready && !picking ? (
        <div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setPicking(true)}>
            Add a secret…
          </Button>
          {status.data?.address ? (
            <span className="ml-2 text-xs text-muted-foreground">{status.data.address}</span>
          ) : null}
        </div>
      ) : null}

      {ready && picking ? (
        <VaultBrowser
          mounts={status.data?.mounts ?? []}
          busy={busy}
          onCancel={() => setPicking(false)}
          onPick={(entry) => {
            setPicking(false)
            // Replace by id so re-picking the same key edits rather than duplicates.
            onChange([...value.filter((e) => e.id !== entry.id), entry])
          }}
        />
      ) : null}
    </div>
  )
}

/** Browse one mount a level at a time, then pick a field. */
function VaultBrowser({
  mounts,
  busy,
  onPick,
  onCancel,
}: {
  mounts: string[]
  busy: boolean
  onPick: (entry: SecretEntry) => void
  onCancel: () => void
}) {
  const [mount, setMount] = useState(mounts[0] ?? '')
  const [path, setPath] = useState('')
  const [field, setField] = useState<string | null>(null)
  const [envName, setEnvName] = useState('')
  const browse = useVaultBrowse(mount, path)

  const segments = path === '' ? [] : path.split('/')
  const entries = browse.data?.entries ?? []
  const fields = browse.data?.fields ?? []

  const choose = (name: string): void => {
    setField(name)
    // A sensible default the operator can overwrite: most secrets are named
    // like the variable they end up in, and typing it twice is friction.
    setEnvName(name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
  }

  return (
    <div data-slot="vault-browser" className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          className="rounded border bg-background px-1 py-0.5 text-xs"
          value={mount}
          aria-label="Vault mount"
          onChange={(e) => { setMount(e.target.value); setPath(''); setField(null) }}
        >
          {mounts.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => { setPath(''); setField(null) }}
        >
          /
        </button>
        {segments.map((segment, index) => (
          <span key={`${segment}-${index}`} className="flex items-center gap-1">
            <ChevronRightIcon className="size-3 text-soft-foreground" aria-hidden="true" />
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => { setPath(segments.slice(0, index + 1).join('/')); setField(null) }}
            >
              {segment}
            </button>
          </span>
        ))}
      </div>

      <ul className="mt-2 flex max-h-56 flex-col gap-0.5 overflow-y-auto">
        {browse.isPending ? <li className="text-xs text-muted-foreground">Reading…</li> : null}
        {entries.map((entry) => (
          <li key={entry}>
            <button
              type="button"
              data-slot="vault-entry"
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12.5px] hover:bg-muted"
              onClick={() => { setPath([...segments, entry.replace(/\/$/, '')].join('/')); setField(null) }}
            >
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {entry}
            </button>
          </li>
        ))}
        {fields.map((name) => (
          <li key={name}>
            <button
              type="button"
              data-slot="vault-field"
              className={cn(
                'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12.5px] hover:bg-muted',
                field === name && 'bg-muted',
              )}
              onClick={() => choose(name)}
            >
              <KeyRoundIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {name}
            </button>
          </li>
        ))}
        {!browse.isPending && entries.length === 0 && fields.length === 0 ? (
          <li className="text-xs text-muted-foreground">Nothing here.</li>
        ) : null}
      </ul>

      {field ? (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Environment variable
            <Input
              data-slot="secret-env-name"
              className="h-8 w-56 font-mono text-xs"
              value={envName}
              onChange={(e) => setEnvName(e.target.value)}
            />
          </label>
          <code className="min-w-0 flex-1 truncate pb-2 text-[11px] text-soft-foreground">
            vault://{mount}/{path}#{field}
          </code>
          <Button
            size="sm"
            data-slot="secret-add"
            disabled={busy || envName.trim() === ''}
            onClick={() => onPick({
              id: `${mount}/${path}#${field}`,
              env: [envName.trim()],
              valueFrom: `vault://${mount}/${path}#${field}`,
            })}
          >
            Add
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      ) : (
        <div className="mt-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      )}
    </div>
  )
}
