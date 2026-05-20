"use client";

import { useMemo } from "react";
import {
  CriCompositeCard,
  VolDislocationCard,
  MarkovStateCard,
  PortfolioConvexityCard,
} from "./HeroCards";
import {
  FlowProjectionTrace,
  MarkovStateGraph,
  SpectralBars,
  InstrumentPanel,
} from "@/components/instruments";
import DashboardNewsFeed from "@/components/DashboardNewsFeed";
import { useRegime } from "@/lib/useRegime";
import { useVcg } from "@/lib/useVcg";
import { useMarkovState, type MarkovBand } from "@/lib/useMarkovState";
import { MarketState } from "@/lib/useMarketHours";
import type { PortfolioData } from "@/lib/types";
import type { PriceData } from "@/lib/pricesProtocol";

const BANDS: readonly MarkovBand[] = ["LOW", "ELEVATED", "HIGH", "CRITICAL"];

type DashboardSurfaceProps = {
  portfolio: PortfolioData | null;
  prices: Record<string, PriceData | undefined>;
  marketState: MarketState;
};

export default function DashboardSurface({
  portfolio,
  prices,
  marketState,
}: DashboardSurfaceProps) {
  const { data: criData } = useRegime(marketState);
  const { data: vcgData } = useVcg(marketState);
  const markov = useMarkovState(criData?.history);

  // Flow Projection: SPY daily closes over the last 20 sessions from the CRI
  // history. Real data, available today. Intraday + dark-pool z-score overlay
  // is the planned upgrade once the DP-prints aggregation endpoint lands.
  const spyTrace = useMemo(() => {
    const hist = criData?.history ?? [];
    const sliced = hist.slice(-20);
    return sliced.map((entry, i) => ({ t: i, v: entry.spy }));
  }, [criData]);

  const markovGraphStates = useMemo(
    () =>
      BANDS.map((band) => ({
        id: band,
        label: band,
        current: band === markov.currentBand,
      })),
    [markov.currentBand],
  );

  const markovGraphTransitions = useMemo(() => {
    const out: { from: string; to: string; probability: number }[] = [];
    for (const from of BANDS) {
      for (const to of BANDS) {
        const p = markov.matrix[from][to];
        if (p > 0.02) {
          out.push({ from, to, probability: p });
        }
      }
    }
    return out;
  }, [markov.matrix]);

  return (
    <div className="dashboard-surface">
      <div className="dashboard-surface__main">
        <section className="dashboard-hero" aria-label="Hero signals">
          <CriCompositeCard data={criData} />
          <VolDislocationCard data={vcgData} />
          <MarkovStateCard state={markov} />
          <PortfolioConvexityCard portfolio={portfolio} prices={prices} />
        </section>

        <section className="dashboard-flow" aria-label="Flow projection">
          <div className="instrument-panel dashboard-flow__panel">
            <span className="panel-edge-trace" aria-hidden />
            <header className="instrument-panel__header">
              <div className="instrument-panel__heading">
                <p className="panel-eyebrow">Flow Module / 05</p>
                <h3 className="panel-title">Flow Projection</h3>
              </div>
              <span className="instrument-badge instrument-badge-core">SPY · 20d</span>
            </header>
            {spyTrace.length > 0 ? (
              <FlowProjectionTrace
                primary={{ label: "SPY close", points: spyTrace }}
                overlay={null}
                overlayAwaiting
                height={220}
              />
            ) : (
              <div className="dashboard-flow__awaiting">Awaiting CRI history</div>
            )}
          </div>
        </section>

        <section className="dashboard-engines" aria-label="Engine readouts">
          <div className="instrument-panel">
            <span className="panel-edge-trace" aria-hidden />
            <header className="instrument-panel__header">
              <div className="instrument-panel__heading">
                <p className="panel-eyebrow">Markov Engine / 06</p>
                <h3 className="panel-title">State Lattice</h3>
              </div>
              <span className="instrument-badge instrument-badge-neutral">
                {markov.sampleSize > 0 ? `${markov.sampleSize}d sample` : "—"}
              </span>
            </header>
            <MarkovStateGraph
              states={markovGraphStates}
              transitions={markovGraphTransitions}
              width={460}
              height={220}
              caption={
                markov.sampleSize > 0
                  ? `${markov.sampleSize}-day transition matrix · CRI bands`
                  : undefined
              }
            />
          </div>

          <div className="instrument-panel">
            <span className="panel-edge-trace panel-edge-trace-warn" aria-hidden />
            <header className="instrument-panel__header">
              <div className="instrument-panel__heading">
                <p className="panel-eyebrow">Spectral Engine / 07</p>
                <h3 className="panel-title">Flow Decomposition</h3>
              </div>
              <span className="instrument-badge instrument-badge-warn">
                Awaiting DP feed
              </span>
            </header>
            <SpectralBars bars={[]} awaiting />
          </div>
        </section>
      </div>

      <aside className="dashboard-surface__rail" aria-label="Newsfeed">
        <DashboardNewsFeed />
      </aside>
    </div>
  );
}
