"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

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
 * Minimal confirmation dialog tailored for operator actions. Mirrors the
 * existing Modal.tsx behaviour (escape + scroll lock + focus) so this stays
 * keyboard-accessible without pulling Modal's API surface into the admin
 * panel where the buttons are the primary affordance.
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
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelRef.current();
    };
    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";
    confirmBtnRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="admin-confirm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="admin-confirm"
    >
      <div className="admin-confirm-panel">
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
    document.body,
  );
}
