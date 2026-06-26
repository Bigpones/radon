/**
 * @vitest-environment node
 *
 * Bug regression — historical trades' date column rendered the previous
 * calendar day for journal rows whose `time` was a date-only ISO string
 * ("YYYY-MM-DD"). `new Date("2026-05-08").toLocaleDateString()` interprets
 * the input as UTC midnight; in any timezone west of UTC that's the
 * previous local day. Today's executed trades vanished from "today" in
 * the user's mental model.
 *
 * The fix: detect date-only input and parse the year/month/day ints as a
 * local-tz Date instead of letting the UTC default kick in.
 */
import { describe, it, expect } from "vitest";
import { formatTradeDate } from "../lib/blotter/formatTradeDate";

describe("formatTradeDate", () => {
  it("renders a date-only ISO string as the same calendar day, not the day before", () => {
    const out = formatTradeDate("2026-05-08");
    // Locale-agnostic check: the rendered output must contain day 8, not 7.
    expect(out).toMatch(/(^|\D)8(\D|$)/);
    expect(out).not.toMatch(/(^|\D)7(\D|$)/);
  });

  it("renders an ISO timestamp using its local-tz calendar day", () => {
    // Mid-day UTC stays on the same calendar day in continental US zones.
    const out = formatTradeDate("2026-05-08T17:30:00Z");
    expect(out).toMatch(/(^|\D)8(\D|$)/);
  });

  it("returns empty string for empty / null / undefined input", () => {
    expect(formatTradeDate("")).toBe("");
    expect(formatTradeDate(null)).toBe("");
    expect(formatTradeDate(undefined)).toBe("");
  });

  it("preserves date-only input across negative UTC offsets (Pacific tz repro)", () => {
    // Direct repro: build a UTC-midnight Date from the same string and
    // confirm the helper does NOT route through it. Without the fix, the
    // helper's output would equal `new Date("2026-05-08").toLocaleDateString()`,
    // which renders day 7 in any zone with offset < 0.
    const buggy = new Date("2026-05-08").toLocaleDateString();
    const fixed = formatTradeDate("2026-05-08");
    // In UTC the two will match (no shift). In a negative-offset zone they
    // must differ — and in either case `fixed` must contain day 8.
    expect(fixed).toMatch(/(^|\D)8(\D|$)/);
    if (buggy.match(/(^|\D)7(\D|$)/)) {
      // Test runner is in a negative-offset zone — the bug would reproduce
      // without the fix. Confirm the fix actually shifts the output.
      expect(fixed).not.toEqual(buggy);
    }
  });
});
