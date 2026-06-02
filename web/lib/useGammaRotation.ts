"use client";

import { useSyncHook, type UseSyncReturn } from "./useSyncHook";
import { MarketState } from "./useMarketHours";
import { isGammaRotationStale } from "./gammaRotationStaleness";

export type GammaRotationInterpretation =
  | "TOP_WATCH"
  | "BOTTOM_WATCH"
  | "RISK_ON"
  | "RISK_OFF"
  | "DUAL_WHIP"
  | "CUSHION"
  | "NORMAL";

export type GammaRotationGate = {
  id: string;
  label: string;
  status: "PASS" | "WATCH" | "FAIL" | string;
  copy: string;
};

export type GammaRotationLevel = {
  strike: number;
  gamma: number;
  distance: number;
  distance_pct: number;
} | null;

export type GammaRotationAsset = {
  ticker: "SPY" | "TLT";
  spot: number | null;
  data_date: string;
  strike_data_date: string | null;
  net_gamma: number | null;
  net_gex: number | null;
  call_gex: number | null;
  put_gex: number | null;
  net_delta: number | null;
  gamma_z: number | null;
  gamma_1d_change: number | null;
  gamma_3d_change: number | null;
  state: "CUSHION" | "WHIP" | "NEUTRAL" | string;
  spot_vs_flip_pct: number | null;
  levels: {
    gex_flip?: GammaRotationLevel;
    max_magnet?: GammaRotationLevel;
    max_accelerator?: GammaRotationLevel;
    put_wall?: GammaRotationLevel;
    call_wall?: GammaRotationLevel;
  };
};

export type GammaRotationHistoryEntry = {
  date: string;
  spy_net_gamma: number | null;
  tlt_net_gamma: number | null;
  spy_gamma_z: number | null;
  tlt_gamma_z: number | null;
  grg_z: number | null;
  raw_spread: number | null;
  state: string;
};

export type GammaRotationData = {
  scan_time: string;
  market_open: boolean;
  data_date: string;
  source: string;
  storage: string;
  lookback_days: number;
  z_window: number;
  signal: {
    state: string;
    state_label: string;
    interpretation: GammaRotationInterpretation;
    tier: 1 | 2 | 3 | null;
    top_watch: boolean;
    bottom_watch: boolean;
    top_score: number;
    bottom_score: number;
    grg_z: number | null;
    raw_spread: number | null;
    spy_gamma_z: number | null;
    tlt_gamma_z: number | null;
    spy_3d_gamma_change: number | null;
    tlt_3d_gamma_change: number | null;
    summary: string;
  };
  assets: {
    SPY: GammaRotationAsset;
    TLT: GammaRotationAsset;
  };
  gates: GammaRotationGate[];
  history: GammaRotationHistoryEntry[];
  top_bottom: {
    top: { active: boolean; copy: string };
    bottom: { active: boolean; copy: string };
  };
};

// Delegate to the market-gated staleness lib so the 5s retry stops re-arming
// off-hours (the bare scanDate-vs-today check used to fire it every weekend).
function needsGammaRotationRetry(data: GammaRotationData | null | undefined): boolean {
  if (!data) return true;
  return isGammaRotationStale(data);
}

const GAMMA_ROTATION_SYNC_CONFIG = {
  endpoint: "/api/gamma-rotation",
  interval: 60_000,
  hasPost: true,
  extractTimestamp: (data: GammaRotationData) => data.scan_time || null,
  shouldRetry: (data: GammaRotationData) => needsGammaRotationRetry(data),
  retryIntervalMs: 5000,
  retryMethod: "GET" as const,
};

export function useGammaRotation(marketState: MarketState | null = null): UseSyncReturn<GammaRotationData> {
  const interval = marketState === MarketState.CLOSED
    ? 0
    : marketState === MarketState.EXTENDED
      ? 300_000
      : 60_000;

  return useSyncHook({ ...GAMMA_ROTATION_SYNC_CONFIG, interval }, true);
}
