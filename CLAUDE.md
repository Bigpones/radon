# RADON — CLAUDE.md

**Radon** = market-structure reconstruction. Surfaces convex opportunities from dark pool / OTC flow, vol surfaces, cross-asset positioning. **Flow signal or nothing.**

Brand: `docs/brand-identity.md` · Structures: `docs/options-structures.{json,md}` · UW spec: `docs/unusual_whales_api.md` · Cloud runbook: `docs/cloud-services.md`

---

## Behavioral Guidelines

**Think before coding.** State assumptions, surface tradeoffs, ask when unclear. Don't pick silently between interpretations.

**Simplicity first.** Minimum code that solves the problem. No speculative features, abstractions for single-use code, "flexibility" not requested, or error handling for impossible scenarios. If 200 lines could be 50, rewrite.

**Surgical changes.** Touch only what you must. Don't "improve" adjacent code/comments/formatting or refactor unrelated things. Match existing style. Remove orphans YOUR changes created; leave pre-existing dead code alone unless asked. Every changed line should trace to the user's request.

**Goal-driven execution.** Transform tasks into verifiable goals ("add validation" → "write tests for invalid inputs, then make them pass"). State a brief plan for multi-step work. Strong success criteria let you loop independently.

---

## ⛔ Mandatory Rules

1. **Be concise.** No preamble.
2. **Red/green TDD always.** Vitest (unit), chrome-cdp / Playwright (E2E). Target 95% coverage.
3. **E2E browser verification for all UI work.** Primary `chrome-cdp`, fallback Playwright (`web/playwright.config.ts`).
4. **API keys** in `.env` files. Never `~/.zshrc` unless fallback.
5. **No raw hex in UI.** Use brand tokens. 4px max border-radius on panels.
6. **No em dashes in user-facing copy.**

## ⛔ Four Gates — Sequential, No Exceptions

| Gate | Rule |
|---|---|
| 1. Convexity | Gain ≥ 2× loss. Defined-risk only. |
| 2. Edge | Specific, data-backed dark-pool / OTC signal that hasn't moved price. |
| 3. Risk | Fractional Kelly. Hard cap 2.5% bankroll / position. |
| 4. ~~No naked shorts~~ | **DISABLED 2026-04-30.** Logic preserved as `_*Impl`. Re-enable: `docs/naked-short-reenable.md`. |

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

