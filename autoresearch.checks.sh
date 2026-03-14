#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Run all related tests — suppress success, only show failures
python3 -m pytest scripts/tests/test_incremental_sync.py scripts/tests/test_atomic_io.py scripts/tests/test_covered_call_detection.py scripts/tests/test_all_long_combo.py -x --tb=short -q 2>&1 | tail -20
