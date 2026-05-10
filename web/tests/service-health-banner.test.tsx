/**
 * @vitest-environment jsdom
 *
 * Tests for <ServiceHealthBanner /> — banner is HIDDEN in steady state
 * (failing.length === 0) and renders with the failing service names + the
 * first failing row's last_error when degraded.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.resetModules();
});

type FailingFixture = {
  service: string;
  state: string;
  last_error: string | null;
  error_summary?: string | null;
};

function mockUseServiceHealth(payload: {
  failing?: FailingFixture[];
} | null): void {
  vi.doMock("@/lib/useServiceHealth", () => ({
    useServiceHealth: () => ({
      data: payload === null
        ? null
        : {
          services: payload.failing ?? [],
          failing: payload.failing ?? [],
          summary: {
            total: (payload.failing ?? []).length,
            failing_count: (payload.failing ?? []).length,
          },
        },
      loading: false,
    }),
  }));
}

describe("<ServiceHealthBanner />", () => {
  it("renders nothing when data is null (initial fetch)", async () => {
    mockUseServiceHealth(null);
    const { default: Banner } = await import("../components/ServiceHealthBanner");
    const { container } = render(<Banner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no failing services (steady state)", async () => {
    mockUseServiceHealth({ failing: [] });
    const { default: Banner } = await import("../components/ServiceHealthBanner");
    const { container } = render(<Banner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders banner when one service is failing", async () => {
    mockUseServiceHealth({
      failing: [{ service: "portfolio-sync", state: "error", last_error: "WAL locked" }],
    });
    const { default: Banner } = await import("../components/ServiceHealthBanner");
    render(<Banner />);
    const banner = screen.getByTestId("service-health-banner");
    expect(banner.textContent).toContain("Background sync degraded");
    expect(banner.textContent).toContain("portfolio-sync");
    expect(banner.textContent).toContain("WAL locked");
  });

  it("lists multiple failing services up to 3 + truncates rest with +N more", async () => {
    mockUseServiceHealth({
      failing: [
        { service: "a", state: "error", last_error: null },
        { service: "b", state: "error", last_error: null },
        { service: "c", state: "error", last_error: null },
        { service: "d", state: "error", last_error: null },
        { service: "e", state: "error", last_error: null },
      ],
    });
    const { default: Banner } = await import("../components/ServiceHealthBanner");
    render(<Banner />);
    const banner = screen.getByTestId("service-health-banner");
    expect(banner.textContent).toContain("a, b, c");
    expect(banner.textContent).toContain("+2 more");
    expect(banner.textContent).not.toContain(", d");
  });

  it("doesn't render last_error when first failing row has null error", async () => {
    mockUseServiceHealth({
      failing: [{ service: "scanner", state: "error", last_error: null }],
    });
    const { default: Banner } = await import("../components/ServiceHealthBanner");
    render(<Banner />);
    const banner = screen.getByTestId("service-health-banner");
    expect(banner.textContent).toContain("scanner");
    expect(banner.querySelector(".service-health-banner__detail")).toBeNull();
  });

  // Regression: the production banner was rendering the raw JSON payload
  // shipped by the route — ``{"message": "ERR: ..."}`` — leaking braces
  // and quotes into user-visible copy and mid-cutting on overflow. The
  // banner now leans on the route's ``error_summary`` and re-runs the
  // same formatter defensively when only ``last_error`` is present.
  describe("JSON-encoded last_error payloads (regression: braces/quotes leak)", () => {
    it("renders only the human-readable message when given a JSON-stringified object via last_error", async () => {
      const raw = JSON.stringify({
        message:
          "ERR: cash flow fetch failed: Flex SendRequest failed (code 1001): Statement could not be generated at this time. Please try again shortly.",
      });
      mockUseServiceHealth({
        failing: [
          { service: "cash-flow-sync", state: "error", last_error: raw },
        ],
      });
      const { default: Banner } = await import("../components/ServiceHealthBanner");
      render(<Banner />);
      const banner = screen.getByTestId("service-health-banner");
      const text = banner.textContent ?? "";
      expect(text).toContain("cash-flow-sync");
      expect(text).toContain("ERR: cash flow fetch failed");
      // No JSON structural characters should leak through.
      expect(text).not.toContain("{");
      expect(text).not.toContain("}");
      expect(text).not.toContain('"');
    });

    it("prefers the route-shipped error_summary when present", async () => {
      mockUseServiceHealth({
        failing: [
          {
            service: "cash-flow-sync",
            state: "error",
            last_error: JSON.stringify({ message: "raw payload that should not render" }),
            error_summary: "ERR: cash flow fetch failed",
          },
        ],
      });
      const { default: Banner } = await import("../components/ServiceHealthBanner");
      render(<Banner />);
      const banner = screen.getByTestId("service-health-banner");
      expect(banner.textContent).toContain("ERR: cash flow fetch failed");
      expect(banner.textContent).not.toContain("raw payload");
      expect(banner.textContent).not.toContain('"');
    });

    it("renders a plain non-JSON string unchanged", async () => {
      mockUseServiceHealth({
        failing: [{ service: "cri-scan", state: "error", last_error: "WAL locked" }],
      });
      const { default: Banner } = await import("../components/ServiceHealthBanner");
      render(<Banner />);
      const banner = screen.getByTestId("service-health-banner");
      expect(banner.textContent).toContain("WAL locked");
      expect(banner.textContent).not.toContain("{");
      expect(banner.textContent).not.toContain('"');
    });

    it("uses the `error` key when the JSON payload omits `message`", async () => {
      const raw = JSON.stringify({ error: "connection refused", wal_conflicts_observed: 4 });
      mockUseServiceHealth({
        failing: [{ service: "portfolio-sync", state: "error", last_error: raw }],
      });
      const { default: Banner } = await import("../components/ServiceHealthBanner");
      render(<Banner />);
      const banner = screen.getByTestId("service-health-banner");
      expect(banner.textContent).toContain("connection refused");
      expect(banner.textContent).not.toContain("wal_conflicts_observed");
      expect(banner.textContent).not.toContain("{");
    });

    it("falls back to generic copy when the JSON payload has no recognisable message keys", async () => {
      const raw = JSON.stringify({ wal_conflicts_observed: 7, retry_count: 3 });
      mockUseServiceHealth({
        failing: [{ service: "newsfeed-scraper", state: "error", last_error: raw }],
      });
      const { default: Banner } = await import("../components/ServiceHealthBanner");
      render(<Banner />);
      const banner = screen.getByTestId("service-health-banner");
      expect(banner.textContent).toContain("service unavailable");
      expect(banner.textContent).not.toContain("{");
      expect(banner.textContent).not.toContain("wal_conflicts_observed");
    });

    it("truncates long messages cleanly with an ellipsis at a word boundary", async () => {
      const longMessage =
        "ERR: cash flow fetch failed: Flex SendRequest failed (code 1001): Statement could not be generated at this time. Please try again shortly.";
      mockUseServiceHealth({
        failing: [
          {
            service: "cash-flow-sync",
            state: "error",
            last_error: JSON.stringify({ message: longMessage }),
          },
        ],
      });
      const { default: Banner } = await import("../components/ServiceHealthBanner");
      render(<Banner />);
      const detail = screen
        .getByTestId("service-health-banner")
        .querySelector(".service-health-banner__detail");
      expect(detail).not.toBeNull();
      const detailText = detail?.textContent ?? "";
      // The detail span carries " - <text>" so the rendered visible
      // string is shorter than the full untrimmed message.
      expect(detailText.length).toBeLessThan(longMessage.length);
      expect(detailText.includes("...")).toBe(true);
    });
  });
});
