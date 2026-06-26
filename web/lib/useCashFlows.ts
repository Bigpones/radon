"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CashFlowType =
  | "Deposit"
  | "Withdrawal"
  | "Dividend"
  | "Interest"
  | "Fee"
  | "WithholdingTax"
  | "Other";

export interface CashFlowRow {
  id: string;
  date: string;
  type: CashFlowType;
  amount: number;
  currency: string;
  description: string | null;
  raw_type: string | null;
  synced_at: string;
}

export interface CashFlowSummary {
  deposits: number;
  withdrawals: number;
  dividends: number;
  net: number;
}

// Surface of the cash_flow_sync daemon's most recent attempt — used by
// the lozenge to explain WHY a synced-Xh-ago reading is stale. Most
// common cause: IBKR Flex throttle code 1001 ("Statement could not be
// generated"). See feedback_flex_cash_transaction_lag.md.
export interface CashFlowSyncStatus {
  state: "ok" | "error" | "stale" | "unknown";
  /** Daemon's last try, success OR failure (vs last_synced_at = last success). */
  last_attempt_at?: string | null;
  /** When the daemon will retry — populated when in throttle / soft-fail embargo. */
  next_attempt_at?: string | null;
  /** Short human-readable failure tag — e.g. "Flex throttled by IBKR". */
  error_summary?: string | null;
  /** True when the failure matches a Flex throttle code (1001/1018/1019). */
  is_throttled?: boolean;
}

export interface CashFlowResponse {
  rows: CashFlowRow[];
  count: number;
  from_date: string;
  summary: CashFlowSummary | null;
  // Most-recent `synced_at` across the rows returned by FastAPI. The UI
  // uses this to render a "Synced Xh ago" lozenge that explains the
  // IBKR Flex T+1 publication cadence. Null when no rows are present.
  last_synced_at?: string | null;
  sync_status?: CashFlowSyncStatus | null;
  db_error?: string | null;
}

const POLL_INTERVAL_MS = 5 * 60_000;

interface UseCashFlowsReturn {
  data: CashFlowResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useCashFlows(days: number = 90, types: string = ""): UseCashFlowsReturn {
  const [data, setData] = useState<CashFlowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const fetchOnce = useCallback(async () => {
    const myId = ++reqIdRef.current;
    try {
      const res = await fetch(
        `/api/cash-flows?days=${days}&types=${encodeURIComponent(types)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`Failed to fetch cash flows (HTTP ${res.status})`);
      const json = (await res.json()) as CashFlowResponse;
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
  }, [days, types]);

  useEffect(() => {
    setLoading(true);
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchOnce]);

  return { data, loading, error, refresh: fetchOnce };
}
