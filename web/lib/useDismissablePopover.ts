import { useEffect, type RefObject } from "react";

/**
 * Dismisses a popover on a mousedown outside its container or on the Escape key.
 *
 * Mirrors the pattern previously duplicated in ColumnsToggle / SharePnlButton /
 * TickerSearch: a `mousedown` listener that closes when the event target is
 * outside `ref`, plus an Escape `keydown` listener. Both listeners are attached
 * only while `enabled` is true, so callers that gate on an `open` flag pass that
 * flag and callers that always listen pass `true`.
 *
 * `onClose` runs when either dismissal fires.
 */
export function useDismissablePopover(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [ref, onClose, enabled]);
}
