const ET_TIME_ZONE = "America/New_York";
const MARKET_CLOSE_MINUTES = 16 * 60;

export type CtaStaleReason = "fresh" | "behind_target" | "missing_cache";

export interface CtaCacheMeta {
  last_refresh: string | null;
  age_seconds: number | null;
  is_stale: boolean;
  stale_threshold_seconds: number | null;
  target_date: string;
  expected_date?: string | null;
  latest_cache_date: string | null;
  latest_available_date?: string | null;
  stale_reason: CtaStaleReason;
}

function toEtDate(now: Date): Date {
  return new Date(now.toLocaleString("en-US", { timeZone: ET_TIME_ZONE }));
}

function formatEtDate(value: Date): string {
  return value.toLocaleDateString("sv", { timeZone: ET_TIME_ZONE });
}

function isTradingWeekday(value: Date): boolean {
  const day = value.getDay();
  return day !== 0 && day !== 6;
}

export function latestClosedTradingDayET(now: Date = new Date()): string {
  const et = toEtDate(now);
  const candidate = new Date(et);
  const minutes = candidate.getHours() * 60 + candidate.getMinutes();

  if (!(isTradingWeekday(candidate) && minutes >= MARKET_CLOSE_MINUTES)) {
    candidate.setDate(candidate.getDate() - 1);
  }

  while (!isTradingWeekday(candidate)) {
    candidate.setDate(candidate.getDate() - 1);
  }

  return formatEtDate(candidate);
}

export function buildCtaCacheMeta(params: {
  targetDate: string;
  latestCacheDate: string | null;
  mtimeMs: number | null;
}): CtaCacheMeta {
  const { targetDate, latestCacheDate, mtimeMs } = params;
  const ageSeconds = typeof mtimeMs === "number" ? Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000)) : null;
  const isStale = !latestCacheDate || latestCacheDate !== targetDate;
  const staleReason: CtaStaleReason = !latestCacheDate
    ? "missing_cache"
    : latestCacheDate === targetDate
      ? "fresh"
      : "behind_target";

  return {
    last_refresh: typeof mtimeMs === "number" ? new Date(mtimeMs).toISOString() : null,
    age_seconds: ageSeconds,
    is_stale: isStale,
    stale_threshold_seconds: null,
    target_date: targetDate,
    latest_cache_date: latestCacheDate,
    stale_reason: staleReason,
  };
}
