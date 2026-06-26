/**
 * Python writes scan_time via `datetime.now().isoformat()` on Hetzner (UTC host),
 * producing naive ISO strings like "2026-05-09T01:58:36.144211".
 *
 * JS parses naive datetime strings as **local time**, which shifts the parsed
 * instant by the user's offset and can roll the ET session date forward —
 * causing the freshness banner to show STALE the moment UTC midnight passes
 * even though it is still the same trading day in ET.
 *
 * Treat naive ISO strings as UTC; pass timezone-aware strings through unchanged.
 */

const TIMEZONE_SUFFIX = /([+-]\d{2}:?\d{2}|Z)$/;

export function parseScanTime(scanTime: string | null | undefined): Date | null {
  if (!scanTime) return null;
  const normalized = TIMEZONE_SUFFIX.test(scanTime) ? scanTime : `${scanTime}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function scanTimeToEtDate(scanTime: string | null | undefined): string | null {
  const d = parseScanTime(scanTime);
  if (!d) return null;
  return d.toLocaleDateString("sv", { timeZone: "America/New_York" });
}
