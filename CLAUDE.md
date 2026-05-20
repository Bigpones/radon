# RADON — CLAUDE.md

**Radon** = market-structure reconstruction. Surfaces convex opportunities from dark pool / OTC flow, vol surfaces, cross-asset positioning. **Flow signal or nothing.**

Brand: `docs/brand-identity.md` · Structures: `docs/options-structures.{json,md}` · UW spec: `docs/unusual_whales_api.md` · Cloud runbook: `docs/cloud-services.md`

---

## ⛔ Mandatory Rules

1. **Be concise.** No preamble.
2. **Red/green TDD always.** Vitest (unit), chrome-cdp / Playwright (E2E). Target 95% coverage.
3. **E2E browser verification for all UI work.** Primary `chrome-cdp`, fallback Playwright (`web/playwright.config.ts`). UI is not done until visually confirmed.
4. **API keys** in `.env` files (table below). Never `~/.zshrc` unless fallback.
5. **No raw hex in UI.** Use brand tokens (`docs/brand-identity.md`). 4px max border-radius on panels.
6. **No em dashes in user-facing copy.**

## ⛔ Four Gates — Sequential, No Exceptions

| Gate | Rule |
|---|---|
| 1. Convexity | Gain ≥ 2× loss. Defined-risk only. |
| 2. Edge | Specific, data-backed dark-pool / OTC signal that hasn't moved price. |
| 3. Risk | Fractional Kelly. Hard cap 2.5% bankroll / position. |
| 4. ~~No naked shorts~~ | **DISABLED 2026-04-30.** Detection logic preserved as `_*Impl`. Re-enable: `docs/naked-short-reenable.md`. |

Any gate fails → stop. Name the gate.

## Data Source Priority

1. Interactive Brokers (TWS / Gateway) — real-time
2. Unusual Whales (`$UW_TOKEN`) — dark pool, sweeps, alerts
3. Yahoo — fallback
4. Web scrape — last resort

Never skip to Yahoo / web without trying IB → UW first. Clients live in `scripts/clients/`.

## Credentials

| File | Loaded by | Contains |
|---|---|---|
| `.env` (root) | python-dotenv | MenthorQ creds, Clerk JWKS / issuer / allowlist |
| `.env.ib-mode` (root, gitignored) | overlayed after `.env` | `IB_GATEWAY_MODE`, `IB_GATEWAY_HOST` — toggled by `scripts/ib mode local\|cloud` |
| `web/.env` | Next.js | `ANTHROPIC_API_KEY`, `UW_TOKEN`, `EXA_API_KEY`, `CEREBRAS_API_KEY`, Clerk keys |

**IB Flex Web Service env (Hetzner `/home/radon/radon-cloud/.env`):**

| Var | Points to | Used by |
|---|---|---|
| `IB_FLEX_TOKEN` | Flex Web Service token | All Flex pulls |
| `IB_FLEX_QUERY_ID` | `1422766` (blotter) | `scripts/trade_blotter/flex_query.py` |
| `IB_FLEX_NAV_QUERY_ID` | `1497709` (Cash Transactions) | `scripts/cash_flow_sync.py`, `scripts/portfolio_performance.py` |
| `IB_GATEWAY_MODE` | `docker` (since 2026-05-07) | `scripts/api/ib_gateway.py` |
| `IB_GATEWAY_COMPOSE_DIR` | `/home/radon/radon-cloud` | `scripts/api/ib_gateway.py` — compose project the container actually runs under (NOT in-tree default). **Required on Hetzner; do not unset.** |

Journal-rehydrate query `1442520` is referenced via `journal_rehydrate.py` reading `IB_FLEX_QUERY_ID` at runtime — on Hetzner that env points at `1422766`. **Don't repurpose `IB_FLEX_NAV_QUERY_ID` for trade pulls** — tuned for `CashTransaction` only.

**`.env` values containing `$` need quoting.** Bash loaders `set -a; . file; set +a` shell-expand `$VAR` substrings; under `set -u` an unset reference aborts silently from systemd. Single-quote the value (`PASS='RX$abc!xyz'`) or use a non-shell loader (systemd `EnvironmentFile=`, `python-dotenv`). See `feedback_env_file_shell_expansion.md`.

---

## Architecture

`npm run dev` runs four services. Filter logs: `npm run dev -- --only <next|ib|api|scraper>`.

| Service | Port / cadence |
|---|---|
| Next.js | 3000 |
| FastAPI (`scripts/api/server.py`, 26 endpoints) | 8321 |
| IB WS relay (`ib_realtime_server.js`) | 8765 |
| Newsfeed scraper (`scripts/newsfeed/index.js`) | 120s |

Next.js routes call FastAPI via `radonFetch()` (`web/lib/radonApi.ts`). **No `spawn()` from Next.js.**

### Auth (Clerk)

All FastAPI routes JWT-protected; Next.js by `web/middleware.ts`; WebSocket via `scripts/api/ws_ticket.py` (30s TTL).

- **FastAPI localhost bypass:** `client.host in {127.0.0.1, ::1}` → auth skipped (covers Next.js → FastAPI server-to-server). `scripts/api/auth.py:51-54`.
- **Next.js localhost bypass:** auto when `NODE_ENV !== "production"`. Production builds enforce. Helpers in `web/middleware.ts`: `isLocalDevAuthBypassEnabled` (auto), `isLocalAuthlessTestBypassEnabled` (`RADON_AUTHLESS_TEST=1` for Playwright).
- **Auth-exempt:** `/health`, `/ws-ticket/validate`, `/docs`, `/openapi.json`, all `*/share` routes.

### IB Gateway — Three Modes

`IB_GATEWAY_MODE` env, persisted to `.env.ib-mode`. Toggle via `scripts/ib mode {local|cloud}`. Switching does NOT auto-reconnect — restart the dev stack.

- **`docker`** (default for local; also Hetzner since 2026-05-07): `ghcr.io/gnzsnz/ib-gateway`, `restart: unless-stopped`. `npm run ib:start`. **Hetzner gotcha:** container is launched by `radon-ib-gateway.service` from `/home/radon/radon-cloud/` (radon-cloud repo), not the in-tree `<repo>/docker/ib-gateway/`. `IB_GATEWAY_COMPOSE_DIR=/home/radon/radon-cloud` overrides FastAPI's in-tree default.
- **`cloud`** (laptop default for dev): Hetzner VM at `ib-gateway:4001` via Tailscale. TCP probe only — `POST /ib/restart` returns 503. Laptop aliases (SSH-wrapped, in `~/.zshrc`): `ibstart/stop/restart/status/logs/health` for IB Gateway only. **Whole-stack control on VPS** uses `/usr/local/bin/radon` (or `ssh root@ib-gateway radon <cmd>`):

  | Command | Effect |
  |---|---|
  | `radon stop` | `systemctl stop` IB + all `radon-*` units |
  | `radon start` | start them all (IB Gateway first) |
  | `radon restart` | stop then start |
  | `radon status` (or bare `radon`) | `systemctl list-units "radon-*"` |

  Auto-enumerates loaded `radon-*` units via `systemctl list-units 'radon-*' --all`. Covers `radon-{ib-gateway,api,relay,monitor,newsfeed,nextjs}` plus timer oneshots `radon-{refresh,vcg-refresh,cta-sync,portfolio-sync}.{service,timer}` and `radon-watchdog-{intraday,continuous,daily,error}.{service,timer}`. **Source at `radon-cloud/scripts/operator-radon.sh`; installed by `setup-vps.sh:install_operator_cli()`.**
