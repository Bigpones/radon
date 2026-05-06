"use client";

import { AlertTriangle } from "lucide-react";
import { useServiceHealth } from "@/lib/useServiceHealth";

/**
 * Service health banner — surfaces when any background dual-write or
 * scheduler is in a non-OK state. Hidden in steady state. Mounted in
 * WorkspaceShell so it appears on every page.
 *
 * Today's TSLA-fill incident stayed silent for 3 hours because the
 * dual-write `try/except: pass` swallowed the WAL-lock failure. With
 * service_health rows being recorded on every dual-write outcome, this
 * banner gives the user the same signal they'd see by tailing the API
 * logs — without leaving the page.
 */
export default function ServiceHealthBanner() {
  const { data } = useServiceHealth();

  const failing = data?.failing ?? [];
  if (failing.length === 0) return null;

  const services = failing.slice(0, 3).map((row) => row.service).join(", ");
  const more = failing.length > 3 ? ` +${failing.length - 3} more` : "";

  return (
    <div className="service-health-banner" role="alert" data-testid="service-health-banner">
      <span className="service-health-banner__icon" aria-hidden>
        <AlertTriangle size={14} />
      </span>
      <div className="service-health-banner__message">
        <strong>Background sync degraded:</strong> {services}{more}
        {failing[0]?.last_error ? (
          <span className="service-health-banner__detail"> — {failing[0].last_error}</span>
        ) : null}
      </div>
    </div>
  );
}
