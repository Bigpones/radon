# Order-Risk Chokepoint Refactor — Plan

## Motivation

Three production bugs in eight days, all in the same bug class — risk math wrong at the **integration seam** between portfolio state and order state, not in the math itself:

| Date | Commit | Surface | Failure mode |
|---|---|---|---|
| 2026-05-19 | `05da575` | OrderTab AAOI risk reversal | Max Loss `$5k` vs real `$755k` |
| 2026-05-26 (early) | `d6a6682` | OptionsChain chain builder (WULF) | UNBOUNDED on bull call spread; Max Gain × 77² |
| 2026-05-26 (late) | `6d45da2` | OptionsChain chain builder (RR) | UNBOUNDED on stock-backed covered call |

Each fix was surgical to one surface. The math (`computeOrderRisk`) is correct in isolation. The bug returns because every new order-entry surface re-creates the portfolio/order seam by hand. **The goal of this refactor: make it structurally impossible to ship a new order surface without portfolio-aware risk math.**

## Audit — surfaces that compute or display order risk today

| # | Surface | File | Augmentation? | Known-broken inputs |
|---|---|---|---|---|
| 1 | OptionsChain — OrderBuilder | `components/ticker-detail/OptionsChainTab.tsx` | **Yes** (reference impl) | None known |
| 2 | OrderTab — single-leg NewOrderForm | `components/ticker-detail/OrderTab.tsx:299-382` | Ad-hoc `coveringLongContracts` only | Coverage from OTHER positions invisible |
| 3 | OrderTab — combo form | `components/ticker-detail/OrderTab.tsx:722-762` | No | Coverage from other positions invisible |
| 4 | InstrumentDetailModal — single-leg order form | `components/InstrumentDetailModal.tsx:141-179` | No, doesn't even receive `portfolio` | Wrong-qty SELL of N where held M<N is treated as pure close; no portfolio coverage at all |
| 5 | ModifyOrderModal — leg editor | `components/ModifyOrderModal.tsx:233-627` | No risk math at all | Combo restructure (bull-put-spread → naked-short-put) silently resubmits with no UNBOUNDED warning |
| 6 | BookTab — stock order form | `components/ticker-detail/BookTab.tsx:332-340` | No | Short stock has no UNBOUNDED warning |
| 7 | FuturesOrderForm | `components/ticker-detail/FuturesOrderForm.tsx:68-73` | No | Short VIX futures are UNBOUNDED, shown only as "Notional" |
| 8 | **IndexOptionOrderForm** | `components/ticker-detail/IndexOptionOrderForm.tsx:74-79` | No | **SPX/NDX/VIX SELL CALL is UNBOUNDED, no warning anywhere** |
| 9 | **MobileOrderTicket** | `components/mobile/MobileOrderTicket.tsx:35-310` | No risk math at all | Risk reversals, short straddles, jade lizards on mobile have ZERO risk feedback |
| 10 | MobileChainLadder | `components/mobile/MobileChainLadder.tsx:210-292` | (Downstream — see #9) | Same as #9 |

**Ranked by user-visible blast radius:**

1. **IndexOptionOrderForm** — SPX SELL CALL is a cash-settled naked short. UI shows only Notional. Highest-impact gap.
2. **MobileOrderTicket** — entire mobile combo builder bypasses risk math.
3. **InstrumentDetailModal** — most-used desktop drilldown for closing legs, three latent bugs, but operator *thinks* the rendered `OrderConfirmSummary` is correct.
4. **FuturesOrderForm** — short futures, no UNBOUNDED.
5. **ModifyOrderModal** — combo restructure with no risk feedback.

## The chokepoint design (the architectural answer)

**Pick a single shape:** branded type + hook + renderless gate component + module-private math.

- `useOrderRisk(input: OrderRiskInput | null): OrderRiskState` — the only public way to compute risk.
- `<OrderRiskGate input={...} surface="chain-builder" />` — renderless component that wraps the hook, owns telemetry, drives `<OrderConfirmSummary>`.
- `AugmentedOrderSummary` — branded type carrying `readonly [__augmented]: "augmented"`. `<OrderConfirmSummary>` accepts only this type.
- `computeOrderRisk` and `augmentOrderLegsWithPortfolioCoverage` move to `lib/order/risk/internal/`. **ESLint blocks imports from outside that folder.**
- A `OrderRiskState` of `"pending"` renders a labeled skeleton + disables submit — **never** a blank UNBOUNDED.

### Why this shape and not the others

- **Pure function** — wrong. Any caller can hand-build an `OrderSummary` literal and skip the function. That's exactly what shipped three times.
- **React Context** — wrong. Contexts are opt-in.
- **Hook alone** — insufficient. Doesn't prevent hand-built summaries reaching `<OrderConfirmSummary>`.
- **Branded type + hook + gate + lint** — three reinforcing layers. Defeating it requires (a) defeating the type brand (unforgeable `unique symbol`), (b) bypassing the eslint rule, AND (c) ignoring a dev-mode runtime assertion. Each layer alone would not have stopped the RR bug; together they do.

## Step-by-step plan (≈23 engineer-hours, 8 PRs)

| # | Step | Files | Hours | Notes |
|---|---|---|---|---|
| 1 | Introduce `AugmentedOrderSummary` brand; lock `<OrderConfirmSummary>` to it | `lib/order/types.ts`, `lib/order/components/OrderConfirmSummary.tsx` | 3 | Breaks compile at every existing call site — intentional |
| 2 | **HIGHEST LEVERAGE** — create `useOrderRisk` + `<OrderRiskGate>`; move `computeOrderRisk` to `internal/`; lint rule | New `lib/order/risk/{useOrderRisk.ts, OrderRiskGate.tsx, internal/computeOrderRisk.ts, index.ts}`, `.eslintrc.json` | 6 | Combined with step 1 this prevents the entire bug class on new surfaces |
| 3 | Migrate `OptionsChainTab` to `<OrderRiskGate>` | `components/ticker-detail/OptionsChainTab.tsx` | 2 | Reference call site → uses the new gate |
| 4 | Migrate OrderTab (×2 forms), BookTab, InstrumentDetailModal, MobileOrderTicket | 5 files | 5 | Closes the four highest-impact surfaces above |
| 5 | Telemetry: per-session "order risk computed" log to `sessionStorage` | New `lib/order/risk/telemetry.ts` | 2 | Bug reports include the dump |
| 6 | `<OrderCloseSummary>` for explicit close paths (also branded) | New `lib/order/risk/OrderCloseSummary.tsx` | 2 | Unifies close-vs-open accounting in one place |
| 7 | Test-only adapter `lib/order/risk/__test_only__.ts`; `lib/orderRisk.ts` becomes a one-line re-export | 2 files | 2 | All 50 existing tests stay unchanged |
| 8 | Document in `web/CLAUDE.md`; CLAUDE.md update | `web/CLAUDE.md` | 1 | "Order-risk chokepoint" section under combo guardrails |

Steps 1+2 must ship together (1 breaks compile; 2 has no consumers). Steps 3–4 can land in any order after. Steps 5–8 land last.

### Highest-leverage step
**Step 2** with step 1's brand: prevents the next RR / WULF / AAOI before it's written. Lint+brand+runtime-assert means a future engineer building a new order surface (mobile, futures, index, modify) cannot ship max-loss/max-gain UI without threading portfolio through the hook. Their code will not compile, lint will block them if they reach for the underlying function, and dev-mode toast surfaces it if they smuggle past both.

### Breaking changes
- `OrderSummary` is renamed `OrderPresentationSummary`, internal to the risk module.
- Every current call site is migrated in steps 3–4.
- `computeOrderRisk` and `augmentOrderLegsWithPortfolioCoverage` lose public export status; production code can no longer import them. Tests reach them through `__test_only__.ts`.
- Pending-portfolio state is now explicit "Coverage indeterminate" (skeleton + disabled submit). Surfaces that previously rendered "max loss: ---" before portfolio resolved will now show a labeled skeleton. This is a behavior change.

## Property-based fuzz suite (the safety net)

Even with the chokepoint, the fuzz suite verifies the seam holds across the input space. New dependency: `fast-check` (~1 MB, MIT licensed).

### The 15 invariants

| # | Name | One-line condition | Bug it would have caught |
|---|---|---|---|
| I1 | Closure under sign | Covered SELL calls ⇒ `maxLoss` finite | WULF, RR |
| I2 | **Monotone in coverage** | Adding LONG cover cannot increase `maxLoss` | WULF, RR, future variants |
| I3 | Cap discipline | Excess longs do not flip `maxGainUnbounded` | Future regression of the 100-shares-per-call cap |
| I4 | **Quantity linearity** | `maxLoss(N) = N × maxLoss(1)` for single-leg | WULF qty² ($3.32M vs $43k) |
| I5 | Empty-portfolio degenerate | `null` portfolio ≡ `{positions: []}` | Phantom-leg injection regressions |
| I6 | Ticker isolation | Other-ticker positions don't leak | Cross-ticker coverage leak |
| I7 | **Stock-cover floor** | Covered call `maxLoss ≈ shares × avgCost − premium` | RR's "would-be $0 maxLoss" if adjustment forgotten |
| I8 | Net premium consistency | `maxLoss + maxGain = intrinsic_span × N × 100` | Premium double-count |
| I9 | Put/call duality | Bull call mirrors to bear put with equal risk | Side-asymmetry refactor drift |
| I10 | Close short-circuit | `coveringLongContracts ≥ N` ⇒ maxLoss = maxGain = 0 | Closing trade mis-routes |
| I11 | Permutation conservation | Leg order doesn't matter | Coverage pairing leaks |
| I12 | Non-negative finite bounded | When bounded, value finite & ≥ 0 | NaN/Infinity propagation |
| I13 | Covered call max gain ceiling | Pure covered call never unbounded gain | Excess shares spilling in |
| I14 | Augmentation idempotence | `augment(augment(...)) == augment(...)` | Double-call re-injection |
| I15 | comboQuantity scaling | Scale combo by k ⇒ risk scales by k | Multi-leg qty² regression |

### Highest-leverage three (ship first)

1. **I2 / P4 — Coverage monotonicity.** This IS the bug class. WULF and RR are both single instances of "adding coverage didn't make the verdict finite." Every plausible next variant (expiry-format drift, new IB security type the loader skips, direction-string casing) manifests here as a `null` that should have been finite.
2. **I4 / P3 — Quantity linearity.** Catches qty² and its descendants. Runs in <500ms.
3. **I7 — Stock-cover floor (exact-dollar assertion).** The latent bug ALL OTHER properties miss: going from "no cover, unbounded" to "covered, $0" passes monotonicity but is still wrong. Pin the dollar number, not just the boundedness.

### Targeted property tests (the 5 to write first)

- **P1** — long calls fully cover short calls ⇒ bounded (WULF guard, 1000 runs, ~300ms)
- **P2** — 100×N shares cover N short calls ⇒ bounded + finite (RR guard, 1000 runs, ~250ms)
- **P3** — single-leg quantity linearity (qty² guard, 1000 runs, ~400ms)
- **P4** — coverage monotonicity (the catches-future-variants property, 1000 runs, ~600ms)
- **P5** — empty portfolio ≡ null portfolio (degenerate equivalence, 500 runs, ~150ms)

### Wiring + CI

- Files: `web/tests/fuzz/order-risk.fuzz.test.ts`, `web/tests/fuzz/generators.ts`, `web/tests/fuzz/builders.ts`.
- Vitest picks up via existing `web/tests/**/*.test.ts` glob; zero config change.
- CI seed: `42` for reproducibility. Local exploratory runs: `RADON_FUZZ_RANDOM=1 npm run test fuzz`.
- Performance budget: ≈8–12s total fuzz addition. Under the 30s cap.
- Counter-example reporter prints shrunk failing input as JSON for one-line repro paste into `order-risk.test.ts` as an example-based regression.

## Sequencing recommendation

1. **Week 1** — Steps 1+2 ship together. Plus P1+P2+P3+P4 (the four most direct fuzz properties). This kills the bug class on all *current* and *future* desktop chain surfaces.
2. **Week 2** — Step 3 (migrate chain) + Step 4 surfaces (1–2 per day, ordered by user-visible impact: IndexOptionOrderForm first, MobileOrderTicket second, InstrumentDetailModal third).
3. **Week 3** — Steps 5–8 + remaining fuzz invariants (I5–I15).

After step 2 lands, **the architectural answer to "will this happen again" changes from "yes, in a different shape" to "only if the engineer defeats the type system, the lint rule, AND the runtime assertion."** That is the bar this refactor is designed to clear.

## What this refactor does NOT solve

- IB-side margin disagreement. The chokepoint reflects the operator's view; IB's margin engine is a separate oracle. If they ever disagree (e.g., portfolio-margin rule change), the chokepoint is silent.
- Race conditions where portfolio updates mid-render. The pending state mitigates first-paint but a portfolio snapshot taken at click time may not match the snapshot at submit time.
- Pricing seam — `computeNetPrice`, `computeNetOptionQuote`, `resolveSpreadPriceData` are separate code paths. A pricing bug (wrong sign, stale bid/ask) still ships independently.
