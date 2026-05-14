# Operations Runbook

Live-trading operational concerns: IB Gateway connection modes, background services, watchdogs, deploy flow. The authoritative developer runbook is [`CLAUDE.md`](../CLAUDE.md). The cloud-services architecture deep dive is [`docs/cloud-services.md`](cloud-services.md).

## Environment Variables

### Web app (`web/.env`)

```bash
ANTHROPIC_API_KEY=
UW_TOKEN=
EXA_API_KEY=
CEREBRAS_API_KEY=                       # optional, newsfeed text tagger

# Clerk authentication
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
```

### Root `.env`

```bash
MENTHORQ_USER=
MENTHORQ_PASS=

# IB Gateway
IB_GATEWAY_HOST=127.0.0.1               # ib-gateway for cloud/Tailscale
IB_GATEWAY_PORT=4001
IB_GATEWAY_MODE=docker                  # docker | cloud | launchd
IB_GATEWAY_COMPOSE_DIR=                 # required on Hetzner (radon-cloud repo path)

# Clerk JWT validation (FastAPI + WS relay)
CLERK_JWKS_URL=
CLERK_ISSUER=
ALLOWED_USER_IDS=user_...               # comma-separated allowlist

# Newsfeed scraper
THEMARKETEAR_EMAIL=
THEMARKETEAR_PASSWORD=

# IB Flex Web Service (Hetzner)
IB_FLEX_TOKEN=
IB_FLEX_QUERY_ID=1422766                # blotter
IB_FLEX_NAV_QUERY_ID=1497709            # cash transactions
```

`scripts/cta_sync_service.py` and `scripts/run_cta_sync.sh` parse `.env` values literally instead of shell-sourcing them, so unquoted secrets containing shell metacharacters (`$`, backticks, etc.) survive the scheduled CTA path.

`.env.ib-mode` overlays `.env` and stores the IB mode toggle from `scripts/ib mode local|cloud`.

## IB Gateway

Three deployment modes selected by `IB_GATEWAY_MODE`:

| Mode | Description |
|------|-------------|
| `docker` (default; Hetzner production) | `ghcr.io/gnzsnz/ib-gateway` via Docker Compose, `restart: unless-stopped`, healthcheck, autoheal sidecar. |
| `cloud` (laptop dev) | Gateway on the Hetzner VM at `ib-gateway:4001` over Tailscale MagicDNS. Health check is a TCP port probe; local restart returns 503. |
| `launchd` (legacy) | IBC under macOS launchd. |

**2FA-aware restart.** After every restart, IB Gateway sits at the IBKR Mobile push prompt with the API socket already open, so port probes alone falsely report success. `restart_ib_gateway()` now runs an explicit `managedAccounts()` probe; non-empty resets backoff, empty advances it (1m → 2m → 5m → 15m → 30m → 60m capped). `/health` exposes `auth_state` (`authenticated | awaiting_2fa | unreachable | unknown | remote`) and `restart_backoff` (attempt count, next attempt in seconds, last outcome). `POST /ib/reset-backoff` is the operator escape hatch after manually approving 2FA.

**Hetzner gotcha.** On Hetzner, `radon-ib-gateway.service` launches the container from `/home/radon/radon-cloud/`, not the in-tree `docker/ib-gateway/`. `IB_GATEWAY_COMPOSE_DIR=/home/radon/radon-cloud` is required to point FastAPI's `_check_docker()` at the right compose project. Without it, `container_state` reports `not_found` while the container is actually running.

**ib_insync request bounding.** `ib_insync` has no built-in timeout on its async API calls — `qualifyContractsAsync`, `reqHistoricalDataAsync`, and `reqMktData` will block forever when the gateway is logged in but the user session isn't authenticated (the 2FA-pending state). Any script that imports `ib_insync` directly must wrap each await in `asyncio.wait_for(..., timeout=15)` and pre-check `auth_state == "authenticated"` against FastAPI `/health` before instantiating `IB()`. `cri_scan.py` is the reference implementation.

