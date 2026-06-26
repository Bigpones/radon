"use client";

import { useCallback, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogChrome } from "@/lib/useDialogChrome";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
};

export default function Modal({ open, onClose, title, children, className }: ModalProps) {
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const { portalTarget, panelRef } = useDialogChrome<HTMLDivElement>({ open, onClose });

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onCloseRef.current();
    },
    [],
  );

  if (!open || !portalTarget) return null;

  return createPortal(
    <div className={`modal-backdrop ${className ?? ""}`} onClick={handleBackdropClick}>
      <div className="modal-content" ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-header">
          <span className="modal-title" id={titleId}>{title}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    portalTarget,
  );
}
