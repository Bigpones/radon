"""Service control for the operator admin panel.

Surfaces the same units the operator-radon.sh CLI manages (radon-* systemd
units plus the IB Gateway container's service unit) and exposes start/stop/
restart actions. Whitelisted at the unit-name boundary so the panel cannot
control arbitrary system units.

Host modes:
  - Hetzner / Linux with systemd  -> uses ``systemctl`` for unit control.
  - Anything else (laptop docker, launchd, dev)  -> returns ``supported=False``
    so the UI can render a "service control is host-only" notice without an
    error spike.

The endpoint surface is intentionally small (status + 3 verbs) so the front
end can render a generic table without per-service branching.
"""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional

logger = logging.getLogger("radon.services")

# Whitelisted unit-name pattern. Any unit listed by /admin/services or passed
# to /admin/services/<unit>/<action> must match. This keeps the panel from
# being a generic systemctl proxy.
_UNIT_PATTERN = re.compile(r"^radon-[a-z0-9-]+(?:\.service|\.timer)?$|^radon-ib-gateway\.service$")

# Static catalogue surfaced in /admin/services when systemd is unavailable.
# Lets the UI render the panel + the "not controllable from here" notice
# instead of an empty state.
_PLACEHOLDER_UNITS: List[str] = [
    "radon-ib-gateway.service",
    "radon-api.service",
    "radon-relay.service",
    "radon-monitor.service",
    "radon-newsfeed.service",
    "radon-nextjs.service",
]


@dataclass
class UnitStatus:
    """Snapshot of a single systemd unit, JSON-serializable."""

    unit: str
    load_state: str        # "loaded" | "not-found" | "masked" | ...
    active_state: str      # "active" | "inactive" | "failed" | "activating" | ...
    sub_state: str         # "running" | "dead" | "exited" | ...
    description: str
    can_control: bool

    def to_dict(self) -> dict:
        return asdict(self)


def is_valid_unit(unit: str) -> bool:
    """True when ``unit`` is in the allowlist for service control.

    Centralised so both the listing endpoint and the action endpoint use the
    same rule. Anything outside this pattern is rejected at the boundary.
    """
    return bool(_UNIT_PATTERN.match(unit))


def is_systemd_available() -> bool:
    """True when this host can run ``systemctl`` against ``radon-*`` units.

    On the laptop (macOS / dev) the binary is absent and we degrade to a
    read-only catalogue. The boolean is intentionally narrow: presence of
    ``systemctl`` on PATH is enough; whether the caller has permission is
    surfaced later by the per-action result.
    """
    return shutil.which("systemctl") is not None


async def _systemctl(*args: str, timeout: float = 15.0) -> tuple[str, str, int]:
    """Run a systemctl invocation and return (stdout, stderr, returncode).

    Wraps subprocess so all callers share the same timeout and decode rules.
    """
    proc = await asyncio.create_subprocess_exec(
        "systemctl",
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return (
            stdout.decode("utf-8", errors="replace").strip(),
            stderr.decode("utf-8", errors="replace").strip(),
            proc.returncode if proc.returncode is not None else -1,
        )
    except asyncio.TimeoutError:
        proc.kill()
        return ("", "systemctl timed out", -1)


def _parse_show_output(raw: str) -> Dict[str, str]:
    """Parse ``systemctl show -p key1,key2 unit`` output into a dict."""
    fields: Dict[str, str] = {}
    for line in raw.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        fields[key.strip()] = value.strip()
    return fields


async def list_units() -> List[str]:
    """Return the canonical list of radon-* units this host knows about.

    On a systemd host we enumerate loaded radon-* units via
    ``systemctl list-units 'radon-*' --all --no-legend``. On non-systemd
    hosts we fall back to ``_PLACEHOLDER_UNITS`` so the UI can still render.
    """
    if not is_systemd_available():
        return list(_PLACEHOLDER_UNITS)

    stdout, _stderr, rc = await _systemctl(
        "list-units", "radon-*", "--all", "--no-legend", "--plain",
    )
    if rc != 0 or not stdout:
        return list(_PLACEHOLDER_UNITS)

    units: List[str] = []
    for line in stdout.splitlines():
        first = line.strip().split()
        if not first:
            continue
        unit = first[0]
        if is_valid_unit(unit):
            units.append(unit)
    return units or list(_PLACEHOLDER_UNITS)


async def show_unit(unit: str) -> UnitStatus:
    """Return a :class:`UnitStatus` snapshot for a single unit.

    Always returns a value, never raises — a not-found / unreadable unit
    surfaces as ``load_state="not-found"`` so the UI can render the row.
    """
    if not is_valid_unit(unit):
        return UnitStatus(unit, "rejected", "unknown", "unknown", "", can_control=False)

    if not is_systemd_available():
        return UnitStatus(
            unit,
            load_state="unsupported",
            active_state="unknown",
            sub_state="unknown",
            description="systemctl unavailable on this host",
            can_control=False,
        )

    stdout, _stderr, rc = await _systemctl(
        "show", unit,
        "-p", "LoadState",
        "-p", "ActiveState",
        "-p", "SubState",
        "-p", "Description",
    )
    if rc != 0:
        return UnitStatus(unit, "unknown", "unknown", "unknown", "", can_control=False)

    parsed = _parse_show_output(stdout)
    load_state = parsed.get("LoadState", "unknown")
    return UnitStatus(
        unit=unit,
        load_state=load_state,
        active_state=parsed.get("ActiveState", "unknown"),
        sub_state=parsed.get("SubState", "unknown"),
        description=parsed.get("Description", ""),
        can_control=load_state == "loaded",
    )


async def list_units_with_status() -> List[UnitStatus]:
    """Snapshot every known radon-* unit. Used by ``GET /admin/services``."""
    units = await list_units()
    statuses = await asyncio.gather(*(show_unit(u) for u in units))
    return list(statuses)


ALLOWED_ACTIONS = frozenset({"start", "stop", "restart"})


@dataclass
class ActionResult:
    """Outcome of a start/stop/restart call against a single unit."""

    unit: str
    action: str
    ok: bool
    detail: str
    returncode: int

    def to_dict(self) -> dict:
        return asdict(self)


async def control_unit(unit: str, action: str) -> ActionResult:
    """Invoke ``systemctl <action> <unit>`` after allowlist + verb checks.

    Returns an :class:`ActionResult` whether or not the call succeeded so
    the route handler can shape an HTTP response from a single object.
    """
    if action not in ALLOWED_ACTIONS:
        return ActionResult(unit, action, False, f"action {action!r} is not allowed", -1)

    if not is_valid_unit(unit):
        return ActionResult(unit, action, False, f"unit {unit!r} is not allowed", -1)

    if not is_systemd_available():
        return ActionResult(
            unit, action, False,
            "systemctl is not available on this host. "
            "Service control is only available on the Hetzner deployment.",
            -1,
        )

    stdout, stderr, rc = await _systemctl(action, unit, timeout=60.0)
    detail = stderr or stdout or f"systemctl exited with rc={rc}"
    return ActionResult(unit, action, rc == 0, detail, rc)
