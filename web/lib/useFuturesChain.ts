"use client";

import { useEffect, useState } from "react";

export interface FuturesChainContract {
  conId: number;
  symbol: string;
  localSymbol: string;
  exchange: string;
  currency: string;
  lastTradeDateOrContractMonth: string;
  multiplier: string;
  tradingClass: string;
  marketName: string;
  minTick: number;
}

export interface FuturesChainData {
  symbol: string;
  exchange: string;
  contracts: FuturesChainContract[];
  count: number;
}

interface UseFuturesChainState {
  data: FuturesChainData | null;
  loading: boolean;
  error: string | null;
}

/**
 * useFuturesChain — fetches the futures contract chain for a symbol via
 * GET /api/futures/chain. Returns sorted-by-expiry contracts so the UI
 * can render a dropdown with the front month first.
 *
 * Currently scoped to VIX (the only futures root in the resolver as of
 * Phase 2). Pass `null` to disable.
 */
export function useFuturesChain(symbol: string | null): UseFuturesChainState {
  const [state, setState] = useState<UseFuturesChainState>({
    data: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!symbol) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    fetch(`/api/futures/chain?symbol=${encodeURIComponent(symbol)}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Chain fetch failed (${res.status})`);
        }
        return res.json() as Promise<FuturesChainData>;
      })
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            data: null,
            loading: false,
            error: err instanceof Error ? err.message : "Chain fetch failed",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return state;
}
