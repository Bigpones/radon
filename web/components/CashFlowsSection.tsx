"use client";

import { useMemo, useState } from "react";
import { ChevronDown, TriangleAlert, Wallet } from "lucide-react";
import { useCashFlows, type CashFlowRow, type CashFlowType } from "@/lib/useCashFlows";
import SectionEmptyState from "@/components/SectionEmptyState";
import { TableSkeleton } from "@/components/ui/Skeleton";

const TYPE_TONE: Record<CashFlowType, "accum" | "distrib" | "neutral"> = {
  Deposit: "accum",
  Dividend: "accum",
  Interest: "accum",
  Withdrawal: "distrib",
  Fee: "distrib",
  WithholdingTax: "distrib",
  Other: "neutral",
};

function fmtUsd(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtUsdAbs(n: number): string {
  return `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string): string {
  if (!iso || iso.length < 10) return iso;
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y.slice(2)}`;
}

const PAGE_SIZE = 15;

export default function CashFlowsSection() {
  const { data, loading, error } = useCashFlows(90);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<"all" | CashFlowType>("all");
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    if (filter === "all") return all;
    return all.filter((r) => r.type === filter);
  }, [data?.rows, filter]);

  const summary = data?.summary ?? null;
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageStart = page * PAGE_SIZE;
  const pageRows = rows.slice(pageStart, pageStart + PAGE_SIZE);
  const stopToggle = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div className="section" data-testid="cash-flows-section">
      <div
        className="section-header cash-flows-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls="cash-flows-body"
        data-testid="cash-flows-toggle"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        <div className="section-title">
          <ChevronDown
            size={12}
            style={{
              transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform 150ms ease",
            }}
          />
          CASH FLOWS (90 DAYS)
        </div>
        <div className="cash-flows-meta">
          {summary && (
            <>
              <span className="cash-flows-stat">
                <span className="cash-flows-stat-label">DEPOSITS</span>
                <span className="cash-flows-stat-value positive">{fmtUsdAbs(summary.deposits)}</span>
              </span>
              <span className="cash-flows-stat">
                <span className="cash-flows-stat-label">WITHDRAWALS</span>
                <span className="cash-flows-stat-value negative">{fmtUsdAbs(summary.withdrawals)}</span>
              </span>
              <span className="cash-flows-stat">
                <span className="cash-flows-stat-label">NET</span>
                <span
                  className={`cash-flows-stat-value ${summary.net >= 0 ? "positive" : "negative"}`}
                >
                  {fmtUsd(summary.net)}
                </span>
              </span>
            </>
          )}
          <select
            className="filter-select"
            value={filter}
            onClick={stopToggle}
            onChange={(e) => {
              setFilter(e.target.value as typeof filter);
              setPage(0);
            }}
            onKeyDown={stopToggle}
          >
            <option value="all">ALL</option>
            <option value="Deposit">Deposits</option>
            <option value="Withdrawal">Withdrawals</option>
            <option value="Dividend">Dividends</option>
            <option value="Interest">Interest</option>
            <option value="Fee">Fees</option>
            <option value="WithholdingTax">Withholding Tax</option>
            <option value="Other">Other</option>
          </select>
          <span className="pill defined">{rows.length} TXNS</span>
        </div>
      </div>

      {expanded && (
        <div id="cash-flows-body">
          {error && (
            <div className="section-body">
              <SectionEmptyState
                icon={TriangleAlert}
                tone="danger"
                headline="Couldn't load cash flows"
                secondary={error}
                testId="cash-flows-error"
              />
            </div>
          )}

          {!error && loading && !data ? (
            <div className="section-body p-6">
              <TableSkeleton rows={4} columns={4} />
            </div>
          ) : !error && rows.length === 0 ? (
            <div className="section-body">
              <SectionEmptyState
                icon={Wallet}
                headline="No cash transactions in the last 90 days"
                secondary="Deposits, withdrawals, dividends, and fees appear here once IBKR settles them."
                testId="cash-flows-empty"
              />
            </div>
          ) : !error ? (
            <>
              <div className="section-body table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 110 }}>Date</th>
                      <th style={{ width: 130 }}>Type</th>
                      <th className="right" style={{ width: 160 }}>Amount</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((row: CashFlowRow) => (
                      <tr key={row.id} data-testid={`cash-flow-row-${row.id}`}>
                        <td>{fmtDate(row.date)}</td>
                        <td>
                          <span className={`pill ${TYPE_TONE[row.type] ?? "neutral"}`}>
                            {row.type}
                          </span>
                        </td>
                        <td className={`right ${row.amount >= 0 ? "positive" : "negative"}`}>
                          {fmtUsd(row.amount)}
                        </td>
                        <td className="cell-muted">{row.description ?? row.raw_type ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="cash-flows-pagination">
                  <button
                    className="btn-secondary"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    ← Prev
                  </button>
                  <span className="cell-muted">
                    Page {page + 1} of {totalPages}
                  </span>
                  <button
                    className="btn-secondary"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage(page + 1)}
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
