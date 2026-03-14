# IB Sync Latency — Ideas Backlog

## Explored and exhausted
- **Sleep tuning**: 2.7s is the floor for streaming mode. Below this, options data randomly fails.
- **Adaptive polling**: Python-level checking overhead exceeds savings.
- **Account summary → accountValues()**: 0ms cache read vs 200-700ms round-trip. Done.
- **Skip qualifyContracts**: exchange='SMART' for all contracts. Done (also fixed stock exchange bug).
- **Batch PnL Single**: bypass IBClient wrapper, call ib.reqPnLSingle directly. Done.
- **Overlap sleeps**: all subscriptions concurrent, one combined sleep. Done.
- **Snapshot market data**: Fails with delayed-frozen data (type 4) — only 8/26 positions get prices vs 25/26 streaming. Works during market hours only (~24/26 in 1.5s). Not robust.
- **Phase 6 fallback**: Reduced from 1.0s to 0.3s. Validated 2.99s in benchmark (needs more runs to confirm reliability).
- **Import optimization**: ib_insync takes 121ms import — unavoidable, it's a required dependency.
- **Post-IB processing**: collapse_positions <1ms, atomic_save ~1.4ms, display ~0.2ms — negligible.

## Remaining (~marginal)
- **Persistent connection pool**: Keep an IB connection alive between syncs (saves ~200ms connect). Needs daemon.
- **Reduce position count**: Portfolio-dependent, not a code change.
- **Skip illiquid positions**: Detect thin options and skip reqMktData. Saves a few ms of IB processing.
- **JSON output mode (--json)**: Output to stdout instead of file+display. Saves ~5ms + web layer file read.
- **Conditional Phase 6**: Skip account PnL polling entirely if not needed by caller.
