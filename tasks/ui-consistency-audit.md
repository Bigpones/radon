# Radon Web UI — Consistency, Reuse & Cross-Device Parity Audit

_Generated 2026-05-28 via dynamic multi-agent workflow (`ui-consistency-audit`)._
_Surface coverage: 7 areas, 186 components/routes/tokens catalogued. 31 raw findings; 1 rejected on verification (dead code)._

## Executive summary

Radon's UI is largely token-driven and routes through a single `WorkspaceShell`, but three structural themes recur:

1. **Dialog / order-entry duplication.** A canonical `Modal.tsx` exists, yet `FillsModal`, `ShareReportModal`, and admin `ConfirmDialog` hand-roll their own backdrop / Escape / scroll-lock, and several drop accessibility behavior entirely. The single-leg order ticket and the futures/index order forms are near-duplicates of each other. This duplication sits on the order-placement seam where wrong-risk bugs have repeatedly shipped.
2. **Token leakage.** Several panels (GEX, VCG, Regime, ratings bar) bake raw hex / rgba / `#000` / `#fff` instead of brand tokens, so they do not adapt between light and dark themes while neighboring rows do.
3. **Touch / mobile parity gaps.** `InfoTooltip` (used 30x) is hover-only with a sub-44px target, several charts bind inspection to `onMouseMove` only, the Discover table has no mobile card variant, and the theme toggle is desktop-only.

No P0s. **9 x P1, 5 x P2, 2 x P3** confirmed (parity items re-graded into the same scale below).

---

## 1. Reusable component opportunities (ranked)

| # | Proposed shared unit | Current duplicate sites | Sev |
|---|---|---|---|
| R1 | `useDialogChrome()` / `useFocusTrap()` hook + route all dialogs through `Modal.tsx` | `Modal.tsx`, `FillsModal.tsx` (no portal/Escape/scroll-lock/ARIA), `ShareReportModal.tsx`, `admin/ConfirmDialog.tsx`, `NewsfeedLightbox.tsx`, `mobile/BottomSheet.tsx` | P1 |
| R2 | `<SingleLegOrderTicket>` (action toggle + qty + limit w/ BID·MID·ASK + TIF + confirm-step + `OrderRiskGate` slot) | `InstrumentDetailModal.tsx:110-342` (LegOrderForm), `ticker-detail/BookTab.tsx:300-623` (StockOrderForm) | P1 |
| R3 | `<ListedContractOrderForm>` + shared `formatExpiry` util | `ticker-detail/FuturesOrderForm.tsx:45-283`, `ticker-detail/IndexOptionOrderForm.tsx:43-338` (~90% identical) | P1 |
| R4 | `<SortTh>` component + `usePriceDirection()` hook | `PositionTable.tsx:34,76` vs `WorkspaceSections.tsx:759,801` (verbatim copies) | P1 |
| R5 | Migrate `SortableCtaTable` onto shared `useSort` + `SortTh` | `SortableCtaTable.tsx:126-130` (3rd sort impl, 3-state cycle, no a11y) | P2 |
| R6 | Delete orphan `CtaTables.tsx` | `CtaTables.tsx` (never imported; `tests/cta-page.test.ts:55` asserts non-import; helpers already drifted) | P2 |
| R7 | `<MetricBreakdownModal>` primitive + `lib/format/money.ts` | `PnlBreakdownModal.tsx`, `ExposureBreakdownModal.tsx`, `AccountMetricModal.tsx`; money fmts also dup in `FillsModal`, `dashboard/PortfolioSnapshotCard` | P2 |
| R8 | `<BookSectionHeader>` + `.book-l1-cell` classes | `ticker-detail/BookTab.tsx:48-296,692-729` (4x repeated inline header style; mirrored bid/ask columns) | P3 |
| R9 | `useDismissablePopover(ref, onClose)` hook | `ColumnsToggle.tsx:31-47`, `SharePnlButton`, `TickerSearch` (triplicated click-outside+Escape) | P3 |

**Rejected on verification:** "Three single-purpose alert banners" (`ConnectionBanner`, `ServiceHealthBanner`, `FlexTokenBanner`) — all three are **dead code** (zero non-test imports), already superseded by `FooterTelemetryStrip` (MOVE 11, 2026-05-20). No action.

---

## 2. Visual / theme consistency

