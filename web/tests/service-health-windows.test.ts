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
  getServiceCategory,
  isStale,
  type MarketState,
  type ServiceCategory,
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
    expect(closed).toBe(3 * 24 * 60 * 60_000); // 3 days closed (covers Fri close → Mon open)
  });

  it("collapses `extended` to `closed` for market-hours-only writers", () => {
    // pre-market (04:00-09:30 ET) + after-hours (16:00-20:00 ET) map to
    // MarketState=`extended`. fill-monitor, exit-orders, journal-sync,
    // orders-sync, portfolio-sync don't run in extended hours — the
    // monitor daemon gates them on `requires_market_hours=True`. So
    // the `extended` window must match `closed`, or the banner falsely
    // flags them every weekday morning between 04:00 and 09:30 ET.
    // Surfaced 2026-05-15 as a pre-market false-degraded banner.
    const services = [
      "orders-sync",
      "portfolio-sync",
      "journal-sync",
      "fill-monitor",
      "exit-orders",
      "orders-read-compare",
    ];
    for (const service of services) {
      const extended = getFreshnessWindowMs(service, "extended");
      const closed = getFreshnessWindowMs(service, "closed");
      expect(extended).toBe(closed);
    }
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

/**
 * Regression: scanner / discover / flow-analysis / analyst-ratings are
 * market-hours-only writers — they only run during 9:30-16:00 ET on
 * weekdays. Off-hours quiet on those services is normal, so the
 * ``closed`` window must be wide enough to cover a weekend (~3 days)
 * without flipping them to ``stale`` and firing the banner.
 *
 * 2026-05-09 incident: all four flipped to stale on a Saturday, even
 * though they had a clean Friday-afternoon finish, because they were
 * not in the windows table and fell back to the 1h default.
 */
describe("market-hours-only services (weekend-aware closed window)", () => {
  const SAT_NOON = Date.parse("2026-05-09T16:00:00Z"); // Sat noon ET-ish
  const FRI_4PM = Date.parse("2026-05-08T20:00:00Z"); // Fri 4 PM ET, last finish

  const friFinish = new Date(FRI_4PM).toISOString();

  it.each([
    "scanner",
    "discover",
    "flow-analysis",
    "analyst-ratings",
  ])("%s: a Friday-4PM finish does not flip to stale by Saturday noon", (service) => {
    expect(isStale(service, friFinish, "closed", SAT_NOON)).toBe(false);
  });

  it.each([
    "scanner",
    "discover",
    "flow-analysis",
    "analyst-ratings",
  ])("%s: still fires fast during market hours (≤30 min)", (service) => {
    const NOW = Date.parse("2026-05-08T18:00:00Z"); // Fri 2 PM ET
    const sixtyMinAgo = new Date(NOW - 60 * 60_000).toISOString();
    expect(isStale(service, sixtyMinAgo, "open", NOW)).toBe(true);
  });
});

/**
 * Regression: the windows table keyed orders / portfolio writers as
 * ``ib-orders-sync`` / ``ib-portfolio-sync`` but the actual writers
 * (scripts/ib_orders.py, scripts/ib_sync.py) record under
 * ``orders-sync`` / ``portfolio-sync`` (no ``ib-`` prefix). The
 * mismatch silently demoted both to the 1h default and fired the
 * banner overnight + on weekends.
 *
 * Also: ``orders-read-compare`` (web/app/api/orders/route.ts) was
 * never in the table at all — same problem.
 *
 * All three are market-hours-only signals — same closed window as
 * the cri/gex/vcg/cta family.
 */
describe("DB-name aligned writers (orders-sync / portfolio-sync / orders-read-compare)", () => {
  const SAT_NOON = Date.parse("2026-05-09T16:00:00Z");
  const FRI_4PM = Date.parse("2026-05-08T20:00:00Z");
  const friFinish = new Date(FRI_4PM).toISOString();

  it.each([
    "orders-sync",
    "portfolio-sync",
    "orders-read-compare",
  ])("%s: a Friday-4PM finish does not flip to stale by Saturday noon", (service) => {
    expect(isStale(service, friFinish, "closed", SAT_NOON)).toBe(false);
  });

  it.each([
    "orders-sync",
    "portfolio-sync",
    "orders-read-compare",
  ])("%s: still fires fast during market hours", (service) => {
    const NOW = Date.parse("2026-05-08T18:00:00Z"); // Fri 2 PM ET
    const sixtyMinAgo = new Date(NOW - 60 * 60_000).toISOString();
    expect(isStale(service, sixtyMinAgo, "open", NOW)).toBe(true);
  });
});

/**
 * Each entry in SERVICE_FRESHNESS_WINDOWS now carries a ``category``
 * field so the banner can distinguish:
 *
 *  - ``scheduled``: a daemon/timer/cron fires this without user action.
 *    Past-window silence is a real problem and SHOULD fire the banner.
 *  - ``on-demand``: only runs when a user visits its page or POSTs to
 *    its scan endpoint. Past-window silence means "you haven't looked
 *    at it today" and should NOT fire the banner.
 */
describe("SERVICE_FRESHNESS_WINDOWS — category field", () => {
  it("every entry declares a category", () => {
    for (const [service, entry] of Object.entries(SERVICE_FRESHNESS_WINDOWS)) {
      expect(
        entry.category,
        `service ${service} is missing the category field`,
      ).toBeDefined();
      expect(["scheduled", "on-demand"]).toContain(entry.category);
    }
  });

  it.each<[string, ServiceCategory]>([
    ["newsfeed-scraper", "scheduled"],
    ["journal-sync", "scheduled"],
    ["cash-flow-sync", "scheduled"],
    ["fill-monitor", "scheduled"],
    ["exit-orders", "scheduled"],
    ["flex-token-check", "scheduled"],
    ["cri-scan", "scheduled"],
    ["vcg-scan", "scheduled"],
    ["replica-watchdog", "scheduled"],
    ["orders-sync", "scheduled"],
    ["portfolio-sync", "scheduled"],
    ["scanner", "on-demand"],
    ["discover", "on-demand"],
    ["flow-analysis", "on-demand"],
    ["analyst-ratings", "on-demand"],
    ["gex-scan", "on-demand"],
    // cta-sync is scheduled by radon-cta-sync.timer on Hetzner — flipped
    // from on-demand when the autonomous timer landed.
    ["cta-sync", "scheduled"],
    ["watchdog-alerts", "scheduled"],
    ["orders-read-compare", "on-demand"],
  ])("%s is categorized as %s", (service, expected) => {
    expect(SERVICE_FRESHNESS_WINDOWS[service]?.category).toBe(expected);
  });
});

describe("getServiceCategory", () => {
  it("returns the configured category for a known scheduled service", () => {
    expect(getServiceCategory("newsfeed-scraper")).toBe("scheduled");
  });

  it("returns the configured category for a known on-demand service", () => {
    expect(getServiceCategory("scanner")).toBe("on-demand");
  });

  it("treats unknown services as scheduled (fail loud, not quiet)", () => {
    // An unrecognised writer is more likely to be a misnamed scheduled
    // service we forgot to register than a genuinely new on-demand
    // surface — defaulting to ``scheduled`` keeps the banner honest
    // about silent daemons.
    expect(getServiceCategory("brand-new-handler")).toBe("scheduled");
  });
});
