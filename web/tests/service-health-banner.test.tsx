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

function mockUseServiceHealth(payload: {
  failing?: { service: string; state: string; last_error: string | null }[];
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
});