**IB Flex env (Hetzner `/home/radon/radon-cloud/.env`):** `IB_FLEX_TOKEN`, `IB_FLEX_QUERY_ID=1422766` (blotter), `IB_FLEX_NAV_QUERY_ID=1497709` (CashTransactions — don't repurpose for trade pulls), `IB_GATEWAY_MODE=docker`, `IB_GATEWAY_COMPOSE_DIR=/home/radon/radon-cloud` (required; in-tree default is wrong on VPS). Journal rehydrate uses query `1442520` via `IB_FLEX_QUERY_ID` at runtime.

**`.env` values with `$` need single-quoting.** Bash `set -a; . file; set +a` shell-expands `$VAR` under `set -u` and aborts silently from systemd. Single-quote (`PASS='RX$abc!xyz'`) or use systemd `EnvironmentFile=` / `python-dotenv`. See `feedback_env_file_shell_expansion.md`.

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

- **FastAPI localhost bypass:** `client.host in {127.0.0.1, ::1}` → auth skipped (covers Next.js → FastAPI). `scripts/api/auth.py:51-54`.
- **Next.js localhost bypass:** auto when `NODE_ENV !== "production"`. `RADON_AUTHLESS_TEST=1` for Playwright.
- **Auth-exempt:** `/health`, `/ws-ticket/validate`, `/docs`, `/openapi.json`, all `*/share` routes.

### IB Gateway — Three Modes

`IB_GATEWAY_MODE` env, persisted to `.env.ib-mode`. Toggle via `scripts/ib mode {local|cloud}`. Switching does NOT auto-reconnect — restart the dev stack.

- **`docker`** (default local; also Hetzner since 2026-05-07): `ghcr.io/gnzsnz/ib-gateway`, `restart: unless-stopped`. `npm run ib:start`. **Hetzner gotcha:** container launched by `radon-ib-gateway.service` from `/home/radon/radon-cloud/`, not in-tree `<repo>/docker/ib-gateway/`. `IB_GATEWAY_COMPOSE_DIR=/home/radon/radon-cloud` is required.
- **`cloud`** (laptop dev default): Hetzner VM `ib-gateway:4001` via Tailscale. TCP probe only — `POST /ib/restart` returns 503. Laptop aliases (SSH-wrapped, `~/.zshrc`): `ibstart/stop/restart/status/logs/health`. **Whole-stack VPS control** via `/usr/local/bin/radon` (or `ssh root@ib-gateway radon <cmd>`): `radon stop|start|restart|status` operates on all `radon-*` units (auto-enumerates via `systemctl list-units 'radon-*' --all`). Source: `radon-cloud/scripts/operator-radon.sh`; installed by `setup-vps.sh:install_operator_cli()`.
- **`launchd`** (legacy): `~/ibc/bin/`, Mon-Fri auto-lifecycle.

Auto-recovery (docker): port + CLOSE_WAIT detection at startup (poll 45s); subprocess errors trigger health check first — only restart if port not listening or CLOSE_WAIT. Client ID collisions, VOL errors, transient timeouts do NOT trigger restart.

**2FA-aware restart with backoff + cross-process push lock.** After restart, IB Gateway sits at IBKR Mobile push prompt with API socket open — `port_listening:true` falsely reports success. Three gates:

1. **Cross-process push lock** (`scripts/utils/ib_2fa_lock.py`, `/var/lib/radon/ib-2fa-push-lock.json`, 10-min TTL). Every restart path that fires a push acquires the lock first; while held, requests REJECTED with `reason="2fa_push_in_flight"`. Defends against stacked-push rejection (IBKR's backend can't reconcile multiple pending push tokens — every approval shows "unsuccessful" when pushes pile up).
2. **In-memory backoff ladder** (per-process). `restart_ib_gateway()` runs `managedAccounts()` probe post-restart; non-empty resets backoff, empty advances (1m → 2m → 5m → 15m → 30m → 60m capped).
3. **Watchdog stuck-2FA self-heal (2026-05-20).** `is_stuck_awaiting_2fa()` fires when `auth_state=awaiting_2fa` AND `push_lock_active=false` AND `next_attempt_in_secs<=0`. After 3 consecutive stuck cycles (~3 min), watchdog acquires lock + triggers `systemctl restart radon-ib-gateway.service`. `stuck_2fa_count` freezes during push-in-flight/backoff; resets only on `auth_state=authenticated`.

`/health` exposes `auth_state`, `service_state`, `upstream_dead`, `restart_backoff` (incl. `push_lock`, `attempt_count`, `next_attempt_in_secs`). Next.js footer reads via `useIBStatusContext().displayStatus` (polls `/api/admin/health` every 15s) — fixes "footer says CONNECTED while banner says degraded". **`POST /ib/reset-backoff`** clears BOTH in-memory backoff AND push lock — operator escape hatch after manual 2FA approval.

IBC-side relogin on 2FA timeout is **disabled** (`TWOFA_TIMEOUT_ACTION: exit`, `RELOGIN_AFTER_TWOFA_TIMEOUT: "no"` in `docker/ib-gateway/docker-compose.yml`). VPS counterpart uses IBC default (`no`). **Do not re-enable** anywhere; bypasses the push lock.

See `scripts/api/ib_gateway.py:restart_ib_gateway`, `scripts/ib_watchdog.py:run_cycle`, `scripts/utils/ib_2fa_lock.py`.

**IB request bounding pattern.** `ib_insync` has no per-request timeout. When IB Gateway is logged in but awaiting 2FA, `qualifyContractsAsync`/`reqHistoricalDataAsync`/`reqMktData` block forever. Scripts importing `ib_insync` directly **must**: (1) wrap every IB await in `asyncio.wait_for(..., timeout=15)`, (2) pre-check FastAPI `/health` for `auth_state == "authenticated"` before `IB()`. See `scripts/cri_scan.py:_fetch_ib`.

### Client ID Ranges

| Range | Usage |
|---|---|
| 0–9 | FastAPI IBPool (sync=3, orders=4, data=5) |
| 10–19 | WS relay |
| 20–49 | Subprocess scripts AND monitor_daemon handlers — **always `client_id="auto"`** |
| 50–69 | Scanners |
| 90–99 | CLI |

**Never hardcode in 20–49.** As of 2026-05-20 daemon handlers (`fill_monitor`, `exit_orders`, `journal_sync`) also use `client_id="auto"` — prior hardcoded 70/71/72 left them one CLOSE_WAIT away from stuck "client id already in use". Auto-allocator: `scripts/clients/ib_client.py:_connect_auto_allocate`.

### Two-Mode Deployment

Both modes read/write the **same Turso DB** (`libsql://radon-joemccann.aws-us-west-2.turso.io`) **direct-to-cloud — no embedded replica anywhere as of 2026-05-20**. JSON files in `data/` are written alongside as fallback. The libsql embedded replica was retired after WAL conflicts between multi-writer-per-host and direct-cloud writers. All processes run with `Environment=RADON_DB_NO_REPLICA=1`. Reads +30–60 ms (absorbed by SWR); WAL contention structurally impossible. See `feedback_libsql_replica_one_writer.md`.

- `scripts/cloud.sh` → `RADON_MODE=hetzner`. Schedulers run as systemd on Hetzner (`radon-{api,monitor,relay,refresh,nextjs}`); laptop runs only Next.js + newsfeed. `app.radon.run` serves when laptop closed.
- `scripts/local.sh` → `RADON_MODE=local`. Laptop launchd plists own all schedulers.

**Auto-deploy on push to main.** `.github/workflows/deploy.yml` SSHes to Hetzner and runs `bash scripts/deploy.sh` from `~/radon-cloud/`. `git push origin main` IS the deploy. Confirm: `gh run list --workflow=deploy.yml --limit 1`. After deploy, `sudo systemctl restart radon-api.service` may be needed.

Schema: `scripts/db/migrations/0001_init.sql`. Writers: `scripts/db/writer.{js,py}`. Routes prefer DB, fall back to disk.

**Image host:** `https://media.radon.run` (Caddy on Hetzner, fed by laptop rsync over Tailscale). Posts use absolute URLs. Fallback: `RADON_MEDIA_REMOTE=radon@5.78.148.38:/home/radon/radon-cloud/media/`.

**Newsfeed is Hetzner-resident.** Headless Playwright; auth via `THEMARKETEAR_EMAIL`/`THEMARKETEAR_PASSWORD`. Session at `data/newsfeed-storage.json` (gitignored, ~30d), re-auth every ~6h. Polls 120s. Service: `radon-newsfeed.service` (`Restart=on-failure`). On Hetzner `RADON_MEDIA_REMOTE=/home/radon/radon-cloud/media/`. Local: `node scripts/newsfeed/index.js --once`.

**Trades canonical store:** Turso `journal` table. `/journal` and `/orders` both derive from it. `/orders` uses `web/lib/blotter/fromJournal.ts:journalRowsToBlotter()` with fallback to `data/blotter.json` for legacy rows lacking `realized_pnl`/`cost_basis`/`proceeds`. See `docs/cloud-services.md`.

### Autonomous Timers (Hetzner)

| Timer | Cadence | Endpoint |
|---|---|---|
| `radon-refresh.timer` | Mon–Fri */15min | direct `scripts/data_refresh.py` |
| `radon-vcg-refresh.timer` | Mon–Fri 13–21 UTC */5min | `POST /vcg/scan` |
| `radon-portfolio-sync.timer` | Mon–Fri 13–21 UTC */60s | `POST /portfolio/sync` |
| `radon-cta-sync.timer` | Mon–Fri 18:15, 19:00, 21:30 UTC | `POST /menthorq/cta` |
| `radon-watchdog-{intraday,continuous,daily,error}.timer` | see below | reads `service_health` |

Unit files in `radon-cloud/services/`; enumerated by `setup-vps.sh SERVICE_FILES`. Wrappers use literal env parser (not `set -a`) to avoid `$VAR` expansion.

### Service Health Watchdog

Four buckets at `scripts/watchdog/`, monitors every `scheduled` service in `web/lib/serviceHealthWindows.ts`, notifies via Pushover (P1 only) + always-on `service_health` row:

- **`intraday`**: `vcg-scan`, `cri-scan`, `orders-sync`, `portfolio-sync` — 5 min, Mon–Fri 13:00–21:00 UTC.
- **`continuous`**: `newsfeed-scraper`, `replica-watchdog`, `fill-monitor`, `exit-orders`, `journal-sync` — 5 min, 24/7.
- **`daily`**: `cash-flow-sync`, `flex-token-check`, `cta-sync` — hourly, 24/7.
- **`error`**: every scheduled service except `watchdog-alerts` (recursive-alert prevention) — 5 min, 24/7.

Anti-flood: 2-consecutive-failure hysteresis; 1h per-(service,severity) cooldown in `watchdog_cooldowns`; `python -m scripts.watchdog ack <service>` for 4h muting. Env: `PUSHOVER_USER`, `PUSHOVER_TOKEN` (absent = degrade gracefully).

Services tagged `scheduled` or `on-demand`. Stale `scheduled` → red banner. Stale `on-demand` → `state="dormant"`, amber chip. **Event-driven writers** (`replica-watchdog`, `watchdog-alerts`) use 24h windows — tight windows treat quiet healthy periods as stale.

### Monitor Daemon Market-Hours Gate

`scripts/monitor_daemon/daemon.py:is_market_hours()` gates handlers with `requires_market_hours=True`. Uses `datetime.now(ZoneInfo("America/New_York"))` for EST↔EDT auto via tzdata; fail-open UTC-5 fallback. **Never reintroduce hardcoded offsets.** See `feedback_hardcoded_timezone_offsets.md`.

### Production Build Constraint

Next.js 16 prerender crashes on `/_global-error` + `/_not-found` (root ClerkProvider not materialised in workers). `web/package.json` build uses `next build --experimental-build-mode=compile`. `app/error.tsx`, `app/[ticker]/not-found.tsx`, `app/global-error.tsx` use plain `<a>` + pure JSX (no `next/link`, no `useEffect`, no `globals.css`).

---

## ⚠️ Cache Contract — Disk-Backed Routes

Every Next.js GET handler reading live disk state (`data/*.json`, `data/menthorq_cache/`) **MUST** export `dynamic = "force-dynamic"`. Every client fetch hitting these routes **MUST** pass `cache: "no-store"`.

Covered routes: `menthorq/cta`, `journal`, `discover`, `flow-analysis`, `blotter`, `vcg`, `internals`, `portfolio`, `performance`, `scanner`, `regime`, `gex`, `orders`, `service-health`. Hooks: `useMenthorqCta`, `useSyncHook`, `useJournal`, `usePortfolio`, `useDiscover`, `useOrders`. Contract test: `web/tests/api-routes-no-cache-contract.test.ts`.

---

## Combo / BAG Order Guardrails

1. **Never map combo `Order.action` from debit vs credit.** IB combo legs define structure. SELL envelope reverses legs. For entry: keep envelope BUY, preserve per-leg actions.
2. **`ComboLeg.action` = structure, not direction.** Always `LONG → BUY`, `SHORT → SELL`. Flipping causes IB error 201.
3. **Structure change → invalidate manual net price.** Recompute from normalized combo quote on single-leg ↔ combo transitions.
4. **Combo natural market uses cross-fields:** BUY combo pays ASK on BUY legs, BID on SELL legs; SELL combo receives BID on BUY legs, ASK on SELL legs. Impls: `computeNetOptionQuote()`, `ComboOrderForm.netPrices`, `resolveOrderPriceData()`.
5. **Trace path before fixing:** chain builder → `/api/orders/place` → FastAPI bridge → `scripts/ib_place_order.py`.
6. **Required regressions:** unit (action/ratio/net-price), browser (displayed net + submitted payload).
7. **Closing-trade detection (2026-05-20, commit e55b643).** `OrderRiskLeg.coveringLongContracts` tells risk model how many contracts of the exact same option are held LONG. SELL with `coveringLongContracts >= effectiveContracts` short-circuits to `maxLoss: 0`. SELL with `coveringLongContracts < effectiveContracts` flags only excess (M−N) as naked. Wired in `OrderTab.NewOrderForm.orderSummary`. Without this, every SELL-to-close of a long call triggered false "Uncovered short call". See `web/lib/orderRisk.ts:36-50` (field), `:187-219` (short-circuit), `:277-285` (multi-leg discount), `:311-315` (helper).

### IB Error Message Rendering

IBKR rejection text embeds literal `<br>` tokens. `web/lib/orderError.ts:formatOrderError` normalises every variant to `\n` BEFORE prefix-stripping. `.order-error-detail` in `globals.css` uses `white-space: pre-line`. Never use `dangerouslySetInnerHTML` for IB text.

## Cancel / Modify Failure Propagation

1. **Use subprocess with original clientId.** Master (0) sees all orders but can't modify (Error 10147/103). `ib_order_manage.py` reconnects as original.
2. **Clear VOL fields before modify.** Reset `volatility`/`volatilityType` to IB sentinels (`1.7976931348623157e+308` / `2147483647`) to avoid Error 321.
3. **Confirm against refreshed open-order snapshot**, not stale `Trade`. Disappearance after cancel = success.
4. **Preserve upstream error detail.** Subprocess JSON → FastAPI `detail` → Next.js. Never collapse to 500.
5. **Required regressions:** unit, route, browser.

---

## Calculations — Correctness Rules

### Sign Convention
Credits negative, debits positive. **Never `Math.abs()` on option prices without approval.** Preserve sign through entire display pipeline.

### Daily Change %
```
Day Chg % = Daily P&L / |Yesterday's Close Value| × 100   (NEVER entry cost)
```
Per-leg: `sign × (last - close) × contracts × 100`. Impl: `getOptionDailyChg()`.

**Same-day exception:** `entry_date == today (ET)` → yesterday's close meaningless. Day Chg + Today P&L use entry-cost baseline → Today P&L = Total P&L = `MV − EC`. `ib_daily_pnl` ignored same-day.

### Entry-Date Resolution (`ib_sync.py`)

Strict ordered fallback, MOST → LEAST specific:
1. blotter (per-contract: `ticker|expiry|right|strike`)
2. trade_log (`ticker|structure`)
3. IB fills (per-contract, same-session)
4. prev portfolio (`ticker|structure|expiry`, excluding today)
5. **today** ← brand-new positions land here

**Never use per-ticker blotter fallback.** Test: `test_combo_entry_date.py`.

### Position Cache Refresh

`ib_insync.positions()` returns in-memory cache. TWS push updates `pos.position` immediately but `pos.avgCost` lags while TWS recomputes VWAP server-side. `IBClient.get_positions()` calls `reqPositions()` + `sleep(1)` BEFORE reading, draining pending updates so size and avgCost are consistent. Without this, portfolio syncs in seconds after a fill wrote mismatched `(size_new, avg_old)`. Opt out via `get_positions(refresh=False)` for tight read loops. Try/except so gateway hiccups fall back to cache. Tests: `test_ib_client.py::TestPortfolioOperations`. Added 2026-05-20 (commit 5d10def).

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

Combo: signed sum across legs. Files: `web/lib/blackScholes.ts`, `impliedValue.ts`, `useRiskFreeRate.ts`. Columns gated on `positions.some(p => p.structure_type !== "Stock")`.

### Position Structure (`detect_structure_type()`)
Stock→equity. Long Call/Put→defined. Short Call/Put→undefined. Spreads→defined. Synthetic/Risk Reversal→undefined. Long Straddle→defined. Covered Call→defined. All-long combo→defined. Unrecognized→complex (→Undefined Risk table).

### Data Normalization
JSON: `"ticker"`. IB contracts: `"symbol"`. Read defensively: `t.get("ticker") or t.get("symbol")`.

### Margin Warning Thresholds (`web/lib/marginWarning.ts`)

```
critical:  excess_liquidity ≤ 0                              (active margin call)
critical:  cushion < 0.01                                    (imminent)
warning:   cushion < 0.05                                    (approaching)
warning:   equity_with_loan_value ≤ maint_margin_req × 1.10  (IBKR rule)
none:      otherwise

cushion = excess_liquidity / net_liquidation
```

`assessMargin()` is pure — derives on client from `portfolio.account_summary`. Toast in `WorkspaceShell.tsx`; `prevMarginLevelRef` fires only on transition to higher rank (`none < warning < critical`). Dismiss via `×`. **Never auto-dismiss** (`addToast(..., 0)`). Tests: `web/tests/margin-warning.test.ts` (12), `web/e2e/margin-warning-toast.spec.ts` (6).

---

## Component Cheat Sheet

| Tab | Key Files | Notes |
|---|---|---|
| **VCG** | `useVcg.ts`, `vcgStaleness.ts`, `app/api/vcg/route.ts`, `VcgPanel.tsx`, `vcg_scan.py`, `data/vcg.json` | RO: VIX>28 + VCG>2.5. EDR: VIX>25 + VCG 2.0–2.5. BOUNCE: VCG<-3.5. VVIX = amplifier, not gate. `POST /vcg/{scan,share}`, 60s cooldown. Autonomous 5-min via `radon-vcg-refresh.timer`. Wrapper POSTs `/vcg/scan`, fallback direct script. 15min banner window. |
| **GEX** | `useGex.ts`, `gexStaleness.ts`, `app/api/gex/route.ts`, `GexPanel.tsx`, `gex_scan.py`, `data/gex.json` | UW: `call_gex` positive, `put_gex` negative, `net = call_gex + put_gex` (no negation). Levels: GEX Flip, Max Magnet, Max Accelerator, Put/Call Wall. Bias: BULL/CAUTIOUS_BULL/NEUTRAL/CAUTIOUS_BEAR/BEAR. 71 tests. |
| **CRI / Regime** | `criStaleness.ts`, `regime` route triggers `cri_scan.py` | Stale if `data.date != today` OR (market_open AND mtime>60s). CRI `history` carries ~251 days; chart slices for display; statistical windows are explicit constants. |
| **Regime market-closed** | `RegimePanel` | Use `data.{vix,vvix,spy}` only. `activeCorr = data.cor1m`. `liveCri / intradayRvol = null`. Don't update VIX/VVIX timestamps. COR1M = DAILY. |
| **Regime day-change** | `.regime-strip-day-chg` | VIX/VVIX/SPY: WS `last` vs `close`. RVOL: `intradayRvol - data.realized_vol`. COR1M: `data.cor1m_5d_change`. Arrow right of change via `display: flex; gap: 4px`. |
| **Regime history** | `CriHistoryChart.tsx` | 20 sessions, 440px. L: VIX `#05AD98` + VVIX `#8B5CF6`. R: RVOL `#F5A623` + COR1M `#D946A8`. |
| **CRI spread zoom** | `RegimeRelationshipView.tsx`, `regimeRelationships.ts` | "Correlation Risk Premium" on `/regime/cri`: presets (`1M/3M/6M/1Y/All`, default `1Y`) + brush minimap (hand-built pointer events, no `d3.brushX`). `Z_SCORE_WINDOW=20` scoped to full history, not visible slice. Brand tokens, 4px radius. |
| **Options Chain sticky header** | `OptionsChainTab.tsx` | Three required CSS rules: `background: var(--bg-panel-raised)` on `.chain-header`+`.chain-side-label`; `position: sticky; top: 0`/`top: 24px`; `.chain-grid thead { position: relative; z-index: 10 }`. |
| **Column visibility** | `useColumnVisibility(tableId, defaults)` | `localStorage` keyed `radon:columns:<tableId>`. Buckets: `positions-{defined,undefined,equity}`, `orders-open`. `<ColumnsToggle />` left of filter input. |
| **Margin Warning Toast** | `marginWarning.ts`, `WorkspaceShell.tsx` | Stage 1 — threshold-derived from `portfolio.account_summary`. Persistent toast, fires only on transition to worse rank. |
| **Cash Flows** (on `/orders`) | `scripts/cash_flow_sync.py`, `0002_cash_flows.sql`, `GET /cash-flows`, `useCashFlows.ts`, `CashFlowsSection.tsx`, `handlers/cash_flow_sync.py` | IBKR `CashTransaction` rows (deposits/withdrawals/dividends/interest/fees/withholding). Reads `IB_FLEX_NAV_QUERY_ID`. Idempotent on `transactionID`. **Cadence: once per ET trading day at 17:00 ET.** Skips weekends + US holidays via `utils.market_calendar`. Throttle-aware backoff on Flex 1001/1018/1019: 24h→48h→72h→168h capped. 36 pytest + 4 vitest + 7 Playwright. |
| **LLM Token Index** (on `/regime/llm`) | `scripts/llm_token_index.py`, `0007_llm_token_index.sql`, `GET /llm-token-index`, `useLlmTokenIndex.ts`, `LlmTokenIndexCard.tsx`, `radon-llm-index.{service,timer}` | Pulls Artificial Analysis API once daily 06:30 UTC. Per-model blended `0.7*input + 0.3*output`, `raw_avg_usd = median(basket)`. Basket: GPT-4o, Opus 4.7, Sonnet 4.5, Gemini 2.5 Pro, DeepSeek V3, Llama 3.1 405B, Mistral Large. Missing models skip. Normalised to 1.0 on first persisted UTC date. Env: `ARTIFICIAL_ANALYSIS_API_KEY`. 25h service-health window. |
| **Mobile shell** (PWA, 393×852) | `useViewport.ts`, `breakpoints.ts`, `components/mobile/{MobileShell,MobileAppBar,MobileTabBar,MobileMoreDrawer,TickerSearch,Card,BottomSheet}.tsx`, `PwaRegister.tsx`, `public/{manifest.webmanifest,sw.js}` | `useViewport()` (≤640 / 641-1023 / ≥1024) drives `<MobileShell>` from `WorkspaceShell` when `isMobile && hasMounted`. Sets `body[data-mobile="true"]`. Manifest standalone, theme #0a0f14. Hand-written SW bypasses `/api`, `/_next/data`, `/ws` to preserve cache contract. |
| **Mobile variants** | `mobile/{MobilePositionList,MobileOrderList,MobileBlotterList,MobileExecutedList,MobileJournalList,MobileChainLadder,MobileOrderTicket}.tsx` | Branched via `isMobile && hasMounted`. All P&L/combo math reused. Chain ladder 2-col, tap → BottomSheet detail with Greeks. Pending strip → `MobileOrderTicket` posts `/api/orders/place` with same body shape. |
| **Mobile tests** | `tests/{use-viewport,mobile-bottom-sheet}.test.*` (15 vitest); `e2e/mobile-*.spec.ts` (48 Playwright at 393×852) | `PLAYWRIGHT_PORT=3033 npx playwright test --project=mobile`. E2E stubs API + skips WS prices. |

---

## Newsfeed Scraper

Module split under `scripts/newsfeed/` (`paths`, `browser`, `auth`, `cdp`, `extract`, `media`, `store`, `tagger`, `vision_tagger`, `taxonomy`, `scheduler`, `index`). Output shape locked by `web/components/DashboardNewsFeed.tsx` (`MarketEarPost`).

**Key behaviors:**
- **Headless Playwright** replaces chrome-cdp. Env: `THEMARKETEAR_EMAIL`, `THEMARKETEAR_PASSWORD`. Session `data/newsfeed-storage.json` reuses; full re-auth ~6h. `cdp.js` is a back-compat shim.
- **IPv4 forced** for `themarketear.com` CDN and `api.cerebras.ai` — both AAAA-unreachable from residential IPv6.
- **Cookie-gated images:** `media.js` accepts `getCookieHeader` callback; Playwright `context.cookies()` follows `/images/<hash>.png` 301 → digitaloceanspaces.
- **Rollover** at 500 KB → archive + keep ⌈N×0.2⌉. `mergePosts` preserves `tags`.

**Tagging:**
- Router: vision tagger (`claude-haiku-4-5`, ~$0.003/post) for posts with images; text tagger (Cerebras `gpt-oss-120b` → fallback `qwen-3-235b-a22b-instruct-2507`).
- gpt-oss-120b needs `max_tokens: 800` (reasoning model).
- Exactly **3 tags per post**, free-form.
- **Naming** (`__normaliseTags`): UPPERCASE, multi-word UPPERCASE-KEBAB-CASE (`PUT-CALL-RATIO`), allowed `A-Z 0-9 - &`, case-insensitive dedup.
- `hydrateTags` skips posts with `tags.length >= 3` unless `force=true`.
- `data/tag_taxonomy.json` force-tracked. Filter chips auto-derive.
- Either `CEREBRAS_API_KEY` or `ANTHROPIC_API_KEY` sufficient.

**Backfill:** `scripts/newsfeed/backfill_tags.js`. `--retag` re-tags all. Throttles to ~24 req/min.

**`concurrently` env quirk:** `index.js` explicitly loads `web/.env` + root `.env` via `dotenv`.

**Filter UI:** Per-post chips, AND-semantics with ≥2. Active filters as top bar with × + "Clear all". Deep-link: `/dashboard?tags=BTC,vol`. URL writes in post-commit `useEffect`.

**Env overrides:** `RADON_NEWSFEED_DATA_DIR`, `_POSTS_FILE`, `_ARCHIVE_DIR`, `_MEDIA_DIR`, `_PUBLIC_ROOT`, `CDP_CLI`.

**Tests:** 64 cases across `newsfeed-{scraper,tagger,taxonomy,time}`, `dashboard-newsfeed-{pagination,tag-filter}`.

---

## Theme System

- **Single source of truth:** `web/lib/ThemeContext.tsx` (`useTheme()`). Never duplicate theme state.
- **Pre-paint bootstrap:** `ThemeBootstrap.tsx` mounts in `<head>` and synchronously sets `data-theme` on `<html>` from `localStorage.theme` or `prefers-color-scheme` BEFORE React hydrates. Eliminates FOWT.
- **SSR theme pinned to `"dark"`** in `ThemeContext.tsx:SSR_THEME`. Provider's initial `useState` MUST return this constant — never read localStorage/matchMedia/`data-theme` during first render, or React #418 hydration mismatch fires for every light-theme user. Post-mount `useEffect` reconciles via `readClientTheme()`. Commit 68c6e57 + `tests/theme-provider-hydration.test.tsx`.
- **Brand tokens via `color-mix(in srgb, var(--token) X%, transparent)`** — never bake raw `rgba(R,G,B,α)`. Raw rgba doesn't shift between light/dark CSS vars; `color-mix` does. Tailwind `green-500`/`red-500` are NOT brand — replace with `var(--positive)`/`var(--negative)`.
- **`<meta name="theme-color">` owned by Next.js viewport metadata** — declare light/dark variants via `viewport.themeColor`. Do NOT mutate from client code.
- **`<head>` and `data-theme`** — root layout sets `suppressHydrationWarning` on `<html>`; `ThemeBootstrap` paints the attribute. Do not hardcode `data-theme="dark"` in JSX.
- **IB Gateway status display** — `IBStatusContext.displayStatus`: `connected | awaiting_2fa | unhealthy | unreachable | ib_offline | relay_offline`, derived from WS-relay + `/api/admin/health` (15s poll). Sidebar footer + MobileAppBar chip both read this. Amber `.status-dot-warn` for `awaiting_2fa`.
- **ETF Company tab filter** — `CompanyTab.tsx` hides equity-only stats (Market Cap, P/E, EPS, Next Earnings) when `uw_info.issue_type` matches `ETF|ETN|FUND|MUTUAL|REIT`. Drops Div Yield too for `INDEX|IDX`.

---

## High-Throughput Architecture

500+ symbols, <500ms signal-to-order.

- **Parallel scanning:** `scanner.py` (15 workers), `discover.py` (10 workers). `UWRateLimitError` skips ticker.
- **Atomic state:** `scripts/utils/atomic_io.py` — `atomic_save()` (temp + `os.replace()` + SHA-256), `verified_load()`.
- **Batched WS relay:** per-client last-write-wins, 100ms flush. 5000 msg/s → 10 batched/s.
- **Stale tick detection:** 30s check, 45s no-ticks → auto-restart Gateway (120s cooldown).
- **WS state machine** (`usePrices.ts`): `idle → connecting → open → closed`. `connStateRef` idempotent connect, `socketGenRef` ignores stale events, diff-based sub/unsub, exponential backoff (1s–30s, max 10).
- **Vectorized:** `kelly_size_batch()` (NumPy), `portfolio_greeks_vectorized()`. Cross-validated to 10⁻¹².
- **IBClient resilience:** disconnect recovery (5 attempts, 2ⁿs cap 30s); pacing (162/366: 10s backoff); invalid contracts (200/354: no retry, `_failed_contracts`).
- **Performance page:** Phase A sequential IB+cache; Phase B ThreadPool UW/Yahoo. `PERF_FETCH_WORKERS` (default 8). Disk cache TTL 15min/24h. SWR via `POST /performance/background`.

---

## Evaluation — 7 Milestones (Stop on Failure)

1. Validate ticker → `scripts/fetch_ticker.py` (1B Seasonality · 1C Analyst · 1D News)
2. Dark pool flow → `scripts/fetch_flow.py` (with intraday interpolation)
3. Options flow → `scripts/fetch_options.py` (3B OI changes → `fetch_oi_changes.py`, REQUIRED)
4. **Edge decision — PASS/FAIL** (FAIL = stop)
5. Structure — convex (R:R < 2:1 = stop)
6. Kelly sizing — enforce 2.5% cap
7. Log → `trade_log.json` (executed) or `docs/status.md` (NO_TRADE)

### Intraday Dark Pool Interpolation

During market hours, partial data is volume-weighted interpolated. **Always output BOTH actual and interpolated.**

`progress = minutes since 9:30 ET / 390`. Projected = actual / progress. Blend: `(projected × progress) + (prior_5d_avg × (1 - progress))`. Pace = actual / (avg_prior × progress).

| Progress | Confidence | Prior weight |
|---|---|---|
| 0–25% | VERY_LOW | 75%+ |
| 25–50% | LOW | 50–75% |
| 50–75% | MEDIUM | 25–50% |
| 75–100% | HIGH | <25% |

Use interpolated for edge. LOW/VERY_LOW → re-evaluate after 2 PM ET. Pace>1.2x → real. Actual opposite prior → likely reversal.

### Signal Interpretation

- **P/C Ratio:** >2.0 BEAR | 1.2–2.0 LEAN_BEAR | 0.8–1.2 NEUTRAL | 0.5–0.8 LEAN_BULL | <0.5 BULL
- **Flow Side:** Ask-dominant = buying | Bid-dominant = selling
- **Analyst Buy%:** ≥70% BULL | 50–69% LEAN_BULL | 30–49% LEAN_BEAR | <30% BEAR
- **Seasonality:** >60% FAVORABLE | 50–60% NEUTRAL | <50% UNFAVORABLE

> Seasonality / ratings = context, not gates. Strong flow overrides weak seasonality.

### Seasonality Fallback
UW → EquityClock Vision (Claude Haiku) → Cache (`data/seasonality_cache/{TICKER}.json`). Route: `web/app/api/ticker/seasonality/route.ts`. Keys: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_API_KEY`, `CLAUDE_API_KEY`.

---

## Reports — Mandatory at Milestone 5

| Report | Template | Output |
|---|---|---|
| Trade Spec | `.pi/skills/html-report/trade-specification-template.html` | `reports/{ticker}-evaluation-{YYYY-MM-DD}.html` |
| P&L | `.pi/skills/html-report/pnl-template.html` | `reports/pnl-{TICKER}-{YYYY-MM-DD}.html` |
| Share PnL Card | `next/og` (Satori), 1200x630 PNG | `web/app/api/share/pnl/route.tsx` |

Reference: `reports/goog-evaluation-2026-03-04.html`. Sections: Header+gates, Summary, Milestone pass/fail, Dark Pool, Options Flow, Context, Structure & Kelly, Spec, Thesis & Risk, Four Gates.

`Return on Risk = P&L / Capital at Risk`

---

## Commands

| Command | Action |
|---|---|
| `scan` / `discover` | Watchlist / market-wide flow |
| `evaluate [TICKER]` | Full 7-milestone eval |
| `portfolio` / `sync` | Positions / pull from IB |
| `blotter` / `blotter-history` | Today / historical |
| `leap-scan` / `garch-convergence` / `seasonal` | IV mispricing / GARCH / seasonality |
| `analyst-ratings [TICKERS]` | Ratings + targets |
| `vcg-scan` / `cri-scan` / `gex-scan` | Vol-credit gap / Crash Risk / Gamma |
| `menthorq-{cta,dashboard,screener,forex,summary,quin}` | MenthorQ tools |

## Critical Data Files

| File | Purpose |
|---|---|
| `data/portfolio.json` | Open positions, bankroll, exposure |
| `data/trade_log.json` | **Append-only** trade journal |
| `data/watchlist.json` | Surveillance tickers |
| `data/tag_taxonomy.json` | Auto-growing UPPERCASE tag list (force-tracked) |
| `data/{vcg,gex}.json` | Scan caches |
| `data/price_history_cache/` | Auto-pruned at 500 |

`data/replica.db` (libsql embedded replica) decommissioned 2026-05-20. Must NOT exist on any Radon host. Safe to delete if it appears. See `feedback_libsql_replica_one_writer.md`.

---

## Startup Checklist

- [ ] `scripts/cloud.sh` (default) or `scripts/local.sh`
- [ ] `curl http://localhost:8321/health` → `ib_gateway.port_listening: true`
- [ ] Reconciliation, exit orders, CRI scan auto-running
- [ ] Market hours: `TZ=America/New_York date +"%A %H:%M"` (9:30–16:00 ET, Mon–Fri)

## Output Discipline

- Always `signal → structure → Kelly math → decision`
- State probabilities; flag uncertainty
- Failing gate = stop, name the gate
- **Never rationalize a bad trade**
