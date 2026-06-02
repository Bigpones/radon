import { describe, expect, it } from "vitest";
import { mostRecentSessionDate } from "../lib/marketSession";
import { isVcgDataStale } from "../lib/vcgStaleness";
import { isGexDataStale } from "../lib/gexStaleness";

// mostRecentSessionDate resolves the session whose data we should HAVE, so the
// weekend/pre-open calendar-date roll no longer flags finalized data stale.
// Times below are UTC; the comment gives the ET wall-clock they map to.
describe("mostRecentSessionDate", () => {
  it("weekday after the open → today", () => {
    // Mon 2026-03-09 10:00 EDT (after 09:30 open)
    expect(mostRecentSessionDate(new Date("2026-03-09T14:00:00Z"))).toBe("2026-03-09");
  });

  it("weekday after the close → today (so a missed scan still catches up)", () => {
    // Thu 2026-03-12 16:15 EDT (after the 16:00 close)
    expect(mostRecentSessionDate(new Date("2026-03-12T20:15:00Z"))).toBe("2026-03-12");
  });

  it("weekday pre-open → previous trading day (no pre-market scan)", () => {
    // Mon 2026-03-09 08:00 EDT (before the open) → Friday
    expect(mostRecentSessionDate(new Date("2026-03-09T12:00:00Z"))).toBe("2026-03-06");
  });

  it("Saturday → previous Friday", () => {
    // Sat 2026-03-07 12:00 EST → Friday
    expect(mostRecentSessionDate(new Date("2026-03-07T17:00:00Z"))).toBe("2026-03-06");
  });

  it("Sunday → previous Friday", () => {
    // Sun 2026-03-08 12:00 EDT → Friday
    expect(mostRecentSessionDate(new Date("2026-03-08T16:00:00Z"))).toBe("2026-03-06");
  });
});

// The off-hours scan-storm fix: on a weekend, finalized Friday data is NOT
// stale, so no background scan fires. (todayET is injected to the weekend's
// expected session = Friday, which is what the production default resolves to.)
describe("staleness over a weekend serves finalized data", () => {
  const fridayScan = new Date("2026-03-06T16:00:00-05:00").toISOString();
  const expectedSession = "2026-03-06"; // mostRecentSessionDate on the weekend

  it("VCG: Friday data is not stale on Saturday (market closed)", () => {
    expect(isVcgDataStale({ scan_time: fridayScan }, expectedSession, false)).toBe(false);
  });

  it("GEX: Friday data is not stale on Saturday (market closed)", () => {
    expect(isGexDataStale({ scan_time: fridayScan }, expectedSession, false)).toBe(false);
  });

  it("VCG: stale when behind the expected session (catch-up)", () => {
    const thursdayScan = new Date("2026-03-05T16:00:00-05:00").toISOString();
    expect(isVcgDataStale({ scan_time: thursdayScan }, expectedSession, false)).toBe(true);
  });
});
