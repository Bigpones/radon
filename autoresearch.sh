#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/web"

# Clean previous build
rm -rf .next

# Build
npm run build 2>&1 > /tmp/next-build.log
build_exit=$?

if [ $build_exit -ne 0 ]; then
  cat /tmp/next-build.log >&2
  exit $build_exit
fi

# Measure client JS bundle size (KB)
js_bytes=$(find .next/static -name "*.js" -exec cat {} + | wc -c | tr -d ' ')
js_kb=$(( js_bytes / 1024 ))

# Measure CSS size (KB)
css_bytes=$(find .next/static -name "*.css" -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')
css_kb=$(( css_bytes / 1024 ))

# Count chunks
chunk_count=$(find .next/static -name "*.js" | wc -l | tr -d ' ')

# Extract build time from log
build_time=$(grep -o "Compiled successfully in [0-9.]*s" /tmp/next-build.log | grep -o "[0-9.]*" || echo "0")

echo "METRIC bundle_kb=$js_kb"
echo "METRIC css_kb=$css_kb"
echo "METRIC chunk_count=$chunk_count"
echo "METRIC build_s=$build_time"
