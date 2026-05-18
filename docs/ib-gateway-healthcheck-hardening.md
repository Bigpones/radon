# IB Gateway Healthcheck Hardening — Proposal

**Status**: proposed, not implemented.
**Owner**: Joe.
**Author**: investigation session 2026-05-17 → 2026-05-18.

---

## Problem

On 2026-05-17 → 2026-05-18 (a ~24h window) the Hetzner IB Gateway container
degraded three times in three different ways:

| Time (UTC) | Symptom | Detection latency |
|---|---|---|
| 2026-05-17 23:45 | IBKR daily auto-logoff fired, container exited cleanly, Docker auto-restarted, 2FA dialog opened+closed in <1s for hours (rate-limit) | Joe noticed via dashboard ~12h later |
| 2026-05-18 16:22 | Java app alive, port 4001 accepts TCP, but API thread frozen — pool clients (3/4/5) connected mid-day suddenly went `connected: false`, no shutdown event in logs | Joe noticed banner ~30 min later |
| 2026-05-18 19:42 | Same JVM API-thread hang. Existing pool clients OK, new monitor-daemon connections (clientId 70 / 72) `Connected` at TCP layer then `TimeoutError` on API handshake within 3s | Banner caught it within 1 cycle (~3 min) — but only because the *monitor* tried fresh connections |

The middle and last cases are the harder ones. The container's
`docker inspect` reports `Status: running (healthy)` throughout, and our
own monitoring tools can't distinguish "Java app responsive" from
"Java process exists and accepts TCP."

---

## Why the current healthcheck misses it

`docker/services/.../docker-compose.yml` (and the radon-cloud copy on the
VPS) ships:

```yaml
healthcheck:
  test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/4001"]
  interval: 30s
  timeout: 10s
  retries: 5
  start_period: 60s
```

That's a pure TCP open. The OS accepts the SYN as long as the JVM has the
socket bound. Whether the API thread is alive and answering the IB binary
handshake is invisible to bash. Result: when the API thread hangs, the
container stays "healthy" in Docker's eyes and never restarts.

Our `restart_ib_gateway()` in `scripts/api/ib_gateway.py` already has the
right signal (`managedAccounts()` empty after restart → backoff) but it's
only invoked when a request comes in and IB rejects it. There's no
continuous watchdog that proactively detects this drift.

---

## Proposed fix — host-side API-aware watchdog

Add a small systemd timer on the VPS that polls FastAPI's `/health`
every 60s. FastAPI already does the right probe (`ib_pool.connect_all()`
during startup; `service_state` reflects real handshake state). The
watchdog just needs to *act* on a persistent degraded reading.

### Wire

```
radon-ib-watchdog.timer  →  radon-ib-watchdog.service  →  scripts/ib_watchdog.py
```

### Algorithm

```
counter = read_state('ib_watchdog_degraded_count', 0)
health  = GET http://localhost:8321/health  (5s timeout)

if health.ib_gateway.service_state == 'healthy':
    write_state('ib_watchdog_degraded_count', 0)
    exit 0

if health.ib_gateway.port_listening and health.ib_gateway.upstream_dead:
    # The hang signature — TCP open but API not responding.
    counter += 1
    write_state('ib_watchdog_degraded_count', counter)
    log_warn(f"IB gateway API-degraded for {counter} cycles")
    if counter >= 3:
        # 3 cycles × 60s = 3 minutes of sustained API hang.
        log_warn("Triggering ib-gateway docker restart via systemd")
        run("systemctl restart radon-ib-gateway.service")
        write_state('ib_watchdog_degraded_count', 0)
        # The existing 2FA backoff in `restart_ib_gateway()` does NOT
        # gate systemctl, but it does gate the FastAPI in-process
        # restart path. We're bypassing that on purpose — if 2FA backoff
        # is active, the container is already broken and Docker's
        # `restart: always` plus our manual restart will both fire
        # safely. Worst case: extra 2FA push at restart time.
    exit 0

# Anything else (auth_state == awaiting_2fa, etc.) is NOT this bug.
# Reset and let the existing 2FA-aware restart logic handle it.
write_state('ib_watchdog_degraded_count', 0)
```

