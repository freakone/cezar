import { useMutation, useQueryClient } from '@tanstack/react-query'

import { putConfig } from '@/api/client'
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

  if (isPending || !data) {
    return <p className="text-sm text-muted-foreground">Checking this machine for a container runtime…</p>
  }

  const { runtime, enabled, effective, image, hasContainerfile } = data
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
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
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
              <span className="text-emerald-600 dark:text-emerald-400">Ready</span>
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
