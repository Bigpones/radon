import { describe, expect, it } from "vitest";

import { getMarketPhaseFromDate } from "../lib/serviceHealthWindows";

describe("getMarketPhaseFromDate", () => {
  it("returns closed on weekends", () => {
    // Saturday 11:00 ET
    expect(getMarketPhaseFromDate(new Date("2026-06-06T15:00:00Z"))).toBe("closed");
  });

  it("returns closed before 04:00 ET", () => {
    // Fri 03:59 ET
    expect(getMarketPhaseFromDate(new Date("2026-06-05T07:59:00Z"))).toBe("closed");
  });

  it("returns pre at the 04:00 ET open", () => {
    // Fri 04:00 ET
    expect(getMarketPhaseFromDate(new Date("2026-06-05T08:00:00Z"))).toBe("pre");
  });

  it("returns pre just before the 09:30 ET bell", () => {
    // Fri 09:29 ET
    expect(getMarketPhaseFromDate(new Date("2026-06-05T13:29:00Z"))).toBe("pre");
  });

  it("returns open at the 09:30 ET bell", () => {
    // Fri 09:30 ET
    expect(getMarketPhaseFromDate(new Date("2026-06-05T13:30:00Z"))).toBe("open");
  });

  it("returns open mid-session", () => {
    // Fri 14:30 ET
    expect(getMarketPhaseFromDate(new Date("2026-06-05T18:30:00Z"))).toBe("open");
  });

  it("returns open at the 16:00 ET close", () => {
    // Fri 16:00 ET
    expect(getMarketPhaseFromDate(new Date("2026-06-05T20:00:00Z"))).toBe("open");
  });

  it("returns after just past the 16:00 ET close", () => {
    // Fri 16:01 ET
    expect(getMarketPhaseFromDate(new Date("2026-06-05T20:01:00Z"))).toBe("after");
  });

  it("returns after just before 20:00 ET", () => {
    // Fri 19:59 ET
    expect(getMarketPhaseFromDate(new Date("2026-06-05T23:59:00Z"))).toBe("after");
  });

  it("returns closed just past 20:00 ET", () => {
    // Fri 20:01 ET (still Friday in ET)
    expect(getMarketPhaseFromDate(new Date("2026-06-06T00:01:00Z"))).toBe("closed");
  });
});
