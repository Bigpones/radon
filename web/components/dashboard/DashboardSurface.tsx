"use client";

import DashboardNewsFeed from "@/components/DashboardNewsFeed";
import { PortfolioSnapshotCard } from "./PortfolioSnapshotCard";
import { OrdersSnapshotCard } from "./OrdersSnapshotCard";
import { OpportunitiesCard } from "./OpportunitiesCard";
import type { OrdersData, PortfolioData } from "@/lib/types";

type DashboardSurfaceProps = {
  portfolio: PortfolioData | null;
  orders: OrdersData | null;
  realizedPnl?: number;
};

/**
 * DashboardSurface — actionable trading dashboard. Two equal columns:
 *
 *   LEFT (50%) — what the trader needs to act on right now:
 *     - Portfolio snapshot (Net Liq / Today P&L / Open Risk / Cash)
 *     - Open orders + today's fills (compressed; click-through to /orders)
 *     - Trading opportunities (scanner + discover tabs; click to ticker)
 *
 *   RIGHT (50%) — live market intel (the surface the trader actually reads):
 *     - DashboardNewsFeed (full width, with tag filter + image lightbox)
 *
 * Regime-focused panels (CRI / VCG / Markov state lattice / Spectral
 * decomposition / Flow projection) live on /regime sub-tabs, not here.
 * The MarkovStateGraph / FlowProjectionTrace / SpectralBars primitives
 * remain available via `components/instruments/` for re-use there.
 */
export default function DashboardSurface({
  portfolio,
  orders,
  realizedPnl = 0,
}: DashboardSurfaceProps) {
  return (
    <div className="dashboard-surface">
      <div className="dashboard-surface__main">
        <PortfolioSnapshotCard portfolio={portfolio} realizedPnl={realizedPnl} />
        <OrdersSnapshotCard orders={orders} />
        <OpportunitiesCard />
      </div>
      <aside className="dashboard-surface__rail" aria-label="Newsfeed">
        <DashboardNewsFeed />
      </aside>
    </div>
  );
}
