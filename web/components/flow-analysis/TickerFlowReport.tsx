"use client";

import { ArrowDownRight, ArrowUpRight, Minus, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { useTickerFlowReport, type FlowReportData } from "@/lib/useTickerFlowReport";
import { classifyFlowSignal, type FlowDirection } from "@/lib/flowSignal";

type Props = {
  ticker: string;
};

export default function TickerFlowReport({ ticker }: Props) {
  const { data, status, error, refresh } = useTickerFlowReport(ticker);
  const verdict = useMemo(() => deriveVerdict(data), [data]);
  const isAnalyzing = status === "loading" || status === "scanning";

  return (
    <div className="ticker-flow-report" data-testid="ticker-flow-report">
      <SignalBadge ticker={ticker} verdict={verdict} status={status} onRefresh={refresh} />

      {error && (
        <div className="section">
          <div className="section-body">
            <div className="alert-item bearish" role="alert">{error}</div>
          </div>
        </div>
      )}

      {isAnalyzing && !data && <AnalyzingPanel ticker={ticker} status={status} />}

      {data && <ReportSections data={data} isAnalyzing={isAnalyzing} />}
    </div>
  );
}

type Verdict = ReturnType<typeof classifyFlowSignal>;

function deriveVerdict(data: FlowReportData | null): Verdict | null {
  if (!data) return null;
  // Prefer the server-derived verdict when present (kept in sync with
  // classifyFlowSignal). Re-run client-side as a defensive fallback.
  if (data.verdict?.direction) {
    const verdict = classifyFlowSignal({
      dark_pool: data.dark_pool,
      options_flow: data.options_flow,
      combined_signal: data.combined_signal,
      analysis: data.analysis,
    });
    return {
      ...verdict,
      direction: data.verdict.direction,
      confidence: data.verdict.confidence ?? verdict.confidence,
    };
  }
  return classifyFlowSignal({
    dark_pool: data.dark_pool,
    options_flow: data.options_flow,
    combined_signal: data.combined_signal,
    analysis: data.analysis,
  });
}

function directionMeta(direction: FlowDirection | null) {
  if (direction === "BULLISH") {
    return { label: "Bullish", className: "bullish", Icon: ArrowUpRight };
  }
  if (direction === "BEARISH") {
    return { label: "Bearish", className: "bearish", Icon: ArrowDownRight };
  }
  return { label: "Neutral", className: "neutral", Icon: Minus };
}

function SignalBadge({
  ticker,
  verdict,
  status,
  onRefresh,
}: {
  ticker: string;
  verdict: Verdict | null;
  status: ReturnType<typeof useTickerFlowReport>["status"];
  onRefresh: () => void;
}) {
  const direction = verdict?.direction ?? null;
  const meta = directionMeta(direction);
  const Icon = meta.Icon;
  const showVerdict = status === "fresh" || status === "error" || status === "scanning";

  return (
    <section className="section ticker-flow-hero">
      <div className="ticker-flow-hero-header">
        <div>
          <div className="ticker-flow-hero-eyebrow">FLOW REPORT</div>
          <div className="ticker-flow-hero-symbol">{ticker}</div>
        </div>
        <button
          type="button"
          className="ticker-flow-refresh"
          onClick={onRefresh}
          disabled={status === "loading" || status === "scanning"}
          aria-label="Refresh flow report"
        >
          <RefreshCw size={12} />
          <span>{status === "scanning" ? "Analyzing" : "Refresh"}</span>
        </button>
      </div>

      <div
        className={`ticker-flow-badge ticker-flow-badge-${meta.className}`}
        role="status"
        aria-live="polite"
        data-direction={direction ?? "PENDING"}
        data-status={status}
      >
        <div className="ticker-flow-badge-icon">
          {showVerdict && verdict ? <Icon size={28} /> : <PulseDot />}
        </div>
        <div className="ticker-flow-badge-body">
          <div className="ticker-flow-badge-label">
            {showVerdict && verdict ? meta.label : `Analyzing ${ticker}`}
          </div>
          <div className="ticker-flow-badge-rationale">
            {showVerdict && verdict
              ? verdict.rationale
              : "Reconstructing dark pool and options flow"}
          </div>
        </div>
        {showVerdict && verdict && (
          <div className="ticker-flow-badge-conviction">
            <div className="ticker-flow-badge-conviction-value">{verdict.confidence}</div>
            <div className="ticker-flow-badge-conviction-label">Conviction</div>
          </div>
        )}
      </div>
    </section>
  );
}

function PulseDot() {
  return <span className="ticker-flow-pulse" aria-hidden="true" />;
}

function AnalyzingPanel({ ticker, status }: { ticker: string; status: string }) {
  const message =
    status === "scanning"
      ? `Analyzing ${ticker}`
      : `Loading cached report for ${ticker}`;
  return (
    <section className="section">
      <div className="section-body">
        <div className="ticker-flow-analyzing">
          <div className="ticker-flow-analyzing-spinner" aria-hidden="true" />
          <div className="ticker-flow-analyzing-body">
            <div className="ticker-flow-analyzing-title">{message}</div>
            <ul className="ticker-flow-analyzing-steps">
              <li>Pulling dark pool prints across the last 5 trading sessions</li>
              <li>Reconstructing buy / sell pressure from NBBO mid-cross</li>
              <li>Aggregating institutional options flow</li>
              <li>Synthesizing directional verdict</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function ReportSections({
  data,
  isAnalyzing,
}: {
  data: FlowReportData;
  isAnalyzing: boolean;
}) {
  const dpAgg = data.dark_pool?.aggregate ?? {};
  const buyRatio = dpAgg.dp_buy_ratio;
  const buyPct = typeof buyRatio === "number" ? Math.round(buyRatio * 100) : null;
  const sellPct = typeof buyRatio === "number" ? 100 - Math.round(buyRatio * 100) : null;
  const optionsFlow = data.options_flow ?? {};
  const dailyAll = data.dark_pool?.daily ?? [];
  const daily = dailyAll.slice().sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  return (
    <>
      <section className="section">
        <div className="section-header">
          <div className="section-title">Dark Pool Aggregate</div>
          <div className="report-meta" style={{ margin: 0 }}>
            {data.market_status ?? ""}
          </div>
        </div>
        <div className="section-body ticker-flow-grid">
          <Metric
            label="Direction"
            value={(dpAgg.flow_direction ?? "UNKNOWN").replace("_", " ")}
            tone={dpAgg.flow_direction === "ACCUMULATION" ? "positive" : dpAgg.flow_direction === "DISTRIBUTION" ? "negative" : "neutral"}
          />
          <Metric
            label="Strength"
            value={typeof dpAgg.flow_strength === "number" ? `${dpAgg.flow_strength}` : "--"}
          />
          <Metric
            label="Buy / Sell %"
            value={buyPct == null ? "--" : `${buyPct}% / ${sellPct}%`}
          />
          <Metric
            label="Prints"
            value={dpAgg.num_prints != null ? dpAgg.num_prints.toLocaleString() : "--"}
          />
          <Metric
            label="Total Volume"
            value={dpAgg.total_volume != null ? formatNumber(dpAgg.total_volume) : "--"}
          />
          <Metric
            label="Total Premium"
            value={dpAgg.total_premium != null ? `$${formatNumber(dpAgg.total_premium)}` : "--"}
          />
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <div className="section-title">Options Flow Bias</div>
        </div>
        <div className="section-body ticker-flow-grid">
          <Metric
            label="Bias"
            value={(optionsFlow.bias ?? "NO_DATA").replace("_", " ")}
            tone={optionsBiasTone(optionsFlow.bias)}
          />
          <Metric
            label="Call/Put Ratio"
            value={optionsFlow.call_put_ratio == null ? "--" : optionsFlow.call_put_ratio.toFixed(2)}
          />
          <Metric
            label="Call Premium"
            value={optionsFlow.call_premium != null ? `$${formatNumber(optionsFlow.call_premium)}` : "--"}
          />
          <Metric
            label="Put Premium"
            value={optionsFlow.put_premium != null ? `$${formatNumber(optionsFlow.put_premium)}` : "--"}
          />
        </div>
      </section>

      {daily.length > 0 && (
        <section className="section">
          <div className="section-header">
            <div className="section-title">Daily Dark Pool History</div>
            <span className="pill neutral">{daily.length} SESSIONS</span>
          </div>
          <div className="section-body">
            <table className="ticker-flow-daily">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Direction</th>
                  <th>Strength</th>
                  <th>Buy %</th>
                  <th>Prints</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((d) => {
                  const pct = typeof d.dp_buy_ratio === "number" ? Math.round(d.dp_buy_ratio * 100) : null;
                  const dirClass =
                    d.flow_direction === "ACCUMULATION"
                      ? "accum"
                      : d.flow_direction === "DISTRIBUTION"
                        ? "distrib"
                        : "neutral";
                  return (
                    <tr key={d.date}>
                      <td className="mono">{d.date}</td>
                      <td>
                        <span className={`pill ${dirClass}`}>
                          {(d.flow_direction ?? "NEUTRAL").replace("_", " ")}
                        </span>
                      </td>
                      <td className="mono">{d.flow_strength ?? "--"}</td>
                      <td className="mono">{pct == null ? "--" : `${pct}%`}</td>
                      <td className="mono">{d.num_prints ?? "--"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="section">
        <div className="report-meta">
          {data.fetched_at
            ? `Report Generated: ${new Date(data.fetched_at).toLocaleString()} - Source: UW API - Dark Pool Lookback: ${data.lookback_days ?? 5} Trading Days`
            : "No report timestamp available"}
          {isAnalyzing ? " - Refreshing in background..." : ""}
        </div>
      </section>
    </>
  );
}

function optionsBiasTone(bias?: string | null): "positive" | "negative" | "neutral" {
  if (!bias) return "neutral";
  if (bias.includes("BULLISH")) return "positive";
  if (bias.includes("BEARISH")) return "negative";
  return "neutral";
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative" | "neutral";
}) {
  return (
    <div className="ticker-flow-metric">
      <div className="ticker-flow-metric-label">{label}</div>
      <div className={`ticker-flow-metric-value tone-${tone}`}>{value}</div>
    </div>
  );
}

function formatNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toLocaleString();
}
