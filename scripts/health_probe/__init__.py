"""Tier-3 OFF-BOX health prober — isolated from the trading stack.

This package is the outermost ring of Radon's health observability. Tiers 1 and
2 (FastAPI /health and the scripts/health_service daemon's /edge-health surface)
both run ON the Hetzner VPS, so a whole-box outage takes every on-box observer
down with it and leaves the last service_health row latched. Tier-3 runs OFF
the box (GitHub Actions infra, which is NOT on the Radon tailnet) and records
public-edge reachability into Turso, which is also off-box.

Reachability is limited by design to the public edge:
  * https://app.radon.run/edge-health/ping   — static 200 liveness
  * https://app.radon.run/edge-health/status — the Tier-2 daemon's aggregate

It CANNOT reach Tailscale :8321 (FastAPI) or TCP :4001 (IB Gateway) from a
GitHub runner — those are tailnet-only. That is acceptable: /edge-health/status
already aggregates the internal probes, so proving the public edge answers (and
surfacing what its aggregate says) is the realistic Tier-3.

By contract this package is stdlib-only. It must NOT import the trading stack
(scripts.api.*, ib_insync, uvicorn, ...) NOR libsql / libsql_experimental —
the GitHub runner has none of those and the whole point is zero shared fate.
Writes go to Turso over the libsql HTTP (Hrana-over-HTTP) /v2/pipeline API
using urllib only. See scripts/health_probe/probe.py and turso_http.py.
"""
