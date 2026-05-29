"use client";

import { useEffect, useRef, useState } from "react";

type UseDialogChromeOptions = {
  /** When false the chrome is inert: no scroll-lock, no listeners, no focus moves. */
  open: boolean;
  /** Invoked when the user presses Escape. */
  onClose?: () => void;
  /**
   * When false, Escape is ignored. Defaults to true. Surfaces with their own
   * Escape semantics (e.g. preventDefault + navigation) can opt out and wire
   * their own handler.
   */
  closeOnEscape?: boolean;
  /**
   * When false, the panel does not receive initial focus and Tab is not
   * trapped. Defaults to true.
   */
  trapFocus?: boolean;
};

type UseDialogChrome<T extends HTMLElement> = {
  /** Portal mount target, resolved on the client only (null during SSR / first paint). */
  portalTarget: HTMLElement | null;
  /** Attach to the dialog panel: gives it focus, scopes the focus trap, and is the tabIndex={-1} target. */
  panelRef: React.RefObject<T | null>;
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * useDialogChrome — the shared contract for every Radon dialog/overlay.
 *
 * Owns the cross-cutting concerns that each modal previously re-implemented:
 *   - portal mount target (deferred to a client effect so SSR never touches `document`)
 *   - Escape-to-close
 *   - body scroll-lock (restores the prior value, so nested overlays compose)
 *   - initial focus moves into the panel on open
 *   - focus-trap (Tab / Shift+Tab cycle within the panel)
 *   - focus-restore (the element focused before open is refocused on close)
 *
 * Visuals + markup stay entirely with the caller; this only manages behavior.
 */
export function useDialogChrome<T extends HTMLElement = HTMLElement>({
  open,
  onClose,
  closeOnEscape = true,
  trapFocus = true,
}: UseDialogChromeOptions): UseDialogChrome<T> {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const panelRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (closeOnEscape && event.key === "Escape") {
        onCloseRef.current?.();
        return;
      }
      if (!trapFocus || event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.offsetParent !== null || element === panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || active === panel) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (trapFocus) panelRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (trapFocus && previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [open, closeOnEscape, trapFocus]);

  return { portalTarget, panelRef };
}

export default useDialogChrome;