- **`launchd`** (legacy): `~/ibc/bin/`, Mon-Fri auto-lifecycle.

Auto-recovery (docker mode): port + CLOSE_WAIT detection at startup (poll 45s); subprocess errors trigger health check first — only restart if port not listening or CLOSE_WAIT. Client ID collisions, VOL errors, transient timeouts do NOT trigger restart.

**2FA-aware restart with exponential backoff + cross-process push lock.** After restart, IB Gateway sits at IBKR Mobile push prompt with API socket open — `port_listening:true` falsely reports success. Three gates govern restarts:

1. **Cross-process 2FA push lock** (`scripts/utils/ib_2fa_lock.py`, default `/var/lib/radon/ib-2fa-push-lock.json`, 10-min TTL). Every restart path that fires an IBKR Mobile push — `scripts/api/ib_gateway.restart_ib_gateway`, `scripts/ib_watchdog.trigger_restart` — acquires the lock first. While another holder owns it, the request is REJECTED with `reason="2fa_push_in_flight"`. This is the structural defence against stacked-push rejection: IBKR's backend cannot reconcile multiple pending push tokens, so the user sees "unsuccessful" on every approval when pushes pile up.
2. **In-memory backoff ladder** (per-process, `_restart_state`). `restart_ib_gateway()` runs `managedAccounts()` probe post-restart; non-empty resets backoff, empty advances (1m → 2m → 5m → 15m → 30m → 60m, capped). Refuses fresh restarts inside window.
3. **Watchdog stuck-2FA self-heal (added 2026-05-20).** `scripts/ib_watchdog.is_stuck_awaiting_2fa()` classifier fires when `auth_state=awaiting_2fa` AND `push_lock_active=false` AND `next_attempt_in_secs<=0`. After 3 consecutive stuck cycles (≈3 min) the watchdog acquires the push lock and triggers a fresh `systemctl restart radon-ib-gateway.service`, which sends a new IBKR Mobile push. Eliminates the human-in-the-loop dependency where the system would sit stuck overnight waiting for an operator to click "Force 2FA Push" on /admin. The new `stuck_2fa_count` on `WatchdogState` freezes (does not reset) when a push is in flight or a backoff retry is scheduled — so the next cycle after lock-release acts promptly. Counter resets to 0 only on `auth_state=authenticated`.

`/health` exposes `auth_state` (`authenticated | awaiting_2fa | unreachable | unknown | remote`), `service_state` (`healthy | unhealthy | starting | unknown`), `upstream_dead`, and `restart_backoff` (including `push_lock: {holder, expires_at, remaining_secs, reason}`, `attempt_count`, `next_attempt_in_secs`). The Next.js footer reads these via `useIBStatusContext().displayStatus` (polls `/api/admin/health` every 15s) — added 2026-05-20 to fix the recurring "footer says CONNECTED while banner says degraded" contradiction; the prior WS-relay flag stayed "open" through half-open 2FA prompts (TCP alive, API mute). **`POST /ib/reset-backoff`** is the operator escape hatch after manually approving 2FA — clears BOTH the in-memory backoff AND the cross-process push lock so the next legitimate restart proceeds immediately.

IBC-side relogin on 2FA timeout is **disabled** (`TWOFA_TIMEOUT_ACTION: exit`, `RELOGIN_AFTER_TWOFA_TIMEOUT: "no"` in `docker/ib-gateway/docker-compose.yml`). VPS counterpart at `/home/radon/radon-cloud/docker-compose.yml` does not set these vars — IBC default is `no`, so it's already safe. **Do not re-enable IBC-side relogin** anywhere; it bypasses the push lock.

See `scripts/api/ib_gateway.py:restart_ib_gateway`, `scripts/ib_watchdog.py:run_cycle`, `scripts/utils/ib_2fa_lock.py`, `feedback_ib_gateway_2fa_verification.md`, `feedback_2fa_push_stacking.md`.

**IB request bounding pattern.** `ib_insync` has no per-request timeout. When IB Gateway is logged in but session awaiting 2FA, `qualifyContractsAsync`/`reqHistoricalDataAsync`/`reqMktData` block forever. Scripts importing `ib_insync` directly **must**: (1) wrap every IB await in `asyncio.wait_for(..., timeout=15)`, and (2) pre-check FastAPI `/health` for `auth_state == "authenticated"` before instantiating `IB()`; `/health` unreachable → optimistic fall-through. See `scripts/cri_scan.py:_fetch_ib`, `feedback_ib_insync_no_request_timeouts.md`.

### Client ID Ranges

| Range | Usage |
|---|---|
| 0–9 | FastAPI IBPool (sync=3, orders=4, data=5) |
| 10–19 | WS relay |
| 20–49 | Subprocess scripts AND monitor_daemon handlers — **always `client_id="auto"`** |
| 50–69 | Scanners |
| 90–99 | CLI |

**On-demand scripts MUST use `client_id="auto"`. Never hardcode in 20–49.** As of 2026-05-20 monitor_daemon handlers (`fill_monitor`, `exit_orders`, `journal_sync`) also use `client_id="auto"` — the prior 70/71/72 hardcoded daemon range left them one CLOSE_WAIT socket away from a stuck "client id already in use" error on every transient gateway hiccup. The auto-allocator in `scripts/clients/ib_client.py:_connect_auto_allocate` rotates around in-use IDs.

### Two-Mode Deployment

Both modes read/write the **same Turso DB** (`libsql://radon-joemccann.aws-us-west-2.turso.io`) **direct-to-cloud — no embedded replica anywhere as of 2026-05-20**. JSON files in `data/` are written alongside as fallback. The libsql embedded-replica architecture (`data/replica.db`) was retired after a same-day pair of incidents: first multi-writer-per-host WAL checkpoint contention (radon-cloud `741cfc6`), then single-writer WAL-frame conflicts between the replica owner and direct-cloud writers (radon-cloud `2c46232`). All Radon processes (`radon-{nextjs,api,relay,monitor,newsfeed}`) now run with `Environment=RADON_DB_NO_REPLICA=1`. Reads cost +30–60 ms cloud round-trip (absorbed by SWR caching); WAL contention is structurally impossible. See `feedback_libsql_replica_one_writer.md`.

