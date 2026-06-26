# Asset Detail View — Cockpit IA Overhaul: Implementation Plan

Refactor the ticker detail view (`app.radon.run/[ticker]`) from the **hero + 8-peer-tab**
layout into the **book-first cockpit** IA. Driven by the synthesized + double-scrutinized
spec (`/tmp/ia/spec.md`) and the approved mockup (`/tmp/radon-asset-detail-ia.html`).

**Thesis:** the book is the page. On entry you see the order book; the hero is gone;
position numerics live in one place; the live trace is cut. Hot-path surfaces (Book,
Tape, Ticket, Position) are always docked; reference surfaces (Chain/News/Ratings/
Seasonal/Info) open a deck over the Act column only, never occluding the book.

**Status: plan only. Mockup approved (rendering bugs fixed). No production code yet.**

---

## 0. Current state (verified)

- **`web/components/TickerWorkspace.tsx`** — reads `?tab=` from the URL, `VALID_TABS`
  (line 9), defaults to `"company"` (line 30); `setTab` → `router.replace` (no history
  pollution); pulls `prices/fundamentals/portfolio/orders/depths/tape` from
  `TickerDetailContext`; renders `<TickerDetailContent>` inside `.ticker-detail-page`
  with a `← Back` button.
- **`web/components/TickerDetailContent.tsx`** — the layout to overhaul:
  - **Hero** (`240-260`): left = position pill + `<TickerQuoteTelemetry priceData={quotePriceData}>`; right = `<PriceChart … valueKind=…>` (the Live Trace).
  - **Tab bar** (`263-273`) + **tab content** (`276-340`): Company / Book / Chain /
    Position / Order / News / Ratings / Seasonal. Default `company`.
  - Already computes everything the cockpit needs: `bookKey`, `bookKind`, `bookDepth`,
    `quotePriceData` (depth-NBBO-corrected), `isSpreadNet`, `position`, `tickerOrders`,
    `onDepthSymbolChange` effect, `stockFallback`.
- **Tabs render:** `<CompanyTab>`, `<BookTab>` (the new L2 montage/ladder + tape),
  `<OptionsChainTab>`, `<PositionTab>`, `<OrderTab>`, `<NewsTab>`, `<RatingsTab>`,
  `<SeasonalityTab>`. All consume props already in scope.
- **CSS:** `.ticker-detail-{content,hero,hero-left,hero-right,header}`, `.ticker-tabs`,
  `.ticker-tab`, `.ticker-tab-content` at `globals.css:4912-4955` (incl. a mobile media
  query). These get replaced/augmented, not deleted wholesale (other code may reference).
- **Mobile:** `WorkspaceShell` renders `MobileShell` chrome when `isMobile && hasMounted`,
  but ticker-detail still renders `TickerWorkspace` → `TickerDetailContent` (no mobile
  variant of the detail body today). The cockpit's 3-column grid will NOT fit 393px →
  needs an explicit mobile fallback (§5).

---

## 1. Target layout (from the approved mockup)

CSS grid cockpit, `100vh`, no page scroll:

```
grid-template-rows: 34px 1fr;
grid-template-columns: 1fr minmax(360px, 36%) 44px;
areas: "head head head" / "book act rail"
```

- **Header strip (34px, spans all):** symbol · kind · last · netΔ% · SPREAD (derived) ·
  ●LIVE · position chip (label+link, no numerics). **No redundant bid×ask scalar** (book owns it).
- **Book column (~62%):** `<OrderBook>` montage/ladder top (~62% col ht) + Time & Sales
  tape bottom, shared price axis. Cursor parked here on load.
- **Act column (~36%):** `<OrderTab>` (ticket) pinned top + `<PositionTab>` (or FLAT
  affordance) pinned bottom. Both always live, no mode switch.
- **Glyph rail (44px):** labeled vertical nav `c/p/n/r/s/i/:` with badges; opens the deck.
- **Deck:** `position:fixed`, slides over the **Act column only** (`right:44px`,
  `width:36%`), `visibility:hidden` when closed (mockup fix — avoids the right-edge clip).
  Esc closes. Holds Chain / News / Ratings / Seasonal / Info / Position-expand / palette.

---

## 2. Navigation model change

**Replace 8 URL tabs with: docked hot-path + deck for reference.**

- New URL param semantics: `?deck=<c|p|n|r|s|i>` opens a deck panel; **no `deck` = book-first
  default** (the cockpit with book+ticket+position, deck closed). This replaces
  `?tab=company` as the default and is the core "book is what you land on" change.
- Keep `?posId=` (deep-link to a specific position) — drives which position the Act
  column + Position deck show.
