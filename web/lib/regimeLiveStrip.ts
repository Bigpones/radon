import type { PriceData } from "./pricesProtocol";
import type { CriData, CriHistoryEntry } from "./useRegime";

type RegimeStripData = Pick<
  CriData,
  | "vix"
  | "vvix"
  | "spy"
  | "cor1m"
  | "cor1m_previous_close"
  | "cor1m_5d_change"
  | "vvix_vix_ratio"
  | "spx_100d_ma"
  | "spx_distance_pct"
> & {
  history?: Array<Pick<CriHistoryEntry, "cor1m">>;
};

type ResolveRegimeStripLiveStateInput = {
  marketOpen: boolean;
  prices: Record<string, PriceData>;
  data?: Partial<RegimeStripData> | null;
};

export type RegimeStripLiveState = {
  liveVix: number | null;
  liveVvix: number | null;
  liveSpy: number | null;
  liveCor1m: number | null;
  hasLiveVix: boolean;
  hasLiveVvix: boolean;
  hasLiveSpy: boolean;
  hasLiveCor1m: boolean;
  vixValue: number;
  vvixValue: number;
  spyValue: number;
  cor1mValue: number;
  vixClose: number | null;
  vvixClose: number | null;
  spyClose: number | null;
  cor1mPreviousClose: number | null;
  corr5dChange: number | null;
  vvixVixRatio: number;
  spxDistancePct: number;
};

export function resolveRegimeStripLiveState({
  marketOpen,
  prices,
  data,
}: ResolveRegimeStripLiveStateInput): RegimeStripLiveState {
  const liveVix = marketOpen ? (prices.VIX?.last ?? null) : null;
  const liveVvix = marketOpen ? (prices.VVIX?.last ?? null) : null;
  const liveSpy = marketOpen ? (prices.SPY?.last ?? null) : null;
  const liveCor1m = marketOpen ? (prices.COR1M?.last ?? null) : null;

  const vixClose = marketOpen ? (prices.VIX?.close ?? null) : null;
  const vvixClose = marketOpen ? (prices.VVIX?.close ?? null) : null;
  const spyClose = marketOpen ? (prices.SPY?.close ?? null) : null;

  const vixValue = liveVix ?? data?.vix ?? 0;
  const vvixValue = liveVvix ?? data?.vvix ?? 0;
  const spyValue = liveSpy ?? data?.spy ?? 0;
  const cor1mValue = liveCor1m ?? data?.cor1m ?? 0;

  const lastHistoryCor1m = data?.history && data.history.length > 0
    ? data.history[data.history.length - 1]?.cor1m ?? null
    : null;
  const cor1mPreviousClose = marketOpen
    ? data?.cor1m_previous_close ?? lastHistoryCor1m ?? null
    : null;

  const vvixVixRatio = vixValue > 0 ? vvixValue / vixValue : data?.vvix_vix_ratio ?? 0;
  const ma = data?.spx_100d_ma ?? null;
  const spxDistancePct = ma && ma > 0 ? ((spyValue / ma) - 1) * 100 : data?.spx_distance_pct ?? 0;

  return {
    liveVix,
    liveVvix,
    liveSpy,
    liveCor1m,
    hasLiveVix: liveVix != null,
    hasLiveVvix: liveVvix != null,
    hasLiveSpy: liveSpy != null,
    hasLiveCor1m: liveCor1m != null,
    vixValue,
    vvixValue,
    spyValue,
    cor1mValue,
    vixClose,
    vvixClose,
    spyClose,
    cor1mPreviousClose,
    corr5dChange: data?.cor1m_5d_change ?? null,
    vvixVixRatio,
    spxDistancePct,
  };
}
