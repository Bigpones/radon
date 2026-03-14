#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

score=0
dimensions=0
test_count=0

# ── M1-M7: Python attribution engine tests ──
echo "=== Python attribution tests ==="
py_result=$(cd scripts && python3 -m pytest tests/test_portfolio_attribution.py -v --tb=short 2>&1) || true
echo "$py_result" | tail -30

# Count passing tests
py_passed=$(echo "$py_result" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo "0")
test_count=$((test_count + py_passed))

# M1: strategy classifier
if echo "$py_result" | grep -q "test_classify.*PASSED"; then
  score=$((score + 10)); dimensions=$((dimensions + 1))
  echo "M1: Strategy classifier ✓ (+10)"
fi

# M2: strategy P&L
if echo "$py_result" | grep -q "test_strategy_pnl.*PASSED"; then
  score=$((score + 10)); dimensions=$((dimensions + 1))
  echo "M2: Strategy P&L ✓ (+10)"
fi

# M3: strategy win rate
if echo "$py_result" | grep -q "test_strategy_win_rate.*PASSED"; then
  score=$((score + 10)); dimensions=$((dimensions + 1))
  echo "M3: Strategy win rate ✓ (+10)"
fi

# M4: kelly calibration
if echo "$py_result" | grep -q "test_kelly_calibration.*PASSED"; then
  score=$((score + 10)); dimensions=$((dimensions + 1))
  echo "M4: Kelly calibration ✓ (+10)"
fi

# M5: ticker attribution
if echo "$py_result" | grep -q "test_ticker_attribution.*PASSED"; then
  score=$((score + 10)); dimensions=$((dimensions + 1))
  echo "M5: Ticker attribution ✓ (+10)"
fi

# M6: edge quality
if echo "$py_result" | grep -q "test_edge_quality.*PASSED"; then
  score=$((score + 10)); dimensions=$((dimensions + 1))
  echo "M6: Edge quality ✓ (+10)"
fi

# M7: risk profile
if echo "$py_result" | grep -q "test_risk_profile.*PASSED"; then
  score=$((score + 10)); dimensions=$((dimensions + 1))
  echo "M7: Risk profile ✓ (+10)"
fi

# ── M8-M9: Web build ──
echo ""
echo "=== Web build ==="
cd web
rm -rf .next

build_log=$(npm run build 2>&1) || true
build_exit=$?

if echo "$build_log" | grep -q "Compiled successfully"; then
  echo "Build: OK"
  # M8: API route
  if [ -f "app/api/attribution/route.ts" ]; then
    score=$((score + 10)); dimensions=$((dimensions + 1))
    echo "M8: API route ✓ (+10)"
  fi
  # M9: UI panel
  if [ -f "components/AttributionPanel.tsx" ]; then
    score=$((score + 10)); dimensions=$((dimensions + 1))
    echo "M9: UI panel ✓ (+10)"
  fi
else
  echo "Build: FAILED"
  echo "$build_log" | tail -20 >&2
fi

# Build time
raw_time=$(echo "$build_log" | grep "Compiled successfully" | grep -oE '[0-9.]+[ms]*' | tail -1 || echo "0")
if echo "$raw_time" | grep -q "ms$"; then
  build_time=$(echo "$raw_time" | sed 's/ms$//' | awk '{printf "%.1f", $1/1000}')
else
  build_time=$(echo "$raw_time" | sed 's/s$//')
fi

cd ..

# ── M10: Integration vitest ──
echo ""
echo "=== Attribution vitest ==="
if [ -f "web/tests/attribution.test.ts" ]; then
  vt_result=$(npx vitest run web/tests/attribution.test.ts --reporter=dot 2>&1) || true
  echo "$vt_result" | tail -5
  vt_passed=$(echo "$vt_result" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' | head -1 || echo "0")
  vt_passed=$(echo "$vt_passed" | tr -d '[:space:]')
  test_count=$((test_count + vt_passed))
  if [ "$vt_passed" -gt 0 ]; then
    score=$((score + 10)); dimensions=$((dimensions + 1))
    echo "M10: Integration ✓ (+10)"
  fi
else
  echo "No attribution vitest yet — skipping M10"
fi

# ── Checks: existing tests must not regress ──
echo ""
echo "=== Regression check (existing vitest) ==="
check_result=$(npx vitest run --reporter=dot 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -10) || true
echo "$check_result"
failed=$(echo "$check_result" | grep "Test Files" | grep -o '[0-9]* failed' | grep -o '[0-9]*' || echo "0")
if [ "$failed" -gt 10 ]; then
  echo "REGRESSION: $failed test files failed (max allowed: 10 pre-existing on this branch)"
  exit 1
fi
echo "Regression check OK ($failed pre-existing failures)"

echo ""
echo "=== Results ==="
echo "METRIC attribution_score=$score"
echo "METRIC dimensions=$dimensions"
echo "METRIC test_count=$test_count"
echo "METRIC build_s=${build_time:-0}"
