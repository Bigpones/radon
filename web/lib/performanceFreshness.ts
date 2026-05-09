import { scanTimeToEtDate } from "./parseScanTime";

type PerformanceFreshness = {
  as_of?: string | null;
  last_sync?: string | null;
} | null | undefined;

const ET_TIME_ZONE = "America/New_York";

/**
 * `last_sync` is a wall-clock timestamp produced by `scripts/ib_sync.py`.
 * On Hetzner (UTC host) older builds wrote `datetime.now().isoformat()` —
 * a naive ISO string. Naive slicing of those strings rolls the ET session
 * date forward the moment UTC midnight passes (~20:00 ET), even though
 * it is still the same trading day in ET.
 *
 * Treat naive strings as UTC and convert to the ET calendar day so the
 * portfolio freshness gate matches the trading session a human would.
 */
export function portfolioAsOfFromLastSync(lastSync: string | null | undefined): string | null {
  if (!lastSync || lastSync.length < 10) return null;
  return scanTimeToEtDate(lastSync);
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

export function latestPortfolioTargetDateET(now: Date = new Date()): string {
  const candidate = toEtDate(now);

  while (!isTradingWeekday(candidate)) {
    candidate.setDate(candidate.getDate() - 1);
  }

  return formatEtDate(candidate);
}

export function isPortfolioBehindCurrentEtSession(
  portfolioLastSync: string | null | undefined,
  targetDate: string = latestPortfolioTargetDateET(),
): boolean {
  const portfolioAsOf = portfolioAsOfFromLastSync(portfolioLastSync);
  return portfolioAsOf !== null && portfolioAsOf < targetDate;
}

export function isPerformanceBehindPortfolioSync(
  performance: PerformanceFreshness,
  portfolioLastSync: string | null | undefined,
): boolean {
  const portfolioAsOf = portfolioAsOfFromLastSync(portfolioLastSync);
  if (!portfolioLastSync || !portfolioAsOf || !performance) return false;

  const performanceLastSync = performance.last_sync ?? null;
  const performanceAsOf = performance.as_of ?? null;

  return performanceLastSync !== portfolioLastSync || performanceAsOf !== portfolioAsOf;
}
