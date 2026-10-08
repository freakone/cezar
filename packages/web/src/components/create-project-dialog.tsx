import { SettingsIcon } from 'lucide-react'
import { useState } from 'react'
import { Link as RouterLink, useNavigate } from 'react-router'

import { useCreateProject, useProjects } from '@/api/queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * "Add project → New project" — the third way in, beside opening a folder that
 * exists and cloning one that exists elsewhere.
 *
 * Deliberately the smallest of the three dialogs: one field. Where it lands is
 * the workspace's checkout root, the same place clones go, so there is one
 * answer to "where do my projects live" rather than a per-dialog one — and the
 * target is previewed for the same reason the clone dialog previews it.
 *
 * No progress line: creating a repo is one fast local operation, so there is
 * nothing to watch. Errors are shown verbatim, because the one that actually
 * happens is git's ("Please tell me who you are" for an unconfigured identity),
 * and it already names its own fix.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState('')
  const projects = useProjects()
  const create = useCreateProject()
  const navigate = useNavigate()

  const projectsDir = projects.data?.projectsDir ?? ''
  const trimmed = name.trim()
  const target = trimmed === '' ? '' : `${projectsDir.replace(/\/+$/, '')}/${trimmed}`

  const submit = () => {
    if (trimmed === '' || create.isPending) return
    create.mutate(
      { name: trimmed },
      {
        onSuccess: ({ project }) => {
          onOpenChange(false)
          // Raw react-router `useNavigate`: a deliberate cross-project jump,
          // exactly as the clone and folder-browser dialogs do.
          navigate(`/p/${encodeURIComponent(project.id)}/`)
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (create.isPending ? undefined : onOpenChange(next))}>
      <DialogContent data-slot="create-project-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            cezar creates the folder in your checkout root, runs <code>git init</code> and makes a first commit,
            then adds it as a project.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5">
          <Label htmlFor="create-name">Project name</Label>
          <Input
            id="create-name"
            data-slot="create-name"
            autoFocus
            placeholder="my-app"
            value={name}
            disabled={create.isPending}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
          <div className="flex min-w-0 items-center gap-1">
            <p
              data-slot="create-target"
              className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-soft-foreground"
              title={target}
            >
              {target}
            </p>
            {create.isPending ? (
              <Button
                data-slot="create-root-settings"
                variant="ghost"
                size="icon-sm"
                className="size-7"
                aria-label="Edit checkout root"
                title="Edit checkout root"
                disabled
              >
                <SettingsIcon className="size-3.5" aria-hidden="true" />
              </Button>
            ) : (
              <Button asChild variant="ghost" size="icon-sm" className="size-7">
                <RouterLink
                  to="/settings/global/projects"
                  data-slot="create-root-settings"
                  aria-label="Edit checkout root"
                  title="Edit checkout root"
                >
                  <SettingsIcon className="size-3.5" aria-hidden="true" />
                </RouterLink>
              </Button>
            )}
          </div>
        </div>

        {create.isError ? (
          <p data-slot="create-error" className="text-[13px] text-danger">
            {create.error instanceof Error ? create.error.message : 'could not create that project'}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={create.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-slot="create-confirm" disabled={trimmed === '' || create.isPending} onClick={submit}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
