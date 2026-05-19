"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Per-day row of the Radon LLM Token Expenditure Index.
 *
 * `index_value` is normalised: 1.0 on the first persisted day, then
 * `raw_today / raw_base` thereafter. `raw_avg_usd` is the pre-normalize
 * weighted median in USD per million tokens — kept on the wire for
 * sanity-checking + future re-derivation.
 */
export interface LlmTokenIndexRow {
  date: string;
  index_value: number;
  raw_avg_usd: number;
  methodology_version: number;
}

export interface LlmTokenIndexResponse {
  rows: LlmTokenIndexRow[];
  count: number;
  days: number;
  fetched_at?: string;
  error?: string;
}

/** Poll every 5 min — backend timer updates once/day so anything faster
 *  just consumes Turso bandwidth without surfacing fresher data. */
const POLL_INTERVAL_MS = 5 * 60_000;

interface UseLlmTokenIndexReturn {
  data: LlmTokenIndexResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useLlmTokenIndex(days: number = 180): UseLlmTokenIndexReturn {
  const [data, setData] = useState<LlmTokenIndexResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const fetchOnce = useCallback(async () => {
    const myId = ++reqIdRef.current;
    try {
      const res = await fetch(`/api/llm-token-index?days=${days}`, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Failed to fetch LLM token index (HTTP ${res.status})`);
      }
      const json = (await res.json()) as LlmTokenIndexResponse;
      if (reqIdRef.current === myId) {
        setData(json);
        setError(null);
      }
    } catch (err) {
      if (reqIdRef.current === myId) {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    } finally {
      if (reqIdRef.current === myId) setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    setLoading(true);
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchOnce]);

  return { data, loading, error, refresh: fetchOnce };
}