- `scripts/cloud.sh` → `RADON_MODE=hetzner`. Schedulers run as systemd on Hetzner (`radon-{api,monitor,relay,refresh,nextjs}`); laptop runs only Next.js + newsfeed. `app.radon.run` keeps serving when laptop is closed.
- `scripts/local.sh` → `RADON_MODE=local`. Laptop launchd plists own all schedulers.

**Auto-deploy on push to main.** `.github/workflows/deploy.yml` SSHes to Hetzner as `radon` user and runs `bash scripts/deploy.sh` from `~/radon-cloud/`. `git push origin main` IS the deploy. Confirm: `gh run list --workflow=deploy.yml --limit 1`. After deploy, `sudo systemctl restart radon-api.service` may be needed (FastAPI does NOT auto-reload in production).

Schema: `scripts/db/migrations/0001_init.sql`. Writers: `scripts/db/writer.{js,py}`. Routes prefer DB, fall back to disk.

**Image host:** `https://media.radon.run` (Caddy on Hetzner, fed by laptop rsync over Tailscale). Posts use absolute URLs. Public-IP fallback: `RADON_MEDIA_REMOTE=radon@5.78.148.38:/home/radon/radon-cloud/media/`.

**Newsfeed is Hetzner-resident.** Headless Playwright (`scripts/newsfeed/browser.js` + `auth.js`); auth via `THEMARKETEAR_EMAIL` / `THEMARKETEAR_PASSWORD`. Session at `data/newsfeed-storage.json` (gitignored, ~30d), full re-auth every ~6h. Polls 120s. Hetzner: `radon-newsfeed.service` (`Restart=on-failure`, `RestartSec=30`). `deploy.sh` runs `npx playwright install chromium`. On Hetzner `RADON_MEDIA_REMOTE=/home/radon/radon-cloud/media/` (local fs path; rsync skips SSH self-loop). Local dev: `node scripts/newsfeed/index.js --once`.

**Trades canonical store:** Turso `journal` table. Both `/journal` and `/orders` derive from it. `/orders` uses `web/lib/blotter/fromJournal.ts:journalRowsToBlotter()` with union+preference fallback to `data/blotter.json` for legacy rows lacking explicit `realized_pnl`/`cost_basis`/`proceeds`. New rehydrate runs include them; `data/blotter.json` decays to redundant fallback. See `docs/cloud-services.md` § "Trades — single source of truth".

### Autonomous timers (Hetzner only)

Several scans/syncs have systemd timers on VPS so data refreshes regardless of laptop state:

| Timer | Cadence | Wrapper | Endpoint |
|---|---|---|---|
| `radon-refresh.timer` | Mon–Fri */15min | `scripts/data_refresh.py` (cri+vcg) | direct script |
| `radon-vcg-refresh.timer` | Mon–Fri 13–21 UTC every 5min | `scripts/run_vcg_refresh.sh` | `POST /vcg/scan` |
| `radon-portfolio-sync.timer` | Mon–Fri 13–21 UTC every 60s | `scripts/run_portfolio_refresh.sh` | `POST /portfolio/sync` |
| `radon-cta-sync.timer` | Mon–Fri 18:15, 19:00, 21:30 UTC | `scripts/run_cta_sync.sh` | `POST /menthorq/cta` (Playwright) |
| `radon-watchdog-{intraday,continuous,daily,error}.timer` | see watchdog section | `python -m scripts.watchdog --bucket <name>` | reads `service_health` |

Unit files in `radon-cloud/services/`; `setup-vps.sh SERVICE_FILES` enumerates so `wipe-vps.sh` rebuilds install automatically.

Wrapper env-loader: `run_*_refresh.sh` use literal parser (not `set -a; . file`) to avoid `$VAR` expansion. See `feedback_env_file_shell_expansion.md`.

### Service health watchdog

Four buckets at `scripts/watchdog/`, monitors every `scheduled` service in `web/lib/serviceHealthWindows.ts`, notifies via Pushover (P1 only) + always-on `service_health` row:

- **`intraday`** (`vcg-scan`, `cri-scan`, `orders-sync`, `portfolio-sync`) — 5 min, Mon–Fri 13:00–21:00 UTC.
- **`continuous`** (`newsfeed-scraper`, `replica-watchdog`, `fill-monitor`, `exit-orders`, `journal-sync`) — 5 min, 24/7.
- **`daily`** (`cash-flow-sync`, `flex-token-check`, `cta-sync`) — hourly, 24/7.
- **`error`** — every scheduled service except `watchdog-alerts` (recursive-alert prevention), 5 min, 24/7.

Anti-flood: **2-consecutive-failures hysteresis**; **1h per-(service,severity) cooldown** in `watchdog_cooldowns` table; **`python -m scripts.watchdog ack <service>` CLI** for 4h muting via `watchdog_acks` table. Env in `radon-cloud/.env`: `PUSHOVER_USER`, `PUSHOVER_TOKEN` — absent vars degrade gracefully (alerts still land in `service_health`). Discord support was removed 2026-05-19.

**Service categories** (`web/lib/serviceHealthWindows.ts`): every service tagged `scheduled` or `on-demand`. Stale `scheduled` → red banner. Stale `on-demand` (`gex-scan`, `discover`, `flow-analysis`, `analyst-ratings`, `orders-read-compare`) → `state="dormant"`, amber "visit to refresh" chip.

**Event-driven writers use 24h windows:** `replica-watchdog` and `watchdog-alerts` only write on heal/alert events; tight windows treat quiet healthy periods as stale.

### Monitor daemon market-hours gate

`scripts/monitor_daemon/daemon.py:is_market_hours()` gates handlers with `requires_market_hours=True` (`fill_monitor`, `exit_orders`, `journal_sync`). Uses `datetime.now(ZoneInfo("America/New_York"))` so EST↔EDT transitions auto via tzdata; fail-open fallback to UTC-5 if zoneinfo unavailable. **Never reintroduce a fixed offset** for ET conversion anywhere. See `feedback_hardcoded_timezone_offsets.md`.

### Production Build Constraint

Next.js 16 prerender crashes on `/_global-error` + `/_not-found` (root ClerkProvider context not materialised in isolated workers). `web/package.json` build uses `next build --experimental-build-mode=compile`. `app/error.tsx`, `app/[ticker]/not-found.tsx`, `app/global-error.tsx` use plain `<a>` + pure JSX (no `next/link`, no `useEffect`, no `globals.css`).

---

