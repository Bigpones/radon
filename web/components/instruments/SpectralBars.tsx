"use client";

/**
 * SpectralBars — static bar set with values from any signal source, rendered
 * in the brand's spectral-decomposition grammar (brand-identity.md § 6).
 * Distinct from SpectralLoader: this is a *real signal* surface, not a
 * loading state. Each bar height is proportional to |value|; tone shifts
 * between teal/violet by sign for diverging series.
 */

export type SpectralBar = {
  /** X-axis label rendered below the bar set. Often "09:30", "10:00", … */
  label: string;
  /** Signed value. Positive → core color, negative → extreme color. */
  value: number;
};

export type SpectralBarsProps = {
  bars: SpectralBar[];
  height?: number;
  /** Show every Nth label only. Default: every 4th for 24-bar series. */
  labelEveryN?: number;
  /** When true, render a hatch in place of bars and a "awaiting" caption. */
  awaiting?: boolean;
  /** Optional caption below the bars (e.g. "30m buckets · today"). */
  caption?: string;
};

export function SpectralBars({
  bars,
  height = 96,
  labelEveryN = 4,
  awaiting = false,
  caption,
}: SpectralBarsProps) {
  if (awaiting) {
    return (
      <div className="spectral-bars spectral-bars--awaiting">
        <div className="spectral-bars__awaiting-hatch" aria-hidden />
        <div className="spectral-bars__awaiting-label">Awaiting decomposition feed</div>
      </div>
    );
  }

  const maxAbs = bars.reduce((m, b) => Math.max(m, Math.abs(b.value)), 0) || 1;

  return (
    <div className="spectral-bars">
      <div className="spectral-bars__bars" style={{ height }}>
        {bars.map((b, i) => {
          const pct = (Math.abs(b.value) / maxAbs) * 100;
          const tone = b.value < 0 ? "neg" : "pos";
          return (
            <span
              key={`${b.label}-${i}`}
              className={`spectral-bars__bar spectral-bars__bar--${tone}`}
              style={{ height: `${pct}%` }}
              title={`${b.label}: ${b.value.toFixed(2)}`}
            />
          );
        })}
      </div>
      <div className="spectral-bars__axis">
        {bars.map((b, i) => (
          <span
            key={`l-${b.label}-${i}`}
            className="spectral-bars__label"
            style={{ visibility: i % labelEveryN === 0 ? "visible" : "hidden" }}
          >
            {b.label}
          </span>
        ))}
      </div>
      {caption ? <div className="spectral-bars__caption">{caption}</div> : null}
    </div>
  );
}
