"use client";

import { useMemo } from "react";
import { useSyncHook, type UseSyncReturn } from "./useSyncHook";
import type { LeapData } from "./types";

/**
 * useLeap — read-only hook for the LEAP IV-mispricing scan. Mirrors
 * useScanner. Triggering a fresh scan is intentionally not exposed yet;
 * the route is GET-only until a scheduled job or FastAPI bridge lands.
 */
const config = {
  endpoint: "/api/leap",
  extractTimestamp: (d: LeapData) => d.scan_time || null,
};

export function useLeap(active: boolean): UseSyncReturn<LeapData> {
  const stableConfig = useMemo(() => config, []);
  return useSyncHook<LeapData>(stableConfig, active);
}
