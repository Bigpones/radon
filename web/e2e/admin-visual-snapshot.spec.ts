/**
 * Visual-snapshot run for the admin panel. Used during build-out to capture
 * the rendered page for manual review. NOT a regression test — the assertion
 * is just "the page renders without crashing"; the artefact is the PNG.
 */
import { test, expect } from "@playwright/test";

test("admin panel — visual snapshot", async ({ page }) => {
  await page.route("**/api/admin/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        ib_gateway: {
          auth_state: "awaiting_2fa",
          port_listening: true,
          gateway_mode: "docker",
          host: "127.0.0.1",
          port: 4001,
          container_state: "running",
          container_health: "healthy",
          restart_backoff: {
            attempt_count: 2,
            last_attempt_at: 0,
            next_attempt_after: 0,
            next_attempt_in_secs: 120,
            last_outcome: "awaiting_2fa",
            push_lock: {
              holder: "scripts.api.ib_gateway.restart_ib_gateway",
              acquired_at: 0,
              expires_at: 0,
              remaining_secs: 30,
              reason: "restart_ib_gateway",
            },
          },
        },
        ib_pool: {
          sync: { connected: true, client_id: 3, managed_accounts: ["U1234567"] },
          orders: { connected: true, client_id: 4, managed_accounts: ["U1234567"] },
          data: { connected: false, client_id: 5, managed_accounts: [] },
        },
      }),
    }),
  );
  await page.route("**/api/admin/services", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        supported: true,
        units: [
          {
            unit: "radon-ib-gateway.service",
            load_state: "loaded",
            active_state: "active",
            sub_state: "running",
            description: "IB Gateway container",
            can_control: true,
          },
          {
            unit: "radon-api.service",
            load_state: "loaded",
            active_state: "active",
            sub_state: "running",
            description: "Radon FastAPI",
            can_control: true,
          },
          {
            unit: "radon-relay.service",
            load_state: "loaded",
            active_state: "active",
            sub_state: "running",
            description: "WebSocket price relay",
            can_control: true,
          },
          {
            unit: "radon-monitor.service",
            load_state: "loaded",
            active_state: "active",
            sub_state: "running",
            description: "Monitor daemon",
            can_control: true,
          },
          {
            unit: "radon-newsfeed.service",
            load_state: "loaded",
            active_state: "failed",
            sub_state: "failed",
            description: "Newsfeed scraper",
            can_control: true,
          },
          {
            unit: "radon-nextjs.service",
            load_state: "loaded",
            active_state: "inactive",
            sub_state: "dead",
            description: "Next.js web app",
            can_control: true,
          },
        ],
      }),
    }),
  );

  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto("/admin");
  await expect(page.getByTestId("admin-page")).toBeVisible();
  await page.screenshot({ path: "test-results/admin-panel-snapshot.png", fullPage: true });
});
