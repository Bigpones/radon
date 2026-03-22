# Autoresearch: Python Test Suite Speed

## Objective
Optimize the Python test suite (`scripts/tests/` + `scripts/trade_blotter/test_*.py`) for wall-clock execution time. The suite has 1327 non-integration tests across ~60 files. Current baseline is ~22s.

## Metrics
- **Primary**: `total_s` (seconds, lower is better) — total pytest wall-clock time
- **Secondary**: `tests_passed` — must stay at 1327 (no tests dropped), `tests_failed` — must stay at 0

## How to Run
`./autoresearch.sh` — runs pytest with `--ignore` for integration tests, outputs `METRIC` lines.

## Files in Scope
- `scripts/tests/test_*.py` — all unit/integration test files
- `scripts/tests/test_monitor_daemon/*.py` — daemon test files
- `scripts/trade_blotter/test_blotter.py` — blotter tests
- `scripts/trade_blotter/test_integration.py` — trade blotter integration tests
- `scripts/tests/conftest.py` — shared fixtures
- `scripts/clients/uw_client.py` — UW client (retry/backoff config)
- `scripts/clients/ib_client.py` — IB client (connect retry logic)
- `scripts/api/subprocess.py` — subprocess runner
- `pyproject.toml` — pytest config

## Off Limits
- **DO NOT** delete or skip any tests
- **DO NOT** change test assertions or expected behavior
- **DO NOT** change production code behavior (only test infrastructure and timing)
- `scripts/tests/test_menthorq_integration.py` — always excluded (requires browser, hangs without it)
- Web/frontend tests (`web/tests/`)

## Constraints
- All 1327 tests must pass
- 0 test failures
- No functionality changes in production code
- No reduction in code coverage

## What's Been Tried

### Baseline (~22s)
The main bottlenecks are:
1. `test_uw_client.py::test_500_raises_server_error` — 7s (UW client retries 500 with real `time.sleep`, backoff 1+2+4=7s)
2. `test_api_subprocess.py::test_module_error_falls_back_to_stdout_when_stderr_is_empty` — 5s (spawns real subprocess with 5s timeout)
3. `test_ib_client.py::test_connect_exhausts_retries` — 3s (IB connect retry with real `time.sleep`)
4. `test_ib_client.py::test_connect_retries_on_transient_error` — 1s (same pattern)
5. `test_client_id_allocation.py::test_explicit_id_no_retry_on_conflict` — 1s (real sleep)
6. `test_api_subprocess.py::test_timeout_kills_process` — 0.5s (real timeout)

Total from top-30 slow tests: ~18s out of 22s.

Root causes:
- Tests use real `time.sleep()` during retry logic instead of patching it
- Tests spawn real subprocesses with real timeouts instead of mocking
- No parallelism — single process execution
