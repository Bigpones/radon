import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const PANEL_PATH = join(TEST_DIR, "../components/RegimePanel.tsx");
const source = readFileSync(PANEL_PATH, "utf-8");

describe("RegimePanel — live COR1M rendering", () => {
  it("prefers the live COR1M websocket price over cached CRI COR1M when available", () => {
    expect(source).toMatch(/liveCor1m/);
    expect(source).toMatch(/const activeCorr\s*=\s*liveCor1m\s*\?\?/);
  });

  it("shows a live badge for COR1M when a live COR1M value is present", () => {
    const cor1mLabelLine = source.match(/<div className="regime-strip-label">COR1M[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(cor1mLabelLine).toContain("LiveBadge");
    expect(cor1mLabelLine).not.toContain("LiveBadge live={false}");
    expect(cor1mLabelLine).toMatch(/liveCor1m|hasLiveCor1m/);
  });

  it("pushes the live COR1M value into the RVOL/COR1M history chart", () => {
    expect(source).toMatch(/rvolCorrLive\.cor1m\s*=\s*liveCor1m/);
  });

  it("anchors the live COR1M day-change line to the prior CRI/Cboe close, not the IB close field", () => {
    expect(source).toContain("cor1m_previous_close");
    expect(source).not.toMatch(/const cor1mClose\s*=\s*marketOpen\s*\?\s*\(prices\["COR1M"\]\?\.close \?\? null\)\s*:\s*null/);
    expect(source).toMatch(/<DayChange last=\{liveCor1m\} close=\{cor1mPreviousClose\} \/>/);
  });

  it("moves the COR1M 5d change into the muted strip subline", () => {
    expect(source).toContain('5d chg:');
    expect(source).toMatch(/<div className="regime-strip-sub">\{`5d chg:/);
  });
});
