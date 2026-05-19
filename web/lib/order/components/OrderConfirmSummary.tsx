"use client";

/**
 * OrderConfirmSummary — Order summary panel for confirmation step
 *
 * Usage:
 *   <OrderConfirmSummary summary={orderSummary} />
 */

import type { OrderSummary } from "../types";

interface OrderConfirmSummaryProps {
  summary: OrderSummary;
  /** Show as info callout (blue) or neutral */
  variant?: "info" | "neutral";
  /** Custom class name */
  className?: string;
}

function formatCurrency(value: number | null | undefined): string {
  if (value == null) return "---";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPrice(value: number | null | undefined): string {
  if (value == null) return "---";
  return `$${value.toFixed(2)}`;
}

export function OrderConfirmSummary({
  summary,
  variant = "info",
  className = "",
}: OrderConfirmSummaryProps) {
  const variantClass = variant === "info" ? "order-confirm-summary-info" : "";
  const showMaxGain = summary.maxGainUnbounded === true || summary.maxGain != null;
  const showMaxLoss = summary.maxLossUnbounded === true || summary.maxLoss != null;
  const hasUndefinedRisk =
    summary.maxLossUnbounded === true ||
    (summary.undefinedRiskReason != null && summary.undefinedRiskReason.length > 0);

  return (
    <div
      className={`order-confirm-summary ${variantClass} ${className}`.trim()}
      data-undefined-risk={hasUndefinedRisk ? "true" : undefined}
    >
      <div className="order-confirm-description">{summary.description}</div>
      <div className="order-confirm-metrics">
        {summary.totalCost != null && (
          <span className="order-confirm-metric">
            <span className="order-confirm-metric-label">{summary.totalLabel ?? "Total:"}</span>
            <span className="order-confirm-metric-value">{formatCurrency(summary.totalCost)}</span>
          </span>
        )}
        {showMaxGain && (
          <span className="order-confirm-metric">
            <span className="order-confirm-metric-label">Max Gain:</span>
            <span className="order-confirm-metric-value order-confirm-positive">
              {summary.maxGainUnbounded === true ? "UNBOUNDED" : formatCurrency(summary.maxGain)}
            </span>
          </span>
        )}
        {showMaxLoss && (
          <span className="order-confirm-metric">
            <span className="order-confirm-metric-label">Max Loss:</span>
            <span
              className="order-confirm-metric-value order-confirm-negative"
              data-unbounded={summary.maxLossUnbounded === true ? "true" : undefined}
            >
              {summary.maxLossUnbounded === true ? "UNBOUNDED" : formatCurrency(summary.maxLoss)}
            </span>
          </span>
        )}
        {summary.breakeven != null && (
          <span className="order-confirm-metric">
            <span className="order-confirm-metric-label">Breakeven:</span>
            <span className="order-confirm-metric-value">{formatPrice(summary.breakeven)}</span>
          </span>
        )}
        {summary.estimatedPnl != null && (
          <span className="order-confirm-metric">
            <span className="order-confirm-metric-label">{summary.estimatedPnlLabel ?? "Est. P&L:"}</span>
            <span className={`order-confirm-metric-value ${summary.estimatedPnl >= 0 ? "order-confirm-positive" : "order-confirm-negative"}`}>
              {formatCurrency(summary.estimatedPnl)}
            </span>
          </span>
        )}
      </div>
      {hasUndefinedRisk && (
        <div
          className="order-confirm-undefined-risk"
          role="alert"
          data-testid="order-undefined-risk-warning"
        >
          <span className="order-confirm-undefined-risk-label">GATE 1: Undefined risk</span>
          <span className="order-confirm-undefined-risk-detail">
            {summary.maxLossUnbounded === true
              ? `${summary.undefinedRiskReason ?? "Uncovered short option"} — loss is theoretically unbounded.`
              : `${summary.undefinedRiskReason ?? "Naked short exposure"} — max loss reflects assignment-at-zero stress, not a defined-risk cap.`}
          </span>
        </div>
      )}
    </div>
  );
}
