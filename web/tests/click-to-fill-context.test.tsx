/**
 * @vitest-environment jsdom
 */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { TickerDetailProvider, useTickerDetail } from "../lib/TickerDetailContext";
import { OrderActionsProvider } from "../lib/OrderActionsContext";
import OrderTab from "../components/ticker-detail/OrderTab";
import type { PriceData } from "@/lib/pricesProtocol";

afterEach(() => cleanup());

describe("TickerDetailContext orderPrefill nonce", () => {
  it("stamps a NEW monotonically-increasing nonce on every publish (even identical price+side)", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(TickerDetailProvider, null, children);
    const { result } = renderHook(() => useTickerDetail(), { wrapper });

    act(() => result.current.setOrderPrefill({ price: 49.7, action: "BUY", source: "montage" }));
    const n1 = result.current.orderPrefill!.nonce;
    act(() => result.current.setOrderPrefill({ price: 49.7, action: "BUY", source: "montage" }));
    const n2 = result.current.orderPrefill!.nonce;

    expect(n2).toBeGreaterThan(n1);
    expect(result.current.orderPrefill!.price).toBe(49.7);
  });
});

const PRICE: PriceData = {
  symbol: "SMCI", last: 49.69, lastIsCalculated: false, bid: 49.67, ask: 49.7,
  bidSize: 100, askSize: 100, volume: 1, high: null, low: null, open: null, close: 49,
  week52High: null, week52Low: null, avgVolume: null, delta: null, gamma: null,
  theta: null, vega: null, impliedVol: null, undPrice: null, timestamp: new Date().toISOString(),
};

// A harness that renders OrderTab inside both providers and exposes the context
// setter so the test can publish a prefill the way the book click would.
function Harness({ onCtx }: { onCtx: (set: (p: { price: number; action?: "BUY" | "SELL"; quantity?: number; source: "montage" | "ladder" | "tape" }) => void) => void }) {
  const ctx = useTickerDetail();
  onCtx(ctx.setOrderPrefill);
  return React.createElement(OrderTab, {
    ticker: "SMCI",
    position: null,
    portfolio: null,
    prices: { SMCI: PRICE },
    openOrders: [],
    tickerPriceData: PRICE,
  });
}

function renderOrderTab() {
  let setPrefill!: (p: { price: number; action?: "BUY" | "SELL"; quantity?: number; source: "montage" | "ladder" | "tape" }) => void;
  const utils = render(
    React.createElement(
      OrderActionsProvider,
      null,
      React.createElement(
        TickerDetailProvider,
        null,
        React.createElement(Harness, { onCtx: (s) => { setPrefill = s; } }),
      ),
    ),
  );
  return { ...utils, setPrefill: (p: Parameters<typeof setPrefill>[0]) => act(() => setPrefill(p)) };
}

describe("OrderTab consumes click-to-fill prefill", () => {
  function limitInput() {
    return screen.getByPlaceholderText("0.00") as HTMLInputElement;
  }

  it("a montage ASK click fills the limit price + sets BUY", () => {
    const { setPrefill } = renderOrderTab();
    setPrefill({ price: 49.7, action: "BUY", source: "montage" });
    expect(limitInput().value).toBe("49.70");
    expect(screen.getByRole("button", { name: "BUY" }).className).toContain("order-action-buy");
  });

  it("a SECOND identical click (new nonce) re-applies the fill", () => {
    const { setPrefill } = renderOrderTab();
    setPrefill({ price: 49.7, action: "BUY", source: "montage" });
    // user edits the field away...
    fireEvent.change(limitInput(), { target: { value: "1.23" } });
    expect(limitInput().value).toBe("1.23");
    // ...clicking the same level again re-fills (nonce changed).
    setPrefill({ price: 49.7, action: "BUY", source: "montage" });
    expect(limitInput().value).toBe("49.70");
  });

  it("typing in the price field is NOT clobbered without a new click (no nonce change)", () => {
    renderOrderTab();
    fireEvent.change(limitInput(), { target: { value: "42.50" } });
    // No prefill published → value stays as typed across re-renders.
    expect(limitInput().value).toBe("42.50");
  });

  it("a price-only prefill (action omitted) does not change the action toggle", () => {
    const { setPrefill } = renderOrderTab();
    // Default action with no position is BUY; publish SELL-less price-only.
    setPrefill({ price: 49.68, source: "tape" });
    expect(limitInput().value).toBe("49.68");
    expect(screen.getByRole("button", { name: "BUY" }).className).toContain("order-action-buy");
  });
});
