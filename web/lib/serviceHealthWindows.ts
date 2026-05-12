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

/**
 * How a writer is triggered.
 *
 *  - ``scheduled``: a daemon, systemd timer, or cron fires this
 *    automatically without user interaction. Past-window silence
 *    indicates a real problem and SHOULD fire the degraded banner.
 *  - ``on-demand``: only runs when a user visits its page or POSTs to
 *    its scan endpoint. Past-window silence just means "nobody has
 *    looked at it today" and should NOT fire the degraded banner.
 *
 * The route handler uses this to coerce past-window ``on-demand`` rows
 * into the ``dormant`` state (informational) while ``scheduled`` rows
 * continue to coerce into ``stale`` (degraded).
 */
export type ServiceCategory = "scheduled" | "on-demand";

type Window = {
  open: number;
  extended: number;
  closed: number;
  category: ServiceCategory;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Per-service freshness windows in ms. Values match the spec table:
 *
 *   newsfeed-scraper     5m always
 *   orders-sync          10m open, 3d closed   (writer: scripts/ib_orders.py)
 *   portfolio-sync       10m open, 3d closed   (writer: scripts/ib_sync.py)
 *   orders-read-compare  10m open, 3d closed   (writer: web/app/api/orders/route.ts)
 *   journal-sync         10m always
 *   cash-flow-sync       25h (daily handler)
 *   fill-monitor         5m open, 1h closed
 *   exit-orders          5m open, 1h closed
 *   flex-token-check     25h (daily)
 *   cri-scan             35m open, 1d closed
 *   gex-scan             30m open, 1d closed
 *   vcg-scan             15m open, 1d closed   (5-min cadence; 3 missed cycles)
 *   cta-sync             35m open, 1d closed
 *   replica-watchdog     5m always (continuous)
 *
 * Service names MUST match the canonical writer name (no ``ib-`` prefix
 * for orders/portfolio — the writers record under ``orders-sync`` /
 * ``portfolio-sync`` directly). Mismatches silently fall through to the
 * 1h default and fire the banner overnight + on weekends.
 */
export const SERVICE_FRESHNESS_WINDOWS: Record<string, Window> = {
  "newsfeed-scraper": { open: 5 * MIN, extended: 5 * MIN, closed: 5 * MIN, category: "scheduled" },

  // Market-hours-only IB feeds. Closed-window covers the longest
  // natural gap (Fri 16:00 ET → Mon 09:30 ET ≈ 65h) so a quiet
  // weekend doesn't trip the banner.
  "orders-sync": { open: 10 * MIN, extended: 10 * MIN, closed: 3 * DAY, category: "scheduled" },
  "portfolio-sync": { open: 10 * MIN, extended: 10 * MIN, closed: 3 * DAY, category: "scheduled" },
  // ``orders-read-compare`` only runs when /api/orders is hit, so even
  // though the dashboard polls it every 60s the writer itself has no
  // autonomous trigger and is treated as on-demand for the banner.
  "orders-read-compare": { open: 10 * MIN, extended: 10 * MIN, closed: 3 * DAY, category: "on-demand" },

  "journal-sync": { open: 10 * MIN, extended: 10 * MIN, closed: 10 * MIN, category: "scheduled" },
  "cash-flow-sync": { open: 25 * HOUR, extended: 25 * HOUR, closed: 25 * HOUR, category: "scheduled" },

  "fill-monitor": { open: 5 * MIN, extended: 5 * MIN, closed: 1 * HOUR, category: "scheduled" },
  "exit-orders": { open: 5 * MIN, extended: 5 * MIN, closed: 1 * HOUR, category: "scheduled" },

  "flex-token-check": { open: 25 * HOUR, extended: 25 * HOUR, closed: 25 * HOUR, category: "scheduled" },

  "cri-scan": { open: 35 * MIN, extended: 35 * MIN, closed: 1 * DAY, category: "scheduled" },
  // ``gex-scan`` still flows through ``record_service_health`` only when
  // a user POSTs the scan endpoint, so it's on-demand for banner purposes.
  "gex-scan": { open: 30 * MIN, extended: 30 * MIN, closed: 1 * DAY, category: "on-demand" },
  // ``vcg-scan`` has an autonomous 5-min cadence during market hours
  // (radon-vcg-refresh.timer / com.radon.vcg-refresh). The 15-min open
  // window tolerates 3 missed cycles before flagging — long enough to
  // absorb transient FastAPI or IB Gateway blips, short enough to
  // surface a real outage well inside the trading day.
  "vcg-scan": { open: 15 * MIN, extended: 15 * MIN, closed: 1 * DAY, category: "scheduled" },
  // ``cta-sync`` has an autonomous Mon-Fri schedule on the VPS
  // (radon-cta-sync.timer fires 18:15, 19:00, 21:30 UTC) plus the
  // laptop launchd plist as a redundant local trigger. Stale > 25h
  // means the timer failed across both regimes; 25h tolerates a long
  // weekend (Friday 21:30 UTC → Monday 18:15 UTC ≈ 69h) plus any
  // single missed firing.
  "cta-sync": { open: 25 * HOUR, extended: 25 * HOUR, closed: 72 * HOUR, category: "scheduled" },

  // Market-hours-only writers: triggered by the FastAPI scan endpoints
  // during the trading day, dormant on nights and weekends. The
  // ``closed`` window has to be wide enough to bridge a full weekend
  // (Friday 16:00 ET → Monday 09:30 ET ≈ 65h) without flipping to
  // stale. Per-service intraday cadence varies but ≤30 min during
  // market hours catches genuine outages quickly.
  "scanner": { open: 30 * MIN, extended: 30 * MIN, closed: 3 * DAY, category: "on-demand" },
  "discover": { open: 30 * MIN, extended: 30 * MIN, closed: 3 * DAY, category: "on-demand" },
  "flow-analysis": { open: 30 * MIN, extended: 30 * MIN, closed: 3 * DAY, category: "on-demand" },
  "analyst-ratings": { open: 30 * MIN, extended: 30 * MIN, closed: 3 * DAY, category: "on-demand" },

  "replica-watchdog": { open: 5 * MIN, extended: 5 * MIN, closed: 5 * MIN, category: "scheduled" },
};

const DEFAULT_WINDOW: Window = {
  open: 1 * HOUR,
  extended: 1 * HOUR,
  closed: 1 * HOUR,
  // Default to ``scheduled`` so the banner stays honest about silent
  // daemons we forgot to register — an unrecognised writer is more
  // likely a misnamed scheduled service than a brand-new on-demand
  // surface.
  category: "scheduled",
};

/**
 * Resolve the freshness window for ``service`` under the given market
 * state. Unknown services fall back to a 1h default.
 */
export function getFreshnessWindowMs(service: string, market: MarketState): number {
  const entry = SERVICE_FRESHNESS_WINDOWS[service] ?? DEFAULT_WINDOW;
  return entry[market];
}

/**
 * Resolve the trigger-category for ``service``. Unknown services fall
 * back to ``scheduled`` — the safer default so the banner keeps
 * shouting about silent daemons we forgot to register here.
 */
export function getServiceCategory(service: string): ServiceCategory {
  const entry = SERVICE_FRESHNESS_WINDOWS[service] ?? DEFAULT_WINDOW;
  return entry.category;
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
