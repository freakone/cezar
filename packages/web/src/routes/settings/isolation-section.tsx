import { useMutation, useQueryClient } from '@tanstack/react-query'

import { decideIsolationSuggestions, putConfig } from '@/api/client'
import { queryKeys, useIsolationStatus } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'

/**
 * Project settings → Isolation: run this project's agents inside a container
 * instead of on this machine.
 *
 * The page answers two questions that are deliberately NOT merged, because they
 * fail differently and are fixed differently:
 *
 *  - **Can this machine isolate?** Is a container runtime installed, and on
 *    macOS/Windows is its VM running. Nothing the project can configure changes
 *    this, and each failure has exactly one command that fixes it — so the
 *    server sends that command and this page shows it verbatim.
 *  - **Should this project isolate?** The operator's switch.
 *
 * A single boolean would make the switch unexplainable: "off" would mean both
 * "you turned it off" and "your VM is stopped". So the switch reflects the
 * SETTING, and a separate line states what a task started right now would
 * actually do. When those disagree, the disagreement is the most important
 * thing on the page and is rendered as such rather than as a silent default.
 */
/** Toggle or re-mode one credential, leaving the rest of the map untouched. */
type Choice = boolean | { mode?: 'mount' | 'copy'; keys?: string[] }

function nextEnabled(
  current: Record<string, Choice>,
  id: string,
  value: Choice,
): Record<string, Choice> {
  const next = { ...current }
  if (value === false) delete next[id]
  else next[id] = value
  return next
}

/** Tick or untick one file of a narrowable credential, preserving the rest. */
function nextKeys(choice: Choice | undefined, name: string, on: boolean): string[] {
  const current = (typeof choice === 'object' && choice?.keys) || []
  return on ? [...current.filter((k) => k !== name), name] : current.filter((k) => k !== name)
}

/** OpenSSH loads these by name with no `config` entry; anything else needs one. */
const DEFAULT_KEY_NAMES = ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk', 'id_dsa']

