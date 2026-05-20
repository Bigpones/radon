"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@clerk/nextjs";
import { createReconnectStrategy, type ReconnectState } from "./reconnectStrategy";

/* ─── Types ───────────────────────────────────────────── */

export type ConnectionState = "connected" | "ib_offline" | "relay_offline";

/** Authoritative IB auth state from FastAPI /health.ib_gateway.auth_state.
 *  Mirrors scripts/api/ib_gateway.py auth-state machine. */
export type IBAuthState =
  | "authenticated"
  | "awaiting_2fa"
  | "unreachable"
  | "unknown"
  | "remote";

/** Authoritative IB service state from FastAPI /health.ib_gateway.service_state. */
export type IBServiceState = "healthy" | "unhealthy" | "starting" | "unknown";

/** Display-level status the footer/banner derive from the combined signal.
 *  Single source of truth so footer (sidebar) and banner (ConnectionBanner)
 *  never disagree again. Resolution priority (highest first):
 *    relay_offline > unreachable > awaiting_2fa > unhealthy > ib_offline > connected
 */
export type IBDisplayStatus =
  | "connected"
  | "awaiting_2fa"
  | "unhealthy"
  | "unreachable"
  | "ib_offline"
  | "relay_offline";

export type IBStatusState = {
  /** WebSocket to our realtime server is open */
  wsConnected: boolean;
  /** IB Gateway is connected (reported by relay WS) — DO NOT trust this for
   *  UI labels; the WS flag derives from the relay's long-held ib_insync
   *  socket which can stay "connected" while IB Gateway is actually sitting
   *  at the 2FA prompt (half-open socket, TCP alive but API mute). The
   *  authoritative signal is `authState` below, polled from FastAPI /health
   *  which checks Docker container health, pool client managed_accounts,
   *  and ibc auth_state. */
  ibConnected: boolean;
  /** Timestamp when connection was lost (null = connected) */
  disconnectedSince: number | null;
  /** Derived three-state legacy connection status (WS+ibConnected). Kept
   *  for ConnectionBanner backward-compat. New consumers should read
   *  `displayStatus` instead. */
  connectionState: ConnectionState;
  /** Authoritative IB auth state from FastAPI /health. */
  authState: IBAuthState | null;
  /** Authoritative IB service state from FastAPI /health. */
  serviceState: IBServiceState | null;
  /** True when FastAPI cannot reach IB Gateway (port closed or API mute). */
  upstreamDead: boolean | null;
  /** Single derived label for the footer / banner. */
  displayStatus: IBDisplayStatus;
};

type StatusMessage = {
  type: "status";
  ib_connected: boolean;
};

type PingMessage = {
  type: "ping";
};

/* ─── Context ─────────────────────────────────────────── */

const IBStatusContext = createContext<IBStatusState>({
  wsConnected: false,
  ibConnected: false,
  disconnectedSince: null,
  connectionState: "relay_offline",
  authState: null,
  serviceState: null,
  upstreamDead: null,
  displayStatus: "relay_offline",
});

/* ─── Staleness constants ─────────────────────────────── */

const STALENESS_CHECK_INTERVAL_MS = 15_000;
const STALENESS_THRESHOLD_MS = 60_000;
const HEALTH_POLL_MS = 15_000;

type HealthPayload = {
  ib_gateway?: {
    auth_state?: IBAuthState;
    service_state?: IBServiceState;
    upstream_dead?: boolean;
  };
};

function deriveDisplayStatus(args: {
  wsConnected: boolean;
  ibConnected: boolean;
  authState: IBAuthState | null;
  serviceState: IBServiceState | null;
  upstreamDead: boolean | null;
}): IBDisplayStatus {
  // /health is the source of truth when we have it. Order matters — pick the
  // most severe applicable state first.
  if (!args.wsConnected) return "relay_offline";
  if (args.upstreamDead === true || args.authState === "unreachable") return "unreachable";
  if (args.authState === "awaiting_2fa") return "awaiting_2fa";
  if (args.serviceState === "unhealthy") return "unhealthy";
  if (args.authState === "authenticated" && args.serviceState === "healthy") return "connected";
  // Fall back to the legacy WS-relay flag when /health hasn't responded yet.
  if (args.ibConnected) return "connected";
  return "ib_offline";
}

/* ─── Provider ────────────────────────────────────────── */

