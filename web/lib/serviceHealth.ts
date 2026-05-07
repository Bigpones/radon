/**
 * Node-side service_health writer. Used by Next.js routes (currently
 * /api/orders comparison logging) when they detect a state worth
 * surfacing on the dashboard banner.
 *
 * Schema is owned by `scripts/db/migrations/0001_init.sql`:
 *   service (PK) | state | last_attempt_started_at | last_attempt_finished_at
 *                | last_error (JSON) | updated_at
 *
 * The Python writer in scripts/db/writer.py is the canonical impl; this
 * is a thin parallel for the few routes that need to record their own
 * health from JS. Keep the column shape identical.
 */
import { getDb } from "@/lib/db";

export type ServiceHealthState = "ok" | "syncing" | "warn" | "error" | "paused";

export async function recordServiceHealth(params: {
  service: string;
  state: ServiceHealthState;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: unknown;
}): Promise<void> {
  const { service, state, startedAt = null, finishedAt = null, error = null } = params;
  const updatedAt = new Date().toISOString();
  const errorPayload = error == null ? null : JSON.stringify(error);

  const db = getDb();
  await db.execute({
    sql: `
      INSERT INTO service_health
        (service, state, last_attempt_started_at, last_attempt_finished_at, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(service) DO UPDATE SET
        state                    = excluded.state,
        last_attempt_started_at  = COALESCE(excluded.last_attempt_started_at, service_health.last_attempt_started_at),
        last_attempt_finished_at = COALESCE(excluded.last_attempt_finished_at, service_health.last_attempt_finished_at),
        last_error               = excluded.last_error,
        updated_at               = excluded.updated_at
    `,
    args: [service, state, startedAt, finishedAt, errorPayload, updatedAt],
  });
}
