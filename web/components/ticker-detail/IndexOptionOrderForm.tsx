"use client";

import { useEffect, useMemo, useState } from "react";
import { useIndexOptionsChain } from "@/lib/useIndexOptionsChain";

interface IndexOptionOrderFormProps {
  ticker: string;
}

type OrderAction = "BUY" | "SELL";
type OptionRight = "C" | "P";

function formatExpiry(date: string): string {
  if (date.length === 8) {
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  }
  return date;
}

/**
 * Index-option order form — Phase 3 surface. Cascading dropdowns:
 *   expiry → right → strike → submit
 *
 * Two-step chain load: first call fetches ALL expirations (no expiry
 * param — quick), second call fetches contracts FOR the selected
 * expiry (filtered server-side). Without the second-step scope the
 * chain returns 1000+ contracts which is overkill for the form.
 *
 * Submits to /api/orders/place with type=option + conId + exchange so
 * IB doesn't pick up VIXW weeklies or other related roots by accident.
 */
export function IndexOptionOrderForm({ ticker }: IndexOptionOrderFormProps) {
  const symbol = ticker.toUpperCase();

  // Step 1: expiries (no expiry scope)
  const initial = useIndexOptionsChain(symbol, null);

  const [selectedExpiry, setSelectedExpiry] = useState<string | null>(null);
  const [right, setRight] = useState<OptionRight>("C");
  const [selectedConId, setSelectedConId] = useState<number | null>(null);
  const [action, setAction] = useState<OrderAction>("BUY");
  const [quantity, setQuantity] = useState<string>("1");
  const [limitPrice, setLimitPrice] = useState<string>("");
  const [tif, setTif] = useState<"DAY" | "GTC">("DAY");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitOk, setSubmitOk] = useState<string | null>(null);

  // Default to nearest expiry on load.
  useEffect(() => {
    if (initial.data?.expirations.length && selectedExpiry == null) {
      setSelectedExpiry(initial.data.expirations[0]);
    }
  }, [initial.data, selectedExpiry]);

  // Step 2: contracts scoped to the chosen expiry
  const scoped = useIndexOptionsChain(symbol, selectedExpiry);

  const expiryContracts = useMemo(() => {
    if (!scoped.data) return [];
    return scoped.data.contracts.filter((c) => c.right === right);
  }, [scoped.data, right]);

  // Reset selected strike when expiry or right changes
  useEffect(() => {
    setSelectedConId(null);
  }, [selectedExpiry, right]);

  const selectedContract = useMemo(
    () => expiryContracts.find((c) => c.conId === selectedConId) ?? null,
    [expiryContracts, selectedConId],
  );

  const notional = useMemo(() => {
    const price = parseFloat(limitPrice);
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0) return null;
    return Math.abs(price * qty * 100);
  }, [limitPrice, quantity]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitOk(null);
    if (!selectedContract) {
      setSubmitError("Pick a strike");
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
          type: "option",
          symbol,
          action,
          quantity: qty,
          limitPrice: price,
          tif,
          expiry: selectedContract.lastTradeDateOrContractMonth,
          strike: selectedContract.strike,
          right: selectedContract.right,
          conId: selectedContract.conId,
          exchange: selectedContract.exchange,
        }),
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error((body.error as string) ?? `Order failed (${res.status})`);
      setSubmitOk(`${action} ${qty} ${selectedContract.localSymbol} @ ${price} submitted`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Order failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (initial.loading) {
    return <div className="futures-form-loading">Loading {symbol} options chain…</div>;
  }
  if (initial.error) {
    return <div className="futures-form-error">Chain error: {initial.error}</div>;
  }
  if (!initial.data || initial.data.expirations.length === 0) {
    return <div className="futures-form-empty">No listed {symbol} options.</div>;
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
        {symbol} Options · {initial.data.exchange} · {initial.data.tradingClass}
      </div>

      <label className="futures-form-row">
        <span className="futures-form-label">Expiry</span>
        <select
          value={selectedExpiry ?? ""}
          onChange={(e) => setSelectedExpiry(e.target.value)}
          className="futures-form-select"
        >
          {initial.data.expirations.map((exp) => (
            <option key={exp} value={exp}>
              {formatExpiry(exp)}
            </option>
          ))}
        </select>
      </label>

      <div className="futures-form-row futures-form-action-row">
        <button
          type="button"
          onClick={() => setRight("C")}
          className={`futures-form-action${right === "C" ? " futures-form-action--active" : ""}`}
        >
          CALL
        </button>
        <button
          type="button"
          onClick={() => setRight("P")}
          className={`futures-form-action${right === "P" ? " futures-form-action--active" : ""}`}
        >
          PUT
        </button>
      </div>

      <label className="futures-form-row">
        <span className="futures-form-label">Strike</span>
        {scoped.loading ? (
          <div className="futures-form-loading">Loading strikes…</div>
        ) : (
          <select
            value={selectedConId ?? ""}
            onChange={(e) => setSelectedConId(parseInt(e.target.value, 10))}
            className="futures-form-select"
          >
            <option value="">— pick a strike —</option>
            {expiryContracts.map((c) => (
              <option key={c.conId} value={c.conId}>
                ${c.strike} {c.right}
              </option>
            ))}
          </select>
        )}
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
        <span className="futures-form-label">Limit Price (per share, x100 = contract)</span>
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
          <span>100</span>
        </div>
        <div className="futures-form-summary-row">
          <span>Notional (limit × qty × 100)</span>
          <span>
            {notional == null
              ? "—"
              : `$${notional.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          </span>
        </div>
      </div>

      <button
        type="submit"
        disabled={submitting || selectedConId == null}
        className="futures-form-submit"
      >
        {submitting
          ? "Submitting…"
          : `${action} ${selectedContract?.localSymbol ?? symbol}`}
      </button>

      {submitError && <div className="futures-form-error">{submitError}</div>}
      {submitOk && <div className="futures-form-success">{submitOk}</div>}
    </form>
  );
}
