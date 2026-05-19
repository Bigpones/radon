/**
 * @vitest-environment jsdom
 *
 * Component-level coverage for the operator admin panel. Verifies:
 *   - IbGatewayCard renders the right pill for each auth_state.
 *   - Force-2FA button is disabled (with tooltip + reason) while the
 *     push lock is held.
 *   - Confirm dialog gates execution: click on button only opens the
 *     dialog; the network call fires after the confirm action.
 *   - Service rows render with the start / restart / stop trio.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import IbGatewayCard from "../components/admin/IbGatewayCard";
import Ib2faControls from "../components/admin/Ib2faControls";
import ServiceControlPanel from "../components/admin/ServiceControlPanel";
import type {
  AdminHealthPayload,
  ServicesListResponse,
} from "../lib/adminTypes";

afterEach(() => {
  cleanup();
});

function buildHealth(overrides: Partial<AdminHealthPayload["ib_gateway"]> = {}): AdminHealthPayload {
  return {
    status: "ok",
    ib_gateway: {
      auth_state: "authenticated",
      port_listening: true,
      gateway_mode: "docker",
      host: "127.0.0.1",
      port: 4001,
      container_state: "running",
      container_health: "healthy",
      restart_backoff: {
        attempt_count: 0,
        last_attempt_at: 0,
        next_attempt_after: 0,
        next_attempt_in_secs: 0,
        last_outcome: null,
        push_lock: null,
      },
      ...overrides,
    },
    ib_pool: {
      sync: { connected: true, client_id: 3, managed_accounts: ["U1234"] },
      orders: { connected: true, client_id: 4, managed_accounts: ["U1234"] },
      data: { connected: false, client_id: 5, managed_accounts: [] },
    },
  };
}

describe("<IbGatewayCard />", () => {
  it("renders the authenticated state pill in positive tone", () => {
    render(<IbGatewayCard health={buildHealth()} loading={false} error={null} />);
    const pill = screen.getByTestId("ib-auth-state");
    expect(pill.className).toContain("admin-pill-positive");
    expect(pill.textContent).toContain("Authenticated");
  });

  it("renders awaiting_2fa with warning tone", () => {
    render(
      <IbGatewayCard
        health={buildHealth({ auth_state: "awaiting_2fa" })}
        loading={false}
        error={null}
      />,
    );
    const pill = screen.getByTestId("ib-auth-state");
    expect(pill.className).toContain("admin-pill-warning");
    expect(pill.textContent?.toLowerCase()).toContain("awaiting");
  });

  it("renders unreachable with negative tone", () => {
    render(
      <IbGatewayCard
        health={buildHealth({ auth_state: "unreachable", port_listening: false })}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByTestId("ib-auth-state").className).toContain("admin-pill-negative");
  });

  it("surfaces the push lock holder + remaining time when held", () => {
    const health = buildHealth({
      auth_state: "awaiting_2fa",
      restart_backoff: {
        attempt_count: 1,
        last_attempt_at: 1000,
        next_attempt_after: 1060,
        next_attempt_in_secs: 60,
        last_outcome: "awaiting_2fa",
        push_lock: {
          holder: "scripts.api.ib_gateway.restart_ib_gateway",
          acquired_at: 1000,
          expires_at: 1045,
          remaining_secs: 45,
          reason: "restart_ib_gateway",
        },
      },
    });
    render(<IbGatewayCard health={health} loading={false} error={null} />);
    expect(screen.getByTestId("ib-push-lock").textContent).toContain("restart_ib_gateway");
    expect(screen.getByTestId("ib-push-lock").textContent).toContain("45s");
  });

  it("renders the pool table with the row for each role", () => {
    render(<IbGatewayCard health={buildHealth()} loading={false} error={null} />);
    const table = screen.getByTestId("ib-pool-table");
    expect(table.textContent).toContain("sync");
    expect(table.textContent).toContain("orders");
    expect(table.textContent).toContain("data");
    expect(table.textContent).toContain("U1234");
  });
});

describe("<Ib2faControls />", () => {
  it("disables Force 2FA button while push lock is held", () => {
    const health = buildHealth({
      restart_backoff: {
        attempt_count: 1,
        last_attempt_at: 0,
        next_attempt_after: 0,
        next_attempt_in_secs: 30,
        last_outcome: "awaiting_2fa",
        push_lock: {
          holder: "ib_watchdog",
          acquired_at: 0,
          expires_at: 0,
          remaining_secs: 30,
          reason: "watchdog_restart",
        },
      },
    });
    render(
      <Ib2faControls
        health={health}
        onForcePush={vi.fn()}
        onResetBackoff={vi.fn()}
        onRestartStack={vi.fn()}
      />,
    );
    const btn = screen.getByTestId("force-2fa-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByTestId("force-2fa-disabled-reason").textContent).toContain("ib_watchdog");
  });

  it("clicking Force 2FA opens confirmation (does not fire onForcePush directly)", () => {
    const onForcePush = vi.fn().mockResolvedValue(undefined);
    render(
      <Ib2faControls
        health={buildHealth()}
        onForcePush={onForcePush}
        onResetBackoff={vi.fn()}
        onRestartStack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("force-2fa-button"));
    expect(screen.getByTestId("admin-confirm")).toBeTruthy();
    // The actual handler must NOT have fired yet — only after Confirm.
    expect(onForcePush).not.toHaveBeenCalled();
  });

  it("fires onForcePush after the confirm action is clicked", async () => {
    const onForcePush = vi.fn().mockResolvedValue(undefined);
    render(
      <Ib2faControls
        health={buildHealth()}
        onForcePush={onForcePush}
        onResetBackoff={vi.fn()}
        onRestartStack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("force-2fa-button"));
    fireEvent.click(screen.getByTestId("admin-confirm-action"));
    // Allow the microtask queue to flush the awaited call.
    await Promise.resolve();
    expect(onForcePush).toHaveBeenCalledTimes(1);
  });

  it("renders Restart All Services button", () => {
    render(
      <Ib2faControls
        health={buildHealth()}
        onForcePush={vi.fn()}
        onResetBackoff={vi.fn()}
        onRestartStack={vi.fn()}
      />,
    );
    const btn = screen.getByTestId("restart-stack-button") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
  });

  it("clicking Restart All opens confirmation, does not fire handler directly", () => {
    const onRestartStack = vi.fn().mockResolvedValue(undefined);
    render(
      <Ib2faControls
        health={buildHealth()}
        onForcePush={vi.fn()}
        onResetBackoff={vi.fn()}
        onRestartStack={onRestartStack}
      />,
    );
    fireEvent.click(screen.getByTestId("restart-stack-button"));
    expect(screen.getByTestId("admin-confirm")).toBeTruthy();
    expect(onRestartStack).not.toHaveBeenCalled();
  });

  it("fires onRestartStack after the confirm action is clicked", async () => {
    const onRestartStack = vi.fn().mockResolvedValue(undefined);
    render(
      <Ib2faControls
        health={buildHealth()}
        onForcePush={vi.fn()}
        onResetBackoff={vi.fn()}
        onRestartStack={onRestartStack}
      />,
    );
    fireEvent.click(screen.getByTestId("restart-stack-button"));
    fireEvent.click(screen.getByTestId("admin-confirm-action"));
    await Promise.resolve();
    expect(onRestartStack).toHaveBeenCalledTimes(1);
  });

  it("confirmation modal warns about the 2FA approval requirement", () => {
    render(
      <Ib2faControls
        health={buildHealth()}
        onForcePush={vi.fn()}
        onResetBackoff={vi.fn()}
        onRestartStack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("restart-stack-button"));
    const confirm = screen.getByTestId("admin-confirm");
    expect(confirm.textContent).toMatch(/2FA/i);
    expect(confirm.textContent).toMatch(/IB Gateway/i);
  });
});

describe("<ServiceControlPanel />", () => {
  function services(overrides: Partial<ServicesListResponse> = {}): ServicesListResponse {
    return {
      supported: true,
      units: [
        {
          unit: "radon-api.service",
          load_state: "loaded",
          active_state: "active",
          sub_state: "running",
          description: "Radon FastAPI",
          can_control: true,
        },
        {
          unit: "radon-ib-gateway.service",
          load_state: "loaded",
          active_state: "active",
          sub_state: "running",
          description: "IB Gateway container",
          can_control: true,
        },
      ],
      ...overrides,
    };
  }

  it("renders every unit row with start / restart / stop buttons", () => {
    render(
      <ServiceControlPanel
        services={services()}
        loading={false}
        error={null}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId("service-row-radon-api.service")).toBeTruthy();
    expect(screen.getByTestId("service-start-radon-api.service")).toBeTruthy();
    expect(screen.getByTestId("service-restart-radon-api.service")).toBeTruthy();
    expect(screen.getByTestId("service-stop-radon-api.service")).toBeTruthy();
  });

  it("start runs immediately (no confirmation)", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <ServiceControlPanel
        services={services()}
        loading={false}
        error={null}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByTestId("service-start-radon-api.service"));
    await Promise.resolve();
    expect(onAction).toHaveBeenCalledWith("radon-api.service", "start");
  });

  it("stop opens a destructive confirmation modal before firing", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <ServiceControlPanel
        services={services()}
        loading={false}
        error={null}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByTestId("service-stop-radon-api.service"));
    expect(screen.getByTestId("admin-confirm")).toBeTruthy();
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("admin-confirm-action"));
    await Promise.resolve();
    expect(onAction).toHaveBeenCalledWith("radon-api.service", "stop");
  });

  it("renders read-only notice + disabled buttons when host has no systemd", () => {
    render(
      <ServiceControlPanel
        services={services({
          supported: false,
          units: [
            {
              unit: "radon-api.service",
              load_state: "unsupported",
              active_state: "unknown",
              sub_state: "unknown",
              description: "",
              can_control: false,
            },
          ],
        })}
        loading={false}
        error={null}
        onAction={vi.fn()}
      />,
    );
    const restartBtn = screen.getByTestId("service-restart-radon-api.service") as HTMLButtonElement;
    expect(restartBtn.disabled).toBe(true);
  });
});
