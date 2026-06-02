/**
 * @vitest-environment jsdom
 */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DepthMontage } from "../components/ticker-detail/DepthMontage";
import { TimeAndSales } from "../components/ticker-detail/TimeAndSales";
import type { DepthBook, Trade } from "@/lib/pricesProtocol";

afterEach(() => cleanup());

function book(): DepthBook {
  return {
    kind: "stock",
    entitled: true,
    feed: "SMART",
    bid: [
      { price: 49.67, size: 1428, exchange: "ARCA" },
      { price: 49.66, size: 500, exchange: "BATS" },
    ],
    ask: [
      { price: 49.70, size: 250, exchange: "ARCA" },
      { price: 49.71, size: 332, exchange: "NSDQ" },
    ],
  } as unknown as DepthBook;
}

describe("DepthMontage click-to-fill", () => {
  it("clicking an ASK level emits BUY at that price (lift the offer)", () => {
    const onPriceClick = vi.fn();
    render(React.createElement(DepthMontage, { book: book(), onPriceClick }));
    // The ask side rows carry aria-label "Fill ticket: BUY <price>".
    fireEvent.click(screen.getByLabelText("Fill ticket: BUY 49.70"));
    expect(onPriceClick).toHaveBeenCalledWith({ price: 49.70, action: "BUY", source: "montage" });
  });

  it("clicking a BID level emits SELL at that price (hit the bid)", () => {
    const onPriceClick = vi.fn();
    render(React.createElement(DepthMontage, { book: book(), onPriceClick }));
    fireEvent.click(screen.getByLabelText("Fill ticket: SELL 49.67"));
    expect(onPriceClick).toHaveBeenCalledWith({ price: 49.67, action: "SELL", source: "montage" });
  });

  it("renders no click affordance + does not crash when handler absent", () => {
    const { container } = render(React.createElement(DepthMontage, { book: book() }));
    expect(container.querySelector(".book-row-fill")).toBeNull();
    expect(container.querySelectorAll('[role="button"]').length).toBe(0);
  });
});

function trades(): Trade[] {
  // OLDEST-first (relay order). classifyTicks tick-tests each vs the prior.
  return [
    { price: 49.68, size: 5, exchange: "FINRA", time: "2026-06-02T15:43:32Z" },
    { price: 49.70, size: 3, exchange: "FINRA", time: "2026-06-02T15:43:33Z" }, // uptick -> BUY
    { price: 49.69, size: 8, exchange: "FINRA", time: "2026-06-02T15:43:34Z" }, // downtick -> SELL
  ] as unknown as Trade[];
}

describe("TimeAndSales click-to-fill", () => {
  it("clicking an uptick print emits BUY with the print size as quantity", () => {
    const onPriceClick = vi.fn();
    render(React.createElement(TimeAndSales, { trades: trades(), visible: true, onPriceClick }));
    fireEvent.click(screen.getByLabelText("Fill ticket: 49.70"));
    expect(onPriceClick).toHaveBeenCalledWith({ price: 49.70, action: "BUY", quantity: 3, source: "tape" });
  });

  it("clicking a downtick print emits SELL", () => {
    const onPriceClick = vi.fn();
    render(React.createElement(TimeAndSales, { trades: trades(), visible: true, onPriceClick }));
    fireEvent.click(screen.getByLabelText("Fill ticket: 49.69"));
    expect(onPriceClick).toHaveBeenCalledWith({ price: 49.69, action: "SELL", quantity: 8, source: "tape" });
  });

  it("omits action for a flat/first print (price-only, never a wrong-side guess)", () => {
    const onPriceClick = vi.fn();
    render(React.createElement(TimeAndSales, { trades: trades(), visible: true, onPriceClick }));
    // The first print (49.68) has no prior -> tone flat -> action omitted.
    fireEvent.click(screen.getByLabelText("Fill ticket: 49.68"));
    const arg = onPriceClick.mock.calls[0][0];
    expect(arg.price).toBe(49.68);
    expect(arg.action).toBeUndefined();
    expect(arg.source).toBe("tape");
  });
});
