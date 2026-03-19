# Autoresearch Ideas — Scan Command Speed Optimization

## Status: ✅ COMPLETE (42% improvement achieved)

Best result: 29,801ms for 19 tickers (from 51,293ms baseline)

**Note**: Reverted 3-day lookback to preserve signal accuracy.

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
- Flow alerts were fetched but never used
- Added `skip_options_flow=True` parameter — saves 1 API call per ticker

### 4. Batch Darkpool Fetching
- UW may support fetching multiple tickers in one call
- Check `/api/darkpool/recent` endpoint

### 5. Reduce Worker Count ✅ APPLIED
- Reduced from 15 to 5 workers
- Less aggressive parallelism reduces rate limit pressure

### 6. Add Scanner-Specific Cache
- Cache scan results for short period (5 min)
- Useful for repeated scans during same session

## From Evaluate Optimization (Already Applied)
- UW request cache (60s TTL) — should help scanner
- M2/M3 flow_alerts params aligned — scanner uses same fetch_flow

## Tried and Failed
(Updated as experiments accumulate)

