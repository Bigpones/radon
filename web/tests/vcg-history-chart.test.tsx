/**
 * @vitest-environment jsdom
 */

import React from "react";
import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import VcgPanel from "../components/VcgPanel";
import type { VcgData, VcgHistoryEntry } from "@/lib/useVcg";

// jsdom doesn't ship ResizeObserver; the chart wires one up on mount.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    class StubResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver =
      StubResizeObserver;
  }
});

const mockUseVcg = vi.fn();

vi.mock("@/lib/useVcg", () => ({
  useVcg: (...args: unknown[]) => mockUseVcg(...args),
}));

function buildHistory(count: number): VcgHistoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-05-${String(i + 1).padStart(2, "0")}`,
    residual: 0.001 + i * 0.0001,
    vcg: -1 + i * 0.15,
    vcg_adj: -0.9 + i * 0.15,
    beta1: -0.0139,
    beta2: -0.023,
    vix: 18 + i * 0.2,
    vvix: 110 + i * 0.5,
    credit: 80 - i * 0.05,
  }));
}

function buildVcgData(overrides: Partial<VcgData> = {}): VcgData {
  return {
    scan_time: "2026-05-17T20:00:00Z",
    market_open: false,
    credit_proxy: "HYG",
    signal: {
      vcg: 1.45,
      vcg_adj: 1.45,
      residual: 0.0034,
      beta1_vvix: -0.0139,
      beta2_vix: -0.023,
      alpha: 0,
      vix: 21,
      vvix: 118,
      credit_price: 79.6,
      credit_5d_return_pct: -0.4,
      ro: 0,
      edr: 0,
      tier: null,
      bounce: 0,
      vvix_severity: "elevated",
      sign_ok: true,
      sign_suppressed: false,
      pi_panic: 0,
      regime: "NORMAL",
      interpretation: "WATCH",
      attribution: {
        vvix_pct: 50,
        vix_pct: 50,
        vvix_component: 0,
        vix_component: 0,
        model_implied: 0,
      },
    },
    history: buildHistory(20),
    ...overrides,
  };
}

describe("VcgPanel — 20-session history chart", () => {
  it("renders the VCG history chart section when history has ≥ 2 sessions", () => {
    mockUseVcg.mockReturnValue({
      data: buildVcgData(),
      loading: false,
      error: null,
      lastSync: "2026-05-17T20:00:00Z",
    });

    const { container, getByTestId } = render(
      React.createElement(VcgPanel, { prices: {} }),
    );

    const section = getByTestId("vcg-history-chart-section");
    expect(section).toBeTruthy();

    const chart = container.querySelector('[data-testid="cri-history-chart"]');
    expect(chart).toBeTruthy();

    // Legend should mention both series labels
    expect(container.textContent).toContain("VCG Z-SCORE");
    expect(container.textContent).toContain("HYG PRICE");
  });

  it("hides the chart section when history has fewer than 2 sessions", () => {
    mockUseVcg.mockReturnValue({
      data: buildVcgData({ history: [] }),
      loading: false,
      error: null,
      lastSync: "2026-05-17T20:00:00Z",
    });

    const { container } = render(React.createElement(VcgPanel, { prices: {} }));
    expect(container.querySelector('[data-testid="vcg-history-chart-section"]')).toBeNull();
  });

  it("uses the credit_proxy label dynamically (e.g. JNK instead of HYG)", () => {
    mockUseVcg.mockReturnValue({
      data: buildVcgData({ credit_proxy: "JNK" }),
      loading: false,
      error: null,
      lastSync: "2026-05-17T20:00:00Z",
    });

    const { container } = render(React.createElement(VcgPanel, { prices: {} }));
    expect(container.textContent).toContain("JNK PRICE");
    expect(container.textContent).not.toContain("HYG PRICE");
  });

  it("renders the chart ABOVE the history table (chart-first reading order)", () => {
    mockUseVcg.mockReturnValue({
      data: buildVcgData(),
      loading: false,
      error: null,
      lastSync: "2026-05-17T20:00:00Z",
    });

    const { container } = render(React.createElement(VcgPanel, { prices: {} }));
    const html = container.innerHTML;
    const chartIdx = html.indexOf('data-testid="vcg-history-chart-section"');
    const tableIdx = html.indexOf("VCG History (20d)");
    expect(chartIdx).toBeGreaterThan(-1);
    expect(tableIdx).toBeGreaterThan(-1);
    expect(chartIdx).toBeLessThan(tableIdx);
  });
});
