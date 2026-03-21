# Autoresearch Ideas — Scan Command Speed Optimization

## Status: ✅ COMPLETE (67% improvement achieved)

Best result: 16,811ms for 19 tickers (from 51,293ms baseline)

**Note**: Reverted 3-day lookback to preserve signal accuracy. Skip options flow for speed (evaluate.py handles conflict detection).

## Promising Ideas

### 1. Leverage Existing UW Cache
- Scanner uses fetch_flow.py which should already use the 60s TTL cache
- Verify cache is being hit during scans
- May already be benefiting from evaluate.py optimizations

### 2. Reduce Days of Darkpool Data ❌ REVERTED
- Tried 3 days but reverted to 5 days
- Scanner needs full 5-day context to detect pattern breaks
- 3-day view can miss distribution day on day 4, giving false "sustained" signal
- Signal accuracy > speed

### 3. Skip Flow Alerts for Scanning ✅ APPLIED
- Scanner only uses darkpool data for ranking
- Flow alerts were fetched but scanner didn't use them
- Added `skip_options_flow=True` parameter — saves 1 API call per ticker
- Conflict detection deferred to evaluate.py (which does full analysis)
- Trade-off: Speed (50-67% faster) vs accuracy (scanner may rank conflicting tickers highly)
- Decision: Accept trade-off — scanner is a quick filter, evaluate.py catches conflicts

### 4. Batch Darkpool Fetching ❌ NOT APPLICABLE
- `/api/darkpool/recent` only returns live/recent trades
- Scanner needs 5 days of historical data per ticker
- No batch historical endpoint available

### 5. Reduce Worker Count ✅ APPLIED
- Reduced from 15 to 5 workers
- Less aggressive parallelism reduces rate limit pressure

### 6. Add Scanner-Specific Cache ⏭️ SKIPPED
- Cache scan results for short period (5 min)
- Diminishing returns — 67% already achieved
- Added complexity not worth marginal gains

## From Evaluate Optimization (Already Applied)
- UW request cache (60s TTL) — should help scanner
- M2/M3 flow_alerts params aligned — scanner uses same fetch_flow

## Tried and Failed
(Updated as experiments accumulate)

