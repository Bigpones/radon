# IB Sync Latency — Ideas Backlog

## Explored and exhausted
- **Sleep tuning**: 2.7s is the floor for streaming mode. Below this, options data randomly fails.
- **Adaptive polling**: Python-level checking overhead (0.1-0.25s per check) exceeds savings.
- **Account summary → accountValues()**: 0ms cache read vs 200-700ms round-trip. Done, merged.
- **Skip qualifyContracts**: exchange='SMART' for all contracts. Done, merged (also fixed stock exchange bug).
- **Batch PnL Single**: bypass IBClient wrapper, call ib.reqPnLSingle directly. Done, merged.
- **Overlap sleeps**: all subscriptions concurrent, one combined sleep. Done, merged.
- **Snapshot market data**: Fails with delayed-frozen data (type 4) — only 8/26. Not robust.
- **Import optimization**: ib_insync takes 121ms — unavoidable direct dependency.
- **Post-IB processing**: collapse <1ms, atomic_save ~1.4ms, display ~0.2ms — negligible.

## Pending validation (code ready, needs IB Gateway)
- **Eliminate Phase 6 fallback sleep entirely**: Account PnL subscription has 2.7s+ head start from Phase 2. No fallback sleep needed — accept None if data hasn't arrived. Saves 0-0.3s (conditional path). Code change committed on branch.

## Remaining (diminishing returns)
- **Persistent connection pool**: Keep IB connection alive between syncs. Saves ~200ms connect per call. Requires daemon architecture change — beyond scope of this optimization.
