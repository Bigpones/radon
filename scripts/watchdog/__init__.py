"""Watchdog services — periodic checks against scheduled writers.

Each tracked `service_health` row gets a per-cadence bucket (`intraday`,
`continuous`, `daily`, `error`) and a freshness/error policy. When a row
goes stale or errors past 2 consecutive checks, the watchdog dispatches
a notification to whichever channels are configured via env (Discord,
Pushover, Resend) plus an always-on `service_health` log row.

See scripts/watchdog/services.py for the canonical service catalog.
"""
