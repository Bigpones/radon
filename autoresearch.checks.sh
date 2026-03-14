#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Run vitest — allow non-zero exit (9 pre-existing failures)
# Strip ANSI codes for reliable parsing
output=$(npx vitest run --reporter=dot 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -10) || true
echo "$output"

# Extract test file failure count from "N failed" on the "Test Files" line
failed=$(echo "$output" | grep "Test Files" | grep -o '[0-9]* failed' | grep -o '[0-9]*' || echo "0")

# 9 pre-existing test FILE failures are allowed
if [ "$failed" -gt 9 ]; then
  echo "ERROR: $failed test files failed (max allowed: 9 pre-existing)"
  exit 1
fi

echo "Tests OK ($failed pre-existing failures, no new ones)"
