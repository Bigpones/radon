/**
 * Delta-adjusted leverage helper.
 *
 * Surfaces how levered long or short the portfolio is against
 * Net Liquidation Value:
 *
 *   leverage_pct        = (dollar_delta / nlv) * 100
 *   leverage_multiplier = dollar_delta / nlv
 *
 * Sign matters — positive = long-biased, negative = short-biased.
 * The caller is responsible for applying directional brand tokens.
 */

/**
 * Pct values within +/- this band classify as market-neutral.
 * Sized for "round-trip" portfolios — small directional drift is noise.
 */
export const NEUTRAL_PCT_THRESHOLD = 0.5;

export type LeverageRatio = {
  /** Percentage of NLV represented by directional exposure (signed). */
  pct: number;
  /** Multiplier of NLV represented by directional exposure (signed). */
  multiplier: number;
};

export type LeverageBias = "long" | "short" | "neutral";

function isUsableNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Compute the directional leverage ratio. Returns null when NLV is
 * unusable (zero, negative, missing, or non-finite) or the dollar
 * delta itself is non-finite — the caller should hide the row.
 */
export function computeLeverageRatio(
  dollarDelta: number,
  netLiq: number,
): LeverageRatio | null {
  if (!isUsableNumber(dollarDelta)) return null;
  if (!isUsableNumber(netLiq) || netLiq <= 0) return null;

  const multiplier = dollarDelta / netLiq;
  const pct = multiplier * 100;

  return { pct, multiplier };
}

/**
 * Classify the leverage pct as long, short, or market-neutral.
 * The neutral band absorbs round-tripping noise so we don't paint
 * 0.0001x as red/green.
 */
export function classifyLeverageBias(pct: number): LeverageBias {
  if (Math.abs(pct) <= NEUTRAL_PCT_THRESHOLD) return "neutral";
  return pct > 0 ? "long" : "short";
}

export function formatLeveragePct(pct: number): string {
  const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

export function formatLeverageMultiplier(multiplier: number): string {
  const sign = multiplier < 0 ? "-" : "";
  return `${sign}${Math.abs(multiplier).toFixed(2)}x`;
}
