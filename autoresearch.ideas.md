# IB Sync Latency — Ideas Backlog

## Explored and exhausted
- **Sleep tuning**: 2.5s is the floor with close fallback. Lower (2.0s, 1.5s) loses data.
- **Adaptive polling**: Python-level checking overhead (0.1-0.25s per check) exceeds savings.
- **Account summary → accountValues()**: 0ms cache read vs 200-700ms round-trip. Done, merged.
- **Skip qualifyContracts**: exchange='SMART' for all contracts. Done, merged.
- **Batch PnL Single**: bypass IBClient wrapper, call ib.reqPnLSingle directly. Done, merged.
- **Overlap sleeps**: all subscriptions concurrent, one combined sleep. Done, merged.
- **Snapshot market data**: Fails with delayed-frozen data (type 4) — only 8/26. Not robust.
- **Phase 6 elimination**: Account PnL arrives during Phase 4 sleep. No fallback needed. Done, merged.
- **Close price fallback**: Catches degraded gateway states (15+ positions saved). Done, merged.
- **Import optimization**: ib_insync takes 121ms — unavoidable, it's a required dependency.
- **Post-IB processing**: collapse <1ms, atomic_save ~1.4ms, display ~0.2ms — negligible.
- **Sleep 2.0s/2.3s with close fallback**: Works but overfits to degraded gateway — close prices mask the fact that live data wouldn't arrive in time. Rejected for data quality reasons during market hours.

## Remaining (diminishing returns, not worth pursuing)
- **Persistent connection pool**: Keep IB connection alive between syncs. Saves ~200ms connect. Needs daemon architecture change — beyond scope.
