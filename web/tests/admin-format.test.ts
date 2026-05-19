/**
 * Unit tests for the pure helpers in ``lib/adminFormat.ts``. These are the
 * source of truth for status pill colours, force-push gating, and per-unit
 * tones — keeping them in pure functions means the UI components stay
 * trivially testable in jsdom (next file over).
 */
import { describe, expect, it } from "vitest";
import {
  authStateLabel,
  authStateTone,
  backoffSummary,
  forcePushDisabledReason,
  isForcePushDisabled,
  unitTone,
} from "../lib/adminFormat";

describe("authStateTone", () => {
  it("maps authenticated to positive", () => {
    expect(authStateTone("authenticated")).toBe("positive");
  });
  it("maps awaiting_2fa to warning", () => {
    expect(authStateTone("awaiting_2fa")).toBe("warning");
  });
  it("maps unreachable to negative", () => {
    expect(authStateTone("unreachable")).toBe("negative");
  });
  it("treats remote / unknown / null as neutral", () => {
    expect(authStateTone("remote")).toBe("neutral");
    expect(authStateTone("unknown")).toBe("neutral");
    expect(authStateTone(null)).toBe("neutral");
    expect(authStateTone(undefined)).toBe("neutral");
  });
});

describe("authStateLabel", () => {
  it("produces human copy for every documented state", () => {
    expect(authStateLabel("authenticated")).toBe("Authenticated");
    expect(authStateLabel("awaiting_2fa")).toBe("Awaiting 2FA");
    expect(authStateLabel("unreachable")).toBe("Unreachable");
    expect(authStateLabel("remote")).toBe("Remote");
    expect(authStateLabel("unknown")).toBe("Unknown");
    expect(authStateLabel(null)).toBe("Unknown");
  });
});

describe("isForcePushDisabled", () => {
  it("disables when pending", () => {
    expect(isForcePushDisabled({ pushLock: null, pending: true })).toBe(true);
  });
  it("disables when push lock is held with positive remaining", () => {
    expect(
      isForcePushDisabled({
        pushLock: {
          holder: "scripts.api.ib_gateway.restart_ib_gateway",
          acquired_at: 1000,
          expires_at: 2000,
          remaining_secs: 45,
          reason: "restart_ib_gateway",
        },
        pending: false,
      }),
    ).toBe(true);
  });
  it("does NOT disable when push lock object has zero remaining (expired)", () => {
    expect(
      isForcePushDisabled({
        pushLock: {
          holder: "ib_watchdog",
          acquired_at: 1000,
          expires_at: 1001,
          remaining_secs: 0,
          reason: null,
        },
        pending: false,
      }),
    ).toBe(false);
  });
  it("does NOT disable when no lock and not pending", () => {
    expect(isForcePushDisabled({ pushLock: null, pending: false })).toBe(false);
  });
});

describe("forcePushDisabledReason", () => {
  it("returns null when neither lock nor pending", () => {
    expect(forcePushDisabledReason({ pushLock: null, pending: false })).toBeNull();
  });
  it("returns 'Restart in flight' when pending", () => {
    expect(forcePushDisabledReason({ pushLock: null, pending: true })).toBe("Restart in flight");
  });
  it("returns lock holder + remaining when held", () => {
    const reason = forcePushDisabledReason({
      pushLock: {
        holder: "ib_watchdog",
        acquired_at: 0,
        expires_at: 0,
        remaining_secs: 30,
        reason: "watchdog",
      },
      pending: false,
    });
    expect(reason).toContain("ib_watchdog");
    expect(reason).toContain("30s");
  });
});

describe("backoffSummary", () => {
  it("reports no backoff when attempt_count is 0 or missing", () => {
    expect(backoffSummary(null)).toBe("No backoff active");
    expect(backoffSummary(undefined)).toBe("No backoff active");
    expect(
      backoffSummary({
        attempt_count: 0,
        last_attempt_at: 0,
        next_attempt_after: 0,
        next_attempt_in_secs: 0,
        last_outcome: null,
        push_lock: null,
      }),
    ).toBe("No backoff active");
  });
  it("singularises attempt count of 1", () => {
    expect(
      backoffSummary({
        attempt_count: 1,
        last_attempt_at: 0,
        next_attempt_after: 0,
        next_attempt_in_secs: 60,
        last_outcome: "awaiting_2fa",
        push_lock: null,
      }),
    ).toBe("1 attempt, next in 60s");
  });
  it("pluralises when count > 1", () => {
    expect(
      backoffSummary({
        attempt_count: 3,
        last_attempt_at: 0,
        next_attempt_after: 0,
        next_attempt_in_secs: 900,
        last_outcome: "awaiting_2fa",
        push_lock: null,
      }),
    ).toBe("3 attempts, next in 900s");
  });
});

describe("unitTone", () => {
  const base = {
    unit: "radon-api.service",
    load_state: "loaded",
    description: "Radon API",
    can_control: true,
  };
  it("active + running -> positive", () => {
    expect(unitTone({ ...base, active_state: "active", sub_state: "running" })).toBe("positive");
  });
  it("active + exited -> neutral fallback (not running)", () => {
    expect(unitTone({ ...base, active_state: "active", sub_state: "exited" })).toBe("neutral");
  });
  it("failed -> negative", () => {
    expect(unitTone({ ...base, active_state: "failed", sub_state: "failed" })).toBe("negative");
  });
  it("inactive -> warning", () => {
    expect(unitTone({ ...base, active_state: "inactive", sub_state: "dead" })).toBe("warning");
  });
  it("activating -> warning", () => {
    expect(unitTone({ ...base, active_state: "activating", sub_state: "start" })).toBe("warning");
  });
  it("uncontrollable -> neutral regardless of state", () => {
    expect(
      unitTone({ ...base, can_control: false, active_state: "active", sub_state: "running" }),
    ).toBe("neutral");
  });
});
