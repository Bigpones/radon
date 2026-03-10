"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

type UseSyncConfig<T> = {
  endpoint: string;
  interval?: number;
  hasPost?: boolean; // default true; false = GET-only polling
  extractTimestamp?: (data: T) => string | null;
};

export type UseSyncReturn<T> = {
  data: T | null;
  loading: boolean;
  syncing: boolean;
  error: string | null;
  lastSync: string | null;
  syncNow: () => void;
};

export function useSyncHook<T>(config: UseSyncConfig<T>, active: boolean): UseSyncReturn<T> {
  const { endpoint, interval = DEFAULT_INTERVAL_MS, hasPost = true, extractTimestamp } = config;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const didInitialSync = useRef(false);

  const triggerSync = useCallback(async () => {
    setSyncing(true);
    try {
      const method = hasPost ? "POST" : "GET";
      const res = await fetch(endpoint, { method });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Sync failed (${res.status})`);
      }
      const json = (await res.json()) as T;
      setData(json);
      setLastSync(extractTimestamp ? extractTimestamp(json) : new Date().toISOString());
      setError(null);
    } catch (err) {
      // Only show error if we don't already have valid cached data —
      // a failed background sync shouldn't clobber a working display
      setData((prev) => {
        if (!prev) setError(err instanceof Error ? err.message : "Sync failed");
        return prev;
      });
    } finally {
      setSyncing(false);
    }
  }, [endpoint, hasPost, extractTimestamp]);

  // Initial fetch — read cached file, auto-sync if stale
  useEffect(() => {
    if (!active) return;

    const init = async () => {
      try {
        const res = await fetch(endpoint);
        if (!res.ok) throw new Error("Failed to fetch cached data");
        const json = (await res.json()) as T;
        setData(json);
        setLastSync(extractTimestamp ? extractTimestamp(json) : null);
        setError(null);
        setLoading(false);

        // Auto-sync on first load
        if (!didInitialSync.current) {
          didInitialSync.current = true;
          void triggerSync();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setLoading(false);
        if (!didInitialSync.current) {
          didInitialSync.current = true;
          void triggerSync();
        }
      }
    };

    void init();
  }, [active, endpoint, triggerSync, extractTimestamp]);

  // Auto-sync interval (only when active)
  useEffect(() => {
    if (!active) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      void triggerSync();
    }, interval);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [active, interval, triggerSync]);

  const syncNow = useCallback(() => {
    void triggerSync();
  }, [triggerSync]);

  return { data, loading, syncing, error, lastSync, syncNow };
}
