"use client";

import type { PortfolioData } from "@/lib/types";

type Props = {
  portfolio: PortfolioData | null;
  realizedPnl?: number;
};

function fmtMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtMoneySigned(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (value === 0) return `$0`;
  const sign = value < 0 ? "−" : "+";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function pnlTone(value: number | null | undefined): "core" | "fault" | "neutral" {
  if (value == null || value === 0) return "neutral";
  return value > 0 ? "core" : "fault";
}

/**
 * PortfolioSnapshotCard — the top-of-dashboard portfolio summary. Net Liq,
 * Today P&L, Open Risk (deployed capital), and free cash. Reads from the
 * existing portfolio prop wired by WorkspaceShell — no new data plumbing.
 */
export function PortfolioSnapshotCard({ portfolio, realizedPnl = 0 }: Props) {
  const acct = portfolio?.account_summary;
  const netLiq = acct?.net_liquidation ?? null;
  const ibDaily = acct?.daily_pnl ?? null;
  // Prefer IB's streamed dailyPnL when available; fall back to realized fills.
  const todayPnl = ibDaily ?? (realizedPnl !== 0 ? realizedPnl : null);
  const cash = acct?.cash ?? acct?.settled_cash ?? null;
  const openRisk = portfolio?.total_deployed_dollars ?? null;
  const todayTone = pnlTone(todayPnl);

  return (
    <section className="snapshot-card">
      <span className="panel-edge-trace" aria-hidden />
      <header className="snapshot-card__header">
        <p className="panel-eyebrow">Portfolio / 01</p>
        <h3 className="panel-title">Account</h3>
      </header>
      <div className="snapshot-grid snapshot-grid--portfolio">
        <div className="snapshot-cell">
          <span className="snapshot-cell__label">Net Liquidation</span>
          <span className="snapshot-cell__value">{fmtMoney(netLiq)}</span>
        </div>
        <div className="snapshot-cell">
          <span className="snapshot-cell__label">Today P&amp;L</span>
          <span className={`snapshot-cell__value snapshot-cell__value--${todayTone}`}>
            {fmtMoneySigned(todayPnl)}
          </span>
        </div>
        <div className="snapshot-cell">
          <span className="snapshot-cell__label">Open Risk</span>
          <span className="snapshot-cell__value">{fmtMoney(openRisk)}</span>
        </div>
        <div className="snapshot-cell">
          <span className="snapshot-cell__label">Cash</span>
          <span className="snapshot-cell__value">{fmtMoney(cash)}</span>
        </div>
      </div>
    </section>
  );
}
