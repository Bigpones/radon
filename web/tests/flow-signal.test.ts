import { describe, expect, it } from "vitest";
import { classifyFlowSignal } from "@/lib/flowSignal";

describe("classifyFlowSignal", () => {
  it("returns NEUTRAL with no rationale crash on null", () => {
    const v = classifyFlowSignal(null);
    expect(v.direction).toBe("NEUTRAL");
    expect(v.confidence).toBe(0);
    expect(v.strength).toBe("NONE");
    expect(v.rationale).toMatch(/No flow data/i);
  });

  it("BULLISH on dark pool ACCUMULATION even without options confirmation", () => {
    const v = classifyFlowSignal({
      dark_pool: { aggregate: { flow_direction: "ACCUMULATION", flow_strength: 45 } },
      options_flow: { bias: "NO_DATA" },
      combined_signal: "DP_ACCUMULATION_ONLY",
    });
    expect(v.direction).toBe("BULLISH");
    expect(v.confidence).toBeGreaterThan(0);
    expect(v.strength).toBe("MODERATE");
    expect(v.rationale.toLowerCase()).toContain("bullish");
  });

  it("BEARISH on dark pool DISTRIBUTION", () => {
    const v = classifyFlowSignal({
      dark_pool: { aggregate: { flow_direction: "DISTRIBUTION", flow_strength: 70 } },
      options_flow: { bias: "BEARISH" },
      combined_signal: "STRONG_BEARISH_CONFLUENCE",
    });
    expect(v.direction).toBe("BEARISH");
    expect(v.confidence).toBeGreaterThanOrEqual(70);
    expect(v.strength).toBe("STRONG");
  });

  it("STRONG label when confluence is present", () => {
    const v = classifyFlowSignal({
      dark_pool: { aggregate: { flow_direction: "ACCUMULATION", flow_strength: 80 } },
      options_flow: { bias: "STRONGLY_BULLISH" },
      combined_signal: "STRONG_BULLISH_CONFLUENCE",
    });
    expect(v.direction).toBe("BULLISH");
    expect(v.strength).toBe("STRONG");
  });

  it("NEUTRAL on no signal", () => {
    const v = classifyFlowSignal({
      dark_pool: { aggregate: { flow_direction: "NEUTRAL", flow_strength: 0 } },
      options_flow: { bias: "NEUTRAL" },
      combined_signal: "NO_SIGNAL",
    });
    expect(v.direction).toBe("NEUTRAL");
    expect(v.confidence).toBe(0);
    expect(v.strength).toBe("NONE");
  });

  it("downgrades when options disagree with dark pool", () => {
    const aligned = classifyFlowSignal({
      dark_pool: { aggregate: { flow_direction: "ACCUMULATION", flow_strength: 50 } },
      options_flow: { bias: "BULLISH" },
      combined_signal: "STRONG_BULLISH_CONFLUENCE",
    });
    const disagrees = classifyFlowSignal({
      dark_pool: { aggregate: { flow_direction: "ACCUMULATION", flow_strength: 50 } },
      options_flow: { bias: "BEARISH" },
      combined_signal: "DP_ACCUMULATION_ONLY",
    });
    expect(disagrees.confidence).toBeLessThan(aligned.confidence);
    expect(disagrees.direction).toBe("BULLISH");
  });

  it("clamps an out-of-range strength value", () => {
    const v = classifyFlowSignal({
      dark_pool: { aggregate: { flow_direction: "ACCUMULATION", flow_strength: 1234 } },
      options_flow: { bias: "BULLISH" },
    });
    expect(v.confidence).toBeLessThanOrEqual(100);
  });

  it("treats UNKNOWN dark pool and NO_DATA options as neutral", () => {
    const v = classifyFlowSignal({
      dark_pool: { aggregate: { flow_direction: "UNKNOWN", flow_strength: 0 } },
      options_flow: { bias: "NO_DATA" },
    });
    expect(v.direction).toBe("NEUTRAL");
  });

  it("respects analysis.signal=STRONG even at moderate dp strength", () => {
    const v = classifyFlowSignal({
      dark_pool: { aggregate: { flow_direction: "DISTRIBUTION", flow_strength: 55 } },
      options_flow: { bias: "BEARISH" },
      analysis: { signal: "STRONG" },
    });
    expect(v.strength).toBe("STRONG");
  });
});
