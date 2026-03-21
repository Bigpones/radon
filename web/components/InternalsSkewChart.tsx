"use client";

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import ChartPanel from "./charts/ChartPanel";

type SkewHistoryPoint = {
  date: string;
  value: number;
};

type InternalsSkewChartProps = {
  history: SkewHistoryPoint[];
  title: string;
  seriesLabel: string;
  dataTestId?: string;
  lineColor?: string;
  decimals?: number;
};

const MARGIN = { top: 20, right: 36, bottom: 30, left: 44 };
const HEIGHT = 240;
const CHART_GRID = "var(--chart-grid, var(--border-dim))";
const CHART_AXIS = "var(--chart-axis, var(--border-dim))";
const CHART_AXIS_MUTED = "var(--chart-axis-muted, var(--text-secondary))";
const CHART_SURFACE = "var(--chart-surface, var(--bg-panel))";

function fmtSigned(v: number, decimals = 3): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(decimals)}`;
}

export default function InternalsSkewChart({
  history,
  title,
  seriesLabel,
  dataTestId,
  lineColor = "var(--signal-core)",
  decimals = 3,
}: InternalsSkewChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ visible: boolean; x: number; y: number; index: number }>(
    { visible: false, x: 0, y: 0, index: -1 },
  );
  const [width, setWidth] = useState(500);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    if (!history || history.length < 2) return;

    const chartData = history.slice().sort((a, b) => a.date.localeCompare(b.date));
    const validData = chartData.filter((d) => Number.isFinite(d.value));
    if (validData.length < 2) return;

    const innerW = width - MARGIN.left - MARGIN.right;
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

    const g = svg
      .attr("width", width)
      .attr("height", HEIGHT)
      .append("g")
      .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

    const dates = validData.map((d) => new Date(d.date));
    const tickLabel = d3.timeFormat("%b %Y");
    const xScale = d3
      .scaleTime()
      .domain(d3.extent(dates) as [Date, Date])
      .range([0, innerW]);

    const yValues = validData.map((d) => d.value);
    const [min, max] = d3.extent(yValues) as [number, number];
    const pad = (max - min) * 0.2 || 1.0;
    const yScale = d3
      .scaleLinear()
      .domain([min - pad, max + pad])
      .range([innerH, 0])
      .nice();

    const yAxisTicks = yScale.ticks(5);
    g.append("g")
      .selectAll("line")
      .data(yAxisTicks)
      .enter()
      .append("line")
      .attr("x1", 0)
      .attr("x2", innerW)
      .attr("y1", (d) => yScale(d))
      .attr("y2", (d) => yScale(d))
      .attr("stroke", CHART_GRID)
      .attr("stroke-width", 1);

    const zeroY = yScale(0);
    g.append("line")
      .attr("x1", 0)
      .attr("x2", innerW)
      .attr("y1", zeroY)
      .attr("y2", zeroY)
      .attr("stroke", "color-mix(in srgb, var(--text-muted) 55%, transparent)")
      .attr("stroke-dasharray", "4 4");

    const line = d3
      .line<SkewHistoryPoint>()
      .x((d) => xScale(new Date(d.date)))
      .y((d) => yScale(d.value))
      .curve(d3.curveMonotoneX);

    g.append("path")
      .datum(validData)
      .attr("fill", "none")
      .attr("stroke", lineColor)
      .attr("stroke-width", 2)
      .attr("d", line);

    g.selectAll(".dot")
      .data(validData)
      .enter()
      .append("circle")
      .attr("class", "dot")
      .attr("cx", (d) => xScale(new Date(d.date)))
      .attr("cy", (d) => yScale(d.value))
      .attr("r", 2)
      .attr("fill", lineColor)
      .attr("stroke", CHART_SURFACE)
      .attr("stroke-width", 1);

    g.append("g")
      .call(d3.axisLeft(yScale).ticks(5).tickFormat((value) => fmtSigned(value as number, decimals)))
      .call((axis) => {
        axis.select(".domain").remove();
        axis.selectAll(".tick line").attr("stroke", CHART_GRID);
        axis
          .selectAll(".tick text")
          .attr("fill", "var(--text-muted)")
          .attr("font-size", "10px")
          .attr("font-family", "IBM Plex Mono, monospace");
      });

    const tickCount = Math.max(2, Math.min(validData.length, Math.floor(innerW / 64)));
    g.append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(xScale).ticks(tickCount).tickFormat((d) => tickLabel(d as Date)))
      .call((axis) => {
        axis.select(".domain").attr("stroke", CHART_AXIS);
        axis.selectAll(".tick line").attr("stroke", CHART_GRID);
        axis
          .selectAll(".tick text")
          .attr("fill", CHART_AXIS_MUTED)
          .attr("font-size", "10px")
          .attr("font-family", "IBM Plex Mono, monospace");
      });

    g.append("rect")
      .attr("width", innerW)
      .attr("height", innerH)
      .attr("fill", "transparent")
      .on("mousemove", (event: MouseEvent) => {
        const [mx] = d3.pointer(event, g.node());
        const date = xScale.invert(mx);
        const bisector = d3.bisector((d: SkewHistoryPoint) => new Date(d.date).getTime()).left;
        let idx = bisector(validData, date.getTime());
        idx = Math.max(0, Math.min(validData.length - 1, idx));
        if (idx > 0) {
          const prev = validData[idx - 1];
          const curr = validData[idx];
          if (Math.abs(new Date(prev.date).getTime() - date.getTime()) < Math.abs(new Date(curr.date).getTime() - date.getTime())) {
            idx -= 1;
          }
        }
        const svgRect = svgRef.current?.getBoundingClientRect();
        setTooltip({
          visible: true,
          x: (event.clientX - (svgRect?.left ?? 0)),
          y: (event.clientY - (svgRect?.top ?? 0)),
          index: idx,
        });
      })
      .on("mouseleave", () => {
        setTooltip((prev) => ({ ...prev, visible: false }));
      });

  }, [history, width]);

  const latest = history && history.length > 0 ? history[history.length - 1] : null;
  const hover = tooltip.visible && tooltip.index >= 0 ? history[tooltip.index] : null;
  const formatTooltipDate = (dateString: string) => {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return dateString;
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };
  const tooltipSideStyle =
    tooltip.visible && tooltip.x > width / 2
      ? { right: width - tooltip.x + 12 }
      : { left: tooltip.x + 12 };

  return (
    <ChartPanel
      family="analytical-time-series"
      title={title}
      legend={[{ label: seriesLabel, color: lineColor }]}
      className="chart-panel-inline"
      bodyClassName="cri-history-chart-panel"
      contentClassName="cri-history-chart-content"
      dataTestId={dataTestId}
    >
      <div ref={containerRef} className="cri-history-chart-shell">
        <div className="chart-surface cri-history-chart-surface">
          {history.length < 2 ? (
            <div className="chart-empty-state cri-history-chart-empty">NO HISTORY AVAILABLE</div>
          ) : (
            <svg ref={svgRef} className="cri-history-chart-svg" />
          )}
        </div>

        {tooltip.visible && hover ? (
          <div
            className="chart-tooltip"
            style={{
              ...tooltipSideStyle,
              top: tooltip.y - 10,
            }}
          >
            <div className="chart-tooltip-date">{formatTooltipDate(hover.date)}</div>
            <div className="chart-tooltip-row">
              <span className="chart-tooltip-label">{seriesLabel}</span>
              <span className="chart-tooltip-value" style={{ color: lineColor }}>
                {fmtSigned(hover.value, decimals)}
              </span>
            </div>
          </div>
        ) : null}
        <div className="regime-strip-sub" style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px" }}>
          <span>{latest ? `Latest: ${latest.date}` : "No history yet"}</span>
          <span>{latest ? `Latest skew: ${fmtSigned(latest.value, decimals)}` : ""}</span>
        </div>
      </div>
    </ChartPanel>
  );
}
