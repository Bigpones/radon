import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { REGIME_QUADRANT_DETAILS } from "../lib/regimeRelationships";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const VIEW_PATH = join(TEST_DIR, "../components/RegimeRelationshipView.tsx");
const source = readFileSync(VIEW_PATH, "utf-8");

describe("Regime relationship state tooltips", () => {
  it("exports definitions for all four quadrant states", () => {
    expect(Object.keys(REGIME_QUADRANT_DETAILS)).toEqual([
      "Systemic Panic",
      "Fragile Calm",
      "Stock Picker's Market",
      "Goldilocks",
    ]);
    expect(REGIME_QUADRANT_DETAILS["Fragile Calm"]).toContain("RVOL is below its 20-session mean");
    expect(REGIME_QUADRANT_DETAILS["Systemic Panic"]).toContain("COR1M is at or above its 20-session mean");
  });

  it("renders a state key with tooltip triggers for the four relationship states", () => {
    expect(source).toContain('data-testid="regime-state-key"');
    expect(source).toContain("regime-state-tooltip-trigger");
    expect(source).toContain("regime-state-tooltip-bubble");
    expect(source).toContain("STATE KEY");
  });
});