export function IsolationSection() {
  const { data, isPending, refetch, isFetching } = useIsolationStatus()
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (enabled: boolean) => putConfig({ sandbox: { enabled } }),
    // The switch's own source of truth is /isolation (it also carries
    // `effective`), so refresh that rather than trusting the PUT's echo.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.isolation })
      void queryClient.invalidateQueries({ queryKey: queryKeys.config })
    },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const saveCredentials = useMutation({
    mutationFn: (enabledMap: Record<string, boolean | { mode?: 'mount' | 'copy' }>) =>
      putConfig({ sandbox: { credentials: { enabled: enabledMap } } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.isolation }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const saveResources = useMutation({
    mutationFn: (patch: { memory?: string | null; cpus?: number | null; shmSize?: string }) =>
      putConfig({ sandbox: { resources: patch } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.isolation }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const decide = useMutation({
    mutationFn: (body: { accept?: string[]; dismiss?: string[] }) => decideIsolationSuggestions(body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.isolation }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (isPending || !data) {
    return (
      <p data-slot="isolation-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Checking this machine for a container runtime…
      </p>
    )
  }

  const { runtime, enabled, effective, image, hasContainerfile, suggestions, credentials, resources } = data
  // The one case worth shouting about: the operator asked for isolation and is
  // not getting it. Every task in this state runs on the host with the
  // operator's own credentials, which is the opposite of what the switch says.
  const misleading = enabled && !effective

  return (
    // Same frame every other settings section uses: sections own their padding
    // and column width, the shell only supplies the header and nav.
    <div
      data-slot="isolation-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <SettingsField
        title="Run agents in a container"
        hint={
          'Each task gets its own container built from this project’s image. The agent sees this repo and '
          + 'nothing else of your machine — not your home directory, not your other repos.'
        }
      >
        <Switch
          checked={enabled}
          disabled={!runtime.ready && !enabled}
          onCheckedChange={(next) => save.mutate(next)}
          aria-label="Run agents in a container"
        />
      </SettingsField>

      {misleading ? (
        <div className="rounded-md border border-danger/50 bg-danger/10 p-3 text-sm">
          <p className="font-medium">Isolation is on, but tasks are running on this machine.</p>
          <p className="mt-1 text-muted-foreground">{runtime.reason}</p>
          {runtime.fix ? (
            <pre className="mt-2 overflow-x-auto rounded bg-background/60 p-2 text-xs">{runtime.fix}</pre>
          ) : null}
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? 'Checking…' : 'Check again'}
          </Button>
        </div>
      ) : null}

      <SettingsField title="Container runtime" hint="What this machine can do, regardless of the setting above.">
        <div className="text-sm">
          {runtime.ready ? (
            <p>
              <span className="text-success">Ready</span>
              {' — '}
              {runtime.provider}
              {runtime.version ? ` ${runtime.version}` : ''}
              {runtime.machineName ? `, VM “${runtime.machineName}”` : ''}
            </p>
          ) : (
            <>
              <p className="text-muted-foreground">{runtime.reason}</p>
              {runtime.fix ? (
                <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">{runtime.fix}</pre>
              ) : null}
              <Button variant="outline" size="sm" className="mt-2" onClick={() => void refetch()} disabled={isFetching}>
                {isFetching ? 'Checking…' : 'Check again'}
              </Button>
            </>
          )}
        </div>
      </SettingsField>

      {suggestions.length > 0 ? (
        <SettingsField
          title="Tools your agents installed"
          hint={
            'cezar noticed these while tasks ran. Adding them to this project’s Containerfile means the next task '
            + 'starts with them already installed instead of installing them again.'
          }
        >
          <div className="flex flex-col gap-2">
            <ul className="flex flex-col gap-1">
              {suggestions.map((s) => (
                <li key={s.command} className="flex items-start gap-2 text-xs">
                  <span className="mt-0.5 shrink-0 rounded bg-muted px-1 py-0.5 font-medium uppercase">{s.manager}</span>
                  <code className="break-all">{s.command}</code>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ accept: suggestions.map((s) => s.command) })}
              >
                Add to Containerfile
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ dismiss: suggestions.map((s) => s.command) })}
              >
                Dismiss
              </Button>
            </div>
            {/* Said plainly, because the alternative reading — "nothing happened" — is
                the one a user would otherwise reach when the current task is unaffected. */}
            <p className="text-xs text-muted-foreground">
              The image rebuilds before your next task. The one running now already has these.
            </p>
          </div>
        </SettingsField>
      ) : null}

      <SettingsField
        title="Container resources"
        hint={
          'Limits for each task container. These cap it WITHIN the container VM’s own allocation — on macOS that is '
          + 'not your machine’s total, so raising a limit above what the VM has does nothing.'
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Memory</span>
            <input
              className="w-24 rounded border bg-background px-2 py-1 text-sm"
              defaultValue={resources.memory ?? ''}
              placeholder="VM max"
              aria-label="Container memory limit"
              onBlur={(e) => {
                const value = e.target.value.trim()
                if (value !== (resources.memory ?? '')) saveResources.mutate({ memory: value || null })
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">CPUs</span>
            <input
              className="w-20 rounded border bg-background px-2 py-1 text-sm"
              defaultValue={resources.cpus ?? ''}
              placeholder="VM max"
              inputMode="decimal"
              aria-label="Container CPU limit"
              onBlur={(e) => {
                const raw = e.target.value.trim()
                const value = raw ? Number(raw) : null
                if (value !== null && !Number.isFinite(value)) return
                if (String(value ?? '') !== String(resources.cpus ?? '')) saveResources.mutate({ cpus: value })
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">/dev/shm</span>
            <input
              className="w-24 rounded border bg-background px-2 py-1 text-sm"
              defaultValue={resources.shmSize}
              aria-label="Container shared memory size"
              onBlur={(e) => {
                const value = e.target.value.trim()
                if (value && value !== resources.shmSize) saveResources.mutate({ shmSize: value })
              }}
            />
          </label>
        </div>
        {/* The one people lose a day to: podman's 64m default kills any headless
            browser, and the crash reads as out-of-memory rather than as shared
            memory. Say it here rather than leaving it to be rediscovered. */}
        <p className="mt-2 text-xs text-muted-foreground">
          Chromium and other headless browsers need roughly 1g of <code>/dev/shm</code>; the container default of 64m
          crashes them with what looks like an out-of-memory error.
        </p>
      </SettingsField>

      <SettingsField
        title="Credentials the agent may use"
        hint={
          'An isolated agent starts with none. Each one you add is a deliberate widening — mount for anything the '
          + 'tool refreshes in place, copy for static keys the container should not be able to write back. '
          + 'Credentials are attached when a task\u2019s container is created, so a change here reaches the NEXT '
          + 'task; one already running keeps what it started with.'
        }
      >
        <ul className="flex flex-col gap-2">
          {credentials.catalog.map((source) => {
            const choice = credentials.enabled[source.id]
            const on = Boolean(choice)
            const mode = (typeof choice === 'object' && choice?.mode) || source.defaultMode
            const picked = (typeof choice === 'object' && choice?.keys) || []
            const names = source.entries.map((e) => e.name)
            // Both warnings apply only once the operator has started picking —
            // an untouched credential is not yet a misconfiguration.
            const missingKnownHosts = picked.length > 0
              && names.includes('known_hosts') && !picked.includes('known_hosts')
            const missingConfig = picked.length > 0
              && names.includes('config') && !picked.includes('config')
              && picked.some((k) => !DEFAULT_KEY_NAMES.includes(k) && k !== 'config' && k !== 'known_hosts')
            return (
              <li key={source.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Switch
                  checked={on}
                  // A credential this machine does not have reads as unavailable,
                  // not as "off": the two call for different next steps.
                  disabled={!source.present || saveCredentials.isPending}
                  onCheckedChange={(next) => saveCredentials.mutate(
                    nextEnabled(credentials.enabled, source.id, next ? { mode } : false),
                  )}
                  aria-label={source.label}
                />
                <span className={source.present ? '' : 'text-muted-foreground'}>{source.label}</span>
                {on && picked.length === 0 ? (
                  <select
                    className="rounded border bg-background px-1 py-0.5 text-xs"
                    value={mode}
                    disabled={saveCredentials.isPending}
                    aria-label={`${source.label} passthrough mode`}
                    onChange={(e) => saveCredentials.mutate(
                      nextEnabled(credentials.enabled, source.id, {
                        mode: e.target.value as 'mount' | 'copy',
                        ...(picked.length > 0 ? { keys: picked } : {}),
                      }),
                    )}
                  >
                    <option value="mount">mount (live)</option>
                    <option value="copy">copy (snapshot)</option>
                  </select>
                ) : null}
                {/* Narrowed passthrough is always a copy, so the mount/copy
                    control would be a lie while files are ticked. Say which one
                    is in force instead of offering a choice that is not real. */}
                {on && picked.length > 0 ? (
                  <span className="rounded border px-1 py-0.5 text-xs text-muted-foreground">copied</span>
                ) : null}
                {!source.present ? (
                  <span className="text-xs text-muted-foreground">not on this machine</span>
                ) : source.note ? (
                  <span className="basis-full text-xs text-muted-foreground">{source.note}</span>
                ) : null}

                {/* The file picker, for a credential that can be narrowed. */}
                {on && source.entries.length > 0 ? (
                  <div data-slot="credential-entries" className="basis-full pl-9">
                    <ul className="flex flex-col gap-1">
                      {source.entries.map((entry) => {
                        const checked = picked.includes(entry.name)
                        return (
                          <li key={entry.name}>
                            <label className="flex cursor-pointer items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                data-slot="credential-entry"
                                className="size-3.5 shrink-0"
                                checked={checked}
                                disabled={saveCredentials.isPending}
                                onChange={(e) => saveCredentials.mutate(
                                  nextEnabled(credentials.enabled, source.id, {
                                    mode,
                                    keys: nextKeys(choice, entry.name, e.target.checked),
                                  }),
                                )}
                              />
                              <code>{entry.name}</code>
                              {entry.detail ? (
                                <span className="text-muted-foreground">{entry.detail}</span>
                              ) : null}
                              {entry.kind === 'config' ? (
                                <span className="text-muted-foreground">host aliases and IdentityFile</span>
                              ) : null}
                              {entry.kind === 'known-hosts' ? (
                                <span className="text-muted-foreground">trusted host keys</span>
                              ) : null}
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                    {/* Three things that decide whether ssh actually works in
                        the container, each of which fails as an unrelated-looking
                        error hours later. */}
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {picked.length === 0
                        ? 'Nothing ticked — the whole ~/.ssh directory is passed, which gives the agent every host every key reaches.'
                        : 'Ticked files are copied into the container; your own keys cannot be modified by it.'}
                    </p>
                    {missingKnownHosts ? (
                      <p className="mt-1 text-xs text-warning">
                        No <code>known_hosts</code>: ssh cannot verify a host it has never seen and will refuse the
                        connection outright, since nothing in a container can answer its prompt.
                      </p>
                    ) : null}
                    {missingConfig ? (
                      <p className="mt-1 text-xs text-warning">
                        No <code>config</code>: ssh only tries keys named <code>id_ed25519</code>, <code>id_rsa</code>
                        {' '}and friends on its own, so a key named anything else is never offered without it.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      </SettingsField>

      <SettingsField
        title="Image"
        hint={
          hasContainerfile
            ? 'Built from this project’s Containerfile, once. Tasks start with its toolchain already installed.'
            : 'This project has no Containerfile, so tasks run on the generic base image — enough for Node, git and gh, '
              + 'but not for a toolchain of its own.'
        }
      >
        <code className="text-sm">{image || '—'}</code>
      </SettingsField>
    </div>
  )
}
