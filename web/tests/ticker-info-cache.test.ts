import { describe, it, expect } from "vitest";
import {
  canReuseUwInfo,
  hasAnyTickerData,
  isPopulated,
  pickUwInfo,
} from "../lib/tickerInfoCache";

const UW = { marketcap: "83039192045", beta: "3.31" };

describe("tickerInfoCache — don't cache empty results", () => {
  describe("isPopulated", () => {
    it("is false for empty / null / undefined", () => {
      expect(isPopulated({})).toBe(false);
      expect(isPopulated(null)).toBe(false);
      expect(isPopulated(undefined)).toBe(false);
    });
    it("is true once any key is present", () => {
      expect(isPopulated(UW)).toBe(true);
    });
  });

  describe("canReuseUwInfo", () => {
    it("REFUSES to reuse an empty cached uw_info even inside the stats TTL (the RKLB bug)", () => {
      // statsCached=true (Exa 24h window alive) but uw_info was poisoned to {}
      expect(canReuseUwInfo({}, true)).toBe(false);
    });
    it("reuses a populated cached uw_info inside the stats TTL", () => {
      expect(canReuseUwInfo(UW, true)).toBe(true);
    });
    it("never reuses once the stats TTL has expired", () => {
      expect(canReuseUwInfo(UW, false)).toBe(false);
    });
  });

  describe("pickUwInfo", () => {
    it("prefers a freshly-fetched payload", () => {
      expect(pickUwInfo(UW, {})).toEqual(UW);
    });
    it("falls back to the last-good cache when the fetch came back empty", () => {
      expect(pickUwInfo({}, UW)).toEqual(UW);
    });
    it("returns {} when neither fetch nor cache has data", () => {
      expect(pickUwInfo({}, null)).toEqual({});
    });
  });

  describe("hasAnyTickerData", () => {
    it("is false only when UW + profile + stats are all empty", () => {
      expect(hasAnyTickerData({}, {}, {})).toBe(false);
    });
    it("is true when any single source has data (e.g. only the Yahoo 52W backfill)", () => {
      expect(hasAnyTickerData({}, {}, { week_52_high: 151 })).toBe(true);
      expect(hasAnyTickerData(UW, {}, {})).toBe(true);
    });
  });
});
