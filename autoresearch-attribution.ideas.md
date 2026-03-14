# Attribution Engine — Ideas Backlog

## Near-term improvements
- Enrich auto-imported trades with retrospective strategy classification (match ticker+date to watchlist scan history)
- Add time-series attribution (P&L by week/month, strategy contribution over time)
- Add profit factor metric per strategy (gross wins / gross losses)
- Add expected value accuracy (Kelly EV prediction vs actual outcome) beyond win rate
- Horizontal bar chart in UI (SVG, no new deps) showing strategy P&L contribution
- Add a "signal → outcome" funnel: scans → evaluations → trades → wins

## Medium-term
- Factor attribution: decompose daily P&L into market beta, sector, idiosyncratic components
- Use IB Flex Query data to get more precise entry/exit dates for time-weighted attribution
- Add benchmark-relative attribution (how much alpha came from each strategy vs SPY)
- Cache attribution JSON with TTL (avoid re-running Python on every page load)

## Won't do (for now)
- Real-time attribution (requires live position marking — use portfolio_performance.py for that)
- Per-trade Sharpe ratios (not meaningful for options with defined max loss)
