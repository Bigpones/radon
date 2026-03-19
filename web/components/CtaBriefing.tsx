"use client";

import type { CtaRow } from "@/lib/useMenthorqCta";

/* ─── Types ──────────────────────────────────────────── */

type CtaTables = {
  main: CtaRow[];
  index: CtaRow[];
  commodity: CtaRow[];
  currency: CtaRow[];
};

type CtaBriefingProps = {
  tables: CtaTables;
  estSellingBn: number | null;
};

/* ─── Helpers ────────────────────────────────────────── */

function fmt(v: number | null | undefined, decimals = 2): string {
  if (v == null || !Number.isFinite(v)) return "---";
  return v.toFixed(decimals);
}

/** Derive equity posture regime from SPX row in main table */
function deriveEquityPosture(main: CtaRow[]): {
  label: string;
  cssColor: string;
  borderColor: string;
  bgColor: string;
} {
  const spx = main.find((r) =>
    r.underlying.toLowerCase().includes("s&p") ||
    r.underlying.toLowerCase().includes("e-mini")
  );
  if (!spx) return { label: "UNKNOWN", cssColor: "var(--text-muted)", borderColor: "var(--border-dim)", bgColor: "transparent" };

  const pctile = spx.percentile_3m;
  const z = spx.z_score_3m;

  if (pctile <= 5 || z <= -2.0) return {
    label: "EXTREME SHORT",
    cssColor: "var(--negative)",
    borderColor: "rgba(232,93,108,0.4)",
    bgColor: "rgba(232,93,108,0.05)",
  };
  if (pctile <= 15 || z <= -1.5) return {
    label: "HEAVY SHORT",
    cssColor: "var(--negative)",
    borderColor: "rgba(232,93,108,0.3)",
    bgColor: "rgba(232,93,108,0.04)",
  };
  if (pctile <= 30) return {
    label: "SHORT",
    cssColor: "var(--warning)",
    borderColor: "rgba(245,166,35,0.35)",
    bgColor: "rgba(245,166,35,0.04)",
  };
  if (pctile >= 95 || z >= 2.0) return {
    label: "EXTREME LONG",
    cssColor: "var(--positive)",
    borderColor: "rgba(5,173,152,0.4)",
    bgColor: "rgba(5,173,152,0.05)",
  };
  if (pctile >= 80 || z >= 1.5) return {
    label: "HEAVY LONG",
    cssColor: "var(--positive)",
    borderColor: "rgba(5,173,152,0.3)",
    bgColor: "rgba(5,173,152,0.04)",
  };
  return {
    label: "NEUTRAL",
    cssColor: "var(--text-muted)",
    borderColor: "var(--border-dim)",
    bgColor: "transparent",
  };
}

/** Pull the SPX row from main */
function getSpxRow(main: CtaRow[]): CtaRow | undefined {
  return main.find((r) =>
    r.underlying.toLowerCase().includes("s&p") ||
    r.underlying.toLowerCase().includes("e-mini")
  );
}

/** Find most extreme commodity long (pctile_3m >= 80) */
function getCrowdedCommodityLongs(commodity: CtaRow[]): CtaRow[] {
  return commodity
    .filter((r) => r.percentile_3m >= 80 && r.position_today > 0)
    .sort((a, b) => b.percentile_3m - a.percentile_3m);
}

/** Derive squeeze risk label */
function deriveSqueezeRisk(spx: CtaRow | undefined): { label: string; cssColor: string } {
  if (!spx) return { label: "UNKNOWN", cssColor: "var(--text-muted)" };
  const pctile = spx.percentile_3m;
  const z = spx.z_score_3m;
  if (pctile <= 5 || z <= -2.0) return { label: "ELEVATED", cssColor: "var(--warning)" };
  if (pctile <= 15 || z <= -1.5) return { label: "MODERATE", cssColor: "var(--warning)" };
  return { label: "LOW", cssColor: "var(--text-muted)" };
}

