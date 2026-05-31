"use client";

import { useEffect, useState } from "react";
import type { QuoteFallback } from "@/lib/quoteTelemetry";

/**
 * Fetches the Unusual Whales stock-state (open/high/low/close/volume/prev_close)
 * for a ticker so the quote telemetry bar has an after-hours fallback when the
 * live WS price feed is dark. Shares the 24h-TTL `/api/ticker/info` cache with
 * CompanyTab, so this adds no meaningful upstream load.
 *
 * Returns the UNDERLYING stock's last completed session — only meaningful for an
 * underlying quote box, never an option/spread quote (caller gates via `enabled`).
 */
export function useStockState(
  ticker: string | null,
  enabled = true,
): { fallback: QuoteFallback | null; loading: boolean } {
  const [fallback, setFallback] = useState<QuoteFallback | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!ticker || !enabled) {
      setFallback(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    // Wrap the call itself: a fetch that throws synchronously (e.g. a strict
    // test mock, or fetch being unavailable) must degrade to "no fallback",
    // never crash the host component's render.
    try {
      fetch(`/api/ticker/info?ticker=${encodeURIComponent(ticker)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (cancelled || !json) return;
          setFallback(toFallback(json.stock_state));
        })
        .catch(() => {
          if (!cancelled) setFallback(null);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    } catch {
      setFallback(null);
      setLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [ticker, enabled]);

  return { fallback, loading };
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : parseFloat(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Shape the raw stock_state record into a QuoteFallback; null if nothing usable. */
export function toFallback(stockState: unknown): QuoteFallback | null {
  if (!stockState || typeof stockState !== "object") return null;
  const s = stockState as Record<string, unknown>;
  const fallback: QuoteFallback = {
    open: toNumber(s.open),
    high: toNumber(s.high),
    low: toNumber(s.low),
    close: toNumber(s.close),
    volume: toNumber(s.volume ?? s.total_volume ?? s.full_day_volume),
    prevClose: toNumber(s.prev_close),
  };
  return Object.values(fallback).some((v) => v != null) ? fallback : null;
}
