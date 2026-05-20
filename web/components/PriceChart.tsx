"use client";

import { useMemo } from "react";
import { Liveline } from "liveline";
import { resolveChartSeriesColor } from "@/lib/chartSystem";
import type { PriceData } from "@/lib/pricesProtocol";
import { usePriceHistory } from "@/lib/usePriceHistory";
import ChartPanel from "./charts/ChartPanel";

interface PriceChartProps {
  ticker: string;
  prices: Record<string, PriceData>;
  /** Override the price key used for charting (e.g. option contract key instead of underlying) */
  priceKey?: string;
  /** Optional pre-resolved priceData that takes precedence over `prices[chartKey]`.
   *  Set by the ticker page when the WS stream lacks a `last` for an option
   *  position so the chart can plot IB's calculated mark instead of the
   *  default-base mock walk. */
  priceData?: PriceData | null;
  /** Theme forwarded from the shell — defaults to 'dark' to preserve existing behavior */
  theme?: "dark" | "light";
}

export default function PriceChart({ ticker, prices, priceKey, priceData: priceDataOverride, theme = "dark" }: PriceChartProps) {
  const chartKey = priceKey ?? ticker;
  // If the caller pre-resolved priceData (e.g. merged calculated mark in),
  // expose it under `chartKey` so usePriceHistory sees the same value the
  // panel does. Memoize to keep the hook's prices ref stable.
  const effectivePrices = useMemo(() => {
    if (!priceDataOverride) return prices;
    return { ...prices, [chartKey]: priceDataOverride };
  }, [prices, priceDataOverride, chartKey]);

  const { data, value, loading, isMid, isCalculated } = usePriceHistory(chartKey, effectivePrices);

  const priceData = priceDataOverride ?? prices[chartKey];
  const closePrice = priceData?.close ?? null;
  const positiveColor = useMemo(() => resolveChartSeriesColor("primary"), []);
  const negativeColor = useMemo(() => resolveChartSeriesColor("fault"), []);

  const color = useMemo(() => {
    if (!closePrice || !value) return positiveColor;
    return value >= closePrice ? positiveColor : negativeColor;
  }, [value, closePrice, positiveColor, negativeColor]);

  const referenceLine = useMemo(() => {
    if (closePrice == null || closePrice <= 0) return undefined;
    return { value: closePrice, label: "PREV CLOSE" };
  }, [closePrice]);

  return (
    <ChartPanel
      family="live-trace"
      title={chartKey === ticker ? "Live Price Trace" : "Live Position Trace"}
      className="chart-panel-inline price-chart-panel"
      bodyClassName="price-chart-panel-body"
      contentClassName="price-chart-panel-content"
      dataTestId="price-chart-panel"
    >
      <div className="price-chart-container">
        {isCalculated && (
          <div className="price-chart-mid-badge" aria-label="Chart value is IB's calculated mark (no live trade)">
            MARK
          </div>
        )}
        {!isCalculated && isMid && (
          <div className="price-chart-mid-badge" aria-label="Chart values are mid price (bid+ask)/2">
            MIDPRICE
          </div>
        )}
        <Liveline
          data={data}
          value={value}
          theme={theme}
          color={color}
          grid={true}
          badge={true}
          scrub={true}
          fill={true}
          formatValue={(v: number) => `$${v.toFixed(2)}`}
          referenceLine={referenceLine}
          loading={loading}
          padding={{ top: 16, right: 80, bottom: 28, left: 12 }}
        />
      </div>
    </ChartPanel>
  );
}
