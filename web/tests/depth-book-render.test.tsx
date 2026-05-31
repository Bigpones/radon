// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { OrderBook } from "../components/ticker-detail/OrderBook";
import { TimeAndSales } from "../components/ticker-detail/TimeAndSales";
import type { DepthBook, Trade } from "../lib/pricesProtocol";

// next/navigation is pulled in transitively by some sibling components; mock it
// so the jsdom render never reaches for a real router.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/RKLB",
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

/* ── fixtures ── */

const STOCK_BOOK: DepthBook = {
  symbol: "RKLB",
  kind: "stock",
  isSmartDepth: true,
  feed: "SMART DEPTH · TOTALVIEW",
  entitled: true,
  timestamp: "2026-05-31T16:00:00Z",
  bid: [
    { price: 152.52, size: 34, marketMaker: "XNMS", exchange: "SMART" },
    { price: 152.52, size: 100, marketMaker: "IEXG", exchange: "SMART" },
    { price: 152.51, size: 100, marketMaker: "XNYS", exchange: "SMART" },
  ],
  ask: [
    { price: 152.7, size: 738, marketMaker: "XNMS", exchange: "SMART" },
    { price: 152.7, size: 100, marketMaker: "BATY", exchange: "SMART" },
    { price: 152.75, size: 10, marketMaker: "XNMS", exchange: "SMART" },
  ],
};

const OPTION_BOOK: DepthBook = {
  symbol: "RKLB_20260620_150_C",
  kind: "option",
  isSmartDepth: true,
  feed: "OPRA · PER-EXCHANGE BBO",
  entitled: true,
  timestamp: "2026-05-31T16:00:00Z",
  bid: [
    { price: 4.35, size: 42, marketMaker: null, exchange: "CBOE", nbbo: true } as never,
    { price: 4.3, size: 25, marketMaker: null, exchange: "PHLX" } as never,
  ],
  ask: [
    { price: 4.45, size: 30, marketMaker: null, exchange: "PHLX", nbbo: true } as never,
    { price: 4.5, size: 55, marketMaker: null, exchange: "CBOE" } as never,
  ],
};

const FUTURE_BOOK: DepthBook = {
  symbol: "ESM6",
  kind: "future",
  isSmartDepth: false,
  feed: "CME · GLOBEX DEPTH",
  entitled: true,
  timestamp: "2026-05-31T16:00:00Z",
  bid: [
    { price: 5012.5, size: 137, marketMaker: null, exchange: null },
    { price: 5012.25, size: 295, marketMaker: null, exchange: null },
  ],
  ask: [
    { price: 5012.75, size: 142, marketMaker: null, exchange: null },
    { price: 5013.0, size: 318, marketMaker: null, exchange: null },
  ],
};

const TAPE: Trade[] = [
  { price: 152.7, size: 1, exchange: "FINY", time: "12:10:29" },
  { price: 152.68, size: 4, exchange: "FINY", time: "12:10:28" },
  { price: 152.73, size: 9, exchange: "XNYS", time: "12:10:27" },
];

const L1_FALLBACK = <div data-testid="l1-fallback">L1 FALLBACK</div>;

function renderBook(book: DepthBook | null, kind: DepthBook["kind"]) {
  return render(
    <OrderBook
      symbolLabel={book?.symbol ?? "RKLB"}
      kind={kind}
      depth={book}
      trades={TAPE}
      last={book?.bid[0]?.price ?? null}
      bid={book?.bid[0]?.price ?? null}
      ask={book?.ask[0]?.price ?? null}
      l1Fallback={L1_FALLBACK}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("OrderBook render — all three kinds", () => {
  it("renders the stock two-sided montage", () => {
    const { container } = renderBook(STOCK_BOOK, "stock");
    expect(container.querySelector(".book-sides")).toBeTruthy();
    // Stock montage draws the price-level edge marker on the first row of a level.
    expect(container.querySelector('.book-row[data-lvlfirst="1"]')).toBeTruthy();
    // Market-maker labels surface.
    expect(container.textContent).toContain("XNMS");
    expect(container.querySelector(".book-ladder")).toBeNull();
  });

  it("renders the option per-exchange BBO montage and suppresses the edge marker", () => {
    const { container } = renderBook(OPTION_BOOK, "option");
    expect(container.querySelector(".book-sides")).toBeTruthy();
    // Options suppress the price-level edge marker entirely.
    expect(container.querySelector('.book-row[data-lvlfirst="1"]')).toBeNull();
    // NBBO best-rule marks the flagged venues, not index 0 alone.
    expect(container.querySelectorAll(".book-row.best").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("CBOE");
  });

  it("renders the futures centered ladder", () => {
    const { container } = renderBook(FUTURE_BOOK, "future");
    expect(container.querySelector(".book-ladder")).toBeTruthy();
    expect(container.querySelector(".book-ladder-spread")).toBeTruthy();
    expect(container.querySelector(".book-sides")).toBeNull();
    expect(container.textContent).toContain("5012.50");
  });
});

describe("Time & Sales toggle reflow", () => {
  it("flips the tape-hidden class and persists to localStorage", () => {
    const { container, getByRole } = renderBook(STOCK_BOOK, "stock");
    const grid = container.querySelector(".book-body-grid")!;
    expect(grid.classList.contains("tape-hidden")).toBe(false);

    const toggle = getByRole("switch");
    fireEvent.click(toggle);

    expect(grid.classList.contains("tape-hidden")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(window.localStorage.getItem("radon:book:tape")).toBe("off");

    fireEvent.click(toggle);
    expect(grid.classList.contains("tape-hidden")).toBe(false);
    expect(window.localStorage.getItem("radon:book:tape")).toBe("on");
  });
});

describe("Degradation — L1 fallback", () => {
  it("renders the L1 fallback when depth is null", () => {
    const { getByTestId } = renderBook(null, "stock");
    expect(getByTestId("l1-fallback")).toBeTruthy();
  });

  it("renders the L1 fallback when entitled:false", () => {
    const unentitled: DepthBook = { ...STOCK_BOOK, entitled: false, bid: [], ask: [] };
    const { getByTestId, container } = renderBook(unentitled, "stock");
    expect(getByTestId("l1-fallback")).toBeTruthy();
    expect(container.querySelector(".book-sides")).toBeNull();
  });
});

describe("Tape tick classification", () => {
  it("colors up / down / flat by the tick test", () => {
    const { container } = render(<TimeAndSales trades={TAPE} visible />);
    const tones = [...container.querySelectorAll(".book-t-px")].map((el) =>
      el.className.replace("book-t-px", "").trim(),
    );
    // First print is flat by convention; 152.68 < 152.70 is down; 152.73 > 152.68 is up.
    expect(tones).toEqual(["flat", "down", "up"]);
  });
});

describe("Brand tokens only — no raw hex / tailwind color utilities", () => {
  it("emits no raw hex colors or green-500/red-500 in the rendered markup", () => {
    const { container } = renderBook(STOCK_BOOK, "stock");
    const html = container.innerHTML;
    // No inline raw hex colors.
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // No tailwind non-brand color utilities.
    expect(html).not.toMatch(/\b(green|red)-500\b/);
  });
});
