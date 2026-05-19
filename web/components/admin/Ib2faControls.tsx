"use client";

import { useState } from "react";
import type { AdminHealthPayload } from "@/lib/adminTypes";
import {
  forcePushDisabledReason,
  isForcePushDisabled,
} from "@/lib/adminFormat";
import ConfirmDialog from "./ConfirmDialog";

type Ib2faControlsProps = {
  health: AdminHealthPayload | null;
  onForcePush: () => Promise<void>;
  onResetBackoff: () => Promise<void>;
  onAfter?: () => void;
};

/**
 * Two-button control surface: Force 2FA Push (primary) + Reset Backoff
 * (secondary). Each button gates on its own confirmation modal. Force push
 * is also gated on the cross-process lock surfaced by /health.
 */
export default function Ib2faControls({
  health,
  onForcePush,
  onResetBackoff,
  onAfter,
}: Ib2faControlsProps) {
  const [showForceConfirm, setShowForceConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [pendingForce, setPendingForce] = useState(false);
  const [pendingReset, setPendingReset] = useState(false);

  const pushLock = health?.ib_gateway?.restart_backoff?.push_lock ?? null;
  const disableForce = isForcePushDisabled({ pushLock, pending: pendingForce });
  const disableReason = forcePushDisabledReason({ pushLock, pending: pendingForce });

  const runForce = async () => {
    setPendingForce(true);
    try {
      await onForcePush();
    } finally {
      setPendingForce(false);
      setShowForceConfirm(false);
      onAfter?.();
    }
  };

  const runReset = async () => {
    setPendingReset(true);
    try {
      await onResetBackoff();
    } finally {
      setPendingReset(false);
      setShowResetConfirm(false);
      onAfter?.();
    }
  };

  return (
    <section className="admin-card" data-testid="ib-controls">
      <header className="admin-card-header">
        <span className="admin-card-title">IB Gateway controls</span>
      </header>

      <div className="admin-actions-row">
        <button
          type="button"
          className="admin-btn admin-btn-primary"
          onClick={() => setShowForceConfirm(true)}
          disabled={disableForce}
          title={disableReason ?? "Fires a fresh IBKR Mobile 2FA push"}
          data-testid="force-2fa-button"
        >
          Force 2FA Push
        </button>

        <button
          type="button"
          className="admin-btn admin-btn-ghost"
          onClick={() => setShowResetConfirm(true)}
          disabled={pendingReset}
          title="Release the push lock and clear the restart backoff counter"
          data-testid="reset-backoff-button"
        >
          Reset Backoff
        </button>
      </div>

      {disableReason && (
        <p className="admin-card-note" data-testid="force-2fa-disabled-reason">
          {disableReason}
        </p>
      )}

      <ConfirmDialog
        open={showForceConfirm}
        title="Force 2FA push?"
        body="This fires an IBKR Mobile 2FA push to your phone. Approve quickly to avoid stacking another push and confusing the IBKR backend."
        confirmLabel="Send push"
        destructive
        pending={pendingForce}
        onConfirm={runForce}
        onCancel={() => setShowForceConfirm(false)}
      />
      <ConfirmDialog
        open={showResetConfirm}
        title="Reset restart backoff?"
        body="Use only after manually approving the in-flight 2FA push outside the lock window. This clears the backoff counter and releases the push lock so the next legitimate restart fires immediately."
        confirmLabel="Reset"
        pending={pendingReset}
        onConfirm={runReset}
        onCancel={() => setShowResetConfirm(false)}
      />
    </section>
  );
}