## ⚠️ Cache Contract — Disk-Backed Routes

Every Next.js GET handler reading live disk state (`data/*.json`, `data/menthorq_cache/`) **MUST** export `dynamic = "force-dynamic"`. Without it Next.js 16 statically prerenders the first response for the dev server's lifetime.

Every client fetch hitting these routes **MUST** pass `cache: "no-store"`.

Covered routes: `menthorq/cta`, `journal`, `discover`, `flow-analysis`, `blotter`, `vcg`, `internals`, `portfolio`, `performance`, `scanner`, `regime`, `gex`, `orders`, `service-health`. Covered hooks: `useMenthorqCta`, `useSyncHook`, `useJournal`, `usePortfolio`, `useDiscover`, `useOrders`. Contract test: `web/tests/api-routes-no-cache-contract.test.ts`, fails CI on regression.

---

## Combo / BAG Order Guardrails

1. **Never map combo `Order.action` from debit vs credit.** IB combo legs define structure. SELL envelope reverses legs. For entry/open: keep envelope BUY, preserve per-leg actions.
2. **`ComboLeg.action` = structure, not direction.** Always `LONG → BUY`, `SHORT → SELL`. Flipping causes IB error 201.
3. **Order-builder structure change → invalidate manual net price.** Recompute from normalized combo quote on single-leg ↔ combo transitions.
4. **Combo natural market uses cross-fields:**
   - BUY combo: pay ASK on BUY legs, BID on SELL legs
   - SELL combo: receive BID on BUY legs, ASK on SELL legs
   - Impls: `computeNetOptionQuote()`, `ComboOrderForm.netPrices`, `resolveOrderPriceData()`.
5. **Trace path before fixing:** chain builder → `/api/orders/place` → FastAPI bridge → `scripts/ib_place_order.py`. Identify whether bug is UI state, payload semantics, or IB combo behavior.
6. **Required regressions:** unit (action/ratio/net-price), browser (displayed net + submitted payload).
7. **Closing-trade detection (added 2026-05-20, commit e55b643).** `OrderRiskLeg.coveringLongContracts` tells the risk model how many contracts of the exact same option (same symbol/expiry/strike/right) are already held LONG. SELL with `coveringLongContracts >= effectiveContracts` short-circuits to `maxLoss: 0` (pure close). SELL with `coveringLongContracts < effectiveContracts` flags only the excess (M − N) contracts as naked. Wired in `OrderTab.NewOrderForm.orderSummary` whenever the user SELLs a held LONG single-leg option. Without this, every SELL-to-close of a long call triggered "GATE 1: UNDEFINED RISK — Uncovered short call" false-positive. Symmetric for puts. See `web/lib/orderRisk.ts:36-50` (field), `:187-219` (single-leg short-circuit), `:277-285` (multi-leg discount), `:311-315` (`effectiveNakedContracts` helper).

### IB error message rendering

IBKR rejection text embeds literal `<br>` tokens as soft line breaks ("Cannot have open orders on both sides...for a`<br>` contract..."). `web/lib/orderError.ts:formatOrderError` normalises every variant (`<br>`, `<br/>`, `<br />`, `<BR>`) to a real `\n` BEFORE the prefix-stripping branch. `.order-error-detail` in `globals.css` uses `white-space: pre-line` so the newlines render as line breaks. Never use `dangerouslySetInnerHTML` for IB text — the regex+pre-line path keeps `details: string[]` a plain string array that e2e selectors and logs can match against. Added 2026-05-20.

## Cancel / Modify Failure Propagation

1. **Cancel/modify MUST use subprocess with original clientId.** Master client (0) sees all orders but can't modify (Error 10147/103). `ib_order_manage.py` reconnects as original.
2. **Clear VOL fields before modify.** Reset `volatility`/`volatilityType` to IB sentinels (`1.7976931348623157e+308` / `2147483647`) to avoid Error 321.
3. **Confirm against refreshed open-order snapshot**, not stale `Trade`. Disappearance after cancel = success.
4. **Preserve upstream error detail.** Subprocess JSON → FastAPI `detail` → Next.js. Never collapse to generic 500.
5. **Required regressions:** unit (refreshed confirmation), route (status propagation), browser (toast/error).

---

## Calculations — Correctness Rules

### Sign Convention
Credits negative, debits positive. **Never `Math.abs()` on option prices without approval.** Preserve sign through entire display pipeline.

### Daily Change %
```
Day Chg % = Daily P&L / |Yesterday's Close Value| × 100   (NEVER entry cost)
```
Per-leg: `sign × (last - close) × contracts × 100`. Impl: `getOptionDailyChg()`.

**Same-day exception:** `entry_date == today (ET)` → yesterday's close meaningless. Day Chg and Today P&L use entry-cost as baseline → Today P&L = Total P&L = `MV − EC`. **`ib_daily_pnl` is ignored same-day** (IB sometimes reports stale numbers for fresh fills).

### Entry-Date Resolution (`ib_sync.py`)

Strict ordered fallback, MOST → LEAST specific:
1. blotter (per-contract: `ticker|expiry|right|strike`)
2. trade_log (`ticker|structure`)
3. IB fills (per-contract, same-session)
4. prev portfolio (`ticker|structure|expiry`, excluding today)
5. **today** ← brand-new positions land here so same-day P&L branch fires

**Never use a per-ticker blotter fallback** — different contracts have different open dates. Regression test: `test_combo_entry_date.py`.

### Position cache refresh (`reqPositions` before reading)

`ib_insync.positions()` returns the library's in-memory cache. TWS push events update individual fields piecewise — `pos.position` (size) updates immediately when a fill clears but `pos.avgCost` lags by a tick or two while TWS recomputes the running VWAP server-side. `IBClient.get_positions()` therefore calls `self._ib.reqPositions()` + `sleep(1)` BEFORE reading the cache, draining pending updates so size and avgCost are consistent in the returned snapshot. Without this, every portfolio sync that ran in the seconds after a new fill wrote a mismatched `(size_new, avg_old)` pair into `portfolio.json` and Turso — manifested as "I added 25 contracts but my AVG ENTRY didn't change". Opt out via `get_positions(refresh=False)` for tight read loops where a parent call already drained. `try/except` around the refresh so a gateway hiccup falls back to the cache rather than crashing the sync. Tests: `test_ib_client.py::TestPortfolioOperations::test_get_positions_forces_refresh_before_reading_cache` + two siblings. Added 2026-05-20 (commit 5d10def).

### Per-Leg P&L
`Leg P&L = sign × (|MV| − |EC|)`. Sum = position P&L. Impl: `LegRow` in `PositionTable.tsx`.

### Total P&L %
`(MV − EC) / |EC| × 100`

