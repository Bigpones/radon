/**
 * Unit tests: Delta-adjusted leverage helper.
 *
 * Computes the ratio of Dollar Delta to Net Liquidation Value:
 *   leverage_pct        = (dollar_delta / nlv) * 100
 *   leverage_multiplier = dollar_delta / nlv
 *
 * Sign is preserved (positive = long-biased, negative = short-biased).
 * Returns null when nlv is 0/undefined/non-finite so the caller can hide the row.
 */

import { describe, it, expect } from "vitest";
import {
  computeLeverageRatio,
  classifyLeverageBias,
  formatLeveragePct,
  formatLeverageMultiplier,
  NEUTRAL_PCT_THRESHOLD,
} from "@/lib/dollarDeltaLeverage";

describe("computeLeverageRatio", () => {
  it("returns Joe's example exactly: $286,059 / $1,611,889.79 ~ 17.75% / 0.1775x", () => {
    const result = computeLeverageRatio(286_059, 1_611_889.79);
    expect(result).not.toBeNull();
    expect(result!.pct).toBeCloseTo(17.7468, 3);
    expect(result!.multiplier).toBeCloseTo(0.17747, 4);
  });

  it("preserves negative sign for short-biased exposure", () => {
    const result = computeLeverageRatio(-500_000, 2_000_000);
    expect(result).not.toBeNull();
    expect(result!.pct).toBeCloseTo(-25, 6);
    expect(result!.multiplier).toBeCloseTo(-0.25, 6);
  });

  it("returns zero for zero dollar delta", () => {
    const result = computeLeverageRatio(0, 1_000_000);
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(0);
    expect(result!.multiplier).toBe(0);
  });

  it("returns null when nlv is 0", () => {
    expect(computeLeverageRatio(100_000, 0)).toBeNull();
  });

  it("returns null when nlv is undefined", () => {
    expect(computeLeverageRatio(100_000, undefined as unknown as number)).toBeNull();
  });

  it("returns null when nlv is null", () => {
    expect(computeLeverageRatio(100_000, null as unknown as number)).toBeNull();
  });

  it("returns null when nlv is NaN", () => {
    expect(computeLeverageRatio(100_000, NaN)).toBeNull();
  });

  it("returns null when dollar_delta is non-finite", () => {
    expect(computeLeverageRatio(Infinity, 1_000_000)).toBeNull();
    expect(computeLeverageRatio(NaN, 1_000_000)).toBeNull();
  });

  it("returns null when nlv is negative (degenerate / margin-call account)", () => {
    expect(computeLeverageRatio(100_000, -500)).toBeNull();
  });

  it("does not abs() the dollar delta — leverage of -2x is allowed", () => {
    const result = computeLeverageRatio(-2_000_000, 1_000_000);
    expect(result).not.toBeNull();
    expect(result!.multiplier).toBeCloseTo(-2, 6);
    expect(result!.pct).toBeCloseTo(-200, 6);
  });
});

describe("classifyLeverageBias", () => {
  it("returns 'long' when pct exceeds neutral band", () => {
    expect(classifyLeverageBias(5)).toBe("long");
    expect(classifyLeverageBias(0.6)).toBe("long");
  });

  it("returns 'short' when pct is below negative neutral band", () => {
    expect(classifyLeverageBias(-5)).toBe("short");
    expect(classifyLeverageBias(-0.6)).toBe("short");
  });

  it("returns 'neutral' when pct is within +/- 0.5%", () => {
    expect(classifyLeverageBias(0)).toBe("neutral");
    expect(classifyLeverageBias(0.4)).toBe("neutral");
    expect(classifyLeverageBias(-0.4)).toBe("neutral");
    expect(classifyLeverageBias(NEUTRAL_PCT_THRESHOLD - 0.0001)).toBe("neutral");
  });

  it("returns 'neutral' for boundary values exactly at threshold", () => {
    expect(classifyLeverageBias(NEUTRAL_PCT_THRESHOLD)).toBe("neutral");
    expect(classifyLeverageBias(-NEUTRAL_PCT_THRESHOLD)).toBe("neutral");
  });
});

describe("formatLeveragePct", () => {
  it("includes a leading + for positive values", () => {
    expect(formatLeveragePct(17.747)).toBe("+17.7%");
  });

  it("includes a leading - for negative values", () => {
    expect(formatLeveragePct(-25.0)).toBe("-25.0%");
  });

  it("renders zero without a sign", () => {
    expect(formatLeveragePct(0)).toBe("0.0%");
  });
});

describe("formatLeverageMultiplier", () => {
  it("renders positive multiplier with two decimals and the x suffix", () => {
    expect(formatLeverageMultiplier(0.17747)).toBe("0.18x");
  });

  it("renders negative multiplier with sign", () => {
    expect(formatLeverageMultiplier(-1.5)).toBe("-1.50x");
  });

  it("renders zero as 0.00x", () => {
    expect(formatLeverageMultiplier(0)).toBe("0.00x");
  });
});
