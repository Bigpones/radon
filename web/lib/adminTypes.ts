/**
 * Shared types for the operator admin panel. Mirrors the FastAPI shape
 * exposed by ``GET /health`` and the ``services`` module so UI components
 * can be tested without a live FastAPI process.
 */

export type IbAuthState =
  | "authenticated"
  | "awaiting_2fa"
  | "unreachable"
  | "unknown"
  | "remote";

export type PushLockState = {
  holder: string;
  acquired_at: number;
  expires_at: number;
  remaining_secs: number;
  reason: string | null;
};

export type RestartBackoffState = {
  attempt_count: number;
  last_attempt_at: number;
  next_attempt_after: number;
  next_attempt_in_secs: number;
  last_outcome: string | null;
  push_lock: PushLockState | null;
};

export type IbPoolRoleStatus = {
  connected: boolean;
  client_id: number;
  managed_accounts: string[];
};

export type IbPoolStatus = Record<string, IbPoolRoleStatus>;

export type IbGatewayHealth = {
  auth_state: IbAuthState;
  port_listening: boolean;
  upstream_dead?: boolean;
  service_state?: string;
  host?: string;
  port?: number;
  gateway_mode?: string;
  restart_backoff?: RestartBackoffState;
  container_state?: string;
  container_health?: string;
};

export type AdminHealthPayload = {
  status: string;
  ib_gateway: IbGatewayHealth;
  ib_pool: IbPoolStatus;
  uw?: boolean;
};

export type UnitStatus = {
  unit: string;
  load_state: string;
  active_state: string;
  sub_state: string;
  description: string;
  can_control: boolean;
};

export type ServicesListResponse = {
  supported: boolean;
  units: UnitStatus[];
};

export type ServiceAction = "start" | "stop" | "restart";

export type ServiceActionResult = {
  unit: string;
  action: ServiceAction;
  ok: boolean;
  detail: string;
  returncode: number;
};

export type RestartLogEntry = {
  at: string;             // ISO timestamp written by the client
  action: "force-2fa" | "reset-backoff" | "service-action";
  target: string;         // unit name or "ib-gateway"
  ok: boolean;
  detail: string;
};
