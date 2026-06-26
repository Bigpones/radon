import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { resolveRegimeStripLiveState } from "../lib/regimeLiveStrip";
import type { PriceData } from "../lib/pricesProtocol";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const PANEL_PATH = join(TEST_DIR, "../components/RegimePanel.tsx");
const HELPER_PATH = join(TEST_DIR, "../lib/regimeLiveStrip.ts");
const panelSource = readFileSync(PANEL_PATH, "utf-8");
const helperSource = readFileSync(HELPER_PATH, "utf-8");

function px(last: number, close = last - 1): PriceData {
  return { last, close } as unknown as PriceData;
}

describe("RegimePanel — live COR1M rendering", () => {
  it("prefers the live COR1M websocket price over cached CRI COR1M when available", () => {
    // Behavioral: live COR1M wins when market open, CRI value when closed.
    const open = resolveRegimeStripLiveState({ prices: { COR1M: px(72) }, data: { cor1m: 55 }, marketOpen: true });
    expect(open.liveCor1m).toBe(72);
    expect(open.cor1mValue).toBe(72);
    const closed = resolveRegimeStripLiveState({ prices: { COR1M: px(72) }, data: { cor1m: 55 }, marketOpen: false });
    expect(closed.cor1mValue).toBe(55);
    // Panel wires the resolved value into the active-correlation field.
    expect(panelSource).toContain("cor1mValue: activeCorr");
  });

  it("shows a live badge for COR1M gated on market open state", () => {
    // The strip uses effectiveHasLiveCor1m (marketOpen && hasLiveCor1m)
    // so the badge shows DAILY when the market is closed, even if the
    // WS relay returns stale Friday close values.
    expect(panelSource).toContain("COR1M <LiveBadge live={effectiveHasLiveCor1m} />");
    expect(panelSource).not.toContain("COR1M <LiveBadge live={false} />");
  });

  it("pushes the live COR1M value into the RVOL/COR1M history chart", () => {
    expect(panelSource).toMatch(/rvolCorrLive\.cor1m\s*=\s*liveCor1m/);
  });

  it("anchors the live COR1M day-change line to the prior CRI/Cboe close, not the IB close field", () => {
    expect(helperSource).toContain("cor1m_previous_close");
    expect(helperSource).not.toContain('prices.COR1M?.close');
    expect(panelSource).toMatch(/<DayChange last=\{liveCor1m\} close=\{cor1mPreviousClose\} \/>/);
  });

  it("moves the COR1M 5d change into the muted strip subline", () => {
    expect(panelSource).toContain('5d chg:');
    expect(panelSource).toContain('sub={<>{`5d chg:');
  });
});
