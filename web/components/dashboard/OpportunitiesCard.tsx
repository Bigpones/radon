"use client";

import { useState } from "react";
import Link from "next/link";
import { useScanner } from "@/lib/useScanner";
import { useDiscover } from "@/lib/useDiscover";

type Tab = "scanner" | "discover";

/**
 * OpportunitiesCard — surfaces trading candidates from the scanner and
 * discover engines. Single card with a tab toggle so the dashboard doesn't
 * burn vertical space on two parallel lists. Top 5 candidates each.
 *
 * LEAP scan output is not yet exposed via an API route — currently a CLI
 * only (scripts/leap_iv_scanner.py). Add a third tab once the /api/leap
 * endpoint lands.
 */
export function OpportunitiesCard() {
  const [tab, setTab] = useState<Tab>("scanner");
  const scanner = useScanner(tab === "scanner");
  const discover = useDiscover(tab === "discover");

  const scannerRows = (scanner.data?.top_signals ?? []).slice(0, 5);
  const discoverRows = (discover.data?.candidates ?? []).slice(0, 5);

  const loading = tab === "scanner" ? scanner.loading : discover.loading;
  const error = tab === "scanner" ? scanner.error : discover.error;
  const lastSync = tab === "scanner" ? scanner.lastSync : discover.lastSync;

  return (
    <section className="snapshot-card">
      <span className="panel-edge-trace" aria-hidden />
      <header className="snapshot-card__header">
        <p className="panel-eyebrow">Opportunities / 03</p>
        <h3 className="panel-title">Trading Candidates</h3>
        <Link
          className="snapshot-card__see-all"
          href={tab === "scanner" ? "/scanner" : "/discover"}
        >
          {tab === "scanner" ? "All scanner →" : "All discover →"}
        </Link>
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
      ) : discoverRows.length === 0 ? (
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
      )}
    </section>
  );
}