/** Derive active signal tags from full dataset */
function deriveSignalTags(tables: CtaTables): Array<{ label: string; cssColor: string; borderColor: string; bgColor: string }> {
  const tags: Array<{ label: string; cssColor: string; borderColor: string; bgColor: string }> = [];

  const spx = getSpxRow(tables.main);
  if (spx && spx.percentile_3m <= 15) {
    tags.push({
      label: "SHORT EQUITIES",
      cssColor: "var(--negative)",
      borderColor: "rgba(232,93,108,0.3)",
      bgColor: "rgba(232,93,108,0.12)",
    });
  }
  if (spx && spx.percentile_3m >= 80) {
    tags.push({
      label: "LONG EQUITIES",
      cssColor: "var(--positive)",
      borderColor: "rgba(5,173,152,0.3)",
      bgColor: "rgba(5,173,152,0.1)",
    });
  }

  // Bond posture
  const bonds = tables.main.filter((r) =>
    r.underlying.toLowerCase().includes("t-note") ||
    r.underlying.toLowerCase().includes("treasury")
  );
  const bondShort = bonds.filter((r) => r.percentile_3m <= 10 && r.position_today < 0);
  if (bondShort.length >= 2) {
    tags.push({
      label: "SHORT BONDS",
      cssColor: "var(--negative)",
      borderColor: "rgba(232,93,108,0.25)",
      bgColor: "rgba(232,93,108,0.1)",
    });
  }

  // Crowded commodity longs
  const crowdedEnergy = tables.commodity.filter(
    (r) => r.percentile_3m >= 85 && r.position_today > 0 &&
      (r.underlying.toLowerCase().includes("brent") ||
        r.underlying.toLowerCase().includes("diesel") ||
        r.underlying.toLowerCase().includes("crude"))
  );
  if (crowdedEnergy.length > 0) {
    tags.push({
      label: "LONG ENERGY",
      cssColor: "var(--signal-core)",
      borderColor: "rgba(5,173,152,0.3)",
      bgColor: "rgba(5,173,152,0.1)",
    });
  }

  // Squeeze watch
  if (spx && spx.percentile_3m <= 10 && spx.position_1m_ago > 0) {
    tags.push({
      label: "SQUEEZE WATCH",
      cssColor: "var(--warning)",
      borderColor: "rgba(245,166,35,0.3)",
      bgColor: "rgba(245,166,35,0.1)",
    });
  }

  return tags;
}

/** Build narrative prose from data */
function buildNarrative(tables: CtaTables, estSellingBn: number | null): string {
  const spx = getSpxRow(tables.main);
  const nq = tables.main.find((r) => r.underlying.toLowerCase().includes("nasdaq"));
  const crowded = getCrowdedCommodityLongs(tables.commodity);

  const parts: string[] = [];

  if (spx) {
    const flipped = spx.position_1m_ago > 0 && spx.position_today < 0;
    const pctile = spx.percentile_3m;
    if (pctile <= 10) {
      parts.push(
        `SPX CTAs at the ${pctile === 0 ? "0th" : pctile + "th"} percentile of their 3M range${flipped ? `, having flipped from ${fmt(spx.position_1m_ago)} long one month ago` : ""}.`
      );
    } else if (pctile >= 90) {
      parts.push(`SPX CTAs at the ${pctile}th percentile of their 3M range — heavily long.`);
    }
  }

  if (nq && nq.percentile_3m <= 10) {
    const increasing = nq.position_today < nq.position_yesterday;
    parts.push(
      `NQ positioning at 0th percentile${increasing ? ", shorts increasing" : ""} (${fmt(nq.position_yesterday)} to ${fmt(nq.position_today)}).`
    );
  }

  if (crowded.length > 0) {
    const labels = crowded.slice(0, 3).map((r) => {
      const name = r.underlying.split(" ")[0];
      return `${name} at ${r.percentile_3m}th pctile`;
    });
    parts.push(`Crowded commodity longs: ${labels.join(", ")}.`);
  }

  const spxShort = getSpxRow(tables.main);
  if (spxShort && spxShort.percentile_3m <= 10 && spxShort.position_1m_ago > 0) {
    parts.push(
      "Positioning is a mean-reversion coil — any bullish catalyst risks violent CTA short-covering across all equity classes."
    );
  }

  if (estSellingBn != null && estSellingBn > 20) {
    parts.push(`Vol-targeting model estimates $${fmt(estSellingBn, 1)}B in forced selling still in pipeline.`);
  }

  return parts.join(" ") || "Positioning data available. No extreme concentration detected.";
}

