"use client";

import type { ReactNode } from "react";

/**
 * FlowProjectionTrace — pure-SVG primary trace + optional overlay rendered
 * across a projection-geometry grid (brand-identity.md § 6 motif). The
 * primary series is rendered as a 2px signal-core path; the overlay as a
 * 1.5px violet-extreme path with 0.85 opacity. Diagonal projection guides
 * give the chart its "scientific instrument" backdrop.
 *
 * The component is data-shape-agnostic — it just takes raw [t, v] arrays
 * and projects them. Callers handle data sourcing (SPY ticks, dark-pool
 * z-scores, etc.).
 */

export type FlowProjectionSeries = {
  /** Series label rendered in the legend. */
  label: string;
  /** Raw points. Time axis is arbitrary; only relative spacing matters. */
  points: { t: number; v: number }[];
  /** "primary" → teal core color; "overlay" → violet extreme color. */
  tone?: "primary" | "overlay";
};

export type FlowProjectionTraceProps = {
  primary: FlowProjectionSeries;
  overlay?: FlowProjectionSeries | null;
  width?: number;
  height?: number;
  /** Optional right-side readout strip. */
  readout?: ReactNode;
  /** Set true when the overlay data source is not yet wired. The component
   *  still renders the primary; the overlay slot shows a brand-true
   *  "awaiting feed" annotation rather than an empty void. */
  overlayAwaiting?: boolean;
};

const PAD = { top: 16, right: 16, bottom: 28, left: 16 };

function buildPath(
  points: { t: number; v: number }[],
  bounds: { tMin: number; tRange: number; vMin: number; vRange: number },
  w: number,
  h: number,
): string {
  if (points.length === 0) return "";
  const sx = (t: number) =>
    PAD.left + ((t - bounds.tMin) / bounds.tRange) * (w - PAD.left - PAD.right);
  const sy = (v: number) =>
    h - PAD.bottom - ((v - bounds.vMin) / bounds.vRange) * (h - PAD.top - PAD.bottom);
  const segs = points.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.t).toFixed(2)} ${sy(p.v).toFixed(2)}`);
  return segs.join(" ");
}

function seriesBounds(points: { t: number; v: number }[]) {
  if (points.length === 0) {
    return { tMin: 0, tRange: 1, vMin: 0, vRange: 1 };
  }
  let tMin = Infinity;
  let tMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of points) {
    if (p.t < tMin) tMin = p.t;
    if (p.t > tMax) tMax = p.t;
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  }
  const tRange = tMax - tMin || 1;
  const vPad = (vMax - vMin) * 0.08 || 0.5;
  const vRange = vMax - vMin + vPad * 2 || 1;
  return { tMin, tRange, vMin: vMin - vPad, vRange };
}

export function FlowProjectionTrace({
  primary,
  overlay,
  width = 720,
  height = 220,
  readout,
  overlayAwaiting = false,
}: FlowProjectionTraceProps) {
  const allPoints = [
    ...primary.points,
    ...(overlay ? overlay.points : []),
  ];
  const bounds = seriesBounds(allPoints.length > 0 ? allPoints : primary.points);
  const primaryPath = buildPath(primary.points, bounds, width, height);
  const overlayPath = overlay ? buildPath(overlay.points, bounds, width, height) : null;

  // Projection-geometry diagonal guides — drawn at fixed angles, low opacity.
  // Per brand-identity.md § 6: "Keep opacity low — structural, not decorative."
  const guides = [-160, -80, 0, 80, 160].map((offset) => {
    const x1 = PAD.left + offset;
    const x2 = x1 + (width - PAD.left - PAD.right);
    return `M${x1} ${height - PAD.bottom} L${x2} ${PAD.top}`;
  });

  return (
    <div className="flow-projection">
      <div className="flow-projection__header">
        <div className="flow-projection__legend">
          <span className="flow-projection__legend-item flow-projection__legend-item--primary">
            <span className="flow-projection__swatch flow-projection__swatch--primary" />
            {primary.label}
          </span>
          {overlay ? (
            <span className="flow-projection__legend-item flow-projection__legend-item--overlay">
              <span className="flow-projection__swatch flow-projection__swatch--overlay" />
              {overlay.label}
            </span>
          ) : overlayAwaiting ? (
            <span className="flow-projection__legend-item flow-projection__legend-item--awaiting">
              Overlay · awaiting feed
            </span>
          ) : null}
        </div>
        {readout ? <div className="flow-projection__readout">{readout}</div> : null}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        aria-hidden
      >
        {/* Projection geometry */}
        <g className="flow-projection__guides">
          {guides.map((d, i) => (
            <path
              key={`g-${i}`}
              d={d}
              stroke="var(--line-grid)"
              strokeWidth="1"
              opacity={0.35}
              fill="none"
            />
          ))}
        </g>
        {/* Baseline */}
        <line
          x1={PAD.left}
          x2={width - PAD.right}
          y1={height - PAD.bottom}
          y2={height - PAD.bottom}
          stroke="var(--line-grid)"
          strokeWidth="1"
        />
        {/* Overlay first so the primary draws on top */}
        {overlayPath ? (
          <path
            d={overlayPath}
            stroke="var(--extreme)"
            strokeWidth="1.5"
            fill="none"
            opacity={0.85}
          />
        ) : null}
        {/* Primary */}
        <path
          d={primaryPath}
          stroke="var(--signal-core)"
          strokeWidth="2"
          fill="none"
        />
      </svg>
    </div>
  );
}
