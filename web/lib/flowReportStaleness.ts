/**
 * Staleness logic for per-ticker flow reports.
 *
 * A flow report is considered fresh while the market is open if it was
 * generated within the TTL. After hours, an EOD report from the current
 * trading day is considered fresh until the next session.
 *
 * Mirrors the pattern used by `gexStaleness.ts` and `vcgStaleness.ts`.
 */

const MARKET_HOURS_TTL_MS = 10 * 60 * 1000; // 10 minutes
const AFTER_HOURS_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export type FlowReportLike = {
  fetched_at?: string | null;
  analysis_time?: string | null;
  cache_meta?: {
    last_refresh?: string | null;
    age_seconds?: number | null;
  } | null;
};

export function flowReportTimestamp(report: FlowReportLike | null | undefined): string | null {
  if (!report) return null;
  return (
    report.fetched_at
    ?? report.analysis_time
    ?? report.cache_meta?.last_refresh
    ?? null
  );
}

function isMarketOpenNow(now: Date = new Date()): boolean {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

/**
 * @param report - parsed flow report
 * @param now - injectable clock for testing
 * @param marketOpenOverride - injectable market state for testing
 */
export function isFlowReportStale(
  report: FlowReportLike | null | undefined,
  now: Date = new Date(),
  marketOpenOverride?: boolean,
): boolean {
  const ts = flowReportTimestamp(report);
  if (!ts) return true;

  const timestamp = Date.parse(ts);
  if (Number.isNaN(timestamp)) return true;

  const ageMs = now.getTime() - timestamp;
  if (ageMs < 0) return false;

  const marketOpen = marketOpenOverride ?? isMarketOpenNow(now);
  const ttl = marketOpen ? MARKET_HOURS_TTL_MS : AFTER_HOURS_TTL_MS;
  return ageMs > ttl;
}

export const FLOW_REPORT_STALENESS = {
  MARKET_HOURS_TTL_MS,
  AFTER_HOURS_TTL_MS,
};