State persists in Turso (via existing `service_health.extra` or a new
small `daemon_state` table — pick whichever feels lower-overhead).

### Why 3 cycles × 60s

- Today's incident: timeouts started at 19:42 and continued for ~13 min
  before the operator restarted. A 3-minute trigger would have cut that
  to <4 min total.
- Faster (1 cycle) risks restart on a transient blip — the 16:22
  incident showed `Connection timed out` for ~30s before stabilizing
  into the longer hang; we don't want to restart for a 30s network blip.
- 60s polling × 3 cycles is also short enough that the `service_state`
  signal predates user impact in most cases.

### Files to create / modify

- `radon-cloud/services/radon-ib-watchdog.{service,timer}` — systemd units
- `radon-cloud/setup-vps.sh:SERVICE_FILES` — register the new units so
  `wipe-vps.sh` rebuilds with them
- `scripts/ib_watchdog.py` — the probe + restart logic (~80 LOC)
- `scripts/api/server.py` — add `service_state` to `/health` payload if
  it isn't already exposed at the right granularity (verify; today's
  output included `service_state: 'unhealthy'` so likely fine)
- `web/lib/serviceHealthWindows.ts` — register `ib-watchdog` so its own
  cycles surface in the banner (event-driven, 24h closed window per the
  precedent in `feedback_event_driven_writer_windows.md`)

---

## Open questions for you

1. **Is restart frequency OK?** This will produce extra IB Gateway
   restarts during normal trading sessions when the JVM degrades. Each
   restart costs ~30s of dead time and one 2FA tap. Given how often
   we've seen the degradation, that seems strictly better than a 13+
   minute hang — but worth confirming.
2. **Should the daily auto-logoff at 23:45 UTC also be addressed
   here?** The right fix is in IBKR account settings (Pre-set Logoff
   Time). If you'd rather just absorb it via this watchdog: yes, it'll
   handle the daily case too — the post-logoff `awaiting_2fa` loop
   isn't `upstream_dead`, so the watchdog will skip it (good, because
   pinging IBKR's auth servers harder won't help). But the watchdog
   could be extended to send a Pushover alert when `auth_state ==
   'awaiting_2fa'` for >5 min.
3. **Where should the state live?** Turso `service_health.extra` is
   convenient (already plumbed) but conflates worker state with
   health metadata. A small `daemon_state` table is cleaner. Lean
   toward `service_health.extra` for v1 since it's zero-migration.

---

## Out of scope

- **JVM tuning** (heap size, GC tuning) — possible root cause of
  the hangs but unverifiable without thread dumps. If hangs continue
  with the watchdog in place, next step is to enable
  `-XX:+HeapDumpOnOutOfMemoryError` and capture a `jstack` next hang.
- **Replacing the gnzsnz/ib-gateway image** — possible upstream bug
  in version `10.45.1b`. The 10.x series has had API-thread bugs
  before. Worth a re-check of IBKR's release notes for newer point
  releases, but not part of this proposal.
- **Moving to client portal gateway** — would change the entire
  data path; out of scope.

---

## Estimated effort

~3 hours: 1h for the watchdog script and tests, 1h for systemd units
+ setup-vps.sh wiring + serviceHealthWindows registration, 1h for VPS
deploy / verify / soak.

## Related

- Memory: `feedback_use_radon_restart_not_piecemeal_systemctl.md` —
  why the operator CLI is the only acceptable stop/start invocation
- Memory: `feedback_ib_gateway_2fa_verification.md` — the existing
  2FA-aware restart backoff
- Memory: `feedback_ib_pool_stuck_after_2fa.md` — `systemctl restart
  radon-api.service` recovery for the post-2FA stuck-pool symptom
- `scripts/api/ib_gateway.py:restart_ib_gateway()` — current
  in-process restart with 2FA backoff
- `web/lib/serviceHealthWindows.ts` — staleness window registration
  contract this watchdog plugs into