- `TickerWorkspace`: rename `activeTab`/`VALID_TABS`/`setTab` → `activeDeck`/`VALID_DECKS`/
  `setDeck`; default `activeDeck = null` (book-first). `setDeck(null)` clears the param.
- **Back-compat:** map legacy `?tab=` values on read — `tab=book|company` → no deck (book
  is now always visible); `tab=chain|position|news|ratings|seasonal` → `deck=<that>`;
  `tab=order` → no deck (ticket is always docked). A tiny `legacyTabToDeck()` shim so old
  links/bookmarks don't 404 into a blank state.

---

## 3. Component work

### 3a. New `AssetCockpit.tsx` (replaces TickerDetailContent's body)
Keep `TickerDetailContent` as the data-resolution layer (all the `useMemo`s for bookKey/
bookKind/quotePriceData/isSpreadNet/position/tickerOrders/stockFallback stay — they're
correct and reused). Extract the **return JSX** into a new `AssetCockpit` that takes the
resolved values as props and renders the grid. Rationale: the resolution logic is ~150
lines of verified correctness (don't disturb it); only the layout changes.

- `<CockpitHeader>` — symbol/kind/last/netΔ/spread/LIVE/position-chip. Last+netΔ+spread
  from `quotePriceData` (single source). Position chip = `position ? position.structure :
  "FLAT"` + `→`, onClick `setDeck("p")`. **No bid/ask scalar** (scrutiny fix — book owns it).
- **Book region** — render the existing `<BookTab>` (already the montage/ladder + tape),
  but stripped of any header quote block it duplicates (confirm `BookTab`/`OrderBook` header
  shows depth-derived NBBO only; it does post the earlier fix — keep). Sits in the `book`
  grid area, full height.
- **Act region** — stack `<OrderTab>` (top) + `<PositionTab>`-or-FLAT (bottom), both always
  mounted. `OrderTab` already takes `{ticker, position, portfolio, prices, openOrders,
  tickerPriceData}` — pass as today. `PositionTab` takes `{position, prices}`. FLAT state
  (no position) = the "ticket opens one" affordance from the mockup.
- `<GlyphRail>` — the labeled nav; `news` badge from `NewsTab`'s unread count (needs a
  count source — see Risks). Buttons call `setDeck(key)`.
- `<AssetDeck>` — the slide-over; renders the selected reference surface
  (`OptionsChainTab` / `NewsTab` / `RatingsTab` / `SeasonalityTab` / `CompanyTab` /
  Position-expand) by `activeDeck`. Keyboard: `c/p/n/r/s/i` open, `Esc` close (guard so it
  doesn't fire while typing in the ticket inputs — check `document.activeElement`).

### 3b. Surfaces — keep, move, cut
| Surface | Action | New home |
|---|---|---|
| `BookTab` (montage/ladder+tape) | keep | Book region (always visible) |
| `OrderTab` | promote | Act region top (always docked) |
| `PositionTab` | promote | Act region bottom (always docked) + `p` deck expand |
| `OptionsChainTab` | demote | deck `c` |
| `NewsTab` / `RatingsTab` / `SeasonalityTab` | demote | deck `n`/`r`/`s` |
| `CompanyTab` | demote hard | deck `i` (last) + session VOL/HIGH/LOW move here off chrome |
| `TickerQuoteTelemetry` hero | **cut** | (replaced by `<CockpitHeader>`) |
| `PriceChart` Live Trace | **cut** from the page | optional `:chart` palette summon later; NOT a standing panel, NOT a header sparkline (scrutiny fix) |
| position pill in hero | **cut** | becomes the header position chip (link, no numerics) |

### 3c. CSS (`globals.css`)
- Add `.cockpit*`, `.book-region`, `.act-region`, `.glyph-rail`, `.asset-deck` rules
  ported from the mockup (brand tokens, `color-mix`, 4px radius, no raw hex, no em dashes).
- Keep the old `.ticker-detail-*` / `.ticker-tab*` classes until grep confirms nothing else
  uses them, then remove in the same PR (or leave as orphan if risky — note it).
- The cockpit replaces `.ticker-detail-page`'s scroll behavior with a fixed-height grid;
  confirm `WorkspaceShell`'s content area gives it the viewport height (the shell currently
  assumes scrollable section content — the cockpit needs `height: 100%` / `min-height:0`
  threading from the shell down, the one layout-integration risk).

---

