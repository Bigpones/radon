"use client";

import { useEffect, useMemo, useState } from "react";
import { useFuturesChain, type FuturesChainContract } from "@/lib/useFuturesChain";
import { OrderRiskGate, type LinearOrderRiskInput } from "@/lib/order";
import type { PortfolioData } from "@/lib/types";

interface FuturesOrderFormProps {
  ticker: string;
  /**
   * Live portfolio snapshot — routes into `<OrderRiskGate>` so SHORT futures
   * land in the same UNBOUNDED treatment as a naked short call. Linear
   * branch (added 2026-05-26 via OrderRiskInput discriminated union).
   */
  portfolio?: PortfolioData | null;
}

type OrderAction = "BUY" | "SELL";

function formatExpiry(date: string): string {
  if (date.length === 8) {
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  }
  if (date.length === 6) {
    return `${date.slice(0, 4)}-${date.slice(4, 6)}`;
  }
  return date;
}

/**
 * Futures order form — phase 2 surface. Replaces the index "not
 * tradeable" notice for symbols Radon supports as futures (VIX
 * currently; SPX / NDX wiring lands later).
 *
 * Flow:
 *   1. useFuturesChain loads the listed contracts via /api/futures/chain
 *   2. User picks an expiry from the dropdown — the form locks to that
 *      contract's conId (avoids re-qualification on the IB side)
 *   3. Submit POSTs to /api/orders/place with type=future + conId
 *
 * Notional banner shows price × contracts × multiplier so the user
 * sees the actual exposure (1 VIX future at 19 = $19,000 notional,
 * ~$5,500 initial margin).
 */
