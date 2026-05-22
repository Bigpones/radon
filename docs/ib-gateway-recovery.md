# IB Gateway — Recovery State Machine

Detailed derivation of the 2FA-aware restart + push lock + watchdog self-heal. Summary in `scripts/api/CLAUDE.md`; this doc is the long-form reference.

---

## Problem

After a restart, IB Gateway sits at the IBKR Mobile push prompt with the API socket open. Naive health checks (`port_listening == true`) falsely report success. Worse: IBKR's backend cannot reconcile multiple pending push tokens — if a second push request fires while the first is pending, every approval shows "unsuccessful" on the user's phone.

Symptoms before the lock:
- FastAPI restart fires push A. Watchdog observes "still no session, looks dead" 60s later, fires push B. User approves either A or B on the phone — IBKR rejects both because two tokens are in flight.
- Net effect: gateway stuck `awaiting_2fa` for hours, unrecoverable without manual `POST /ib/reset-backoff` + manual approval.

---

## Three Gates

### 1. Cross-process push lock

`scripts/utils/ib_2fa_lock.py` reads/writes `/var/lib/radon/ib-2fa-push-lock.json`. 10-min TTL.

Every restart path that fires a push acquires the lock first. While held, restart requests REJECTED with `reason="2fa_push_in_flight"`.

Required participants:
- `restart_ib_gateway` in `scripts/api/ib_gateway.py`
- `radon-ib-watchdog` cycle in `scripts/ib_watchdog.py`
- Any manual `systemctl restart radon-ib-gateway.service` path that the operator triggers via the admin panel

This is what defends against stacked-push rejection.

### 2. In-memory backoff ladder

Per-process. `restart_ib_gateway()` runs a `managedAccounts()` probe post-restart:
- Non-empty result → reset backoff to baseline.
- Empty result → advance backoff: **1m → 2m → 5m → 15m → 30m → 60m capped**.

Backoff applies to the next restart attempt by THIS process. Cross-process backoff is the push lock above.

### 3. Watchdog stuck-2FA self-heal (2026-05-20)

`is_stuck_awaiting_2fa()` fires when ALL of:
- `auth_state == "awaiting_2fa"`
- `push_lock_active == false`
- `next_attempt_in_secs <= 0`

After **3 consecutive stuck cycles (~3 min)**, watchdog acquires the push lock and triggers `systemctl restart radon-ib-gateway.service`.

`stuck_2fa_count` freezes during push-in-flight or active backoff. Resets only on `auth_state == "authenticated"`.

Without the self-heal, a 2FA timeout where the user dismisses the push notification leaves the gateway stuck until the next operator interaction. With it, the watchdog retries cleanly after backoff expires.

---

## Status Surface

`GET /health` exposes:

```json
{
  "auth_state": "authenticated" | "awaiting_2fa" | "unauthenticated",
  "service_state": "...",
  "upstream_dead": false,
  "restart_backoff": {
    "push_lock": { "active": false, "expires_at": null },
    "attempt_count": 0,
    "next_attempt_in_secs": 0
  }
}
```

Next.js footer reads via `useIBStatusContext().displayStatus` (polls `/api/admin/health` every 15s). Fixed "footer says CONNECTED while banner says degraded".

---

## Operator Escape Hatches

`POST /ib/reset-backoff` clears BOTH in-memory backoff AND the cross-process push lock. Use after manually approving 2FA on the phone.

`systemctl restart radon-ib-gateway.service` (via the operator-radon CLI or admin panel) goes through the push lock — won't fire if a push is already in flight.

`radon restart` (whole-stack) restarts all `radon-*` units. Use after a sustained outage.

---

## What NOT to Do

- **Do not re-enable IBC-side relogin on 2FA timeout** (`TWOFA_TIMEOUT_ACTION: exit`, `RELOGIN_AFTER_TWOFA_TIMEOUT: "no"` in `docker/ib-gateway/docker-compose.yml`). VPS counterpart uses IBC default (`no`). IBC's relogin bypasses the push lock and reintroduces the stacked-push bug.
- **Do not piecemeal `systemctl stop radon-<one>`** — it cascade-stops dependents (relay + monitor + api) and `Restart=always` does NOT fire because cascade-stop is a clean stop. Use `radon restart` instead. See `feedback_use_radon_restart_not_piecemeal_systemctl.md`.
- **Do not assume `auth_state=authenticated` means the pool is healthy.** After 2FA resolves, the FastAPI `ib_pool` can stay stuck disconnected. `systemctl restart radon-api.service` flips it. See `feedback_ib_pool_stuck_after_2fa.md`.

---

## Code References

- `scripts/api/ib_gateway.py:restart_ib_gateway`
- `scripts/ib_watchdog.py:run_cycle`
- `scripts/utils/ib_2fa_lock.py`
- `scripts/api/auth.py:51-54` (localhost bypass for Next.js → FastAPI)

---

## Related Feedback Memories

- `feedback_2fa_push_stacking` — stacked push rejection
- `feedback_ib_gateway_2fa_verification` — managedAccounts probe
- `feedback_systemd_cascade_stop_no_autorecover` — cascade-stop issue
- `feedback_ib_pool_stuck_after_2fa` — post-2FA pool recovery
- `feedback_ib_insync_no_request_timeouts` — request-bounding pattern needed because ib_insync blocks indefinitely during awaiting_2fa
