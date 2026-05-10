"use client";

import { useEffect, useState } from "react";

export type ServiceHealthRow = {
  service: string;
  state: string;
  last_attempt_started_at: string | null;
  last_attempt_finished_at: string | null;
  /**
   * Raw JSON payload from ``service_health.last_error``. Diagnostic only
   * — UIs should render ``error_summary`` to stay clear of leaked JSON
   * structure.
   */
  last_error: string | null;
  /**
   * Pre-normalized single-line summary, populated by the route handler
   * via ``formatServiceHealthError``. ``null`` only when ``last_error``
   * itself is ``null``.
   */
  error_summary?: string | null;
  updated_at: string;
};

export type ServiceHealthResponse = {
  services: ServiceHealthRow[];
  failing: ServiceHealthRow[];
  summary: { total: number; failing_count: number };
  warning?: string;
};

const POLL_MS = 60_000;

export function useServiceHealth(): {
  data: ServiceHealthResponse | null;
  loading: boolean;
} {
  const [data, setData] = useState<ServiceHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const res = await fetch("/api/service-health", {
          method: "GET",
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = (await res.json()) as ServiceHealthResponse;
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchOnce();
    const id = window.setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return { data, loading };
}
