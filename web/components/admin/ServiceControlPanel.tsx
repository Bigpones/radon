"use client";

import { useState } from "react";
import type {
  ServiceAction,
  ServicesListResponse,
  UnitStatus,
} from "@/lib/adminTypes";
import { unitActivityLabel, unitTone } from "@/lib/adminFormat";
import type { FlashTarget } from "./AdminWorkspace";
import ConfirmDialog from "./ConfirmDialog";

type ServiceControlPanelProps = {
  services: ServicesListResponse | null;
  loading: boolean;
  error: string | null;
  onAction: (unit: string, action: ServiceAction) => Promise<void>;
  flashTarget?: FlashTarget | null;
};

type PendingAction = {
  unit: string;
  action: ServiceAction;
} | null;

/**
 * Renders every radon-* systemd unit + IB Gateway container service with a
 * stop / start / restart trio. Stop and restart are gated by a confirmation
 * modal; start is treated as low-risk and fires immediately on click.
 */
export default function ServiceControlPanel({
  services,
  loading,
  error,
  onAction,
  flashTarget = null,
}: ServiceControlPanelProps) {
  const [pending, setPending] = useState<PendingAction>(null);
  const [confirm, setConfirm] = useState<PendingAction>(null);

  const runAction = async (unit: string, action: ServiceAction) => {
    setPending({ unit, action });
    try {
      await onAction(unit, action);
    } finally {
      setPending(null);
      setConfirm(null);
    }
  };

  const requestAction = (unit: string, action: ServiceAction) => {
    if (action === "start") {
      void runAction(unit, action);
    } else {
      setConfirm({ unit, action });
    }
  };

  if (loading && !services) {
    return (
      <section className="admin-card" data-testid="services-card">
        <header className="admin-card-header">
          <span className="admin-card-title">Radon services</span>
        </header>
        <p className="admin-card-empty">Loading services...</p>
      </section>
    );
  }

  if (error && !services) {
    return (
      <section className="admin-card" data-testid="services-card">
        <header className="admin-card-header">
          <span className="admin-card-title">Radon services</span>
        </header>
        <p className="admin-card-empty admin-card-error">{error}</p>
      </section>
    );
  }

  const units = services?.units ?? [];

  return (
    <section className="admin-card" data-testid="services-card">
      <header className="admin-card-header">
        <span className="admin-card-title">Radon services</span>
        <span
          className={`admin-pill ${services?.supported ? "admin-pill-positive" : "admin-pill-neutral"}`}
        >
          {services?.supported ? "systemd" : "read-only"}
        </span>
      </header>

      {!services?.supported && (
        <p className="admin-card-note">
          Service control is only available on the Hetzner deployment. This view
          shows the canonical unit list for reference.
        </p>
      )}

      <table className="admin-services-table">
        <thead>
          <tr>
            <th>Unit</th>
            <th>State</th>
            <th>Sub</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {units.map((unit) => (
            <ServiceRow
              key={unit.unit}
              unit={unit}
              supported={services?.supported ?? false}
              pending={pending}
              onRequest={requestAction}
              flashTarget={flashTarget}
            />
          ))}
        </tbody>
      </table>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? `${capitalize(confirm.action)} ${confirm.unit}?` : ""}
        body={
          confirm
            ? confirm.action === "stop"
              ? `This will run systemctl stop ${confirm.unit}. Dependent units will also stop. Use 'Restart' if you want it to come back up.`
              : `This will run systemctl restart ${confirm.unit}. Brief downtime while the unit restarts.`
            : ""
        }
        confirmLabel={confirm ? capitalize(confirm.action) : ""}
        destructive={confirm?.action === "stop"}
        pending={pending !== null}
        onConfirm={() => confirm && runAction(confirm.unit, confirm.action)}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ServiceRow({
  unit,
  supported,
  pending,
  onRequest,
  flashTarget,
}: {
  unit: UnitStatus;
  supported: boolean;
  pending: PendingAction;
  onRequest: (unit: string, action: ServiceAction) => void;
  flashTarget: FlashTarget | null;
}) {
  const tone = unitTone(unit);
  const disabled = !supported || !unit.can_control;
  const isUnitPending = pending?.unit === unit.unit;
  const activity = unitActivityLabel(unit);
  const flashClass = resolveFlashClass(unit.unit, flashTarget);

  return (
    <tr
      data-testid={`service-row-${unit.unit}`}
      className={flashClass}
      data-flash={flashClass ? "true" : undefined}
    >
      <td>
        <div className="admin-unit-cell">
          <span className={`admin-status-dot admin-status-dot-${tone}`} aria-hidden />
          <span className="admin-unit-name">{unit.unit}</span>
        </div>
        {unit.description && <div className="admin-unit-desc">{unit.description}</div>}
        <div
          className="admin-unit-activity"
          data-testid={`service-activity-${unit.unit}`}
        >
          {activity}
        </div>
      </td>
      <td>{unit.active_state}</td>
      <td>{unit.sub_state}</td>
      <td>
        <div className="admin-row-actions">
          {(["start", "restart", "stop"] as ServiceAction[]).map((action) => (
            <button
              key={action}
              type="button"
              className={`admin-btn admin-btn-sm ${action === "stop" ? "admin-btn-danger" : action === "restart" ? "admin-btn-primary" : "admin-btn-ghost"}`}
              disabled={disabled || (isUnitPending && pending?.action === action)}
              onClick={() => onRequest(unit.unit, action)}
              data-testid={`service-${action}-${unit.unit}`}
            >
              {isUnitPending && pending?.action === action ? "..." : capitalize(action)}
            </button>
          ))}
        </div>
      </td>
    </tr>
  );
}

/** Class name added to a row that was just acted on (success or failure). */
function resolveFlashClass(unit: string, flash: FlashTarget | null): string {
  if (!flash || flash.unit !== unit) return "";
  return flash.ok ? "admin-row-flash" : "admin-row-flash-error";
}