export function FuturesOrderForm({ ticker, portfolio = null }: FuturesOrderFormProps) {
  const symbol = ticker.toUpperCase();
  const { data, loading, error } = useFuturesChain(symbol);

  const [selectedConId, setSelectedConId] = useState<number | null>(null);
  const [action, setAction] = useState<OrderAction>("BUY");
  const [quantity, setQuantity] = useState<string>("1");
  const [limitPrice, setLimitPrice] = useState<string>("");
  const [tif, setTif] = useState<"DAY" | "GTC">("DAY");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitOk, setSubmitOk] = useState<string | null>(null);

  // Default to front-month when chain loads.
  useEffect(() => {
    if (data?.contracts.length && selectedConId == null) {
      setSelectedConId(data.contracts[0].conId);
    }
  }, [data, selectedConId]);

  const selectedContract = useMemo<FuturesChainContract | null>(() => {
    if (!data || selectedConId == null) return null;
    return data.contracts.find((c) => c.conId === selectedConId) ?? null;
  }, [data, selectedConId]);

  const multiplier = useMemo(() => {
    if (!selectedContract) return 1000;
    const m = Number(selectedContract.multiplier);
    return Number.isFinite(m) && m > 0 ? m : 1000;
  }, [selectedContract]);

  const notional = useMemo(() => {
    const price = parseFloat(limitPrice);
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0) return null;
    return Math.abs(price * qty * multiplier);
  }, [limitPrice, quantity, multiplier]);

  // Chokepoint input for the linear branch. SHORT futures → UNBOUNDED;
  // LONG futures → bounded by price-to-zero × multiplier. heldQuantity is
  // not yet looked up from the portfolio (rare for futures); a future
  // refinement could scan portfolio for the same conId.
  const riskInput: LinearOrderRiskInput | null = useMemo(() => {
    const price = parseFloat(limitPrice);
    const qty = parseInt(quantity, 10);
    if (!selectedContract || !Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) return null;
    return {
      type: "linear",
      ticker: symbol,
      instrument: "future",
      action,
      quantity: qty,
      limitPrice: price,
      multiplier,
      description: `${action} ${qty} ${selectedContract.localSymbol} @ $${price.toFixed(2)}`,
    };
  }, [selectedContract, action, quantity, limitPrice, multiplier, symbol]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitOk(null);

    if (!selectedContract) {
      setSubmitError("Pick an expiry");
      return;
    }
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      setSubmitError("Quantity must be a positive integer");
      return;
    }
    const price = parseFloat(limitPrice);
    if (!Number.isFinite(price) || price <= 0) {
      setSubmitError("Limit price must be a positive number");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/orders/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "future",
          symbol,
          action,
          quantity: qty,
          limitPrice: price,
          tif,
          conId: selectedContract.conId,
          exchange: selectedContract.exchange,
        }),
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error((body.error as string) ?? `Order failed (${res.status})`);
      }
      setSubmitOk(
        `${action} ${qty} ${selectedContract.localSymbol} @ ${price} submitted`,
      );
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Order failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="futures-form-loading">Loading {symbol} futures chain…</div>;
  }
  if (error) {
    return <div className="futures-form-error">Chain error: {error}</div>;
  }
  if (!data || data.contracts.length === 0) {
    return <div className="futures-form-empty">No listed {symbol} futures.</div>;
  }

  return (
    <form className="futures-order-form" onSubmit={handleSubmit}>
      <div
        className="futures-form-eyebrow"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--signal-core)",
          marginBottom: "12px",
        }}
      >
        {symbol} Futures · {data.exchange}
      </div>

      <label className="futures-form-row">
        <span className="futures-form-label">Expiry</span>
        <select
          value={selectedConId ?? ""}
          onChange={(e) => setSelectedConId(parseInt(e.target.value, 10))}
          className="futures-form-select"
        >
          {data.contracts.map((c) => (
            <option key={c.conId} value={c.conId}>
              {c.localSymbol} — {formatExpiry(c.lastTradeDateOrContractMonth)}
            </option>
          ))}
        </select>
      </label>

      <div className="futures-form-row futures-form-action-row">
        <button
          type="button"
          onClick={() => setAction("BUY")}
          className={`futures-form-action${action === "BUY" ? " futures-form-action--active" : ""}`}
        >
          BUY
        </button>
        <button
          type="button"
          onClick={() => setAction("SELL")}
          className={`futures-form-action${action === "SELL" ? " futures-form-action--active" : ""}`}
        >
          SELL
        </button>
      </div>

      <label className="futures-form-row">
        <span className="futures-form-label">Quantity (contracts)</span>
        <input
          type="number"
          min={1}
          step={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          className="futures-form-input"
          placeholder="Contracts"
        />
      </label>

      <label className="futures-form-row">
        <span className="futures-form-label">Limit Price</span>
        <input
          type="number"
          step={selectedContract?.minTick ?? 0.05}
          value={limitPrice}
          onChange={(e) => setLimitPrice(e.target.value)}
          className="futures-form-input"
          placeholder="0.00"
        />
      </label>

      <label className="futures-form-row">
        <span className="futures-form-label">TIF</span>
        <select value={tif} onChange={(e) => setTif(e.target.value as "DAY" | "GTC")} className="futures-form-select">
          <option value="DAY">DAY</option>
          <option value="GTC">GTC</option>
        </select>
      </label>

      <div className="futures-form-summary">
        <div className="futures-form-summary-row">
          <span>Multiplier</span>
          <span>{multiplier.toLocaleString()}</span>
        </div>
        <div className="futures-form-summary-row">
          <span>Notional</span>
          <span>
            {notional == null
              ? "—"
              : `$${notional.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          </span>
        </div>
      </div>

      {/* Risk math owned by `<OrderRiskGate>` via the linear branch
          (commit 2026-05-26). SHORT futures surface UNBOUNDED + Gate-1
          warning automatically; LONG futures get a bounded max-loss
          equal to price-to-zero × multiplier × qty. */}
      <OrderRiskGate
        input={riskInput}
        portfolio={portfolio}
        surface="futures-form"
        variant="info"
      />

      <button
        type="submit"
        disabled={submitting || selectedConId == null}
        className="futures-form-submit"
      >
        {submitting ? "Submitting…" : `${action} ${selectedContract?.localSymbol ?? symbol}`}
      </button>

      {submitError && <div className="futures-form-error">{submitError}</div>}
      {submitOk && <div className="futures-form-success">{submitOk}</div>}
    </form>
  );
}