### Price Resolution
| Context | Source |
|---|---|
| Stock | `prices[ticker].last` |
| Single-leg option | `prices[optionKey(...)].last` |
| Multi-leg spread | Net from each leg's `prices[legPriceKey(...)]` |
| BAG order | `resolveOrderLastPrice()` / `resolveOrderPriceData()` |
| PriceBar | `resolvePriceBar()` — option for single-leg, underlying for multi-leg |

**Never show underlying where user expects option/spread. Show "---" if unavailable.**

### Exposure Delta Sign
`rawDelta = sign × lp.delta` where `sign = -1` for SHORT. LONG Call →+, SHORT Call →−, LONG Put →−, SHORT Put →+. Impl: `web/lib/exposureBreakdown.ts`.

### Implied (Black-Scholes) Value
TS port of `scripts/scenario_analysis.py:192-226`, verified to 4-decimal Python parity.

| Input | Source order |
|---|---|
| **S** | `prices[ticker].last` → `prices[optionKey].undPrice` → `(bid+ask)/2` |
| **σ** | `prices[optionKey].impliedVol` → bisection on `close` (T_yest = T+1/365) |
| **K** | `leg.strike` |
| **T** | `(expiry@16:00 ET − now) / 365 days` |
| **r** | `useRiskFreeRate()` → FRED DFF, 24h cache, fallback 0.0 |

Combo: signed sum across legs. Files: `web/lib/blackScholes.ts`, `impliedValue.ts`, `useRiskFreeRate.ts`. Implied/Implied MV columns gated on `positions.some(p => p.structure_type !== "Stock")`.

### Position Structure (`detect_structure_type()` in `ib_sync.py`)
Stock→equity. Long Call/Put→defined. Short Call/Put→undefined. Spreads→defined. Synthetic/Risk Reversal→undefined. Long Straddle→defined. Covered Call→defined. All-long combo→defined. Unrecognized→complex (→Undefined Risk table).

### Data Normalization
JSON: `"ticker"`. IB contracts: `"symbol"`. Read defensively: `t.get("ticker") or t.get("symbol")`.

### Margin Warning Thresholds (`web/lib/marginWarning.ts`)

Persistent toast fires on transition into a worse level. Thresholds match IBKR's published guidance.

```
critical:  excess_liquidity ≤ 0                              (active margin call)
critical:  cushion < 0.01  (< 1%)                            (imminent)
warning:   cushion < 0.05  (< 5%)                            (approaching)
warning:   equity_with_loan_value ≤ maint_margin_req × 1.10  (IBKR's own published rule)
none:      otherwise

cushion = excess_liquidity / net_liquidation
```

`assessMargin()` is a pure function — derive on the client from `portfolio.account_summary`. Toast UX in `WorkspaceShell.tsx` near `prevIbConnectedRef`; `prevMarginLevelRef` ensures fire only on transition to higher rank (`none < warning < critical`). Dismiss via `×` close button. **Never auto-dismiss** (`addToast(..., 0)`).

Stage 1 (threshold-derived). **Stage 2** swaps source to IBKR Web API `/fyi/notifications` once OAuth Self-Service activates; toast UI unchanged. Plan: `~/.claude/plans/identify-all-issues-with-reactive-kernighan.md`. Tests: `web/tests/margin-warning.test.ts` (12), `web/e2e/margin-warning-toast.spec.ts` (6).

---

## Component Cheat Sheet

Each tab: hook + staleness lib + API route + panel + scanner + cache file.

