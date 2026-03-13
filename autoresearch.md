# Autoresearch: IB Sync Latency Optimization

## Objective
Minimize end-to-end wall-clock time for `python3 scripts/ib_sync.py --sync --client-id 98` — the full portfolio sync from Interactive Brokers. Currently ~22.7s. This is the critical path for the web dashboard's portfolio refresh.

## Profiling Baseline (22.7s total)

| Phase | Time (ms) | % of Total | Notes |
|-------|-----------|------------|-------|
| **PnL Single requests** | **13,029** | **57%** | `get_pnl_single()` does `sleep(0.5)` per position × 26 = 13s |
| Sleep for PnL data | 3,001 | 13% | Additional 3s sleep after all PnL requests |
| Sleep for MktData | 3,001 | 13% | Fixed 3s sleep waiting for market data |
| PnL poll | 2,001 | 9% | `get_pnl()` does 2s initial sleep + up to 8×1s polling |
| Qualify contracts | 1,013 | 4% | Single batch call — already batched |
| Connect | 604 | 3% | IB API connection handshake |
| Account summary | 208 | 1% | Fast |

## Root Cause: Serial 0.5s Sleeps in PnL Single
`fetch_position_daily_pnl()` calls `client.get_pnl_single()` in a loop, which does `client.sleep(0.5)` PER position. 26 positions × 0.5s = 13s of pure sleeping. The fix is to request all PnL subscriptions upfront (no per-request sleep), then do ONE combined sleep.

## Secondary: Overlapping Sleeps for MktData + PnL
Market data and PnL Single both need time for IB to stream data back. Currently these are sequential (3s + 3s). They can overlap if we request both simultaneously.

## Metrics
- **Primary**: `total_s` (seconds, lower is better) — wall-clock `ib_sync.py --sync --client-id 98`
- **Secondary**: `positions` — number of positions fetched (must stay same, ~20)

## How to Run
`./autoresearch.sh` — runs ib_sync.py with timing, outputs `METRIC name=number` lines.

## Files in Scope
- `scripts/ib_sync.py` — Main sync script (845 lines). Orchestrates connect → fetch → collapse → save.
- `scripts/clients/ib_client.py` — IBClient wrapper (821 lines). `get_pnl_single()` has 0.5s sleep.
- `scripts/utils/incremental_sync.py` — Diff-based skip logic (126 lines).
- `scripts/utils/atomic_io.py` — Atomic JSON writes (97 lines).

## Off Limits
- `scripts/tests/` — Do NOT modify existing tests. Add new ones only.
- `web/` — Do not touch the web layer.
- `lib/` — Do not touch the TypeScript tools layer.
- IB API protocol — We can only optimize our side (sleep durations, concurrency, batching).

## Constraints
1. All 40 existing tests must pass (`pytest scripts/tests/test_incremental_sync.py scripts/tests/test_atomic_io.py scripts/tests/test_covered_call_detection.py scripts/tests/test_all_long_combo.py`).
2. Output portfolio.json must have the same schema and data quality (positions, market values, PnL).
3. Must correctly fetch market prices and daily PnL for all positions.
4. Must work with IB Gateway on port 4001. Use `--client-id 98` to avoid conflicts.
5. The `collapse_positions()` logic and structure detection must not change behavior.

## What's Been Tried
(Nothing yet — this is the baseline.)
