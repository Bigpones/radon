"use client";

import type { ReactNode } from "react";
import type { ChartLegendItem } from "@/lib/chartSystem";
import type { ChartFamily } from "@/lib/chartSystem";
import { chartFamilyLabel, chartRendererLabel } from "@/lib/chartSystem";
import ChartLegend from "./ChartLegend";

type ChartPanelProps = {
  family: ChartFamily;
  title: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  legend?: ChartLegendItem[];
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  contentClassName?: string;
  dataTestId?: string;
  footer?: ReactNode;
};

export default function ChartPanel({
  family,
  title,
  icon,
  badge,
  legend = [],
  children,
  className,
  bodyClassName,
  contentClassName,
  dataTestId,
  footer,
}: ChartPanelProps) {
  return (
    <div className={`section chart-panel ${className ?? ""}`.trim()} data-testid={dataTestId}>
      <div className="section-header chart-panel-header">
        <div className="chart-panel-heading">
          <div
            className="chart-panel-kicker"
            data-chart-family={chartFamilyLabel(family)}
            data-chart-renderer={chartRendererLabel(family)}
          >
            <span>{chartFamilyLabel(family)}</span>
          </div>
          <div className="section-title chart-panel-title">
            {icon ? <span className="chart-panel-icon" aria-hidden="true">{icon}</span> : null}
            <span>{title}</span>
          </div>
        </div>
        {badge ? <div className="chart-panel-badge">{badge}</div> : null}
      </div>
      <div className={`section-body chart-panel-body ${bodyClassName ?? ""}`.trim()}>
        {legend.length > 0 ? <ChartLegend items={legend} className="chart-panel-legend" /> : null}
        <div className={`chart-panel-content ${contentClassName ?? ""}`.trim()}>{children}</div>
        {footer ? <div className="chart-panel-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
