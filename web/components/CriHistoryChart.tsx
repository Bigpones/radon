"use client";

import { useRef, useEffect, useState } from "react";
import * as d3 from "d3";

export interface CriHistoryEntry {
  date: string;
  vix: number;
  vvix: number;
  spy: number;
  cor1m?: number;
  realized_vol?: number | null;
  spx_vs_ma_pct: number;
  vix_5d_roc: number;
}

export interface ChartSeries {
  key: keyof CriHistoryEntry;
  label: string;
  color: string;
  axis: "left" | "right";
  format?: (v: number) => string;
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  d: CriHistoryEntry | null;
}

interface CriHistoryChartProps {
  history: CriHistoryEntry[];
  series: [ChartSeries, ChartSeries];
  title: string;
  /** Override for today's live values — keys match CriHistoryEntry fields */
  liveValues?: Partial<Record<keyof CriHistoryEntry, number>>;
}

const MARGIN = { top: 20, right: 56, bottom: 32, left: 48 };
const HEIGHT = 440;

function defaultFormat(v: number): string {
  return v.toFixed(2);
}

export default function CriHistoryChart({
  history,
  series,
  title,
  liveValues,
}: CriHistoryChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    d: null,
  });
  const [width, setWidth] = useState(400);

  // ResizeObserver for responsive width
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

  // Merge live values into the last data point
  const chartData: CriHistoryEntry[] = (() => {
    if (!history || history.length === 0) return [];
    if (!liveValues || Object.keys(liveValues).length === 0) return history;
    const result = [...history];
    const last = { ...result[result.length - 1] };
    for (const [k, v] of Object.entries(liveValues)) {
      if (v != null) {
        (last as Record<string, unknown>)[k] = v;
      }
    }
    result[result.length - 1] = last;
    return result;
  })();

  const [leftSeries, rightSeries] = series;

  useEffect(() => {
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    if (!chartData || chartData.length < 2) return;

    const innerW = width - MARGIN.left - MARGIN.right;
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

    const g = svg
      .attr("width", width)
      .attr("height", HEIGHT)
      .append("g")
      .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

    // Parse dates
    const dates = chartData.map((d) => new Date(d.date));

    // Scales
    const xScale = d3
      .scaleTime()
      .domain(d3.extent(dates) as [Date, Date])
      .range([0, innerW]);

    // Helper: build Y scale for a series
    function buildYScale(s: ChartSeries) {
      const vals = chartData
        .map((d) => d[s.key] as number | null | undefined)
        .filter((v): v is number => v != null && Number.isFinite(v));
      if (vals.length === 0) return d3.scaleLinear().domain([0, 100]).range([innerH, 0]);
      const ext = d3.extent(vals) as [number, number];
      const pad = (ext[1] - ext[0]) * 0.15 || 2;
      return d3.scaleLinear().domain([ext[0] - pad, ext[1] + pad]).range([innerH, 0]);
    }

    const yLeft = buildYScale(leftSeries);
    const yRight = buildYScale(rightSeries);

    // Grid lines (based on left axis)
    const gridLines = yLeft.ticks(5);
    g.append("g")
      .selectAll("line")
      .data(gridLines)
      .enter()
      .append("line")
      .attr("x1", 0)
      .attr("x2", innerW)
      .attr("y1", (d) => yLeft(d))
      .attr("y2", (d) => yLeft(d))
      .attr("stroke", "#1e293b")
      .attr("stroke-width", 1);

    // Draw a line series
    function drawLine(
      s: ChartSeries,
      yScale: d3.ScaleLinear<number, number>,
    ) {
      const validData = chartData.filter(
        (d) => d[s.key] != null && Number.isFinite(d[s.key] as number),
      );
      if (validData.length < 2) return;

      const line = d3
        .line<CriHistoryEntry>()
        .x((d) => xScale(new Date(d.date)))
        .y((d) => yScale(d[s.key] as number))
        .curve(d3.curveMonotoneX);

      g.append("path")
        .datum(validData)
        .attr("fill", "none")
        .attr("stroke", s.color)
        .attr("stroke-width", 2)
        .attr("d", line);

      // Dots
      g.selectAll(`.dot-${s.key}`)
        .data(validData)
        .enter()
        .append("circle")
        .attr("class", `dot-${s.key}`)
        .attr("cx", (d) => xScale(new Date(d.date)))
        .attr("cy", (d) => yScale(d[s.key] as number))
        .attr("r", 2)
        .attr("fill", s.color)
        .attr("stroke", "#0a0f14")
        .attr("stroke-width", 1);

      // Highlight the last dot (live) with a larger radius and a pulse ring
      const lastValid = validData[validData.length - 1];
      if (liveValues && Object.keys(liveValues).length > 0 && lastValid) {
        g.append("circle")
          .attr("cx", xScale(new Date(lastValid.date)))
          .attr("cy", yScale(lastValid[s.key] as number))
          .attr("r", 4)
          .attr("fill", s.color)
          .attr("stroke", s.color)
          .attr("stroke-width", 1)
          .attr("opacity", 0.5);
      }
    }

    drawLine(leftSeries, yLeft);
    drawLine(rightSeries, yRight);

    // Left Y-axis
    const leftFormat = leftSeries.format ?? defaultFormat;
    g.append("g")
      .call(
        d3
          .axisLeft(yLeft)
          .ticks(5)
          .tickFormat((d) => leftFormat(d as number)),
      )
      .call((axis) => {
        axis.select(".domain").remove();
        axis.selectAll(".tick line").attr("stroke", "#1e293b");
        axis
          .selectAll(".tick text")
          .attr("fill", leftSeries.color)
          .attr("font-size", "10px")
          .attr("font-family", "IBM Plex Mono, monospace");
      });

    // Right Y-axis
    const rightFormat = rightSeries.format ?? defaultFormat;
    g.append("g")
      .attr("transform", `translate(${innerW},0)`)
      .call(
        d3
          .axisRight(yRight)
          .ticks(5)
          .tickFormat((d) => rightFormat(d as number)),
      )
      .call((axis) => {
        axis.select(".domain").remove();
        axis.selectAll(".tick line").attr("stroke", "#1e293b");
        axis
          .selectAll(".tick text")
          .attr("fill", rightSeries.color)
          .attr("font-size", "10px")
          .attr("font-family", "IBM Plex Mono, monospace");
      });

    // X-axis
    const tickCount = Math.max(2, Math.min(chartData.length, Math.floor(innerW / 50)));
    const xAxis = d3
      .axisBottom(xScale)
      .ticks(tickCount)
      .tickFormat((d) => d3.timeFormat("%b %-d")(d as Date));

    g.append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(xAxis)
      .call((axis) => {
        axis.select(".domain").attr("stroke", "#1e293b");
        axis.selectAll(".tick line").attr("stroke", "#1e293b");
        axis
          .selectAll(".tick text")
          .attr("fill", "#94a3b8")
          .attr("font-size", "10px")
          .attr("font-family", "IBM Plex Mono, monospace");
      });

    // Legend
    const legendY = -6;
    [leftSeries, rightSeries].forEach((s, i) => {
      const lx = i * 80;
      g.append("line")
        .attr("x1", lx)
        .attr("x2", lx + 14)
        .attr("y1", legendY)
        .attr("y2", legendY)
        .attr("stroke", s.color)
        .attr("stroke-width", 2);
      g.append("text")
        .attr("x", lx + 18)
        .attr("y", legendY + 4)
        .attr("fill", s.color)
        .attr("font-size", "10px")
        .attr("font-family", "IBM Plex Mono, monospace")
        .attr("font-weight", 500)
        .text(s.label);
    });

    // Invisible overlay for tooltip
    g.append("rect")
      .attr("width", innerW)
      .attr("height", innerH)
      .attr("fill", "transparent")
      .on("mousemove", function (event: MouseEvent) {
        const [mx] = d3.pointer(event, this);
        const hoveredDate = xScale.invert(mx);
        const bisect = d3.bisector((d: CriHistoryEntry) => new Date(d.date)).left;
        let idx = bisect(chartData, hoveredDate);
        idx = Math.max(0, Math.min(chartData.length - 1, idx));
        if (idx > 0) {
          const before = chartData[idx - 1];
          const after = chartData[idx];
          const tBefore = Math.abs(new Date(before.date).getTime() - hoveredDate.getTime());
          const tAfter = Math.abs(new Date(after.date).getTime() - hoveredDate.getTime());
          if (tBefore < tAfter) idx = idx - 1;
        }
        const entry = chartData[idx];
        const svgRect = svgRef.current?.getBoundingClientRect();
        const ex = event.clientX - (svgRect?.left ?? 0);
        const ey = event.clientY - (svgRect?.top ?? 0);
        setTooltip({ visible: true, x: ex, y: ey, d: entry });
      })
      .on("mouseleave", function () {
        setTooltip({ visible: false, x: 0, y: 0, d: null });
      });
  }, [chartData, width, series, liveValues, leftSeries, rightSeries]);

  const showEmpty = !chartData || chartData.length < 2;

  return (
    <div
      ref={containerRef}
      data-testid="cri-history-chart"
      style={{ position: "relative", width: "100%", height: HEIGHT }}
    >
      {showEmpty ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: HEIGHT,
            color: "#94a3b8",
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 11,
            letterSpacing: "0.05em",
          }}
        >
          NO HISTORY AVAILABLE
        </div>
      ) : (
        <svg ref={svgRef} style={{ display: "block", width: "100%", height: HEIGHT }} />
      )}

      {tooltip.visible && tooltip.d && (
        <div
          style={{
            position: "absolute",
            ...(tooltip.x > width / 2
              ? { right: width - tooltip.x + 12 }
              : { left: tooltip.x + 12 }),
            top: tooltip.y - 10,
            background: "var(--bg-panel, #0f1519)",
            border: "1px solid var(--border-dim, #1e293b)",
            padding: "8px 10px",
            pointerEvents: "none",
            zIndex: 10,
            minWidth: 140,
          }}
        >
          <div
            style={{
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: 10,
              color: "#94a3b8",
              marginBottom: 4,
              letterSpacing: "0.05em",
            }}
          >
            {tooltip.d.date}
          </div>
          {series.map((s) => {
            const val = tooltip.d![s.key];
            const fmt = s.format ?? defaultFormat;
            return (
              <div
                key={String(s.key)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  fontFamily: "IBM Plex Mono, monospace",
                  fontSize: 10,
                  lineHeight: "1.6",
                }}
              >
                <span style={{ color: "#64748b" }}>{s.label}</span>
                <span style={{ color: s.color }}>
                  {val != null && Number.isFinite(val as number)
                    ? fmt(val as number)
                    : "---"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