| Tab | Files (under `web/`, `scripts/`) | Notes |
|---|---|---|
| **VCG** (vol-credit gap) | `useVcg.ts`, `vcgStaleness.ts`, `app/api/vcg/route.ts`, `VcgPanel.tsx`, `vcg_scan.py` (20-session), `data/vcg.json`, `scripts/run_vcg_refresh.sh`, `radon-cloud/services/radon-vcg-refresh.timer`, `config/com.radon.vcg-refresh.plist` | RO: VIX>28 + VCG>2.5. EDR: VIX>25 + VCG 2.0–2.5. BOUNCE: VCG<-3.5. VVIX = severity amplifier, not gate. FastAPI: `POST /vcg/{scan,share}`, 60s cooldown. Autonomous 5-min cadence during ET hours via `radon-vcg-refresh.timer` (Hetzner) / `com.radon.vcg-refresh` (laptop). Wrapper POSTs `/vcg/scan`; falls back to direct `vcg_scan.py` if FastAPI unreachable. Banner window: 15min open (3 missed cycles). |
| **GEX** (gamma exposure) | `useGex.ts`, `gexStaleness.ts`, `app/api/gex/route.ts`, `GexPanel.tsx`, `gex_scan.py`, `data/gex.json` | UW fields: `call_gex` positive, `put_gex` negative, `net = call_gex + put_gex` (no negation). Levels: GEX Flip, Max Magnet, Max Accelerator, Put/Call Wall. Bias: BULL / CAUTIOUS_BULL / NEUTRAL / CAUTIOUS_BEAR / BEAR from flip pos + net sign + magnet. Tests: 71. |
| **CRI / Regime** | `web/lib/criStaleness.ts`, `regime` route triggers `cri_scan.py` | Stale if `data.date != today` OR (market_open AND mtime>60s). Closed + date=today → serve EOD. CRI payload's `history` carries full Yahoo intersection (~251 trading days / 13 months); chart slices for display; statistical windows are explicit constants. |
| **Regime market-closed** | `RegimePanel` | Use `data.{vix,vvix,spy}` only (no WS `last`). `activeCorr = data.cor1m`. `liveCri / intradayRvol = null`. Don't update VIX/VVIX timestamps. COR1M badge = DAILY. |
| **Regime day-change** | `.regime-strip-day-chg` | VIX/VVIX/SPY: WS `last` vs `close`. RVOL: `intradayRvol - data.realized_vol`. COR1M: `data.cor1m_5d_change`. Arrow always **right** of change text via `display: flex; gap: 4px`. |
| **Regime history** | `CriHistoryChart.tsx` | 20 sessions, 440px. Left: VIX `#05AD98` + VVIX `#8B5CF6`. Right: RVOL `#F5A623` + COR1M `#D946A8`. |
| **CRI spread chart zoom** | `web/components/RegimeRelationshipView.tsx`, `web/lib/regimeRelationships.ts`, `web/tests/regime-relationship-zoom.test.tsx` | "Correlation Risk Premium" panel on `/regime/cri`: preset chips (`1M/3M/6M/1Y/All`, default `1Y`) above chart + brush minimap below (8px×40px handles + draggable middle pan, hand-built pointer events; no `d3.brushX`). State: `useState<[start,end]>(presetRange("1y", history.length))` re-clamped via effect. Z-score window stays scoped to last 20 sessions of full history via `Z_SCORE_WINDOW=20`, not visible slice. Chip click snaps brush; drag flips active chip to `Custom`. Brand tokens only, 4px max radius. |
| **Options Chain sticky header** | `OptionsChainTab.tsx` | Three required CSS rules — all three or overlap returns: (1) `background: var(--bg-panel-raised)` on `.chain-header` + `.chain-side-label`; (2) `position: sticky; top: 0` / `top: 24px`; (3) `.chain-grid thead { position: relative; z-index: 10 }`. |
| **Column visibility** | `useColumnVisibility(tableId, defaults)` | Persists to `localStorage` keyed `radon:columns:<tableId>`. Buckets: `positions-{defined,undefined,equity}`, `orders-open`. `<ColumnsToggle />` left of filter input in section header. |
| **Margin Warning Toast** | `web/lib/marginWarning.ts`, `web/components/WorkspaceShell.tsx` (`prevMarginLevelRef` block), `web/tests/margin-warning.test.ts`, `web/e2e/margin-warning-toast.spec.ts` | Stage 1 — threshold-derived from `portfolio.account_summary`. Persistent toast (`addToast(..., 0)`), fires only on transition to worse rank. See "Margin Warning Thresholds" in Calculations. |
| **Cash Flows panel** (on `/orders`) | `scripts/cash_flow_sync.py` (Flex pull + classifier), `scripts/monitor_daemon/handlers/_throttle_backoff.py`, `scripts/db/migrations/0002_cash_flows.sql`, `scripts/db/writer.py:upsert_cash_flow`, FastAPI `GET /cash-flows`, `web/app/api/cash-flows/route.ts`, `web/lib/useCashFlows.ts`, `web/components/CashFlowsSection.tsx`, daemon handler `scripts/monitor_daemon/handlers/cash_flow_sync.py` | Surfaces IBKR `CashTransaction` rows (deposits/withdrawals/dividends/interest/fees/withholding) on `/orders`. Reads `IB_FLEX_NAV_QUERY_ID` (1497709). Idempotent on `transactionID`. `_classify()` disambiguates combined Deposits/Withdrawals by amount sign. UI: positive=green, negative=red. **Cadence: once per ET trading day at 17:00 ET (1h after close).** Skips weekends + US holidays via `utils.market_calendar`. Late-fires after 18:00 ET if `last_run` is on a strictly earlier ET trading day. **Throttle-aware exponential backoff** on Flex codes 1001/1018/1019: 24h → 48h → 72h → 168h capped, persists via `get_state`/`set_state`, resets on success. `cash_flow_sync.py` raises `FlexThrottleError` on first throttle hit (no internal retry); handler circuit breaker handles wait. Network blips get one bounded retry. Tests: 36 pytest + 4 vitest + 7 Playwright. |
| **LLM Token Index** (on `/regime/llm`) | `scripts/llm_token_index.py` (Artificial Analysis pull + median + normalize), `scripts/db/migrations/0007_llm_token_index.sql`, `scripts/db/writer.py:record_llm_token_index`/`get_llm_token_index`, FastAPI `GET /llm-token-index`, `web/app/api/llm-token-index/route.ts`, `web/lib/useLlmTokenIndex.ts`, `web/components/LlmTokenIndexCard.tsx`, `web/app/regime/llm/page.tsx`, systemd unit `radon-cloud/services/radon-llm-index.{service,timer}` | LLM Compute Premium card on the Regime tab — fourth tab `LLM` alongside CRI/VCG/GEX. Pulls Artificial Analysis (`https://artificialanalysis.ai/api/v2/data/llms/models`, header `x-api-key`, free tier 1000 req/day) once daily at 06:30 UTC via timer. Index methodology: per-model blended USD/Mtok = `0.7 * input + 0.3 * output`, then `raw_avg_usd = median(basket)`. Basket: GPT-4o, Claude Opus 4.7, Claude Sonnet 4.5, Gemini 2.5 Pro, DeepSeek V3, Llama 3.1 405B, Mistral Large. Missing models log + skip (basket continues). Normalised to 1.0 on first persisted UTC date so chart reads like Silicon Data's compute-cost series. Idempotent on `date` (`ON CONFLICT(date) DO UPDATE`). Env: `ARTIFICIAL_ANALYSIS_API_KEY`. Service health: `llm-token-index` (25h window). Tests: 17 pytest (math/normalize/HTTP/persistence) + 7 pytest (route) + 7 vitest (route+hook) + 4 vitest (card). |
| **Mobile shell** (PWA, iPhone 16 393×852) | `web/lib/useViewport.ts`, `web/lib/breakpoints.ts`, `web/components/mobile/{MobileShell,MobileAppBar,MobileTabBar,MobileMoreDrawer,MobileTickerSearch,Card,CardRow,BottomSheet}.tsx`, `web/components/PwaRegister.tsx`, `web/public/{manifest.webmanifest,sw.js}` | `useViewport()` (≤640 mobile / 641-1023 tablet / ≥1024 desktop) drives `<MobileShell>` from `WorkspaceShell` when `isMobile && hasMounted`. Sets `body[data-mobile="true"]`; global CSS hides desktop sidebar/header, pads main for 56px top + 64px bottom (Dashboard/Positions/Orders/Scanner/More + drawer). Manifest standalone, theme #0a0f14, 192/512 icons. Hand-written SW (~80 LOC) caches static only — bypasses `/api`, `/_next/data`, `/ws` to preserve cache contract. Search opens full-screen overlay wrapping `TickerSearch` (16px input → no iOS zoom). |
| **Mobile per-screen variants** | `web/components/mobile/{MobilePositionList,MobileOrderList,MobileBlotterList,MobileExecutedList,MobileJournalList,MobileChainLadder,MobileOrderTicket}.tsx` | Branched via `isMobile && hasMounted` from `PositionTable.tsx`, `WorkspaceSections.tsx`, `OptionsChainTab.tsx`. All P&L/combo math reused. Chain ladder 2-col (calls/strike/puts), tap cell → BottomSheet detail with Greeks; BUY/SELL footer adds `OrderLeg` to same `orderLegs` state desktop uses. Pending strip → `MobileOrderTicket` (BottomSheet): qty steppers + price ladder + DAY/GTC chips → posts `/api/orders/place` with same body shape (combo guardrails 1-6 unchanged). |
| **Mobile tests** | `web/tests/{use-viewport,mobile-bottom-sheet}.test.{ts,tsx}` (15 vitest); `web/e2e/mobile-*.spec.ts` (48 Playwright at 393×852 via `playwright.config.ts` `mobile` project) | Run: `npm test` (vitest) and `PLAYWRIGHT_PORT=3033 npx playwright test --config playwright.config.ts --project=mobile`. Mobile e2e stubs API routes + skips WS prices; uses `evaluate(el => el.click())` for BottomSheet-footer elements below viewport. |

