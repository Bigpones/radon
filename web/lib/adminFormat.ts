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
  // ``inactive (dead)`` is normal for ``Type=oneshot`` services that have
  // finished cleanly. Treat them as positive when the last exit code is 0;
  // anything else is a warning (might be a stuck or failed run).
  if (unit.active_state === "inactive") {
    if (typeof unit.last_exit_code === "number") {
      return unit.last_exit_code === 0 ? "positive" : "negative";
    }
    return "warning";
  }
  return "neutral";
}

/**
 * "running 3h 22m" for a daemon, "last ran 5m ago (rc=0)" for a oneshot,
 * "never run" when both timestamps are missing.
 *
 * Pulled out of the component so we can unit-test the wording without
 * mounting the table.
 */
export function unitActivityLabel(unit: UnitStatus, now: number = Date.now()): string {
  if (typeof unit.uptime_secs === "number" && unit.uptime_secs >= 0) {
    return `running ${formatUptime(unit.uptime_secs)}`;
  }
  if (unit.last_active_at) {
    const relative = formatRelativeTime(unit.last_active_at, now);
    if (typeof unit.last_exit_code === "number") {
      return `last ran ${relative} (rc=${unit.last_exit_code})`;
    }
    return `last ran ${relative}`;
  }
  return "never run";
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Compact relative-time string for the operator panel: "just now", "23s
 * ago", "5m ago", "3h ago", "yesterday", "3d ago". Always backward-looking
 * — future timestamps clamp to "just now" (clock skew safeguard).
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const delta = now - t;
  if (delta < 5 * SECOND_MS) return "just now";
  if (delta < MINUTE_MS) return `${Math.floor(delta / SECOND_MS)}s ago`;
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)}m ago`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)}h ago`;
  if (delta < 2 * DAY_MS) return "yesterday";
  return `${Math.floor(delta / DAY_MS)}d ago`;
}

/**
 * Compact uptime for a long-running daemon: "45s", "3m", "3h 22m", "2d 4h",
 * "12d". Designed to be glanceable so the row stays readable.
 */
export function formatUptime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0s";
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86_400) {
    const hours = Math.floor(secs / 3600);
    const minutes = Math.floor((secs % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(secs / 86_400);
  const hours = Math.floor((secs % 86_400) / 3600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}
