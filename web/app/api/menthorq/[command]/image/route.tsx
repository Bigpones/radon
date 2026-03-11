import { ImageResponse } from "next/og";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { loadFonts } from "@/lib/og-fonts";
import { OG, ogFamilyContract, ogSeriesColor } from "@/lib/og-theme";
import { lineChartSvg } from "@/lib/og-charts";

export const runtime = "nodejs";

const CACHE_DIR = join(process.cwd(), "..", "data", "menthorq_cache");

type DashboardCache = {
  date: string;
  command: string;
  title?: string;
  data?: any[];
  metadata?: Record<string, any>;
};

async function loadLatestCache(
  command: string
): Promise<DashboardCache | null> {
  try {
    const files = await readdir(CACHE_DIR);
    const matching = files
      .filter((f) => f.startsWith(`${command}_`) && f.endsWith(".json"))
      .sort();
    if (matching.length === 0) return null;
    const raw = await readFile(
      join(CACHE_DIR, matching[matching.length - 1]),
      "utf-8"
    );
    return JSON.parse(raw) as DashboardCache;
  } catch {
    return null;
  }
}

/* ─── Renderers ────────────────────────────────────────── */

const WIDTH = 1200;
const CHART_W = 1160;
const CHART_H = 400;
const ANALYTICAL_TIME_SERIES = ogFamilyContract("analytical-time-series");

function GenericChart({ data }: { data: DashboardCache }) {
  const items = data.data ?? [];
  if (items.length === 0) return <NoData command={data.command} />;

  // Try to render as line chart if data has numeric values
  const first = items[0];
  const valueKey = Object.keys(first).find(
    (k) => typeof first[k] === "number" && k !== "strike"
  );
  const labelKey =
    Object.keys(first).find(
      (k) => typeof first[k] === "string"
    ) ?? "label";

  if (!valueKey) return <NoData command={data.command} />;

  const chartData = items.map((d: any) => ({
    label: String(d[labelKey] ?? ""),
    value: d[valueKey] as number,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
      {lineChartSvg({
        data: chartData,
        width: CHART_W,
        height: CHART_H,
        color: ogSeriesColor("primary"),
        marginLeft: 60,
      })}
    </div>
  );
}

function NoData({ command }: { command: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "200px",
        color: OG.muted,
        fontSize: "13px",
      }}
    >
      No data for {command.toUpperCase()}. Run: python3 scripts/fetch_menthorq_dashboard.py --command {command}
    </div>
  );
}

/* ─── Route ────────────────────────────────────────────── */

const RENDERERS: Record<
  string,
  (props: { data: DashboardCache }) => any
> = {};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ command: string }> }
) {
  const { command } = await params;

  // Don't match the CTA route (it has its own image handler)
  if (command === "cta") {
    return new Response("Use /api/menthorq/cta/image instead", {
      status: 308,
      headers: { Location: "/api/menthorq/cta/image" },
    });
  }

  const data = await loadLatestCache(command);
  if (!data) {
    return new Response(`No ${command} data available`, { status: 404 });
  }

  const fonts = await loadFonts();
  const Renderer = RENDERERS[command] ?? GenericChart;

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          background: OG.bg,
          fontFamily: OG.chart.axisFontFamily,
          color: OG.text,
          padding: `${OG.chart.padding}px`,
        }}
      >
        {/* Title bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "16px",
            paddingBottom: "10px",
            minHeight: `${OG.chart.headerHeight}px`,
            borderBottom: `1px solid ${OG.border}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <span
              style={{
                fontSize: "14px",
                fontWeight: 700,
                letterSpacing: "0.1em",
              }}
            >
              {command.toUpperCase()}
            </span>
            <span
              style={{
                fontSize: "11px",
                color: OG.muted,
                marginLeft: "12px",
              }}
            >
              {data.date ?? "---"}
            </span>
            {data.title && (
              <span
                style={{
                  fontSize: "11px",
                  color: OG.muted,
                  marginLeft: "12px",
                }}
              >
                {data.title}
              </span>
            )}
          </div>
          <div
            style={{
              display: "flex",
              gap: "8px",
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontSize: "11px",
                color: OG.text,
                border: `1px solid ${OG.border}`,
                padding: "4px 8px",
              }}
            >
              {ANALYTICAL_TIME_SERIES.label.toUpperCase()}
            </span>
            <span
              style={{
                fontSize: "11px",
                color: OG.muted,
                border: `1px solid ${OG.border}`,
                padding: "4px 8px",
              }}
            >
              {ANALYTICAL_TIME_SERIES.renderer.toUpperCase()}
            </span>
          </div>
        </div>

        {/* Chart */}
        <Renderer data={data} />
      </div>
    ),
    {
      width: WIDTH,
      height: 500,
      fonts: fonts as any,
    }
  );
}
