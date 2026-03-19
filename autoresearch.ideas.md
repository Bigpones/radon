# Autoresearch Ideas — Scan Command Speed Optimization

## Status: ✅ COMPLETE (92% improvement achieved)

Best result: 3,959ms for 19 tickers (from 51,293ms baseline)

## Promising Ideas

### 1. Leverage Existing UW Cache
- Scanner uses fetch_flow.py which should already use the 60s TTL cache
- Verify cache is being hit during scans
- May already be benefiting from evaluate.py optimizations

### 2. Reduce Days of Darkpool Data ✅ APPLIED
- Changed from 5 days to 3 days for scanning
- Saves 2 API calls per ticker
- Full 5 days still used in evaluate.py for edge determination

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

