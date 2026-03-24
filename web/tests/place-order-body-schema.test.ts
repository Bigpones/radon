import { describe, expect, it } from "vitest";
import { firstPlaceOrderSchemaErrorMessage } from "../lib/placeOrderBodySchema";

describe("placeOrderBodySchema", () => {
  it("accepts minimal stock order body", () => {
    expect(
      firstPlaceOrderSchemaErrorMessage({
        symbol: "AAPL",
        action: "BUY",
        quantity: 1,
        limitPrice: 100,
      }),
    ).toBeNull();
  });

  it("rejects missing symbol with field hint", () => {
    const msg = firstPlaceOrderSchemaErrorMessage({
      action: "BUY",
      quantity: 1,
      limitPrice: 100,
    });
    expect(msg).toBeTruthy();
    expect(msg!.toLowerCase()).toContain("symbol");
  });

  it("rejects malformed combo leg", () => {
    const msg = firstPlaceOrderSchemaErrorMessage({
      type: "combo",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      limitPrice: 1,
      legs: [{ expiry: "20260417", strike: 100, right: "C", action: "BUY", ratio: "x" }],
    });
    expect(msg).toBeTruthy();
  });
});
