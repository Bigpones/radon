#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Run ib_sync with wall-clock timing via Python wrapper
python3 -c "
import time, subprocess, re, sys

start = time.perf_counter()
result = subprocess.run(
    [sys.executable, 'scripts/ib_sync.py', '--sync', '--client-id', '77'],
    capture_output=True, text=True, timeout=120
)
elapsed = round(time.perf_counter() - start, 3)

output = result.stdout + result.stderr
m = re.search(r'SUMMARY: (\d+) positions', output)
positions = int(m.group(1)) if m else 0

print(f'METRIC total_s={elapsed}')
print(f'METRIC positions={positions}')

if result.returncode != 0:
    print(f'EXIT_CODE={result.returncode}', file=sys.stderr)
    sys.exit(result.returncode)
"
