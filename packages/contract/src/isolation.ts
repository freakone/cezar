import { z } from 'zod';

/**
 * Agent isolation — running a task's agent inside a container instead of on the
 * host — as seen by the cockpit.
 *
 * Two facts are needed wherever this is offered, and they are different
 * questions with different answers:
 *
 *  - CAN this machine isolate? (is a container runtime installed, is its VM up)
 *  - SHOULD this project isolate? (the operator's setting)
 *
 * Collapsing them into one boolean is what makes an isolation toggle
 * unexplainable: "off" would mean both "you turned it off" and "your VM is
 * stopped", which need different words and different fixes. So the status
 * carries a human-readable `reason` and, where one exists, the single `fix`
 * command that resolves it.
 */
export const containerRuntimeStatusSchema = z.object({
  /** Isolation can be used right now. */
  ready: z.boolean(),
  provider: z.literal('podman'),
  installed: z.boolean(),
  version: z.string().optional(),
  /** macOS/Windows run containers in a VM; on Linux this is always true. */
  machineRunning: z.boolean(),
  machineName: z.string().optional(),
  /** One actionable sentence. Empty when `ready`. */
  reason: z.string(),
  /** The exact command that fixes `reason`, when one command does. */
  fix: z.string().optional(),
});
export type ContainerRuntimeStatus = z.infer<typeof containerRuntimeStatusSchema>;

/** `GET /api/v1/projects/:id/isolation` — what Settings and the composer read. */
export const isolationStatusResponseSchema = z.object({
  runtime: containerRuntimeStatusSchema,
  /** The project's own setting, as configured. */
  enabled: z.boolean(),
  /**
   * What a task started right now would actually do. `enabled && runtime.ready`
   * — the composer shows THIS, because a toggle that says "on" while the VM is
   * stopped is a lie the run would then have to correct in its own log.
   */
  effective: z.boolean(),
  /** The image tasks would run in, so Settings can name it. */
  image: z.string(),
  /** Whether the repo has its own Containerfile, or is on the generic base. */
  hasContainerfile: z.boolean(),
  /**
   * Installs cezar noticed this project's agents performing, proposed for the
   * image. Observation, not configuration: accepting one is what turns it into
   * a `Containerfile` the user then owns, and nothing is written before that.
   */
  suggestions: z.array(z.object({
    command: z.string(),
    manager: z.enum(['apt', 'npm', 'pnpm', 'yarn', 'pip', 'pipx', 'go', 'cargo', 'gem', 'apk', 'dnf']),
  })).default([]),
  /**
   * Per-container limits. On macOS these cap a container within the podman VM's
   * OWN allocation, not the host's — which is why a task can report 8GB on a
   * 32GB machine, and why the VM size is a separate thing to raise.
   */
  resources: z.object({
    memory: z.string().optional(),
    cpus: z.number().optional(),
    shmSize: z.string(),
  }),
  /**
   * Which of the operator's credentials the agent may use.
   *
   * `catalog` is what this machine offers, with `present` saying whether the
   * file is actually there — a credential the operator does not have must read
   * as unavailable rather than as "off", because the two suggest different next
   * steps. `enabled` and `custom` are the project's choices.
   */
  credentials: z.object({
    catalog: z.array(z.object({
      id: z.string(),
      label: z.string(),
      hostPath: z.string().optional(),
      env: z.array(z.string()).default([]),
      defaultMode: z.enum(['mount', 'copy']),
      note: z.string().optional(),
      present: z.boolean(),
    })).default([]),
    enabled: z.record(z.string(), z.union([z.boolean(), z.object({ mode: z.enum(['mount', 'copy']).optional() })])).default({}),
    custom: z.array(z.object({
      id: z.string(),
      label: z.string().optional(),
      hostPath: z.string().optional(),
      guestPath: z.string().optional(),
      env: z.array(z.string()).optional(),
      mode: z.enum(['mount', 'copy']).optional(),
    })).default([]),
  }),
});
export type IsolationStatusResponse = z.infer<typeof isolationStatusResponseSchema>;
