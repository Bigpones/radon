import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  getRequestId,
  jsonApiError,
  setNoStoreResponseHeaders,
} from "@/lib/apiContracts";
import { getMarketStateFromDate, isStale } from "@/lib/serviceHealthWindows";
import { formatServiceHealthError } from "@/lib/serviceHealthError";

// Disable Next.js static caching: this handler reads live DB state.
export const dynamic = "force-dynamic";

export const runtime = "nodejs";

export type ServiceHealthRow = {
  service: string;
  state: string;
  last_attempt_started_at: string | null;
  last_attempt_finished_at: string | null;
  /**
   * Original raw payload as written by the worker — JSON-encoded object
   * or a plain string. Kept on the wire for diagnostic clients; UIs
   * should prefer ``error_summary`` to avoid leaking JSON structure.
   */
  last_error: string | null;
  /**
   * Human-readable single-line summary of ``last_error`` produced by
   * ``formatServiceHealthError``. Always populated when ``last_error``
   * is non-null, even on parse failure (uses fallback copy). Safe to
   * concatenate directly into user-facing copy.
   */
  error_summary: string | null;
  updated_at: string;
};

function isFailingState(state: string): boolean {
  // ``ok``, ``syncing``, ``paused`` are healthy / informational. Everything
  // else — including ``stale`` from the freshness gate and ``error`` from
  // a real exception — should fire the banner.
  if (state === "ok" || state === "syncing" || state === "paused") return false;
  return true;
}

/**
 * Coerce ``ok`` rows past their freshness window into ``stale``. Real
 * non-ok states (error, syncing, paused) are passed through untouched —
 * the gate only adds signal, never hides it.
 */
function applyStalenessGate(row: ServiceHealthRow, nowMs: number): ServiceHealthRow {
  if (row.state !== "ok") return row;
  const market = getMarketStateFromDate(new Date(nowMs));
  if (isStale(row.service, row.updated_at, market, nowMs)) {
    return { ...row, state: "stale" };
  }
  return row;
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

    const nowMs = Date.now();
    const rows: ServiceHealthRow[] = [];
    for (const row of result.rows) {
      const r = row as unknown as Record<string, unknown>;
      const lastErrorRaw = (r.last_error ?? null) as string | null;
      const raw: ServiceHealthRow = {
        service: String(r.service ?? ""),
        state: String(r.state ?? "unknown"),
        last_attempt_started_at: (r.last_attempt_started_at ?? null) as string | null,
        last_attempt_finished_at: (r.last_attempt_finished_at ?? null) as string | null,
        last_error: lastErrorRaw,
        // Pre-normalize the human-readable summary at the API boundary
        // so every UI consumer (banner, future status pages, etc.) sees
        // a clean string instead of a JSON-stringified blob.
        error_summary: lastErrorRaw == null ? null : formatServiceHealthError(lastErrorRaw),
        updated_at: String(r.updated_at ?? ""),
      };
      // Coerce stale ``ok`` rows so the banner can see them. Per-service
      // freshness windows live in ``lib/serviceHealthWindows.ts`` and
      // expand off-hours for market-cadence services so a quiet weekend
      // doesn't fire a false alarm.
      rows.push(applyStalenessGate(raw, nowMs));
    }

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
