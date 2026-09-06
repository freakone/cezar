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
  const decide = useMutation({
    mutationFn: (body: { accept?: string[]; dismiss?: string[] }) => decideIsolationSuggestions(body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.isolation }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (isPending || !data) {
    return <p className="text-sm text-muted-foreground">Checking this machine for a container runtime…</p>
  }

  const { runtime, enabled, effective, image, hasContainerfile, suggestions } = data
  // The one case worth shouting about: the operator asked for isolation and is
  // not getting it. Every task in this state runs on the host with the
  // operator's own credentials, which is the opposite of what the switch says.
  const misleading = enabled && !effective

  return (
    <div className="flex flex-col gap-6">
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
