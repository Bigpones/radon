import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  getRequestId,
  jsonApiError,
  setNoStoreResponseHeaders,
} from "@/lib/apiContracts";

// Disable Next.js static caching: this handler reads live DB state.
export const dynamic = "force-dynamic";

export const runtime = "nodejs";

export type ServiceHealthRow = {
  service: string;
  state: string;
  last_attempt_started_at: string | null;
  last_attempt_finished_at: string | null;
  last_error: string | null;
  updated_at: string;
};

function isFailingState(state: string): boolean {
  if (state === "ok" || state === "syncing" || state === "paused") return false;
  return true;
}

export async function GET(): Promise<Response> {
  const requestId = getRequestId();
  try {
    const db = getDb();
    const result = await db.execute({
      sql: `
        SELECT service, state, last_attempt_started_at, last_attempt_finished_at,
               last_error, updated_at
          FROM service_health
         ORDER BY updated_at DESC
      `,
      args: [],
    });

    const rows: ServiceHealthRow[] = [];
    for (const row of result.rows) {
      const r = row as unknown as ServiceHealthRow;
      rows.push({
        service: String(r.service ?? ""),
        state: String(r.state ?? "unknown"),
        last_attempt_started_at: r.last_attempt_started_at ?? null,
        last_attempt_finished_at: r.last_attempt_finished_at ?? null,
        last_error: r.last_error ?? null,
        updated_at: String(r.updated_at ?? ""),
      });
    }

    // Banner fires only on explicit non-OK state. Staleness alone is not a
    // failure signal: most writers run on market-hours-only cadences (gex-scan,
    // discover, cta-sync) so a quiet table off-hours is normal. A genuinely
    // stuck writer surfaces via its own try/except → state=warn/fail.
    const failing = rows.filter((r) => isFailingState(r.state));

    const response = NextResponse.json({
      services: rows,
      failing,
      summary: {
        total: rows.length,
        failing_count: failing.length,
      },
    });
    return setNoStoreResponseHeaders(response, requestId);
  } catch (error) {
    // DB unreachable — return empty list instead of 500 so the banner
    // doesn't itself become a noisy alarm during transient issues.
    const message = error instanceof Error ? error.message : "service_health read failed";
    console.warn(`[service-health] ${message}`);
    const response = NextResponse.json({
      services: [],
      failing: [],
      summary: { total: 0, failing_count: 0 },
      warning: message,
    });
    return setNoStoreResponseHeaders(response, requestId);
  }
}
