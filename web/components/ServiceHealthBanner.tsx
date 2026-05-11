"use client";

import { AlertTriangle } from "lucide-react";
import { useServiceHealth } from "@/lib/useServiceHealth";
import type { ServiceHealthRow } from "@/lib/useServiceHealth";
import { humanizeServiceHealthError } from "@/lib/serviceHealthError";

/**
 * Service health banner — surfaces when any background dual-write or
 * scheduler is in a non-OK state. Hidden in steady state. Mounted in
 * WorkspaceShell so it appears on every page.
 *
 * Three severity tones, distinguished via ``data-severity``:
 *   - ``error`` (red): a scheduled worker raised an exception. The
 *     classic "something is broken now" signal.
 *   - ``stale`` (amber): a scheduled worker hasn't heartbeated within
 *     its freshness window. Soft signal — the process may be silent,
 *     hung, or simply between cycles on a slow cadence we
 *     miscalibrated.
 *   - ``dormant`` (informational): on-demand writers past their
 *     freshness window. Nobody has visited the scanner / discover /
 *     gex page today, so the data is old. Not a problem to fix.
 *
 * Errors take precedence over stale; both are "degraded". Dormant is
 * informational and never flips the banner red — when only dormant
 * rows exist, the banner renders the soft chip alone.
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

  const degradedRows = collectDegradedRows(data?.failing ?? []);
  const dormantRows = collectDormantRows(data?.services ?? []);
  const degradedCount = data?.degraded_count ?? degradedRows.length;
  const dormantCount = data?.dormant_count ?? dormantRows.length;

  if (degradedCount === 0 && dormantCount === 0) return null;

  const severity = resolveSeverity(degradedRows, dormantRows);

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
      {degradedRows.length > 0 ? renderDegradedMessage(degradedRows) : null}
      {dormantRows.length > 0 ? renderDormantChip(dormantRows) : null}
    </div>
  );
}

type Severity = "error" | "stale" | "dormant";

const MAX_LISTED = 3;

function collectDegradedRows(failing: ServiceHealthRow[]): ServiceHealthRow[] {
  return failing.filter((row) => row.state === "error" || row.state === "stale");
}

function collectDormantRows(services: ServiceHealthRow[]): ServiceHealthRow[] {
  return services.filter((row) => row.state === "dormant");
}

function resolveSeverity(
  degraded: ServiceHealthRow[],
  dormant: ServiceHealthRow[],
): Severity {
  if (degraded.some((row) => row.state === "error")) return "error";
  if (degraded.length > 0) return "stale";
  if (dormant.length > 0) return "dormant";
  return "stale";
}

function renderDegradedMessage(degraded: ServiceHealthRow[]) {
  const hasError = degraded.some((row) => row.state === "error");
  const headline = hasError
    ? "Background sync degraded:"
    : "Background sync stale (no recent heartbeat):";
  const names = degraded.slice(0, MAX_LISTED).map((row) => row.service).join(", ");
  const more =
    degraded.length > MAX_LISTED ? ` +${degraded.length - MAX_LISTED} more` : "";
  const detail = resolveDetailCopy(degraded[0]);

  return (
    <div className="service-health-banner__message">
      <strong>{headline}</strong> {names}
      {more}
      {detail ? (
        <span className="service-health-banner__detail"> - {detail}</span>
      ) : null}
    </div>
  );
}

function renderDormantChip(dormant: ServiceHealthRow[]) {
  const names = dormant.slice(0, MAX_LISTED).map((row) => row.service).join(", ");
  const more =
    dormant.length > MAX_LISTED ? ` +${dormant.length - MAX_LISTED} more` : "";
  const headline =
    dormant.length === 1
      ? "1 on-demand service dormant:"
      : `${dormant.length} on-demand services dormant:`;

  return (
    <div className="service-health-banner__dormant">
      <strong>{headline}</strong> {names}
      {more}
      <span className="service-health-banner__detail"> - visit to refresh</span>
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
