"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AdminHealthPayload,
  RestartLogEntry,
  ServiceAction,
  ServicesListResponse,
} from "@/lib/adminTypes";
import { useViewport } from "@/lib/useViewport";
import Sidebar from "@/components/Sidebar";
import IbGatewayCard from "./IbGatewayCard";
import Ib2faControls from "./Ib2faControls";
import ServiceControlPanel from "./ServiceControlPanel";
import RestartLog from "./RestartLog";

const HEALTH_POLL_MS = 5_000;

/**
 * Shell for the /admin route. Owns:
 *   - polled IB Gateway health (every 5s)
 *   - radon-* unit catalogue (on mount + after each service action)
 *   - in-memory action log (last 5 entries)
 *   - mobile guard banner (admin tools are desktop-only)
 *
 * Keeps the page-level component thin: child components are render-only.
 */
export default function AdminWorkspace() {
  const { isMobile, hasMounted } = useViewport();
  const [health, setHealth] = useState<AdminHealthPayload | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  const [services, setServices] = useState<ServicesListResponse | null>(null);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [servicesLoading, setServicesLoading] = useState(true);

  const [log, setLog] = useState<RestartLogEntry[]>([]);

  // Lock against concurrent polls; the panel hits localhost FastAPI so we
  // don't want overlapping fetches when a card re-renders.
  const healthInflightRef = useRef(false);

  const fetchHealth = useCallback(async () => {
    if (healthInflightRef.current) return;
    healthInflightRef.current = true;
    try {
      const res = await fetch("/api/admin/health", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `health ${res.status}`);
      }
      const data = (await res.json()) as AdminHealthPayload;
      setHealth(data);
      setHealthError(null);
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : "health probe failed");
    } finally {
      setHealthLoading(false);
      healthInflightRef.current = false;
    }
  }, []);

  const fetchServices = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/services", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `services ${res.status}`);
      }
      const data = (await res.json()) as ServicesListResponse;
      setServices(data);
      setServicesError(null);
    } catch (err) {
      setServicesError(err instanceof Error ? err.message : "service list failed");
    } finally {
      setServicesLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHealth();
    void fetchServices();
    const id = window.setInterval(fetchHealth, HEALTH_POLL_MS);
    return () => window.clearInterval(id);
  }, [fetchHealth, fetchServices]);

  const appendLog = useCallback((entry: RestartLogEntry) => {
    setLog((prev) => [entry, ...prev].slice(0, 25));
  }, []);

  const forcePush = useCallback(async () => {
    const at = new Date().toISOString();
    try {
      const res = await fetch("/api/admin/ib/restart", { method: "POST", cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
        appendLog({ at, action: "force-2fa", target: "ib-gateway", ok: false, detail });
      } else {
        const detail = body.authenticated
          ? "restart authenticated"
          : body.reason
            ? `deferred: ${body.reason}`
            : "restart fired";
        appendLog({ at, action: "force-2fa", target: "ib-gateway", ok: true, detail });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "force push failed";
      appendLog({ at, action: "force-2fa", target: "ib-gateway", ok: false, detail });
    }
    void fetchHealth();
  }, [appendLog, fetchHealth]);

  const resetBackoff = useCallback(async () => {
    const at = new Date().toISOString();
    try {
      const res = await fetch("/api/admin/ib/reset-backoff", { method: "POST", cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
        appendLog({ at, action: "reset-backoff", target: "ib-gateway", ok: false, detail });
      } else {
        appendLog({ at, action: "reset-backoff", target: "ib-gateway", ok: true, detail: "backoff cleared" });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "reset failed";
      appendLog({ at, action: "reset-backoff", target: "ib-gateway", ok: false, detail });
    }
    void fetchHealth();
  }, [appendLog, fetchHealth]);

  const runServiceAction = useCallback(
    async (unit: string, action: ServiceAction) => {
      const at = new Date().toISOString();
      try {
        const res = await fetch(`/api/admin/services/${unit}/${action}`, {
          method: "POST",
          cache: "no-store",
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const detail = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
          appendLog({ at, action: "service-action", target: `${unit} ${action}`, ok: false, detail });
        } else {
          appendLog({
            at,
            action: "service-action",
            target: `${unit} ${action}`,
            ok: true,
            detail: typeof body.detail === "string" ? body.detail.slice(0, 120) : "ok",
          });
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : "service control failed";
        appendLog({ at, action: "service-action", target: `${unit} ${action}`, ok: false, detail });
      }
      void fetchServices();
      void fetchHealth();
    },
    [appendLog, fetchHealth, fetchServices],
  );

  if (hasMounted && isMobile) {
    return (
      <main className="admin-mobile-guard" data-testid="admin-mobile-guard">
        <h1>Operator</h1>
        <p>
          Admin tools require a larger screen. Open this page on a desktop or
          tablet to manage IB Gateway and Radon services.
        </p>
      </main>
    );
  }

  const ibConnected = Boolean(
    health?.ib_gateway?.auth_state === "authenticated" || health?.ib_gateway?.port_listening,
  );

  return (
    <div className="admin-shell" data-testid="admin-page">
      <Sidebar activeSection="admin" actionTone="var(--accent-bg)" ibConnected={ibConnected} />
      <main className="admin-page">
        <header className="admin-page-header">
          <h1 className="admin-page-title">Operator</h1>
          <p className="admin-page-subtitle">
            IB Gateway and Radon service controls. All actions are confirmed
            before they fire and logged in the panel below.
          </p>
        </header>

        <div className="admin-grid">
          <IbGatewayCard health={health} loading={healthLoading} error={healthError} />
          <Ib2faControls
            health={health}
            onForcePush={forcePush}
            onResetBackoff={resetBackoff}
          />
          <ServiceControlPanel
            services={services}
            loading={servicesLoading}
            error={servicesError}
            onAction={runServiceAction}
          />
          <RestartLog entries={log} />
        </div>
      </main>
    </div>
  );
}
