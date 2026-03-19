# Autoresearch Ideas — Evaluate Speed Optimization

## Deferred Optimizations (Complex but Promising)

### 1. Intelligent Request Throttling
- Add adaptive delay between UW API calls based on recent rate limit hits
- Track 429 responses and back off proactively
- Could stabilize performance from 6-50s range to 8-15s range

### 2. UW Request Deduplication Between M1 and M2
- M1 (ticker validation) and M2 (flow analysis) both fetch darkpool data
- M1 fetches 1 day, M2 fetches 5 days — but 1 day overlaps
- Also both fetch flow_alerts separately
- Could save ~3 API calls per ticker by restructuring

### 3. Pre-Warming Cache for Known Tickers
- If we know the watchlist tickers, pre-fetch common data in background
- Could eliminate most API calls during actual evaluation

### 4. Parallel UW Fetching with Rate Limit Awareness
- Use a semaphore to limit concurrent requests to UW
- Track request times and throttle when approaching limit
- Allow parallel but controlled API access

### 5. UW Batch API Investigation
- Check if UW has undocumented batch endpoints
- Could request multiple tickers' data in single call

## Completed Optimizations (for reference)
1. IB connection pooling — saves 1.8s per additional ticker
2. --fast flag — skips IB price history entirely
3. Analyst ratings cache — reuses cached ratings
4. UW request cache (60s TTL) — deduplicates within session
5. M1 validation reduced to 1 day — saves 2 API calls/ticker
6. Multi-ticker CLI support — batch evaluation in single command
