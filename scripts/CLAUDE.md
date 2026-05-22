# Radon Scripts — CLAUDE.md

Python conventions shared across the script tree. Loaded automatically when cwd is anywhere under `scripts/`. Subsystem-specific rules live one level deeper (`scripts/api/`, `scripts/monitor_daemon/`, `scripts/watchdog/`, `scripts/newsfeed/`).

---

## Client ID Ranges

| Range | Usage |
|---|---|
| 0–9 | FastAPI IBPool (sync=3, orders=4, data=5) |
| 10–19 | WS relay |
| 20–49 | Subprocess scripts AND monitor_daemon handlers — **always `client_id="auto"`** |
| 50–69 | Scanners |
| 90–99 | CLI |

**Never hardcode in 20–49.** As of 2026-05-20 daemon handlers (`fill_monitor`, `exit_orders`, `journal_sync`) also use `client_id="auto"` — prior hardcoded 70/71/72 left them one CLOSE_WAIT away from stuck "client id already in use". Auto-allocator: `scripts/clients/ib_client.py:_connect_auto_allocate`.

---

## IB Request Bounding

`ib_insync` has no per-request timeout. When IB Gateway is logged in but awaiting 2FA, `qualifyContractsAsync` / `reqHistoricalDataAsync` / `reqMktData` block forever.

Scripts importing `ib_insync` directly **must**:
1. Wrap every IB await in `asyncio.wait_for(..., timeout=15)`.
2. Pre-check FastAPI `/health` for `auth_state == "authenticated"` before constructing `IB()`.

See `scripts/cri_scan.py:_fetch_ib` for the canonical pattern. Background in `feedback_ib_insync_no_request_timeouts.md`.

---

## High-Throughput Architecture

500+ symbols, <500ms signal-to-order.

- **Parallel scanning:** `scanner.py` (15 workers), `discover.py` (10 workers). `UWRateLimitError` skips ticker.
- **Atomic state:** `scripts/utils/atomic_io.py` — `atomic_save()` (temp + `os.replace()` + SHA-256), `verified_load()`.
- **Batched WS relay:** per-client last-write-wins, 100ms flush. 5000 msg/s → 10 batched/s.
- **Stale tick detection:** 30s check, 45s no-ticks → auto-restart Gateway (120s cooldown).
- **Vectorized:** `kelly_size_batch()` (NumPy), `portfolio_greeks_vectorized()`. Cross-validated to 10⁻¹².
- **IBClient resilience:** disconnect recovery (5 attempts, 2ⁿs cap 30s); pacing (162/366: 10s backoff); invalid contracts (200/354: no retry, `_failed_contracts`).
- **Performance page:** Phase A sequential IB+cache; Phase B ThreadPool UW/Yahoo. `PERF_FETCH_WORKERS` (default 8). Disk cache TTL 15min/24h. SWR via `POST /performance/background`.

---

## Evaluation Pipeline (7 milestones)

Quick reference; full methodology in `docs/evaluation.md`.

1. Validate ticker → `scripts/fetch_ticker.py` (1B Seasonality · 1C Analyst · 1D News)
2. Dark pool flow → `scripts/fetch_flow.py` (intraday interpolation)
3. Options flow → `scripts/fetch_options.py` (3B OI changes → `fetch_oi_changes.py`, REQUIRED)
4. **Edge decision — PASS/FAIL** (FAIL = stop)
5. Structure — convex (R:R < 2:1 = stop)
6. Kelly sizing — enforce 2.5% cap
7. Log → `trade_log.json` (executed) or `docs/status.md` (NO_TRADE)

Reports at milestone 5 are mandatory — see `docs/reports.md` for templates.

---

## Cancel / Modify (scripts side)

Mirror of the rule in `web/CLAUDE.md`:
1. Use subprocess with original `clientId`. Master (0) sees all orders but can't modify (Error 10147/103). `ib_order_manage.py` reconnects as original.
2. Clear VOL fields before modify. Reset `volatility` / `volatilityType` to IB sentinels (`1.7976931348623157e+308` / `2147483647`) to avoid Error 321.
3. Preserve upstream error detail — never collapse to 500.

Browser-side regression tests live in `web/`; this side has unit + route coverage.

---

## Position Cache Refresh Contract (`ib_sync.py`)

`ib_insync.positions()` returns an in-memory cache. TWS push updates `pos.position` immediately but `pos.avgCost` lags while TWS recomputes VWAP server-side. `IBClient.get_positions()` calls `reqPositions()` + `sleep(1)` BEFORE reading, draining pending updates so size and avgCost are consistent. Opt out via `get_positions(refresh=False)` for tight read loops. Try/except so gateway hiccups fall back to cache. Tests: `test_ib_client.py::TestPortfolioOperations`. Added 2026-05-20 (commit 5d10def).

---

## Journal Lot-Matched Basis

`scripts/clients/journal_basis.py:compute_open_basis_for_ticker(db, ticker)` reads raw journal rows and returns per-contract open basis. Used by `ib_sync.py:fetch_positions` to override IB's drifting VWAP with the original opening basis. Persisted-row optimization since 4c85847 (`open_basis` written by `journal_rehydrate.py` on every row) — the reader prefers the persisted value and falls back to recomputation only for older rows + rows written by the real-time daemon.

Full convention (per-contract vs per-share `avg_cost`) lives in `web/CLAUDE.md` since the display layer is where the bug surfaces.

---

## Entry-Date Resolution Contract

Strict ordered fallback in `ib_sync.py:fetch_positions`, MOST → LEAST specific. Test: `scripts/tests/test_combo_entry_date.py`. Full rule in `web/CLAUDE.md` §Entry-Date Resolution — Python-side implementation must match the order documented there.
