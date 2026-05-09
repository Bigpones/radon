"use client";

import { AlertTriangle } from "lucide-react";
import { useServiceHealth } from "@/lib/useServiceHealth";

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
        {failing[0]?.last_error ? (
          <span className="service-health-banner__detail"> — {failing[0].last_error}</span>
        ) : null}
      </div>
    </div>
  );
}
