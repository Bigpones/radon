"use client";

import { useEffect, useState } from "react";

export interface IndexOptionContract {
  conId: number;
  symbol: string;
  localSymbol: string;
  exchange: string;
  currency: string;
  lastTradeDateOrContractMonth: string;
  strike: number;
  right: "C" | "P";
  multiplier: string;
  tradingClass: string;
  minTick: number;
}

export interface IndexOptionsChainData {
  symbol: string;
  exchange: string;
  tradingClass: string;
  expirations: string[];
  contracts: IndexOptionContract[];
  count: number;
}

interface UseChainState {
  data: IndexOptionsChainData | null;
  loading: boolean;
  error: string | null;
}

/**
 * useIndexOptionsChain — fetches the listed index option contracts via
 * GET /api/index-options/chain. Pass `expiry` to scope the fetch to a
 * single expiry (much faster — ~50 contracts vs 1000+).
 *
 * Returns the full expirations list separately so the form can render
 * an expiry dropdown before scoping the strike/right cascade.
 */
export function useIndexOptionsChain(
  symbol: string | null,
  expiry: string | null,
): UseChainState {
  const [state, setState] = useState<UseChainState>({
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

    const params = new URLSearchParams({ symbol });
    if (expiry) params.set("expiry", expiry);

    fetch(`/api/index-options/chain?${params.toString()}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Chain fetch failed (${res.status})`);
        }
        return res.json() as Promise<IndexOptionsChainData>;
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
  }, [symbol, expiry]);

  return state;
}