---

## Newsfeed Scraper

Module split under `scripts/newsfeed/` (`paths`, `browser`, `auth`, `cdp`, `extract`, `media`, `store`, `tagger`, `vision_tagger`, `taxonomy`, `scheduler`, `index`). `scripts/newsfeed-scraper.js` is back-compat shim. Output shape locked by `web/components/DashboardNewsFeed.tsx` (`MarketEarPost`).

**Key behaviors:**
- **Headless Playwright** (`browser.js` + `auth.js`) replaces chrome-cdp. Env: `THEMARKETEAR_EMAIL`, `THEMARKETEAR_PASSWORD`. Storage `data/newsfeed-storage.json` reuses session; full re-auth every ~6h. `cdp.js` is a Playwright shim for back-compat (`runCdpCommand`, `fetchCookieHeader`, `listTargets`, `selectMarketEarTab` still exported).
- **IPv4 forced** for `themarketear.com` CDN (`https.Agent { family: 4 }`) and `api.cerebras.ai` (undici dispatcher) — both AAAA-unreachable from residential IPv6.
- **Cookie-gated images:** `media.js` accepts `getCookieHeader` callback; cookies via Playwright `context.cookies()` to follow `/images/<hash>.png` 301 → `*.cdn.digitaloceanspaces.com`.
- **Rollover** at 500 KB → archive + keep ⌈N×0.2⌉. `mergePosts` preserves `tags` across cycles.

**Tagging:**
- Router: vision tagger (`claude-haiku-4-5`, ~$0.003/post) for posts with images; text tagger (Cerebras `gpt-oss-120b` → fallback `qwen-3-235b-a22b-instruct-2507`) for text-only.
- gpt-oss-120b needs `max_tokens: 800` (reasoning model — chain-of-thought before JSON).
- Exactly **3 tags per post**, free-form. Existing taxonomy shown as context.
- **Naming** (enforced by `__normaliseTags`): UPPERCASE, multi-word UPPERCASE-KEBAB-CASE (`PUT-CALL-RATIO`), allowed `A-Z 0-9 - &`, case-insensitive dedup.
- `hydrateTags` skips posts with `tags.length >= 3` unless `force=true`.
- `data/tag_taxonomy.json` force-tracked despite `data/*.json` gitignore. Filter chip pool auto-derives from tags present.
- Either `CEREBRAS_API_KEY` or `ANTHROPIC_API_KEY` sufficient. Without both, tagging skipped (posts still scraped).

**Backfill:** `scripts/newsfeed/backfill_tags.js`. `--retag` re-tags everything (use after prompt/naming changes). Throttles to ~24 req/min under Cerebras 30 rpm.

**`concurrently` env quirk:** `scripts/newsfeed/index.js` explicitly loads `web/.env` + root `.env` via `dotenv` because `concurrently` doesn't inherit env.

**Filter UI:** Per-post chips, AND-semantics with ≥2. Active filters as top bar with × + "Clear all". Pagination below. Deep-link: `/dashboard?tags=BTC,vol`. URL writes in post-commit `useEffect` to avoid React "Cannot update a component while rendering".

**Env overrides:** `RADON_NEWSFEED_DATA_DIR`, `_POSTS_FILE`, `_ARCHIVE_DIR`, `_MEDIA_DIR`, `_PUBLIC_ROOT`, `CDP_CLI`.

**Tests:** 64 cases across `newsfeed-{scraper,tagger,taxonomy,time}`, `dashboard-newsfeed-{pagination,tag-filter}`.

---

## Theme System

- **Single source of truth:** `web/lib/ThemeContext.tsx` (`useTheme()`). Never duplicate theme state in a component.
- **Pre-paint bootstrap:** `web/components/ThemeBootstrap.tsx` mounts in `<head>` and synchronously sets `data-theme` on `<html>` from `localStorage.theme` or `prefers-color-scheme` BEFORE React hydrates. Eliminates the flash-of-wrong-theme that the `useEffect`-based init suffered. Also frees `/kit`, `app/error.tsx`, `app/global-error.tsx`, and `app/[ticker]/not-found.tsx` from being locked to whatever the SSR root layout hardcoded.
- **SSR theme is pinned to `"dark"`** in `ThemeContext.tsx:SSR_THEME`. The provider's initial `useState` MUST return this constant — never read localStorage/matchMedia/`data-theme` during first render, or React #418 hydration mismatch fires for every light-theme user (descendants like `ClerkThemeBridge`, `WorkspaceShell`'s `actionTone`, `kit/page`'s Sun/Moon icon all branch on `theme`). A post-mount `useEffect` reconciles the real value via `readClientTheme()`. See commit 68c6e57 + `tests/theme-provider-hydration.test.tsx`.
- **Brand tokens via `color-mix(in srgb, var(--token) X%, transparent)`** — never bake brand colors as raw `rgba(R,G,B,α)` literals. Raw rgba doesn't shift between light/dark CSS variables; `color-mix` does. Tailwind colors (`green-500 #22C55E`, `red-500 #EF4444`) are NOT brand and must be replaced with `var(--positive)` / `var(--negative)`. See `feedback_theme_tokens_and_pre_hydration.md`.
- **`<meta name="theme-color">` is owned by Next.js viewport metadata** — declare both light/dark variants via `viewport.themeColor: [{ media, color }, ...]`. Do NOT mutate the meta tag from client code (an earlier ThemeBootstrap attempt did this and broke hydration).
- **`<head>` and `data-theme` on `<html>`** — root layout sets `suppressHydrationWarning` on `<html>` and lets `ThemeBootstrap` paint the attribute. Do not hardcode `data-theme="dark"` in JSX.
- **IB Gateway status display** — `IBStatusContext` exposes a single `displayStatus: "connected" | "awaiting_2fa" | "unhealthy" | "unreachable" | "ib_offline" | "relay_offline"` derived from BOTH the WS-relay edge AND `/api/admin/health` (polled every 15s). Sidebar footer and MobileAppBar chip both read this — they can no longer disagree. `.status-dot-warn` / `.mobile-app-bar__status--warn` amber states for `awaiting_2fa`.
- **ETF Company tab filter** — `CompanyTab.tsx` hides equity-only stats (Market Cap when missing, P/E, EPS, Next Earnings) when `uw_info.issue_type` matches `ETF|ETN|FUND|MUTUAL|REIT`. Drops Div Yield too for `INDEX|IDX`. Avoids the "bunch of empty `---` rows" UX on tickers like USAX.

---

## High-Throughput Architecture

500+ symbols, <500ms signal-to-order.