| # | Finding | Locations | Sev |
|---|---|---|---|
| V1 | Raw hex/rgba (`#85b7eb`, `rgba(56,138,221,..)`, `color:#fff`) for MQ accent | `GexPanel.tsx:64-66,246,281,290-291,331,535` | P1 |
| V2 | Badge text hardcoded `#000`/`#fff` per-state | `VcgPanel.tsx:226-318`, `RegimePanel.tsx:338` | P1 |
| V3 | Solid-fill badges override canonical outline `.pill` | `globals.css:1927-1966`, `VcgPanel`, `RegimePanel`, `GexPanel:531-538` | P1 |
| V4 | Pill font-size 9px inline vs 10px canonical (20 sites) | `globals.css:1930`, `VcgPanel.tsx:226-318` | P2 |
| V5 | Three loading treatments: `SpectralLoader` vs Tailwind `TableSkeleton` vs bare text | `SpectralLoader.tsx`, `ui/Skeleton.tsx`, `WorkspaceSections`, `CashFlowsSection`, `VcgPanel`, `GexPanel:445-456` | P1 |
| V6 | `TableSkeleton` uses `rounded-md` (6px > 4px rule) + `bg-gray-800`/`bg-muted` (off-system) | `ui/Skeleton.tsx:9,18-26` | P2 |
| V7 | `SectionEmptyState` exists but most surfaces use ad-hoc empties (`.tab-empty`, `.fills-empty`, `.eb-empty`, `.futures-form-empty`, `.news-feed-empty`) | `SectionEmptyState.tsx`, ticker-detail tabs, `FillsModal`, `PnlBreakdownModal`, order forms, `DashboardNewsFeed` | P1 |
| V8 | Em dashes in user-facing copy (banned) | `PnlBreakdownModal.tsx:59`, `OptionsChainTab.tsx:493,567`, `OrderTab` header, `CtaTables.tsx:163`, `FuturesOrderForm.tsx:189` | P2 |
| V9 | `0.5px` borders on GEX badges (DPR-inconsistent) vs 1px system | `GexPanel.tsx:64-66,291` | P3 |
| V10 | Ratings bar hardcodes `#048A7A` (=`--signal-deep`), `#475569` (=`--text-muted`), `#9F1239` | `globals.css:5236,5238,5240` | P2 |

---

## 3. Cross-device functional parity

| # | Form factor losing functionality | Finding | Locations | Sev |
|---|---|---|---|---|
| P1 | mobile + tablet-touch | `InfoTooltip` hover/focus-only, no tap-to-reveal, 13px (<44px) trigger; used 30x | `InfoTooltip.tsx:36-50`, `WorkspaceSections.tsx:1300,1454` | P1 |
| P2 | mobile | Theme toggle is desktop-only | `Header.tsx:131-139`, `mobile/MobileAppBar.tsx:71-90`, `mobile/MobileMoreDrawer.tsx:14-22` | P2 |
| P3 | mobile | Discover has no mobile card variant (sibling Scanner does) | `WorkspaceSections.tsx:1418-1472` vs `:1279,1317-1351` | P2 |
| P4 | mobile + tablet-touch | CRI scatter/spread readouts bound to `onMouseMove` only | `RegimeRelationshipView.tsx:522-523,638,935-936` | P2 |
| P5 | mobile + tablet-touch | GEX/VCG/Performance/Internals panels have no mobile variant | `GexPanel`, `VcgPanel`, `PerformancePanel`, `InternalsPanel` | P2 |
| P6 | mobile | Detail modals render wide tables with no inner `table-wrap` | `FillsModal`, `PnlBreakdownModal`, `globals.css:4160-4169` | P3 |
| P7 | mobile | `FooterTelemetryStrip` build-version/WS-count not surfaced on mobile | `FooterTelemetryStrip.tsx`, `mobile/MobileMoreDrawer.tsx:140-150` | P3 |
| P8 | mobile | "Operator" link advertised in mobile drawer routes to a desktop-only guard | `admin/AdminWorkspace.tsx:264-274`, `mobile/MobileMoreDrawer.tsx:21` | P3 |

---

## 4. Interaction pattern consistency

| # | Finding | Locations | Sev |
|---|---|---|---|
| I1 | Order feedback split: inline `OrderErrorBanner`/`.order-success` vs global toast system | `OptionsChainTab:790`, `OrderTab:514`, `InstrumentDetailModal:309`, `Toast.tsx`, `WorkspaceShell:412` | P2 |

(Modal/focus-trap and sort-impl interaction findings are folded into R1, R4, R5 above.)

---

## 5. Prioritized action plan

Status legend: `[x]` = code-complete + typecheck/unit green (E2E visual pass still pending); `[~]` = partial; `[ ]` = deferred (blocked on workflow re-run — see § 6).

