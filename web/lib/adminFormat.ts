/**
 * Pure helpers for the operator admin panel. Kept dependency-free so the
 * component logic is unit-testable without a DOM.
 */

import type {
  IbAuthState,
  PushLockState,
  RestartBackoffState,
  UnitStatus,
} from "./adminTypes";

export type AuthStateTone = "positive" | "warning" | "negative" | "neutral";

/**
 * Map an auth_state to the brand tone token used by the status pill. Keeps
 * the colour decision in one place so the same mapping applies to mobile
 * banners, future status badges, etc.
 */
export function authStateTone(state: IbAuthState | undefined | null): AuthStateTone {
  switch (state) {
    case "authenticated":
      return "positive";
    case "awaiting_2fa":
      return "warning";
    case "unreachable":
      return "negative";
    case "remote":
      return "neutral";
    case "unknown":
    default:
      return "neutral";
  }
}

/** Title-case label for an auth_state, e.g. "awaiting_2fa" -> "Awaiting 2FA". */
export function authStateLabel(state: IbAuthState | undefined | null): string {
  switch (state) {
    case "authenticated":
      return "Authenticated";
    case "awaiting_2fa":
      return "Awaiting 2FA";
    case "unreachable":
      return "Unreachable";
    case "remote":
      return "Remote";
    case "unknown":
      return "Unknown";
    default:
      return "Unknown";
  }
}

/**
 * Should the "Force 2FA Push" button be disabled? True when the cross-process
 * push lock is held (a restart is in flight) OR a network call is pending.
 */
export function isForcePushDisabled(opts: {
  pushLock: PushLockState | null | undefined;
  pending: boolean;
}): boolean {
  if (opts.pending) return true;
  if (opts.pushLock && opts.pushLock.remaining_secs > 0) return true;
  return false;
}

/** Human-readable reason for the disabled state, for tooltips. */
export function forcePushDisabledReason(opts: {
  pushLock: PushLockState | null | undefined;
  pending: boolean;
}): string | null {
  if (opts.pending) return "Restart in flight";
  if (opts.pushLock && opts.pushLock.remaining_secs > 0) {
    return `Another restart is in flight (held by ${opts.pushLock.holder} for ${opts.pushLock.remaining_secs}s)`;
  }
  return null;
}

/** Brief backoff summary, e.g. "3 attempts, next in 120s". */
export function backoffSummary(backoff: RestartBackoffState | null | undefined): string {
  if (!backoff || backoff.attempt_count === 0) {
    return "No backoff active";
  }
  return `${backoff.attempt_count} attempt${backoff.attempt_count === 1 ? "" : "s"}, next in ${backoff.next_attempt_in_secs}s`;
}

/**
 * Coarse tone for a systemd unit so the row can render a colored dot.
 * The mapping is intentionally narrow: anything non-active is treated as
 * a problem so an operator can spot bad rows immediately.
 */
export function unitTone(unit: UnitStatus): "positive" | "warning" | "negative" | "neutral" {
  if (!unit.can_control) return "neutral";
  if (unit.active_state === "active" && unit.sub_state === "running") return "positive";
  if (unit.active_state === "activating" || unit.active_state === "reloading") return "warning";
  if (unit.active_state === "failed") return "negative";
  if (unit.active_state === "inactive") return "warning";
  return "neutral";
}
