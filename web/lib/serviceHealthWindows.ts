/**
 * Per-service freshness windows for the service-health staleness gate.
 *
 * The banner is degraded when an ``ok`` row's ``updated_at`` falls outside
 * its expected refresh interval — the worker is silent, not crashed. This
 * module owns the table of expectations + the pure helpers that derive
 * "fresh / stale" without touching the DB.
 *
 * Windows are tightened during regular trading hours (9:30-16:00 ET) for
 * services whose cadence is market-hours-only; off-hours quiet on those
 * services is normal so the closed-hour window is intentionally loose.
 */

export type MarketState = "open" | "extended" | "closed";

type Window = {
  open: number;
  extended: number;
  closed: number;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Per-service freshness windows in ms. Values match the spec table:
 *
 *   newsfeed-scraper     5m always
 *   ib-orders-sync       10m open, 1d closed
 *   ib-portfolio-sync    10m open, 1d closed
 *   journal-sync         10m always
 *   cash-flow-sync       25h (daily handler)
 *   fill-monitor         5m open, 1h closed
 *   exit-orders          5m open, 1h closed
 *   flex-token-check     25h (daily)
 *   cri-scan             35m open, 1d closed
 *   gex-scan             30m open, 1d closed
 *   vcg-scan             35m open, 1d closed
 *   cta-sync             35m open, 1d closed
 *   replica-watchdog     5m always (continuous)
 */
export const SERVICE_FRESHNESS_WINDOWS: Record<string, Window> = {
  "newsfeed-scraper": { open: 5 * MIN, extended: 5 * MIN, closed: 5 * MIN },

  "ib-orders-sync": { open: 10 * MIN, extended: 10 * MIN, closed: 1 * DAY },
  "ib-portfolio-sync": { open: 10 * MIN, extended: 10 * MIN, closed: 1 * DAY },

  "journal-sync": { open: 10 * MIN, extended: 10 * MIN, closed: 10 * MIN },
  "cash-flow-sync": { open: 25 * HOUR, extended: 25 * HOUR, closed: 25 * HOUR },

  "fill-monitor": { open: 5 * MIN, extended: 5 * MIN, closed: 1 * HOUR },
  "exit-orders": { open: 5 * MIN, extended: 5 * MIN, closed: 1 * HOUR },

  "flex-token-check": { open: 25 * HOUR, extended: 25 * HOUR, closed: 25 * HOUR },

  "cri-scan": { open: 35 * MIN, extended: 35 * MIN, closed: 1 * DAY },
  "gex-scan": { open: 30 * MIN, extended: 30 * MIN, closed: 1 * DAY },
  "vcg-scan": { open: 35 * MIN, extended: 35 * MIN, closed: 1 * DAY },
  "cta-sync": { open: 35 * MIN, extended: 35 * MIN, closed: 1 * DAY },

  // Market-hours-only writers: triggered by the FastAPI scan endpoints
  // during the trading day, dormant on nights and weekends. The
  // ``closed`` window has to be wide enough to bridge a full weekend
  // (Friday 16:00 ET → Monday 09:30 ET ≈ 65h) without flipping to
  // stale. Per-service intraday cadence varies but ≤30 min during
  // market hours catches genuine outages quickly.
  "scanner": { open: 30 * MIN, extended: 30 * MIN, closed: 3 * DAY },
  "discover": { open: 30 * MIN, extended: 30 * MIN, closed: 3 * DAY },
  "flow-analysis": { open: 30 * MIN, extended: 30 * MIN, closed: 3 * DAY },
  "analyst-ratings": { open: 30 * MIN, extended: 30 * MIN, closed: 3 * DAY },

  "replica-watchdog": { open: 5 * MIN, extended: 5 * MIN, closed: 5 * MIN },
};

const DEFAULT_WINDOW: Window = { open: 1 * HOUR, extended: 1 * HOUR, closed: 1 * HOUR };

/**
 * Resolve the freshness window for ``service`` under the given market
 * state. Unknown services fall back to a 1h default.
 */
export function getFreshnessWindowMs(service: string, market: MarketState): number {
  const entry = SERVICE_FRESHNESS_WINDOWS[service] ?? DEFAULT_WINDOW;
  return entry[market];
}

/**
 * True when ``updatedAt`` is past ``service``'s freshness window. Garbage
 * or missing timestamps are treated as stale — the worker hasn't proven
 * itself live, so it shouldn't be assumed live.
 */
export function isStale(
  service: string,
  updatedAt: string | null | undefined,
  market: MarketState,
  nowMs: number = Date.now(),
): boolean {
  if (!updatedAt) return true;
  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) return true;
  const window = getFreshnessWindowMs(service, market);
  return nowMs - ts > window;
}

/**
 * Server-side market-state derivation, mirrored from
 * web/lib/useMarketHours.ts but pure (no React, no setInterval).
 *
 * Returns the current MarketState in America/New_York. Holidays are
 * ignored — they're rare (~10/yr) and not worth a calendar dependency.
 */
export function getMarketStateFromDate(now: Date = new Date()): MarketState {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return "closed";

  const minutes = et.getHours() * 60 + et.getMinutes();
  if (minutes >= 9 * 60 + 30 && minutes <= 16 * 60) return "open";
  if (
    (minutes >= 4 * 60 && minutes < 9 * 60 + 30) ||
    (minutes > 16 * 60 && minutes <= 20 * 60)
  ) {
    return "extended";
  }
  return "closed";
}