- **Parallel scanning:** `scanner.py` (15 workers), `discover.py` (10 workers). `UWRateLimitError` skips ticker, doesn't crash.
- **Atomic state:** `scripts/utils/atomic_io.py` — `atomic_save()` (temp + `os.replace()` + SHA-256), `verified_load()`.
- **Batched WS relay:** `ib_realtime_server.js` — per-client last-write-wins, 100ms flush. 5000 msg/s → 10 batched/s.
- **Stale tick detection:** 30s check, 45s no-ticks → auto-restart Gateway (120s cooldown).
- **WS state machine** (`usePrices.ts`): `idle → connecting → open → closed`. `connStateRef` idempotent connect, `socketGenRef` ignores stale events, diff-based sub/unsub, callback refs, exponential backoff (1s–30s, max 10).
- **Vectorized:** `kelly_size_batch()` (NumPy), `portfolio_greeks_vectorized()`. Cross-validated to 10⁻¹².
- **IBClient resilience:** disconnect recovery (5 attempts, 2ⁿs cap 30s); pacing violations (162/366: 10s backoff); invalid contracts (200/354: no retry, `_failed_contracts`).
- **Performance page:** Phase A sequential IB+cache; Phase B ThreadPool UW/Yahoo. `PERF_FETCH_WORKERS` env (default 8). Disk cache `data/price_history_cache/` TTL 15min/24h. SWR via `POST /performance/background`.

---

## Evaluation — 7 Milestones (Stop on Failure)

1. Validate ticker → `scripts/fetch_ticker.py`
   - 1B Seasonality · 1C Analyst ratings · 1D News / catalysts (context)
2. Dark pool flow → `scripts/fetch_flow.py` (with intraday interpolation)
3. Options flow → `scripts/fetch_options.py`
   - 3B OI changes → `scripts/fetch_oi_changes.py` (REQUIRED)
4. **Edge decision — PASS/FAIL** (FAIL = stop)
5. Structure — convex (R:R < 2:1 = stop)
6. Kelly sizing — enforce 2.5% cap
7. Log → `trade_log.json` (executed) or `docs/status.md` (NO_TRADE)

### Intraday Dark Pool Interpolation

During market hours, today's partial data is volume-weighted interpolated. **Always output BOTH actual and interpolated values.**

`progress = minutes since 9:30 ET / 390`. Projected = actual / progress. Blend: `(projected × progress) + (prior_5d_avg × (1 - progress))`. Pace = actual / (avg_prior × progress).

| Progress | Confidence | Prior weight |
|---|---|---|
| 0–25% | VERY_LOW | 75%+ |
| 25–50% | LOW | 50–75% |
| 50–75% | MEDIUM | 25–50% |
| 75–100% | HIGH | <25% |

Use interpolated for edge assessment. LOW/VERY_LOW → re-evaluate after 2 PM ET. Pace>1.2x → real. Actual opposite prior → likely reversal.

### Signal Interpretation

- **P/C Ratio:** >2.0 BEAR | 1.2–2.0 LEAN_BEAR | 0.8–1.2 NEUTRAL | 0.5–0.8 LEAN_BULL | <0.5 BULL
- **Flow Side:** Ask-dominant = buying | Bid-dominant = selling
- **Analyst Buy%:** ≥70% BULL | 50–69% LEAN_BULL | 30–49% LEAN_BEAR | <30% BEAR
- **Seasonality:** >60% FAVORABLE | 50–60% NEUTRAL | <50% UNFAVORABLE

> Seasonality / ratings = context, not gates. Strong flow overrides weak seasonality.

### Seasonality Fallback
UW → EquityClock Vision (Claude Haiku) → Cache (`data/seasonality_cache/{TICKER}.json`). Route: `web/app/api/ticker/seasonality/route.ts`. Key resolution: `resolveApiKey()` checks `ANTHROPIC_API_KEY`, `CLAUDE_CODE_API_KEY`, `CLAUDE_API_KEY`.

---

## Reports — Mandatory at Milestone 5

| Report | Template | Output |
|---|---|---|
| Trade Spec | `.pi/skills/html-report/trade-specification-template.html` | `reports/{ticker}-evaluation-{YYYY-MM-DD}.html` |
| P&L | `.pi/skills/html-report/pnl-template.html` | `reports/pnl-{TICKER}-{YYYY-MM-DD}.html` |
| Share PnL Card | `next/og` (Satori), 1200x630 PNG | `web/app/api/share/pnl/route.tsx` |

Reference: `reports/goog-evaluation-2026-03-04.html`. Trade Spec sections: Header+gates, Summary Metrics, Milestone pass/fail, Dark Pool, Options Flow, Context, Structure & Kelly, Trade Spec, Thesis & Risk, Four Gates table.

`Return on Risk = P&L / Capital at Risk`

---

## Commands

| Command | Action |
|---|---|
| `scan` / `discover` | Watchlist scan / market-wide flow |
| `evaluate [TICKER]` | Full 7-milestone eval |
| `portfolio` / `sync` | Positions / pull from IB |
| `blotter` / `blotter-history` | Today / historical |
| `leap-scan` / `garch-convergence` / `seasonal` | IV mispricing / GARCH / seasonality |
| `analyst-ratings [TICKERS]` | Ratings + targets |
| `vcg-scan` / `cri-scan` / `gex-scan` | Vol-credit gap / Crash Risk Index / Gamma |
| `menthorq-{cta,dashboard,screener,forex,summary,quin}` | MenthorQ tools |

---

## Critical Data Files

| File | Purpose |
|---|---|
| `data/portfolio.json` | Open positions, bankroll, exposure |
| `data/trade_log.json` | **Append-only** trade journal |
| `data/watchlist.json` | Surveillance tickers |
| `data/tag_taxonomy.json` | Auto-growing UPPERCASE tag list (force-tracked) |
| `data/{vcg,gex}.json` | Scan caches |
| `data/price_history_cache/` | Auto-pruned at 500 |

`data/replica.db` (the libsql embedded replica) was decommissioned 2026-05-20. The file must NOT exist on any host that runs Radon — see `feedback_libsql_replica_one_writer.md` and the "Two-Mode Deployment" section above. If the file appears in `data/` (a stray from older versions or a manual sync attempt) it is safe to delete; nothing reads from it.

---

## Startup Checklist

- [ ] `scripts/cloud.sh` (default) or `scripts/local.sh`
- [ ] `curl http://localhost:8321/health` → `ib_gateway.port_listening: true`
- [ ] Reconciliation, exit orders, CRI scan auto-running
- [ ] Check market hours: `TZ=America/New_York date +"%A %H:%M"` (9:30–16:00 ET, Mon–Fri)

## Output Discipline

- Always `signal → structure → Kelly math → decision`
- State probabilities; flag uncertainty
- Failing gate = stop, name the gate
- **Never rationalize a bad trade**
