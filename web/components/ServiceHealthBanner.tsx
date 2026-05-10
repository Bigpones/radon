"use client";

import { AlertTriangle } from "lucide-react";
import { useServiceHealth } from "@/lib/useServiceHealth";
import { formatServiceHealthError } from "@/lib/serviceHealthError";

/**
 * Service health banner — surfaces when any background dual-write or
 * scheduler is in a non-OK state. Hidden in steady state. Mounted in
 * WorkspaceShell so it appears on every page.
 *
 * Two severity tones, distinguished via ``data-severity``:
 *   - ``error`` (red): a worker raised an exception, dual-write failed,
 *     etc. The classic "something is broken now" signal.
 *   - ``stale`` (amber): worker hasn't heartbeated within its freshness
 *     window. Soft signal — the process may be silent, hung, or simply
 *     between cycles on a slow cadence we miscalibrated.
 *
 * Errors take precedence over stale rows when both are present.
 *
 * The ``last_error`` column is JSON-encoded by the workers, so the
 * route handler runs ``formatServiceHealthError`` against it and ships
 * a clean ``error_summary``. We re-run the same formatter on the client
 * defensively — if a stale cached response, an older API version, or a
 * future writer ever leaks raw JSON to the UI, the banner still renders
 * plain prose instead of ``{"message": "..."}``.
 */
export default function ServiceHealthBanner() {
  const { data } = useServiceHealth();

  const failing = data?.failing ?? [];
  if (failing.length === 0) return null;

  const hasError = failing.some((row) => row.state === "error");
  const severity: "error" | "stale" = hasError ? "error" : "stale";
  const headline = severity === "error"
    ? "Background sync degraded:"
    : "Background sync stale (no recent heartbeat):";

  const services = failing.slice(0, 3).map((row) => row.service).join(", ");
  const more = failing.length > 3 ? ` +${failing.length - 3} more` : "";

  const detail = resolveDetailCopy(failing[0]);

  return (
    <div
      className="service-health-banner"
      role="alert"
      data-testid="service-health-banner"
      data-severity={severity}
    >
      <span className="service-health-banner__icon" aria-hidden>
        <AlertTriangle size={14} />
      </span>
      <div className="service-health-banner__message">
        <strong>{headline}</strong> {services}{more}
        {detail ? (
          <span className="service-health-banner__detail"> - {detail}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Pick the safest detail copy for the first failing row. Prefer the
 * pre-normalized ``error_summary`` shipped by the route; fall back to
 * re-running the formatter against ``last_error`` so the component can
 * never leak JSON structure even if the route response is stale.
 */
function resolveDetailCopy(row: {
  last_error?: string | null;
  error_summary?: string | null;
} | undefined): string | null {
  if (!row) return null;
  if (row.error_summary && row.error_summary.length > 0) return row.error_summary;
  if (row.last_error == null) return null;
  return formatServiceHealthError(row.last_error);
}
