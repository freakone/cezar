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
});
export type IsolationStatusResponse = z.infer<typeof isolationStatusResponseSchema>;
