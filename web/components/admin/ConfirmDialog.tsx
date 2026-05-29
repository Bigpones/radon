"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogChrome } from "@/lib/useDialogChrome";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Minimal confirmation dialog tailored for operator actions. Adopts the shared
 * useDialogChrome contract (escape + scroll lock + focus trap + focus restore)
 * so the cross-cutting behaviour lives in one place; the bespoke visuals and
 * the confirm-button-as-primary-affordance focus default stay local.
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  const { portalTarget, panelRef } = useDialogChrome<HTMLDivElement>({
    open,
    onClose: onCancel,
  });

  useEffect(() => {
    if (!open) return;
    confirmBtnRef.current?.focus();
  }, [open]);

  if (!open || !portalTarget) return null;

  return createPortal(
    <div
      className="admin-confirm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="admin-confirm"
    >
      <div className="admin-confirm-panel" ref={panelRef} tabIndex={-1}>
        <h2 className="admin-confirm-title">{title}</h2>
        <p className="admin-confirm-body">{body}</p>
        <div className="admin-confirm-actions">
          <button
            type="button"
            className="admin-btn admin-btn-ghost"
            onClick={onCancel}
            disabled={pending}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={`admin-btn ${destructive ? "admin-btn-danger" : "admin-btn-primary"}`}
            onClick={onConfirm}
            disabled={pending}
            data-testid="admin-confirm-action"
          >
            {pending ? "Working..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
