// @vitest-environment jsdom

/**
 * Tests for zoom + pan controls on the Correlation Risk Premium chart.
 *
 * Covers (added incrementally — chips first, brush+hover follow):
 *   - Default range covers the last 252 trading days (or all when shorter).
 *   - Preset chips (1M/3M/6M/1Y/All) narrow rendered bars to the right count.
 *   - No raw hex in any new className/style.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

import RegimeRelationshipView from "../components/RegimeRelationshipView";
import type { RegimeRelationshipSource } from "../lib/regimeRelationships";

// Resolve from the vitest cwd. Run-from-web/ and run-from-repo-root both work.
const VIEW_PATH = (() => {
  const candidates = [
    resolve(process.cwd(), "web/components/RegimeRelationshipView.tsx"),
    resolve(process.cwd(), "components/RegimeRelationshipView.tsx"),
    resolve(process.cwd(), "../web/components/RegimeRelationshipView.tsx"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `Could not locate RegimeRelationshipView.tsx from cwd=${process.cwd()}`,
    );
  }
  return found;
})();

function buildHistory(length: number): RegimeRelationshipSource[] {
  const out: RegimeRelationshipSource[] = [];
  // Start far enough back to make a 300+ session span deterministic.
  const startMs = new Date("2024-01-02T00:00:00Z").getTime();
  for (let index = 0; index < length; index += 1) {
    const ts = new Date(startMs + index * 86_400_000);
    const yyyy = ts.getUTCFullYear();
    const mm = String(ts.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(ts.getUTCDate()).padStart(2, "0");
    out.push({
      date: `${yyyy}-${mm}-${dd}`,
      realized_vol: 10 + index * 0.01,
      cor1m: 12 + Math.sin(index / 7) * 2 + index * 0.005,
    });
  }
  return out;
}

function countSpreadBars(): number {
  return document.querySelectorAll(
    '[data-testid="regime-spread-chart"] rect[data-testid^="regime-spread-bar-"]',
  ).length;
}

afterEach(() => cleanup());

describe("Correlation Risk Premium preset range chips", () => {
  it("defaults the visible range to the last 252 trading sessions when history is longer", () => {
    const history = buildHistory(300);
    render(
      React.createElement(RegimeRelationshipView, {
        history,
      }),
    );

    expect(countSpreadBars()).toBe(252);
    const activeChip = screen.getByTestId("regime-spread-range-1y");
    expect(activeChip.getAttribute("data-active")).toBe("true");
  });

  it("shows every bar when history is shorter than a year and keeps the 1Y chip selected", () => {
    const history = buildHistory(40);
    render(
      React.createElement(RegimeRelationshipView, {
        history,
      }),
    );

    expect(countSpreadBars()).toBe(40);
    const oneYear = screen.getByTestId("regime-spread-range-1y");
    expect(oneYear.getAttribute("data-active")).toBe("true");
  });

  it("narrows rendered bars to the right session count when a preset chip is selected", () => {
    const history = buildHistory(300);
    render(
      React.createElement(RegimeRelationshipView, {
        history,
      }),
    );

    fireEvent.click(screen.getByTestId("regime-spread-range-1m"));
    expect(countSpreadBars()).toBe(21);

    fireEvent.click(screen.getByTestId("regime-spread-range-3m"));
    expect(countSpreadBars()).toBe(63);

    fireEvent.click(screen.getByTestId("regime-spread-range-6m"));
    expect(countSpreadBars()).toBe(126);

    fireEvent.click(screen.getByTestId("regime-spread-range-all"));
    expect(countSpreadBars()).toBe(300);
  });

  it("renders mono-font preset chips for each available range", () => {
    const history = buildHistory(120);
    render(
      React.createElement(RegimeRelationshipView, {
        history,
      }),
    );

    const chipRow = screen.getByTestId("regime-spread-range-chips");
    expect(chipRow).toBeTruthy();
    ["1m", "3m", "6m", "1y", "all"].forEach((slug) => {
      expect(screen.getByTestId(`regime-spread-range-${slug}`)).toBeTruthy();
    });
  });

  it("does not introduce raw hex colors in the regime relationship view source", () => {
    const source = readFileSync(VIEW_PATH, "utf-8");
    const hexMatches = source.match(/#(?:[0-9a-fA-F]{3}){1,2}\b/g);
    expect(hexMatches).toBeNull();
  });
});
