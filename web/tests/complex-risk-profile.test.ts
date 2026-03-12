/**
 * TDD test: positions with risk_profile="complex" must not be silently
 * dropped from the portfolio UI.
 *
 * Bug: AAOI (2 long calls) had risk_profile="complex" and was filtered out
 * because PortfolioSections only rendered "defined", "undefined", and "equity".
 *
 * Fix (both sides):
 * 1. ib_sync.py: classify all-long combos as "defined" (not "complex")
 * 2. WorkspaceSections.tsx: include "complex" in the undefined bucket as fallback
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Simulate the filtering logic from WorkspaceSections.tsx PortfolioSections
function filterPositions(positions: Array<{ ticker: string; risk_profile: string }>) {
  const defined = positions.filter((p) => p.risk_profile === "defined");
  const equity = positions.filter((p) => p.risk_profile === "equity");
  // Fixed: "complex" falls into undefined bucket as defense-in-depth
  const undefined_ = positions.filter(
    (p) => p.risk_profile === "undefined" || p.risk_profile === "complex"
  );
  return { defined, equity, undefined: undefined_ };
}

// The OLD buggy filtering logic
function filterPositionsBuggy(positions: Array<{ ticker: string; risk_profile: string }>) {
  const defined = positions.filter((p) => p.risk_profile === "defined");
  const equity = positions.filter((p) => p.risk_profile === "equity");
  const undefined_ = positions.filter((p) => p.risk_profile === "undefined");
  return { defined, equity, undefined: undefined_ };
}

const MOCK_POSITIONS = [
  { ticker: "AAOI", risk_profile: "complex" },  // The bug: this was dropped
  { ticker: "AAPL", risk_profile: "defined" },
  { ticker: "IGV", risk_profile: "undefined" },
  { ticker: "MSFT", risk_profile: "equity" },
];

describe("Complex risk profile handling", () => {
  it("BUG REPRO: old filter drops complex positions entirely", () => {
    const result = filterPositionsBuggy(MOCK_POSITIONS);
    const allRendered = [
      ...result.defined,
      ...result.equity,
      ...result.undefined,
    ];
    // AAOI was silently dropped!
    assert.equal(
      allRendered.find((p) => p.ticker === "AAOI"),
      undefined,
      "Old buggy filter should have dropped AAOI"
    );
    assert.equal(allRendered.length, 3, "Only 3 of 4 rendered with old filter");
  });

  it("FIX: new filter includes complex in undefined bucket", () => {
    const result = filterPositions(MOCK_POSITIONS);
    const allRendered = [
      ...result.defined,
      ...result.equity,
      ...result.undefined,
    ];
    // AAOI now appears
    assert.ok(
      allRendered.find((p) => p.ticker === "AAOI"),
      "AAOI should be rendered after fix"
    );
    assert.equal(allRendered.length, 4, "All 4 positions rendered");
  });

  it("complex positions land in undefined bucket specifically", () => {
    const result = filterPositions(MOCK_POSITIONS);
    assert.ok(
      result.undefined.find((p) => p.ticker === "AAOI"),
      "AAOI should be in the undefined bucket"
    );
  });

  it("all standard risk profiles still route correctly", () => {
    const result = filterPositions(MOCK_POSITIONS);
    assert.deepEqual(result.defined.map((p) => p.ticker), ["AAPL"]);
    assert.deepEqual(result.equity.map((p) => p.ticker), ["MSFT"]);
    assert.ok(result.undefined.map((p) => p.ticker).includes("IGV"));
  });

  it("no positions lost when all are standard profiles", () => {
    const standard = [
      { ticker: "A", risk_profile: "defined" },
      { ticker: "B", risk_profile: "undefined" },
      { ticker: "C", risk_profile: "equity" },
    ];
    const result = filterPositions(standard);
    const all = [...result.defined, ...result.equity, ...result.undefined];
    assert.equal(all.length, 3);
  });
});