/* ─── Component ──────────────────────────────────────── */

export default function CtaBriefing({ tables, estSellingBn }: CtaBriefingProps) {
  const spx = getSpxRow(tables.main);
  const posture = deriveEquityPosture(tables.main);
  const squeezeRisk = deriveSqueezeRisk(spx);
  const tags = deriveSignalTags(tables);
  const narrative = buildNarrative(tables, estSellingBn);
  const crowded = getCrowdedCommodityLongs(tables.commodity);

  return (
    <div
      className="cta-briefing"
      style={{
        margin: "0 0 0 0",
        borderBottom: "1px solid var(--border-dim)",
        borderLeft: `2px solid ${posture.borderColor}`,
        background: posture.bgColor,
        padding: "12px 16px 14px",
      }}
    >
      {/* ── Header row ── */}
      <div className="cta-briefing-header">
        <span
          className="cta-briefing-regime-pill"
          style={{
            color: posture.cssColor,
            borderColor: posture.borderColor,
            background: posture.bgColor,
          }}
        >
          {posture.label}
        </span>
        <span className="cta-briefing-label">CTA EQUITY POSTURE</span>
      </div>

      {/* ── Metric cards ── */}
      <div className="cta-briefing-metrics">
        <div className="cta-briefing-metric">
          <div className="cta-briefing-metric-label">SPX 3M PCTILE</div>
          <div
            className="cta-briefing-metric-value"
            style={{ color: spx && spx.percentile_3m <= 15 ? "var(--negative)" : spx && spx.percentile_3m >= 85 ? "var(--positive)" : "var(--text-primary)" }}
          >
            {spx != null ? (spx.percentile_3m === 0 ? "0th" : `${spx.percentile_3m}th`) : "---"}
          </div>
        </div>
        <div className="cta-briefing-metric">
          <div className="cta-briefing-metric-label">SPX 3M Z-SCORE</div>
          <div
            className="cta-briefing-metric-value"
            style={{ color: spx && spx.z_score_3m <= -1.5 ? "var(--negative)" : spx && spx.z_score_3m >= 1.5 ? "var(--positive)" : "var(--text-primary)" }}
          >
            {spx != null ? fmt(spx.z_score_3m) : "---"}
          </div>
        </div>
        <div className="cta-briefing-metric">
          <div className="cta-briefing-metric-label">EST. SELLING</div>
          <div
            className="cta-briefing-metric-value"
            style={{ color: estSellingBn != null && estSellingBn > 50 ? "var(--warning)" : "var(--text-primary)" }}
          >
            {estSellingBn != null ? `$${fmt(estSellingBn, 0)}B` : "---"}
          </div>
        </div>
        <div className="cta-briefing-metric">
          <div className="cta-briefing-metric-label">SQUEEZE RISK</div>
          <div
            className="cta-briefing-metric-value"
            style={{ color: squeezeRisk.cssColor }}
          >
            {squeezeRisk.label}
          </div>
        </div>
        {crowded.length > 0 && (
          <div className="cta-briefing-metric">
            <div className="cta-briefing-metric-label">CROWDED LONGS</div>
            <div className="cta-briefing-metric-value" style={{ color: "var(--signal-core)" }}>
              {crowded.length}
            </div>
          </div>
        )}
      </div>

      {/* ── Narrative ── */}
      <p className="cta-briefing-narrative">{narrative}</p>

      {/* ── Signal tags ── */}
      {tags.length > 0 && (
        <div className="cta-briefing-tags">
          {tags.map((t) => (
            <span
              key={t.label}
              className="cta-briefing-tag"
              style={{
                color: t.cssColor,
                borderColor: t.borderColor,
                background: t.bgColor,
              }}
            >
              {t.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
