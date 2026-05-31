/**
 * Pure cache-decision helpers for the /api/ticker/info route.
 *
 * Extracted so the "don't cache empty results" invariant
 * (feedback_dont_cache_empty_results) is unit-testable without the route's
 * filesystem + network machinery. A single transient Unusual Whales / Exa
 * failure must never poison a ticker's company data for the full 24h stats
 * TTL — these helpers gate cache reuse and persistence on real payload
 * content, not just on the TTL.
 */

export type RecordMap = Record<string, unknown>;

/** True when a record actually carries data (at least one key). */
export function isPopulated(obj: RecordMap | null | undefined): boolean {
  return !!obj && Object.keys(obj).length > 0;
}

/**
 * Whether the cached `uw_info` may be reused instead of re-fetching from UW.
 *
 * Reuse requires BOTH an unexpired stats window AND a non-empty cached payload.
 * The bug this closes: gating reuse on `statsCached` alone re-served an empty
 * `{}` (from a prior UW hiccup) for 24h even while UW was healthy.
 */
export function canReuseUwInfo(cachedUwInfo: RecordMap | null | undefined, statsCached: boolean): boolean {
  return statsCached && isPopulated(cachedUwInfo);
}

/**
 * Choose the uw_info to serve/persist: prefer a freshly-fetched payload, but
 * never downgrade a populated cache to empty on a transient failure.
 */
export function pickUwInfo(
  fetched: RecordMap,
  cachedUwInfo: RecordMap | null | undefined,
): RecordMap {
  return isPopulated(fetched) ? fetched : (cachedUwInfo ?? {});
}

/**
 * Whether a ticker-info payload is worth persisting behind the 24h TTL. An
 * all-empty result (UW + Exa + stats all blank) must NOT be written — that is
 * the poisoning that strands a ticker at "---" until the window expires.
 */
export function hasAnyTickerData(uwInfo: RecordMap, exaProfile: RecordMap, exaStats: RecordMap): boolean {
  return isPopulated(uwInfo) || isPopulated(exaProfile) || isPopulated(exaStats);
}
