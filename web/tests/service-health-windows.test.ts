/**
 * @vitest-environment node
 *
 * Tests for the per-service freshness window helpers — keys the banner
 * uses to coerce stale ``ok`` rows into a ``stale`` state.
 */
import { describe, it, expect } from "vitest";

import {
  SERVICE_FRESHNESS_WINDOWS,
  getFreshnessWindowMs,
  isStale,
  type MarketState,
} from "../lib/serviceHealthWindows";

describe("SERVICE_FRESHNESS_WINDOWS", () => {
  it("declares a single canonical map keyed by kebab-case service name", () => {
    expect(SERVICE_FRESHNESS_WINDOWS).toBeTypeOf("object");
    // Spot-check the names called out in the spec.
    expect(SERVICE_FRESHNESS_WINDOWS["newsfeed-scraper"]).toBeDefined();
    expect(SERVICE_FRESHNESS_WINDOWS["fill-monitor"]).toBeDefined();
    expect(SERVICE_FRESHNESS_WINDOWS["cash-flow-sync"]).toBeDefined();
    expect(SERVICE_FRESHNESS_WINDOWS["replica-watchdog"]).toBeDefined();
  });

  it("uses identical windows for market-aware services regardless of state when not market-gated", () => {
    // newsfeed-scraper has no market dependency — single window.
    const open = getFreshnessWindowMs("newsfeed-scraper", "open");
    const closed = getFreshnessWindowMs("newsfeed-scraper", "closed");
    expect(open).toBe(closed);
    expect(open).toBe(5 * 60_000); // 5 minutes
  });

  it("uses tighter windows during market hours for market-aware services", () => {
    const open = getFreshnessWindowMs("fill-monitor", "open");
    const closed = getFreshnessWindowMs("fill-monitor", "closed");
    expect(open).toBeLessThan(closed);
    expect(open).toBe(5 * 60_000); // 5 min open
    expect(closed).toBe(60 * 60_000); // 1h closed
  });

  it("falls back to a 1h default for unknown service names", () => {
    expect(getFreshnessWindowMs("does-not-exist", "open")).toBe(60 * 60_000);
    expect(getFreshnessWindowMs("does-not-exist", "closed")).toBe(60 * 60_000);
  });
});

describe("isStale", () => {
  const NOW = Date.parse("2026-05-09T16:00:00Z");

  it("returns false when updated_at is within the window", () => {
    const updated = new Date(NOW - 60_000).toISOString(); // 1 min ago
    expect(isStale("newsfeed-scraper", updated, "open", NOW)).toBe(false);
  });

  it("returns true when updated_at is older than the window", () => {
    const updated = new Date(NOW - 10 * 60_000).toISOString(); // 10 min ago
    expect(isStale("newsfeed-scraper", updated, "open", NOW)).toBe(true);
  });

  it("respects market-aware window expansion (closed market = looser)", () => {
    const tenMinAgo = new Date(NOW - 10 * 60_000).toISOString();
    // fill-monitor: 5 min during open → STALE; 1h closed → FRESH
    expect(isStale("fill-monitor", tenMinAgo, "open", NOW)).toBe(true);
    expect(isStale("fill-monitor", tenMinAgo, "closed", NOW)).toBe(false);
  });

  it("treats null/empty/garbage updated_at as stale", () => {
    expect(isStale("fill-monitor", null, "open", NOW)).toBe(true);
    expect(isStale("fill-monitor", "", "open", NOW)).toBe(true);
    expect(isStale("fill-monitor", "not-a-date", "open", NOW)).toBe(true);
  });

  it("uses the 1h default for unknown services", () => {
    const fortyFiveMinAgo = new Date(NOW - 45 * 60_000).toISOString();
    expect(isStale("does-not-exist", fortyFiveMinAgo, "open", NOW)).toBe(false);
    const seventyMinAgo = new Date(NOW - 70 * 60_000).toISOString();
    expect(isStale("does-not-exist", seventyMinAgo, "open", NOW)).toBe(true);
  });

  it("type-checks MarketState union", () => {
    const states: MarketState[] = ["open", "extended", "closed"];
    expect(states).toHaveLength(3);
  });
});
