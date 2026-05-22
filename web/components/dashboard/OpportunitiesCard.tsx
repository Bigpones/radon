"use client";

import { useState } from "react";
import Link from "next/link";
import { useScanner } from "@/lib/useScanner";
import { useDiscover } from "@/lib/useDiscover";
import { useLeap } from "@/lib/useLeap";

type Tab = "scanner" | "discover" | "leap";

async function triggerLeapScan(): Promise<void> {
  const res = await fetch("/api/leap/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preset: "mag7" }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `LEAP scan failed (${res.status})`);
  }
}

/**
 * OpportunitiesCard — surfaces trading candidates from the scanner, the
 * discover (dark-pool) engine, and the LEAP IV-mispricing scan. Single
 * card with a tab toggle so the dashboard doesn't burn vertical space on
 * three parallel lists. Top 5 candidates each.
 */
export function OpportunitiesCard() {
  const [tab, setTab] = useState<Tab>("scanner");
  const [leapScanning, setLeapScanning] = useState(false);
  const [leapError, setLeapError] = useState<string | null>(null);
  const scanner = useScanner(tab === "scanner");
  const discover = useDiscover(tab === "discover");
  const leap = useLeap(tab === "leap");

  const scannerRows = (scanner.data?.top_signals ?? []).slice(0, 5);
  const discoverRows = (discover.data?.candidates ?? []).slice(0, 5);
  // LEAP results are pre-sorted by best_gap desc inside the script.
  const leapRows = (leap.data?.results ?? []).slice(0, 5);

  const loading =
    tab === "scanner"
      ? scanner.loading
      : tab === "discover"
        ? discover.loading
        : leap.loading || leapScanning;
  const error =
    tab === "scanner"
      ? scanner.error
      : tab === "discover"
        ? discover.error
        : leapError || leap.error;
  const lastSync =
    tab === "scanner" ? scanner.lastSync : tab === "discover" ? discover.lastSync : leap.lastSync;

  const onLeapRefresh = async () => {
    if (leapScanning) return;
    setLeapError(null);
    setLeapScanning(true);
    try {
      await triggerLeapScan();
      // Re-read /api/leap (GET) so the new data/leap.json lands in state.
      leap.syncNow();
    } catch (err) {
      setLeapError(err instanceof Error ? err.message : "LEAP scan failed");
    } finally {
      setLeapScanning(false);
    }
  };

  return (
    <section className="snapshot-card">
      <span className="panel-edge-trace" aria-hidden />
      <header className="snapshot-card__header">
        <p className="panel-eyebrow">Opportunities / 03</p>
        <h3 className="panel-title">Trading Candidates</h3>
        {tab === "leap" ? (
          <button
            type="button"
            className="snapshot-card__see-all snapshot-card__see-all--action"
            onClick={onLeapRefresh}
            disabled={leapScanning}
          >
            {leapScanning ? "Scanning…" : "Run latest →"}
          </button>
        ) : (
          <Link
            className="snapshot-card__see-all"
            href={tab === "scanner" ? "/scanner" : "/discover"}
          >
            {tab === "scanner" ? "All scanner →" : "All discover →"}
          </Link>
        )}
      </header>

      <div className="snapshot-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "scanner"}
          className={`snapshot-tab${tab === "scanner" ? " snapshot-tab--active" : ""}`}
          onClick={() => setTab("scanner")}
        >
          Scanner
          {scanner.data ? <span className="snapshot-tab__count">{scanner.data.signals_found}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "discover"}
          className={`snapshot-tab${tab === "discover" ? " snapshot-tab--active" : ""}`}
          onClick={() => setTab("discover")}
        >
          Discover
          {discover.data ? <span className="snapshot-tab__count">{discover.data.candidates_found}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "leap"}
          className={`snapshot-tab${tab === "leap" ? " snapshot-tab--active" : ""}`}
          onClick={() => setTab("leap")}
        >
          LEAP
          {leap.data ? <span className="snapshot-tab__count">{leap.data.results.length}</span> : null}
        </button>
        <span className="snapshot-tabs__meta">
          {lastSync ? `Last sample ${new Date(lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}` : "—"}
        </span>
      </div>

      {loading ? (
        <div className="snapshot-card__empty">Sampling…</div>
      ) : error ? (
        <div className="snapshot-card__error">{error}</div>
      ) : tab === "scanner" ? (
        scannerRows.length === 0 ? (
          <div className="snapshot-card__empty">No scanner signals captured yet.</div>
        ) : (
          <ul className="snapshot-rows">
            {scannerRows.map((s) => (
              <li key={`s-${s.ticker}`} className="snapshot-row">
                <Link href={`/${encodeURIComponent(s.ticker)}`} className="snapshot-row__ticker">
                  {s.ticker}
                </Link>
                <span className="snapshot-row__signal">{s.signal}</span>
                <span className={`snapshot-row__direction snapshot-row__direction--${s.direction.toLowerCase()}`}>
                  {s.direction}
                </span>
                <span className="snapshot-row__score">{s.score.toFixed(1)}</span>
              </li>
            ))}
          </ul>
        )
      ) : tab === "discover" ? (
        discoverRows.length === 0 ? (
          <div className="snapshot-card__empty">No discover candidates captured yet.</div>
        ) : (
          <ul className="snapshot-rows">
            {discoverRows.map((c) => (
              <li key={`d-${c.ticker}`} className="snapshot-row">
                <Link href={`/${encodeURIComponent(c.ticker)}`} className="snapshot-row__ticker">
                  {c.ticker}
                </Link>
                <span className="snapshot-row__signal">
                  {c.options_bias?.toUpperCase() ?? "—"} · {c.dp_direction || "DP"} {c.dp_strength?.toFixed(1) ?? ""}
                </span>
                <span className={`snapshot-row__direction snapshot-row__direction--${(c.dp_direction || "").toLowerCase()}`}>
                  {c.alerts ?? 0} alerts
                </span>
                <span className="snapshot-row__score">{c.score?.toFixed(1) ?? "—"}</span>
              </li>
            ))}
          </ul>
        )
      ) : leapRows.length === 0 ? (
        <div className="snapshot-card__empty">
          No LEAP scans on file. Click <strong>Run latest →</strong> above, or wait for the next scheduled scan.
        </div>
      ) : (
        <ul className="snapshot-rows">
          {leapRows.map((r) => (
            <li key={`l-${r.ticker}`} className="snapshot-row">
              <Link href={`/${encodeURIComponent(r.ticker)}`} className="snapshot-row__ticker">
                {r.ticker}
              </Link>
              <span className="snapshot-row__signal">
                {r.current_iv != null ? `IV ${r.current_iv.toFixed(1)}` : "IV —"}
                {" · "}
                {r.hv_20 != null ? `HV20 ${r.hv_20.toFixed(1)}` : "HV20 —"}
              </span>
              <span
                className={`snapshot-row__direction snapshot-row__direction--${r.is_mispriced ? "bull" : "neutral"}`}
              >
                {r.is_mispriced ? "Mispriced" : "—"}
              </span>
              <span className="snapshot-row__score">
                {r.best_gap >= 0 ? `+${r.best_gap.toFixed(1)}` : r.best_gap.toFixed(1)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
