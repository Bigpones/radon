import { describe, it, expect } from "vitest";
import { parseSideParam, parseStrikesParam } from "@/lib/useChainUrlState";
import { ALL_STRIKES, formatExpiry } from "@/lib/optionsChainUtils";
import { normalizeOptionExpiry } from "@/lib/pricesProtocol";

describe("chain URL filter param parsing", () => {
  describe("parseSideParam", () => {
    it("passes through calls / puts", () => {
      expect(parseSideParam("calls")).toBe("calls");
      expect(parseSideParam("puts")).toBe("puts");
    });
    it("maps absent / all / unknown to the default 'both'", () => {
      expect(parseSideParam(null)).toBe("both");
      expect(parseSideParam(undefined)).toBe("both");
      expect(parseSideParam("all")).toBe("both");
      expect(parseSideParam("garbage")).toBe("both");
      expect(parseSideParam("")).toBe("both");
    });
  });

  describe("parseStrikesParam", () => {
    it("parses allowed numeric windows", () => {
      expect(parseStrikesParam("10")).toBe(10);
      expect(parseStrikesParam("25")).toBe(25);
      expect(parseStrikesParam("50")).toBe(50);
      expect(parseStrikesParam("100")).toBe(100);
    });
    it("maps 'all' to ALL_STRIKES sentinel", () => {
      expect(parseStrikesParam("all")).toBe(ALL_STRIKES);
    });
    it("falls back to default 15 for absent / out-of-set / garbage", () => {
      expect(parseStrikesParam(null)).toBe(15);
      expect(parseStrikesParam(undefined)).toBe(15);
      expect(parseStrikesParam("7")).toBe(15); // not in the allowed set
      expect(parseStrikesParam("999")).toBe(15);
      expect(parseStrikesParam("abc")).toBe(15);
      expect(parseStrikesParam("")).toBe(15);
    });
    it("treats the literal default 15 as valid", () => {
      expect(parseStrikesParam("15")).toBe(15);
    });
  });

  describe("expiry round-trip (URL boundary conversion)", () => {
    it("normalizeOptionExpiry(formatExpiry(compact)) is identity for valid expiries", () => {
      const compact = "20260717";
      expect(formatExpiry(compact)).toBe("2026-07-17");
      expect(normalizeOptionExpiry(formatExpiry(compact))).toBe(compact);
    });
    it("normalizeOptionExpiry returns null when the de-dashed length is not 8", () => {
      // It enforces length, not digit-validity — an 8-char-after-dash-strip
      // string survives here and is rejected downstream by expirations.includes().
      expect(normalizeOptionExpiry("2026-07")).toBeNull(); // 6 chars
      expect(normalizeOptionExpiry("2026-07-177")).toBeNull(); // 9 chars
    });
  });
});