## 4. Data / duplication (already mostly solved)
- `quotePriceData` (depth-NBBO-corrected) is the single quote source → header. ✓ (done earlier)
- Spread-net for combos → Position panel only (`isSpreadNet` already flagged). ✓
- Book owns bid/ask depth; header shows last/netΔ/spread only — **drop the bid×ask scalar
  anywhere it currently double-renders** (scrutiny Violation 2). Verify `OrderBook` header
  doesn't restate a scalar the cockpit header also shows.
- No new API routes; no cache-contract impact (all WS + existing routes).

---

## 5. Mobile
The 3-col cockpit can't fit 393px. Options:
- **Phase-1 simplest:** on `isMobile`, stack vertically — Book (full width, ~55vh) → a
  segmented control (Ticket | Position) → glyph chips as a horizontal bar opening the deck
  full-screen. Reuse the existing mobile patterns (`MobileChainLadder`, `BottomSheet`).
- Gate via the repo's `useViewport()` (`isMobile && hasMounted`) like other surfaces.
- The deck → `<BottomSheet>` on mobile (already in `components/mobile/`).

---

## 6. Tests
- **Unit:** `legacyTabToDeck()` mapping (every old tab → correct deck/none); `CockpitHeader`
  renders single-source quote (no bid/ask scalar duplication); position chip links not numerics.
- **Component (jsdom):** cockpit renders book + ticket + position always-mounted; glyph
  rail opens the right deck; `Esc` closes; deck does NOT cover the book region (assert book
  region width unchanged when deck open); keyboard guard while typing in ticket inputs.
- **Adaptive:** flat / single-leg option / combo / futures each render the right book kind +
  position content (reuse existing `bookKind` logic tests).
- **E2E/chrome-cdp (RTH):** land on `/MU` → book visible first, no hero; open each deck;
  click a book level → stages into ticket; combo position shows net-credit only in Position.
- Keep the full suite green; this is a layout refactor so watch for snapshot/contract tests
  referencing `.ticker-tab*` or the hero.

---

## 7. Rollout (phased, behind a flag)
- **Flag:** `NEXT_PUBLIC_RADON_COCKPIT` (client). Off → current hero+tabs; On → cockpit.
  Lets us ship + dogfood without a hard cutover.
- **Phase A:** extract `AssetCockpit` + `CockpitHeader` + `GlyphRail` + `AssetDeck`, wire the
  flag, keep all existing tab components as-is (just relocated). No surface rewrites.
- **Phase B:** mobile fallback (§5).
- **Phase C:** remove the flag + the dead hero/`.ticker-tab*` CSS + `PriceChart` from the
  page once verified live RTH. Decide `:chart` palette summon (or drop PriceChart from the
  ticker view entirely; it stays used elsewhere — confirm before deleting the import).
- Live-verify each phase on `app.radon.run` during RTH (book/depth need market hours).

---

## 8. Risks / open questions
- **Viewport height threading:** the cockpit needs a real `100%`/`100vh` height from
  `WorkspaceShell` → today's content area is scroll-oriented. This is the main integration
  unknown; spike it first in Phase A.
- **News unread count** for the rail badge — is there a count source, or compute from
  `NewsTab`'s data? May need a tiny `useNewsCount` or to lift NewsTab's fetch.
- **Always-mounting OrderTab + PositionTab** — `OrderTab` is heavy (order-risk chokepoint,
  `<OrderRiskGate>`). Mounting it always (not lazy on a tab) means its effects run on every
  ticker view. Confirm it's cheap when no order is staged; memoize.
- **Keyboard nav collisions** — `c/p/n/r/s/i` single-key deck opens must not fire while the
  user types in ticket Qty/Limit/TIF. Guard on `activeElement` tag.
- **PriceChart removal blast radius** — used on the ticker view today; confirm no other
  consumer before deleting; the `valueKind="spread-net"` work stays relevant if a `:chart`
  summon is kept.

---

## File map
- **New:** `web/components/ticker-detail/AssetCockpit.tsx`, `CockpitHeader.tsx`,
  `GlyphRail.tsx`, `AssetDeck.tsx`; mobile variant; `web/lib/legacyTabToDeck.ts` (+ tests).
- **Modified:** `TickerDetailContent.tsx` (becomes the resolver that renders `AssetCockpit`),
  `TickerWorkspace.tsx` (deck param + legacy shim), `globals.css` (cockpit rules; remove
  hero/tab rules in Phase C), `WorkspaceShell.tsx` (height threading if needed).
- **Cut (Phase C):** hero JSX, `TickerQuoteTelemetry` usage on this view, `PriceChart` on
  this view (pending `:chart` decision).
- **Reference:** mockup `/tmp/radon-asset-detail-ia.html`, spec `/tmp/ia/spec.md`.
