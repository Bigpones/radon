/**
 * Pure reliability-summary helpers for the operator admin panel's Reliability
 * Strip (Section B) and metrics sections. Every value here is an HONEST
 * instantaneous / freshness signal computed from data that already exists
 * (systemd units, service_health rows, IB auth_state, the off-box external_probe
 * row). NO time-series — uptime %, latency percentiles, MTTR/MTBF are
 * deliberately NOT computed until an append-only history table exists, so the
 * page never shows a fabricated number.
 *
 * Dependency-free + DOM-free so it is unit-testable.
 */

import { authStateLabel, authStateTone, unitVerdict, type AuthStateTone } from "./adminFormat";
import {
  getMarketStateFromDate,
  isStale,
  type MarketState,
} from "./serviceHealthWindows";
import type {
  AdminHealthPayload,
  ExternalProbeRow,
  ServiceHealthRow,
  UnitStatus,
} from "./adminTypes";

// Tile 1 — Liveness: controllable units that are healthy right now.
export type LivenessSummary = { ok: number; total: number };

export function livenessSummary(units: UnitStatus[]): LivenessSummary {
  const controllable = units.filter((u) => u.can_control);
  const ok = controllable.filter((u) => unitVerdict(u).tone === "positive").length;
  return { ok, total: controllable.length };
}

// Tile 2 — Freshness: service_health rows past their per-writer staleness
// window. Market-state-aware via serviceHealthWindows (overnight quiet for a
// market-hours-only writer is NOT stale).
export type FreshnessSummary = { stale: number; total: number; staleServices: string[] };

export function freshnessSummary(
  rows: ServiceHealthRow[],
  market: MarketState = getMarketStateFromDate(),
  nowMs: number = Date.now(),
): FreshnessSummary {
  const staleServices = rows
    .filter((r) => isStale(r.service, r.updated_at ?? null, market, nowMs))
    .map((r) => r.service);
  return { stale: staleServices.length, total: rows.length, staleServices };
}

// Tile 3 — IB auth, with the documented stuck-pool detector folded in.
export type IbAuthSummary = { tone: AuthStateTone; label: string; poolStuck: boolean };

export function ibAuthSummary(health: AdminHealthPayload | null | undefined): IbAuthSummary {
  if (!health || !health.ib_gateway) return { tone: "neutral", label: "Unknown", poolStuck: false };
  const authState = health.ib_gateway.auth_state;
  const roles = Object.values(health.ib_pool ?? {});
  // feedback_ib_pool_stuck_after_2fa: authenticated but every pool client
  // disconnected is the documented stuck-pool symptom; a radon-api restart clears it.
  const poolStuck =
    authState === "authenticated" && roles.length > 0 && roles.every((r) => !r.connected);
  if (poolStuck) return { tone: "warning", label: "Auth OK, pool stuck", poolStuck: true };
  return { tone: authStateTone(authState), label: authStateLabel(authState), poolStuck: false };
}

// Tile 4 — Off-box probe (Tier-3). One sample, explicitly labelled "last probe
// latency", NEVER a percentile. Dead-man's-switch on checked_at.
export type ExternalProbeState = "healthy" | "down" | "stale" | "unknown";
export type ExternalProbeSummary = { state: ExternalProbeState; latencyMs: number | null };

export const EXTERNAL_PROBE_STALE_AFTER_SECONDS = 1200; // 20 min — see scripts/health_probe/reader.py

export function externalProbeSummary(
  probe: ExternalProbeRow | null | undefined,
  nowMs: number = Date.now(),
): ExternalProbeSummary {
  if (!probe || !probe.checked_at) return { state: "unknown", latencyMs: null };
  const ts = Date.parse(probe.checked_at);
  const latencyMs = typeof probe.latency_ms === "number" ? probe.latency_ms : null;
  if (Number.isNaN(ts)) return { state: "unknown", latencyMs };
  if (nowMs - ts > EXTERNAL_PROBE_STALE_AFTER_SECONDS * 1000) return { state: "stale", latencyMs };
  return { state: probe.ok === 1 ? "healthy" : "down", latencyMs };
}
