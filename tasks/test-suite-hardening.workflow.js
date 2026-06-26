export const meta = {
  name: 'test-suite-hardening',
  description: 'Audit & harden Radon test suites (py/ts/api/integration/perf/security/UI): antipatterns, missing edge cases, stale tests, speedups',
  phases: [
    { title: 'Analyze', detail: 'one focused analyzer per suite segment reads real test files' },
    { title: 'Verify', detail: 'adversarially verify every P0/P1 finding for reality + fix safety' },
    { title: 'Synthesize', detail: 'merge into one prioritized, actionable hardening report' },
  ],
}

// ----- shared schemas -----
const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['segment', 'summary', 'findings'],
  properties: {
    segment: { type: 'string' },
    summary: { type: 'string', description: 'health assessment of this segment in 2-4 sentences' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'category', 'severity', 'title', 'files', 'evidence', 'recommendation'],
        properties: {
          id: { type: 'string', description: 'stable slug, e.g. py-ib-01' },
          category: { type: 'string', enum: ['antipattern', 'missing-edge-case', 'stale', 'speedup', 'coverage-gap', 'flakiness'] },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' }, description: 'file:line references' },
          evidence: { type: 'string', description: 'concrete quoted code / line refs proving the issue exists' },
          recommendation: { type: 'string', description: 'specific change; for speedups give expected wall-clock impact' },
          speedupSeconds: { type: ['number', 'null'], description: 'estimated seconds saved if a speedup, else null' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['findingId', 'verdict', 'reasoning', 'safetyRisk', 'refinedRecommendation'],
  properties: {
    findingId: { type: 'string' },
    verdict: { type: 'string', enum: ['confirmed', 'rejected', 'needs-adjustment'] },
    reasoning: { type: 'string', description: 'did you read the file and confirm the evidence is real? quote what you saw.' },
    safetyRisk: { type: 'string', enum: ['none', 'low', 'medium', 'high'], description: 'risk the recommended change reduces coverage or breaks tests' },
    refinedRecommendation: { type: 'string' },
  },
}

const CTX = `Radon = options/market-structure trading app. Stack: Next.js 16 + TS (web/), FastAPI + Python 3.13 (scripts/), libsql/Turso DB, IB Gateway, Unusual Whales.
Test runners: Vitest 4 (config: vitest.config.ts, run via web/ \`npm run test\`, environment: node), pytest 9 (scripts/tests, scripts/api/tests, conftest adds scripts/ to path), Playwright (web/e2e + site/e2e, multiple configs).
There is NO test CI gate today (only .github/workflows/deploy.yml). Project rules: red/green TDD, 95% coverage target, chrome-cdp/Playwright for UI, no naked prod DB writes in tests (guarded by test_db_client_pytest_guard).`

const RUBRIC = `For the assigned segment, READ the actual test files (use Glob+Read+Grep — do not guess). Identify, with file:line evidence:
1. ANTIPATTERNS: over-mocking (mocking the thing under test), assertion-free tests, testing implementation not behavior, brittle snapshot/string matching, shared mutable state across tests, time/date/random nondeterminism, sleeps instead of awaits, network/IB/UW calls not mocked, order-dependent tests, copy-paste duplication that should be parametrized.
2. MISSING EDGE CASES: error paths, empty/null/zero, boundary values, timezone/DST (ET vs UTC — known Radon bug class), negative prices, combo/BAG leg sign conventions, partial fills, stale-cache, auth-failure, concurrency/race. Tie to known Radon bug classes where relevant.
3. STALE / NO-LONGER-RELEVANT: tests for removed features (e.g. embedded libsql replica decommissioned 2026-05-20; naked-short gate disabled), duplicated coverage, tests asserting obsolete behavior, dead fixtures.
4. SPEEDUPS WITHOUT QUALITY LOSS: missing parallelism, expensive per-test setup that belongs in module/session fixtures, real sleeps, unmocked I/O, redundant heavy imports, large fixtures rebuilt per test, opportunities for pytest-xdist / vitest pool / fixture scope widening / fake timers / shared test DB. Estimate seconds saved.
Be specific and conservative: every finding needs real evidence. Prefer fewer high-confidence findings over speculation. Assign severity P0 (broken/dangerous/flaky-in-CI) .. P3 (nice-to-have).`

function analyze(segment) {
  return agent(
    `${CTX}\n\nYou are auditing ONE segment of the Radon test suite: **${segment.name}**.\nScope (files to read): ${segment.scope}\n\n${RUBRIC}\n\nReturn structured findings. id prefix: "${segment.prefix}".`,
    { label: `analyze:${segment.prefix}`, phase: 'Analyze', schema: FINDINGS_SCHEMA }
  )
}

const SEGMENTS = [
  { prefix: 'py-ib', name: 'Python — IB orders / combos / reconcile', scope: 'scripts/tests/test_ib_*.py, test_pool_order_manage.py, test_combo_entry_date.py, test_ratio_detection.py, test_all_long_combo.py, test_covered_call_detection.py, test_naked_short_audit.py, test_client_id_allocation.py, test_cri_client_id.py, test_exit_order_service.py' },
  { prefix: 'py-daemon', name: 'Python — monitor daemon + watchdog', scope: 'scripts/tests/test_monitor_daemon/*.py, scripts/tests/test_watchdog/*.py, test_ib_watchdog.py, test_ib_watchdog_2fa_lock.py, test_ib_2fa_lock.py, test_replica_watchdog.py, test_performance_lock.py' },
  { prefix: 'py-scan', name: 'Python — scanners / eval / quant', scope: 'scripts/tests/test_scanner*.py, test_discover*.py, test_evaluate.py, test_kelly_extended.py, test_kelly_vectorized.py, test_gex_scan.py, test_cri_scan.py, test_leap_scanner.py, test_vectorized_greeks.py, test_scenario_analysis.py, test_free_trade_analyzer.py, test_index_symbols.py' },
  { prefix: 'py-data', name: 'Python — db / sync / writers / journal', scope: 'scripts/tests/test_phase2_writers.py, test_phase34_writers.py, test_phase4_wirings.py, test_*_dual_write.py, test_migrate.py, test_journal_basis.py, test_journal_rehydrate.py, test_bootstrap_journal.py, test_cash_flow_sync*.py, test_cash_flows_route_last_synced.py, test_nav_history.py, test_incremental_sync.py, test_atomic_io.py, test_timezone_aware_writers.py, test_no_replica_env_timing.py, test_db_client_pytest_guard.py, test_scan_time_timezone.py, test_env_loading.py, test_repair_cri_rvol_cache.py, test_price_cache.py, test_daemon_state_dual_write.py' },
  { prefix: 'py-cli', name: 'Python — clients / fetchers / menthorq / flow', scope: 'scripts/tests/test_menthorq*.py, test_uw_client.py, test_fetch_*.py, test_api_flow_cache.py, test_api_subprocess.py, test_server_lifespan_nonblocking.py, test_batched_relay.py, test_ib_resilient.py, test_ib_insync_bounded.py, test_utils.py, test_code_quality.py, test_run_pytest_affected.py, test_startup_cta_sync.py, test_cta_sync_*.py, test_run_*_wrapper.py, scripts/api/tests/*.py' },
  { prefix: 'ts-order', name: 'Vitest — orders / combos / risk / chain / positions', scope: 'web/tests/order-*.test.ts*, chain-*.test.ts*, naked-short-guard.test.ts, margin-warning.test.ts, position-*.test.ts*, instrument-detail-spread-quantity.test.ts, spread-price-bar.test.ts, order-ticket-spread-notional.test.ts, place-order-body-schema.test.ts, realized-pnl*.test.ts, lib/tools/__tests__/kelly.test.ts' },
  { prefix: 'ts-regime', name: 'Vitest — regime / cta / gex / flow / newsfeed / vcg / cri', scope: 'web/tests/regime-*.test.ts*, cta-*.test.ts, gex-*.test.ts*, flow-*.test.ts, newsfeed-*.test.ts, vcg-*.test.tsx, cri-*.test.ts, use-gex.test.ts, use-llm-token-index.test.ts, regime-llm-card.test.tsx' },
  { prefix: 'ts-api', name: 'Vitest — API routes / cache / db / service-health', scope: 'web/tests/*-no-store-header.test.ts, *-route*.test.ts, db-first-read.test.ts, orders-read-from-db.test.ts, service-health-*.test.ts*, route-cache-meta.test.ts, account-balances-complete.test.ts, cash-flows-route-and-hook.test.ts, performance-route.test.ts, performance-freshness.test.ts, fastapi-migration.test.ts, api-routes-extended.test.ts, index-options-chain-api.test.ts, newsfeed-posts-api.test.ts, regime-*cache*.test.ts, discover-*.test.ts, auth-integration.test.ts' },
  { prefix: 'ts-ui', name: 'Vitest — UI components / theme / admin / workspace', scope: 'web/tests/*.tsx (theme-provider-hydration, admin-components, admin-polling, workspace-orders-implied, banner-stale-state, position-table-*, chain-atm-scroll-isolation, day-pnl-premarket-fallback, exposure-breakdown-modal-leverage, dashboard-newsfeed-pagination, gex-panel, vcg-history-chart, order-tab-close-realized-pnl, order-risk-chokepoint, order-risk-telemetry), workspace-chrome-alignment.test.ts, header-fullscreen-control.test.ts, desktop-touch-dropdown-css.test.ts, admin-format.test.ts' },
  { prefix: 'ts-core', name: 'Vitest — pricing / ws / telemetry / utils / lib-tools', scope: 'web/tests/black-scholes.test.ts, price-*.test.ts, ws-server-*.test.ts, use-prices-ws-stability.test.ts, reconnect-strategy.test.ts, rate-limiter.test.ts, quote-telemetry-wrappers.test.ts, price-bar-quote-telemetry.test.ts, stale-option-*.test.ts, utils.test.ts, utils-extended.test.ts, data.test.ts, share-pnl.test.ts, gex-share.test.ts, dollar-delta-leverage.test.ts, og-*.test.ts, table-filter.test.ts, options-chain-utils.test.ts, sync-mutex.test.ts, lib/tools/__tests__/*.test.ts, site/lib/**/*.test.ts, .pi/tests/*.test.ts' },
  { prefix: 'e2e-web', name: 'Playwright E2E — web app (UI + integration + mobile + a11y)', scope: 'web/e2e/*.spec.ts and web/e2e/*.test.js; also read web/playwright.config.ts, playwright.no-server.config.ts, playwright.strip.config.ts. Focus on UI flows, mobile specs, a11y/pwa, and whether selectors are robust, waits are deterministic (no arbitrary timeouts), and fixtures/mocks are used vs live services.' },
  { prefix: 'e2e-site', name: 'Playwright E2E — marketing site + config strategy', scope: 'site/e2e/*.spec.ts, web/playwright.site.config.ts. Plus a CROSS-CUTTING review: are there redundant Playwright configs? Could any E2E specs be downgraded to faster Vitest unit/component tests without losing signal? Are server-start vs no-server configs used optimally?' },
  { prefix: 'sec', name: 'CROSS-CUTTING — security test coverage', scope: 'Search the WHOLE repo for security-relevant test coverage. Read web/tests/auth-integration.test.ts, scripts/api/tests/test_historical_auth.py, test_db_client_pytest_guard.py, test_naked_short_audit.py, test_env_loading.py. Then assess GAPS: is the Clerk middleware perimeter (web/middleware.ts) tested so /api routes cannot go public again (known past incident)? Edge-runtime middleware constraints? Auth bypass, authz, secret leakage in fixtures, SSRF via radonFetch, injection into subprocess args (scripts/api/subprocess.py), structured-error coercion. Report missing security tests as coverage-gap/P0-P1.' },
  { prefix: 'perf', name: 'CROSS-CUTTING — global speed & harness architecture', scope: 'Read vitest.config.ts and pyproject.toml [tool.pytest]. Assess GLOBAL speedups: is pytest running with -n (xdist) parallelism? Is vitest using its default thread pool effectively or could pool/isolate be tuned? Are there session/module-scope fixtures that should be shared? Per-test heavy imports (pandas, ib_insync, playwright)? Redundant coverage instrumentation cost? Missing test sharding for CI? Real sleeps anywhere (grep for time.sleep / setTimeout in tests / page.waitForTimeout). Propose a concrete CI test-gate workflow since none exists. Quantify expected wall-clock savings.' },
]

phase('Analyze')
log(`Auditing ${SEGMENTS.length} suite segments in parallel...`)

const results = await pipeline(
  SEGMENTS,
  (seg) => analyze(seg),
  (res, seg) => {
    if (!res || !res.findings) return { segment: seg.name, prefix: seg.prefix, summary: res?.summary || '', findings: [], verdicts: [] }
    const critical = res.findings.filter((f) => f.severity === 'P0' || f.severity === 'P1')
    if (!critical.length) return { segment: seg.name, prefix: seg.prefix, summary: res.summary, findings: res.findings, verdicts: [] }
    return parallel(
      critical.map((f) => () =>
        agent(
          `${CTX}\n\nAdversarially VERIFY this test-suite finding. Open the cited files and check the evidence is REAL and the recommendation is SAFE (won't silently reduce coverage or introduce flakiness). Default to "needs-adjustment" or "rejected" if you cannot confirm the evidence by reading the file.\n\nFINDING:\n${JSON.stringify(f, null, 2)}`,
          { label: `verify:${f.id}`, phase: 'Verify', schema: VERDICT_SCHEMA }
        ).then((v) => ({ ...v, finding: f }))
      )
    ).then((verdicts) => ({ segment: seg.name, prefix: seg.prefix, summary: res.summary, findings: res.findings, verdicts: verdicts.filter(Boolean) }))
  }
)

phase('Synthesize')
const clean = results.filter(Boolean)
const allFindings = clean.flatMap((r) => r.findings)
const allVerdicts = clean.flatMap((r) => r.verdicts)
log(`${allFindings.length} findings across ${clean.length} segments; ${allVerdicts.length} P0/P1 adversarially verified.`)

const report = await agent(
  `${CTX}\n\nYou are the lead test architect. Synthesize the per-segment audit + adversarial verdicts into ONE prioritized, actionable hardening report (markdown).\n\nPER-SEGMENT SUMMARIES + FINDINGS:\n${JSON.stringify(clean.map((r) => ({ segment: r.segment, summary: r.summary, findings: r.findings })), null, 2)}\n\nADVERSARIAL VERDICTS (P0/P1 only — drop or downgrade anything rejected; apply refinedRecommendation for needs-adjustment):\n${JSON.stringify(allVerdicts, null, 2)}\n\nProduce sections:\n1. Executive summary (suite health by language/layer; biggest risks).\n2. P0/P1 action list — table: id | category | suite | file | fix | safety risk. Confirmed findings first.\n3. Speedups — ranked by estimated seconds saved, with total projected wall-clock improvement; separate "safe now" from "needs measurement".\n4. Stale / delete list — tests safe to remove and why.\n5. Missing edge cases by suite — concrete new test cases to add (one line each).\n6. Recommended CI test-gate (concrete .github/workflows yaml sketch) since none exists today.\n7. Suggested execution order for applying fixes (so the main agent can implement + verify incrementally).\nBe concrete and cite file:line. No fluff.`,
  { label: 'synthesize', phase: 'Synthesize' }
)

return { report, findingCount: allFindings.length, verifiedCount: allVerdicts.length, segments: clean.length }