export function IBStatusProvider({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const [wsConnected, setWsConnected] = useState(false);
  const [ibConnected, setIbConnected] = useState(true); // assume connected until told otherwise
  const [disconnectedSince, setDisconnectedSince] = useState<number | null>(null);
  const [authState, setAuthState] = useState<IBAuthState | null>(null);
  const [serviceState, setServiceState] = useState<IBServiceState | null>(null);
  const [upstreamDead, setUpstreamDead] = useState<boolean | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const prevConnectedRef = useRef<boolean | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stalenessTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMessageRef = useRef<number>(Date.now());
  const strategyRef = useRef<ReconnectState>(
    createReconnectStrategy({ maxAttempts: 0 }) // unlimited for status
  );

  const socketUrl =
    process.env.NEXT_PUBLIC_IB_REALTIME_WS_URL ??
    process.env.IB_REALTIME_WS_URL ??
    "ws://localhost:8765";

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearStalenessTimer = useCallback(() => {
    if (stalenessTimerRef.current) {
      clearInterval(stalenessTimerRef.current);
      stalenessTimerRef.current = null;
    }
  }, []);

  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const buildAuthenticatedUrl = useCallback(async (baseUrl: string): Promise<string> => {
    if (!getTokenRef.current) return baseUrl;
    try {
      const token = await getTokenRef.current();
      if (!token) return baseUrl;
      const { getWsTicket } = await import("./wsTicket");
      const ticket = await getWsTicket(token);
      const separator = baseUrl.includes("?") ? "&" : "?";
      return `${baseUrl}${separator}ticket=${ticket}`;
    } catch (err) {
      console.debug("[IBStatus] Failed to get WS ticket, connecting without auth:", err);
      return baseUrl;
    }
  }, []);

  const socketGenRef = useRef(0);

  const connect = useCallback(() => {
    clearReconnectTimer();

    if (wsRef.current) {
      wsRef.current.close();
    }

    const gen = ++socketGenRef.current;

    (async () => {
      const url = await buildAuthenticatedUrl(socketUrl);
      if (gen !== socketGenRef.current) return; // stale connect attempt

      const ws = new WebSocket(url);
      wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setWsConnected(true);
      strategyRef.current.reset();
      lastMessageRef.current = Date.now();

      // Start staleness check
      clearStalenessTimer();
      stalenessTimerRef.current = setInterval(() => {
        if (Date.now() - lastMessageRef.current > STALENESS_THRESHOLD_MS) {
          // Force reconnect on stale connection
          ws.close();
        }
      }, STALENESS_CHECK_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      lastMessageRef.current = Date.now();
      try {
        const msg = JSON.parse(event.data) as StatusMessage | PingMessage;

        if (msg.type === "ping") {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: "pong" }));
          }
          return;
        }

        if (msg.type === "status") {
          const nowConnected = (msg as StatusMessage).ib_connected;
          setIbConnected(nowConnected);

          if (nowConnected) {
            setDisconnectedSince(null);
          } else {
            setDisconnectedSince((prev) => prev ?? Date.now());
          }

          prevConnectedRef.current = nowConnected;
        }
      } catch {
        // ignore parse errors for non-status messages
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setWsConnected(false);
      clearStalenessTimer();

      // If WS drops, treat as disconnected
      if (prevConnectedRef.current !== false) {
        setIbConnected(false);
        setDisconnectedSince((prev) => prev ?? Date.now());
        prevConnectedRef.current = false;
      }

      // Schedule reconnect with backoff
      if (strategyRef.current.canRetry()) {
        const delay = strategyRef.current.nextDelay();
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) connect();
        }, delay);
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      ws.close();
    };
    })();
  }, [socketUrl, clearReconnectTimer, clearStalenessTimer, buildAuthenticatedUrl]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      clearReconnectTimer();
      clearStalenessTimer();
      if (wsRef.current) {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.close();
        }
        wsRef.current = null;
      }
    };
  }, [connect, clearReconnectTimer, clearStalenessTimer]);

  // Poll /api/admin/health (proxy to FastAPI /health) for the authoritative
  // IB state. This is the only signal that catches the "TCP socket alive but
  // session sitting at 2FA prompt" case — the relay WS reports ib_connected
  // based on its long-held ib_insync socket which stays "open" through such
  // half-open scenarios and is structurally unable to distinguish them.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch("/api/admin/health", { cache: "no-store" });
        if (!res.ok) throw new Error(`health ${res.status}`);
        const payload = (await res.json()) as HealthPayload;
        if (cancelled) return;
        const gw = payload.ib_gateway ?? {};
        setAuthState(gw.auth_state ?? null);
        setServiceState(gw.service_state ?? null);
        setUpstreamDead(typeof gw.upstream_dead === "boolean" ? gw.upstream_dead : null);
      } catch {
        // Don't clear cached values on transient fetch failure — surface as
        // null only if we never had a response. A 502 here is itself a signal,
        // but treating it as "unreachable" requires knowing the cause; the
        // safer move is to leave previous state and let the next poll resolve.
        if (cancelled) return;
        setAuthState((prev) => prev);
      } finally {
        if (!cancelled) timer = setTimeout(poll, HEALTH_POLL_MS);
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Derive three-state connection status (legacy)
  const connectionState: ConnectionState =
    wsConnected && ibConnected
      ? "connected"
      : wsConnected && !ibConnected
        ? "ib_offline"
        : "relay_offline";

  const displayStatus = deriveDisplayStatus({
    wsConnected,
    ibConnected,
    authState,
    serviceState,
    upstreamDead,
  });

  return (
    <IBStatusContext.Provider
      value={{
        wsConnected,
        ibConnected,
        disconnectedSince,
        connectionState,
        authState,
        serviceState,
        upstreamDead,
        displayStatus,
      }}
    >
      {children}
    </IBStatusContext.Provider>
  );
}

export function useIBStatusContext(): IBStatusState {
  return useContext(IBStatusContext);
}
