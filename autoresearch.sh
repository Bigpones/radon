#!/bin/bash
set -euo pipefail

cd /Users/joemccann/dev/apps/finance/radon

# Run pytest, exclude the hanging integration test
# Use -q for minimal output, capture timing
result=$(python3.13 -m pytest scripts/tests/ scripts/trade_blotter/test_blotter.py scripts/trade_blotter/test_integration.py \
  --ignore=scripts/tests/test_menthorq_integration.py \
  -q --tb=no --no-header 2>&1)

# Parse results: "1327 passed, 18 warnings in 22.06s"
# or "1325 passed, 2 failed, 18 warnings in 22.06s"
passed=$(echo "$result" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo "0")
failed=$(echo "$result" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo "0")
total_time=$(echo "$result" | grep -oE 'in [0-9]+\.[0-9]+s' | grep -oE '[0-9]+\.[0-9]+' || echo "0")

echo "METRIC total_s=$total_time"
echo "METRIC tests_passed=$passed"
echo "METRIC tests_failed=$failed"

# Show the summary line for ASI
echo "$result" | tail -3
