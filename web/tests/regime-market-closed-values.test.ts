/**
 * Unit tests: RegimePanel COR1M presentation + market-closed value gating
 *
 * Regression target:
 *  1. The regime strip must use COR1M fields from CRI data, not sector ETF proxies.
 *  2. The component must no longer depend on intraday sector-correlation snapshots.
 *  3. VIX/VVIX/SPY live values and timestamps remain gated on marketOpen.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const PANEL_PATH = join(TEST_DIR, "../components/RegimePanel.tsx");
const HELPER_PATH = join(TEST_DIR, "../lib/regimeLiveStrip.ts");
const panelSource = readFileSync(PANEL_PATH, "utf-8");
const helperSource = readFileSync(HELPER_PATH, "utf-8");

describe("RegimePanel — COR1M replaces sector ETF correlation inputs", () => {
  it("renders COR1M instead of SECTOR CORR", () => {
    expect(panelSource).toContain("COR1M");
    expect(panelSource).not.toContain("SECTOR CORR");
  });

  it("reads COR1M fields from CRI data", () => {
    expect(helperSource).toContain("data?.cor1m");
    expect(helperSource).toContain("data?.cor1m_5d_change");
    expect(panelSource).not.toContain("avg_sector_correlation");
  });

  it("does not depend on intraday sector correlation utilities", () => {
    expect(panelSource).not.toContain("computeIntradaySectorCorr");
    expect(panelSource).not.toContain("appendSnapshot");
    expect(panelSource).not.toContain("bufferDepth");
    expect(panelSource).not.toContain("resetBuffer");
  });

  it("uses COR1M > 60 for the crash-trigger label", () => {
    expect(panelSource).toContain("COR1M > 60");
  });
});

describe("RegimePanel — VIX/VVIX/SPY values must use CRI data when market is closed", () => {
  it("vixVal is gated on marketOpen before using live WS value", () => {
    expect(helperSource).toContain("const liveVix = marketOpen ? (prices.VIX?.last ?? null) : null;");
    expect(helperSource).toContain("const vixValue = liveVix ?? data?.vix ?? 0;");
  });

  it("vvixVal is gated on marketOpen before using live WS value", () => {
    expect(helperSource).toContain("const liveVvix = marketOpen ? (prices.VVIX?.last ?? null) : null;");
    expect(helperSource).toContain("const vvixValue = liveVvix ?? data?.vvix ?? 0;");
  });

  it("spyVal is gated on marketOpen before using live WS value", () => {
    expect(helperSource).toContain("const liveSpy = marketOpen ? (prices.SPY?.last ?? null) : null;");
    expect(helperSource).toContain("const spyValue = liveSpy ?? data?.spy ?? 0;");
  });
});

describe("RegimePanel — VIX/VVIX timestamps must not update when market is closed", () => {
  it("vixLastTs effect is gated on marketOpen", () => {
    // useEffect for vixLastTs must check marketOpen before calling setVixLastTs
    // so that post-close WS ticks don't stamp a live timestamp.
    const vixEffect = panelSource.match(
      /vixLastTs[\s\S]*?setVixLastTs[\s\S]*?(?=\}\s*,?\s*\[)/
    )?.[0] ?? "";
    expect(vixEffect).toMatch(/marketOpen/);
  });

  it("vvixLastTs effect is gated on marketOpen", () => {
    const vvixEffect = panelSource.match(
      /vvixLastTs[\s\S]*?setVvixLastTs[\s\S]*?(?=\}\s*,?\s*\[)/
    )?.[0] ?? "";
    expect(vvixEffect).toMatch(/marketOpen/);
  });
});

describe("RegimePanel — liveCri must not recompute with live prices when market is closed", () => {
  it("liveCri useMemo returns null when market is closed", () => {
    // When !marketOpen, liveCri should be null so `cri` falls back to data?.cri
    // (the authoritative EOD values from cri_scan.py).
    const criMemo = panelSource.match(
      /liveCri[\s\S]*?computeCri[\s\S]*?(?=\}\s*,?\s*\[)/
    )?.[0] ?? "";
    expect(criMemo).toMatch(/marketOpen/);
  });
});
