"use client";

import {
  externalProbeSummary,
  freshnessSummary,
  ibAuthSummary,
  livenessSummary,
} from "@/lib/adminReliability";
import type { AdminHealthPayload, EdgeHealthStatus, UnitStatus } from "@/lib/adminTypes";

type EdgePayload = (EdgeHealthStatus & { reachable?: boolean }) | null;
type Tone = "positive" | "warning" | "negative" | "neutral";

/**
 * The Reliability Strip: four honest, instantaneous tiles. No time-series here
 * (no fabricated uptime % / percentiles) until the health_samples history table
 * exists. Each value is computed from data that already exists.
 */
export default function ReliabilityStrip({
  units,
  edge,
  health,
  edgeReachable,
  loading = false,
}: {
  units: UnitStatus[];
  edge: EdgePayload;
  health: AdminHealthPayload | null;
  edgeReachable: boolean;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <section className="admin-reliability-strip" data-testid="reliability-strip">
        {["Liveness", "Freshness", "IB Auth", "Off-box probe"].map((label) => (
          <div className="admin-tile admin-tile-neutral" key={label}>
            <div className="admin-tile-label">{label}</div>
            <div className="admin-tile-value">
              <span className="admin-skeleton admin-skeleton-line" style={{ width: 72, height: 16 }} />
            </div>
            <div className="admin-tile-sub">
              <span className="admin-skeleton admin-skeleton-line" style={{ width: 100 }} />
            </div>
          </div>
        ))}
      </section>
    );
  }

  const liveness = livenessSummary(units);
  const rows = edge?.service_health?.rows ?? [];
  const freshness = freshnessSummary(rows);
  const auth = ibAuthSummary(health);
  const probe = externalProbeSummary(edge?.external_probe ?? null);

  const livenessTone: Tone =
    liveness.total === 0 ? "neutral" : liveness.ok === liveness.total ? "positive" : "negative";
  const freshnessTone: Tone = !edgeReachable
    ? "neutral"
    : freshness.total === 0
      ? "neutral"
      : freshness.stale === 0
        ? "positive"
        : "warning";
  const probeTone: Tone =
    probe.state === "healthy" ? "positive" : probe.state === "down" ? "negative" : "neutral";

  return (
    <section className="admin-reliability-strip" data-testid="reliability-strip">
      <Tile
        label="Liveness"
        tone={livenessTone}
        value={liveness.total ? `${liveness.ok}/${liveness.total}` : "--"}
        sub={liveness.total ? "units running now" : "no units"}
      />
      <Tile
        label="Freshness"
        tone={freshnessTone}
        value={
          !edgeReachable ? "Unknown" : freshness.total === 0 ? "--" : freshness.stale === 0 ? "All fresh" : `${freshness.stale} stale`
        }
        sub={
          !edgeReachable
            ? "edge unreachable"
            : freshness.total === 0
              ? "no writers reported"
              : freshness.stale > 0
                ? freshness.staleServices.slice(0, 3).join(", ")
                : `${freshness.total} writers current`
        }
      />
      <Tile label="IB Auth" tone={auth.tone} value={auth.label} sub="gateway session" />
      <Tile
        label="Off-box probe"
        tone={probeTone}
        value={
          probe.state === "healthy"
            ? probe.latencyMs != null
              ? `${probe.latencyMs}ms`
              : "OK"
            : probe.state === "down"
              ? "Down"
              : probe.state === "stale"
                ? "Prober silent"
                : "Unknown"
        }
        sub={probe.state === "healthy" ? "last probe latency" : "Tier-3 external witness"}
      />
    </section>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: Tone }) {
  return (
    <div className={`admin-tile admin-tile-${tone}`} data-testid={`tile-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="admin-tile-label">{label}</div>
      <div className="admin-tile-value">
        <span className={`admin-status-dot admin-status-dot-${tone}`} aria-hidden />
        {value}
      </div>
      <div className="admin-tile-sub">{sub}</div>
    </div>
  );
}
