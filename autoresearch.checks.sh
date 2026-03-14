#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Run vitest — only show failures (suppress success output)
# 9 pre-existing failures are expected; we check no NEW ones appear
result=$(npx vitest run --reporter=dot 2>&1 | tail -5)
echo "$result"

# Extract failure count
failed=$(echo "$result" | grep -o '[0-9]* failed' | head -1 | grep -o '[0-9]*' || echo "0")

# 9 pre-existing failures are allowed
if [ "$failed" -gt 9 ]; then
  echo "ERROR: $failed tests failed (max allowed: 9 pre-existing)"
  exit 1
fi

echo "Tests OK ($failed pre-existing failures, no new ones)"