**Client ID ranges.**

| Range | Usage |
|-------|-------|
| 0–9 | FastAPI IBPool (sync=3, orders=4, data=5) |
| 10–19 | WS relay |
| 20–49 | Subprocess scripts — always `client_id="auto"` |
| 50–69 | Scanners |
| 70–89 | Daemons (fill=70, exit=71) |
| 90–99 | CLI |

**Troubleshooting.**

```bash
# Health
curl -s http://localhost:8321/health | python3.13 -m json.tool

# Gateway reachable?
bash -c 'echo > /dev/tcp/ib-gateway/4001' && echo OK || echo FAIL

# Connections on remote host
ssh root@ib-gateway "ss -tnp | grep 4001"

# Fresh client probe
python3.13 -c "from ib_insync import IB; ib=IB(); ib.connect('ib-gateway',4001,clientId=99,timeout=10); print('OK'); ib.disconnect()"
```

**Management commands** (laptop alias → SSH-wrapped; same names on the VPS):

| Command | Action |
|---------|--------|
| `ibstart` | Start container, wait for port 4001 |
| `ibstop` | Stop and remove container |
| `ibrestart` | Restart container |
| `ibstatus` | Container state, port check, active connections |
| `iblogs [N]` | Tail container logs |
| `ibhealth` | Docker healthcheck status |

Deeper troubleshooting and full Docker setup live in [`docs/ib-gateway-docker.md`](ib-gateway-docker.md) and [`docs/ib-connection-troubleshooting.md`](ib-connection-troubleshooting.md).

## Background Services

Hetzner host systemd is the production surface. Laptop dev uses launchd plists in `config/`.

| Service | Cadence | Purpose |
|---------|---------|---------|
| `radon-ib-gateway` | always-on | Broker session for live quotes, execution, reports |
| `radon-api` | always-on | FastAPI on `:8321` |
| `radon-relay` | always-on | IB realtime WebSocket relay on `:8765` |
| `radon-nextjs` | always-on | Next.js terminal at `app.radon.run` |
| `radon-newsfeed` | 120s loop | Headless Playwright scraper for The Market Ear |
| `radon-monitor` | 30s loop | Fills, exit orders, journal sync, cash flow handler |
| `radon-refresh.timer` | 60s | Schedules data-refresh sweeps |
| `radon-vcg-refresh.timer` | Mon-Fri 13-21 UTC every 5 min | Autonomous VCG scan |
| `radon-portfolio-sync.timer` | Mon-Fri 13-21 UTC every 60s | Autonomous portfolio sync |
| `radon-cta-sync.timer` | Mon-Fri 18:15 / 19:00 / 21:30 UTC | MenthorQ CTA refresh |
| `radon-watchdog-{intraday,continuous,daily,error}.timer` | varies | Service-health alerting (Discord, Pushover) |

The autonomous timers retired Radon's previous "data only refreshes when a browser tab is open" failure mode. Some surfaces remain on-demand by design (`scanner`, `discover`, `flow-analysis`, `analyst-ratings`, `gex-scan`, `orders-read-compare`).

**Operator CLI.** `/usr/local/bin/radon` wraps every loaded `radon-*` unit. Auto-enumerates via `systemctl list-units 'radon-*'`, so new timers don't require script edits.

```bash
radon stop      # stop IB + all radon-* units
radon start     # start them all (IB Gateway first)
radon restart
radon status
```

From the laptop: `ssh root@ib-gateway radon stop`. Installed by `radon-cloud/scripts/operator-radon.sh` via `setup-vps.sh:install_operator_cli()`.

## Service Health & Watchdogs

Every dual-write service writes a row to the `service_health` Turso table on every cycle, including no-op short-circuits. The Next.js `<ServiceHealthBanner />` reads the latest row per service and renders a category-aware banner.

