Run portfolio scenario analysis: {{input}}

1. **Parse arguments** — Expect format like `price_shock -10` or `delta_decay 10`.
   - `price_shock <pct>` — Underlying price shock (e.g., `price_shock -10` for -10% shock)
   - `delta_decay <pct>` — Delta decay with no price movement (e.g., `delta_decay 10` for 10% decay)
   - If no arguments provided, run both scenarios at -10% shock and 10% decay.

2. **Get current spot prices** — Run `python3.13 scripts/ib_sync.py` to get fresh portfolio, then build a spots JSON dict from each ticker's current market price data.

3. **Run the scenario**:
   ```
   python3.13 scripts/scenario_analysis.py <scenario_type> --shock|--decay <pct> --spots '<JSON>'
   ```

4. **Present results** in a clear table:

   **Stressed State (scenario description):**
   | Metric | Current | Stressed | Change |
   |--------|---------|----------|--------|
   | Net Liq | $X | $X | -$X (-Y%) |
   | Dollar Delta | $X | $X | -$X (-Y%) |
   | Net Long | $X | $X | -$X (-Y%) |

   **Per-Position Impact** (sorted by absolute impact, largest first):
   | Ticker | Delta | P&L Impact | New MV |
   |--------|-------|------------|--------|

5. **Summarize** — One-sentence takeaway on portfolio vulnerability.
