"use client";

import type { CSSProperties } from "react";

type SpectralLoaderProps = {
  /** Label rendered below the spectrum. Brand voice § 8 wants this to
   *  describe the measurement condition, not a generic "Loading…".
   *  Good: "Sampling 20-session basis". Bad: "Loading data…". */
  label?: string;
  /** Number of spectral bars. Default 24 (matches brand component kit). */
  bars?: number;
  /** Height of the spectrum strip, in pixels. */
  height?: number;
  /** Tonal direction. "core" (default) renders teal; "warn" amber for
   *  cautious or low-quality reconstruction states. */
  tone?: "core" | "warn";
};

const HEIGHT_PROFILE = [
  0.28, 0.34, 0.48, 0.58, 0.76, 0.80, 0.86, 0.72,
  0.58, 0.44, 0.30, 0.22, 0.26, 0.36, 0.64, 0.82,
  0.94, 0.72, 0.54, 0.38, 0.24, 0.20, 0.26, 0.18,
];

/**
 * SpectralLoader — replaces shimmer skeletons with the brand's spectral
 * decomposition motif (brand-identity.md § 6). The spectrum strip pulses
 * with a phase offset that reads as a calibrating instrument rather than
 * a generic loading indicator. Use anywhere a panel is mid-sample.
 */
export default function SpectralLoader({
  label = "Sampling…",
  bars = 24,
  height = 56,
  tone = "core",
}: SpectralLoaderProps) {
  const indices = Array.from({ length: bars }, (_, i) => i);
  return (
    <div
      className={`spectral-loader spectral-loader--${tone}`}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="spectral-loader__spectrum" style={{ height }}>
        {indices.map((i) => (
          <span
            key={i}
            style={
              {
                "--i": i,
                "--baseline": HEIGHT_PROFILE[i % HEIGHT_PROFILE.length],
              } as CSSProperties
            }
          />
        ))}
      </div>
      {label ? <div className="spectral-loader__label">{label}</div> : null}
    </div>
  );
}