| Category | Stale state |
|----------|-------------|
| `scheduled` | Red — banner alerts; treated as outage |
| `on-demand` | Amber — dormant chip; suppressed from alerts |

Staleness windows live in `web/lib/serviceHealthWindows.ts`. Cycle-driven writers (`newsfeed-scraper`, `journal-sync`, `cri-scan`) use tight windows (~cadence × 3). Event-driven writers (`replica-watchdog`, `watchdog-alerts`) use 24h windows because "no event" is the healthy state.

**Watchdog** (`scripts/watchdog/`) runs in four buckets (`intraday`, `continuous`, `daily`, `error`), each with its own timer. Alerts route to Discord and Pushover with per-service cooldown and hysteresis. Ack with `python -m scripts.watchdog ack <service>`. The `error` bucket explicitly skips `watchdog-alerts` itself to avoid recursive alerting.

**Banner humanization.** `service_health.last_error` JSON payloads are rewritten into operator-friendly copy before render (see `web/lib/serviceHealthBanner.ts`).

**Replica watchdog** (`monitor_daemon`) self-heals libsql `WalConflict` errors on the Next.js embedded replica. Long-running write-only services must set `RADON_DB_NO_REPLICA=1` so they write directly to the cloud DB. Only one process per host can hold `data/replica.db` open as a writer.

**Market-hours gate.** Handlers tagged `requires_market_hours=True` (`fill_monitor`, `exit_orders`, `journal_sync`) only run during 09:30-16:00 ET. The daemon converts UTC to ET via `zoneinfo.ZoneInfo("America/New_York")` so DST is handled automatically; a fail-open UTC-5 fallback fires only if the host is missing `tzdata`. Never hardcode a fixed offset for ET — it silently shifts the window 1h every DST season.

## Cash Flows

`scripts/cash_flow_sync.py` pulls `CashTransaction` rows from IBKR Flex (`IB_FLEX_NAV_QUERY_ID=1497709`) and upserts into the `cash_flows` Turso table. Surfaces on `/orders` via `web/components/CashFlowsSection.tsx`.

**Cadence:** once per ET trading day at 17:00 ET (1h after the close). Flex publishes once per day, so faster polling buys nothing. Holidays and weekends are skipped via `utils.market_calendar`. Late-fires past 18:00 ET if the daemon was off.

**Throttle backoff.** Flex codes 1001 / 1018 / 1019 raise `FlexThrottleError` on the first hit (no internal retry, no sleep), and the handler advances an exponential breaker (24h → 48h → 72h → 168h capped) persisted across daemon restarts. The breaker composes with the daily window; embargo expiry waits until the next 17:00 ET slot.

## Deployment

`git push origin main` triggers `.github/workflows/deploy.yml`. The workflow SSHes to Hetzner as the `radon` user and runs `bash scripts/deploy.sh` from `~/radon-cloud/`:

1. `git fetch --all && git reset --hard origin/main`
2. `pip install -r requirements.txt`
3. `npm install && npx playwright install chromium`
4. `next build --experimental-build-mode=compile` (Next.js 16 prerender workaround)
5. `sudo systemctl restart radon-{nextjs,api,relay,monitor}` (health-gated rollback)

Confirm with `gh run list --workflow=deploy.yml --limit 1`. The `radon-cloud` repo lives separately and owns systemd unit files, Caddy config, the Docker Compose project for IB Gateway, and `setup-vps.sh` / `wipe-vps.sh`.

## Production Build Constraint

Next.js 16 prerender crashes on `/_global-error` and `/_not-found` because the root ClerkProvider context isn't materialised in isolated workers. `web/package.json` build pins `next build --experimental-build-mode=compile`. The error and not-found shells (`app/error.tsx`, `app/[ticker]/not-found.tsx`, `app/global-error.tsx`) use plain `<a>` and pure JSX (no `next/link`, `useEffect`, or `globals.css`) for the same reason.