**P1**
- [~] R1 `useDialogChrome` created + consumed by `Modal.tsx`; `FillsModal`/`ShareReportModal`/`ConfirmDialog`/`NewsfeedLightbox`/`BottomSheet` NOT yet migrated
- [ ] R2 `<SingleLegOrderTicket>` written (313 lines) but ORPHANED — not wired into `InstrumentDetailModal`/`BookTab`. Deferred: order-placement seam, needs E2E.
- [ ] R3 `<ListedContractOrderForm>` written (245 lines) but ORPHANED — not wired into `FuturesOrderForm`/`IndexOptionOrderForm`. Dead `formatExpiry` in `lib/format.ts` reverted.
- [x] R4 `<SortTh>` + `usePriceDirection` extracted; `PositionTable` AND `WorkspaceSections` migrated, locals deleted
- [x] V1 `--gex-mq-accent` token added (both themes); GEX raw hex/rgba → `color-mix(var(--token))`
- [x] V2 `--text-on-accent` (aliased to `--accent-text`, theme-aware); `#000`/`#fff` badge text removed
- [x] V3 `.pill--solid` modifier added; VcgPanel/RegimePanel use it instead of inline base-`.pill` overrides
- [~] V5 loading states — panels not fully consolidated on `SpectralLoader`; deferred
- [~] V7 `SectionEmptyState` adopted in WorkspaceSections; ticker-detail tabs / modals not all routed; deferred
- [x] P1 `InfoTooltip` tap-to-reveal + 44px touch target

**P2**
- [ ] R5 `SortableCtaTable` → shared `useSort`+`SortTh` — deferred (entangled with brittle source-grep assertions in `cta-page.test.ts`)
- [x] R6 deleted `CtaTables.tsx` (confirmed zero importers)
- [~] R7 `lib/format/money.ts` created + wired into `PnlBreakdownModal`/`ExposureBreakdownModal`/`PortfolioSnapshotCard` (verified byte-equivalent). `<MetricBreakdownModal>` NOT created; deferred.
- [x] V4 pill font-size standardized on 10px base
- [x] V6 `TableSkeleton` → brand tokens + 4px radius
- [x] V8 em dashes removed (`OptionsChainTab` x2, `PnlBreakdownModal`)
- [x] V10 ratings bar → `--signal-deep` / `--text-muted` / new `--signal-fault-deep`
- [ ] P2 add theme toggle to `MobileMoreDrawer` — deferred
- [ ] P3 Discover mobile card variant (mirror Scanner) — deferred
- [x] P4 `RegimeRelationshipView` → `onPointerMove`/`onPointerLeave` (+ test updated to fire pointer events)
- [ ] P5 single-column mobile layouts for GEX/VCG/Performance/Internals — deferred
- [ ] I1 route order-SUCCESS through `addToast()` — deferred

**P3**
- [ ] R8 `<BookSectionHeader>` + `.book-l1-cell` classes — deferred
- [x] R9 `useDismissablePopover` hook + `ColumnsToggle`/`SharePnlButton`/`TickerSearch` migrated
- [x] V9 GEX `0.5px` → `1px` token border
- [ ] P6 inner `table-wrap` in detail modals — deferred
- [ ] P7 surface build version on mobile drawer — deferred
- [ ] P8 hide/soften Operator link on mobile — deferred

## 6. Status & blocker (2026-05-28)

**Done + verified green (typecheck + 2625 unit tests; only 2 pre-existing baseline failures remain):** R4, R6, R7-formatters, R9, V1, V2, V3, V4, V6, V8, V9, V10, P1, P4.

**Critical regression fixed this pass:** the prior run migrated GexPanel/VcgPanel/RegimePanel to reference `--gex-mq-accent`, `--text-on-accent`, and `.pill--solid` that did NOT exist in `globals.css` (that batch never ran) — badges were rendering with invalid colors. Tokens + classes now defined in both themes.

**Deferred (orphaned or risky):** R1 (4 dialogs), R2/R3 (order-placement seam — orphan files of unverified fidelity; `web/CLAUDE.md` documents 3 wrong-risk bugs at this seam), R5, R7-modal, R8, V5, V7, P2, P3, P5, P6, P7, P8, I1.

**Blocker:** the implementation workflow died on `ANTHROPIC_API_KEY` ("Credit balance is too low" x11). Subagents bill against that key; the main session uses the subscription. To finish the deferred items via workflow: unset `ANTHROPIC_API_KEY` in the launching shell (or top it up) and restart Claude Code, then resume `ui-consistency-implement` (cached agents skip).

**Not committed/pushed:** E2E browser verification (required gate) not yet run, and push to `main` auto-deploys to production. Awaiting either E2E + go-ahead for the verified subset, or the billing fix to complete all findings first.
