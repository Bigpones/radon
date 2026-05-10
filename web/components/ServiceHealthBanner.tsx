"use client";

import { AlertTriangle } from "lucide-react";
import { useServiceHealth } from "@/lib/useServiceHealth";
import { humanizeServiceHealthError } from "@/lib/serviceHealthError";

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
 * a clean ``error_summary``. The banner runs the upgraded
 * ``humanizeServiceHealthError`` on the raw payload to produce
 * banner-ready prose for the known error shapes (Flex throttle, Flex
 * auth, timeout, network blip) and falls back to the route's
 * pre-normalised summary when only that is available. Either path
 * renders plain text, never raw JSON.
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
 * Pick the safest detail copy for the first failing row.
 *
 * Preference order:
 *
 *  1. ``last_error`` (raw structured payload) run through the humanizer.
 *     This is the highest-fidelity path because the raw payload carries
 *     ``next_attempt_at`` and other metadata the API summariser strips.
 *  2. ``error_summary`` (pre-normalised plain text from the route) run
 *     through the humanizer for pattern rewriting. Used when the route
 *     ships a summary but the raw payload is unavailable.
 *  3. ``null`` when neither is present.
 *
 * The humanizer is idempotent on its own output, so step 2's pass
 * through is safe even when the input is already clean.
 */
function resolveDetailCopy(row: {
  last_error?: string | null;
  error_summary?: string | null;
} | undefined): string | null {
  if (!row) return null;
  if (row.last_error != null) {
    return humanizeServiceHealthError(row.last_error);
  }
  if (row.error_summary && row.error_summary.length > 0) {
    return humanizeServiceHealthError(row.error_summary);
  }
  return null;
}
