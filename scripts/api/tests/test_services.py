"""Tests for ``scripts.api.services`` — the operator service-control module.

These pin down the security-relevant pieces:
  - Unit-name allowlist rejects anything outside ``radon-*``.
  - Action allowlist rejects anything outside start/stop/restart.
  - Non-systemd hosts degrade to ``supported=False`` instead of erroring.
  - ``control_unit`` shape-checks before invoking systemctl.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import patch

import pytest


SCRIPTS_DIR = Path(__file__).resolve().parents[2]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


from scripts.api import services as admin_services  # noqa: E402


class TestIsValidUnit:
    @pytest.mark.parametrize(
        "unit",
        [
            "radon-api.service",
            "radon-relay.service",
            "radon-monitor.service",
            "radon-newsfeed.service",
            "radon-nextjs.service",
            "radon-ib-gateway.service",
            "radon-refresh.timer",
            "radon-vcg-refresh.timer",
            "radon-watchdog-intraday.service",
        ],
    )
    def test_accepts_radon_units(self, unit: str) -> None:
        assert admin_services.is_valid_unit(unit) is True

    @pytest.mark.parametrize(
        "unit",
        [
            "ssh.service",
            "nginx.service",
            "radon-../api.service",
            "radon-api.service && rm -rf /",
            "RADON-api.service",  # uppercase rejected
            ".",
            "",
            "../radon-api.service",
        ],
    )
    def test_rejects_non_radon_units(self, unit: str) -> None:
        assert admin_services.is_valid_unit(unit) is False


class TestControlUnitRejection:
    """The allowlist must fire BEFORE we touch systemctl."""

    def test_rejects_invalid_action(self) -> None:
        result = asyncio.run(
            admin_services.control_unit("radon-api.service", "enable"),
        )
        assert result.ok is False
        assert result.returncode == -1
        assert "action" in result.detail.lower()

    def test_rejects_invalid_unit(self) -> None:
        result = asyncio.run(
            admin_services.control_unit("nginx.service", "restart"),
        )
        assert result.ok is False
        assert result.returncode == -1
        assert "unit" in result.detail.lower()

    def test_rejects_injection_attempt(self) -> None:
        result = asyncio.run(
            admin_services.control_unit("radon-api.service && touch /tmp/hack", "restart"),
        )
        assert result.ok is False
        assert result.returncode == -1


class TestNonSystemdHost:
    """On macOS / laptop dev, systemctl is absent — degrade gracefully."""

    def test_list_units_returns_placeholder_catalogue(self) -> None:
        with patch.object(admin_services, "is_systemd_available", return_value=False):
            units = asyncio.run(admin_services.list_units())
        assert "radon-api.service" in units
        assert "radon-ib-gateway.service" in units

    def test_show_unit_reports_unsupported(self) -> None:
        with patch.object(admin_services, "is_systemd_available", return_value=False):
            status = asyncio.run(admin_services.show_unit("radon-api.service"))
        assert status.load_state == "unsupported"
        assert status.can_control is False

    def test_control_unit_refuses_without_systemctl(self) -> None:
        with patch.object(admin_services, "is_systemd_available", return_value=False):
            result = asyncio.run(
                admin_services.control_unit("radon-api.service", "restart"),
            )
        assert result.ok is False
        assert "systemctl" in result.detail.lower()

    def test_list_units_with_status_returns_full_payload(self) -> None:
        with patch.object(admin_services, "is_systemd_available", return_value=False):
            statuses = asyncio.run(admin_services.list_units_with_status())
        assert len(statuses) > 0
        for s in statuses:
            assert s.load_state in {"unsupported", "rejected"}
            assert s.can_control is False


class TestParseShowOutput:
    def test_parses_systemctl_show_payload(self) -> None:
        raw = "LoadState=loaded\nActiveState=active\nSubState=running\nDescription=Radon API\n"
        parsed = admin_services._parse_show_output(raw)
        assert parsed == {
            "LoadState": "loaded",
            "ActiveState": "active",
            "SubState": "running",
            "Description": "Radon API",
        }

    def test_ignores_blank_lines(self) -> None:
        parsed = admin_services._parse_show_output("\nLoadState=loaded\n\n")
        assert parsed == {"LoadState": "loaded"}


class TestParseSystemctlTimestamp:
    """Cover the LC_ALL=C systemctl timestamp formats and never-set sentinels."""

    def test_parses_utc_timestamp(self) -> None:
        # Matches what `systemctl show -p ActiveEnterTimestamp` emits under LC_ALL=C.
        iso = admin_services.parse_systemctl_timestamp("Tue 2026-05-19 18:41:51 UTC")
        assert iso == "2026-05-19T18:41:51Z"

    def test_parses_without_timezone(self) -> None:
        # Some unit show outputs omit the trailing TZ when in monotonic-only mode.
        iso = admin_services.parse_systemctl_timestamp("Tue 2026-05-19 18:41:51")
        assert iso == "2026-05-19T18:41:51Z"

    def test_returns_none_for_unset_sentinels(self) -> None:
        assert admin_services.parse_systemctl_timestamp("") is None
        assert admin_services.parse_systemctl_timestamp("0") is None
        assert admin_services.parse_systemctl_timestamp("n/a") is None

    def test_returns_none_for_garbage(self) -> None:
        assert admin_services.parse_systemctl_timestamp("not a date") is None


class TestUnitStatusEnrichment:
    """Show that ``show_unit`` populates the new timestamp + uptime fields.

    Mocks the systemctl shell-out so we cover both simple-daemon and
    oneshot shapes without touching the OS.
    """

    def _make_show_output(self, **overrides: str) -> str:
        defaults = {
            "LoadState": "loaded",
            "ActiveState": "active",
            "SubState": "running",
            "Description": "Radon FastAPI",
            "Type": "simple",
            "ActiveEnterTimestamp": "Tue 2026-05-19 09:00:00 UTC",
            "InactiveEnterTimestamp": "",
            "ExecMainStartTimestamp": "Tue 2026-05-19 09:00:00 UTC",
            "ExecMainExitTimestamp": "",
            "ExecMainStatus": "",
        }
        defaults.update(overrides)
        return "\n".join(f"{k}={v}" for k, v in defaults.items())

    def test_simple_daemon_reports_uptime(self) -> None:
        """A running ``Type=simple`` unit gets uptime_secs from ActiveEnterTimestamp."""
        async def fake_systemctl(*_args: str, **_kwargs: object) -> tuple[str, str, int]:
            return (self._make_show_output(), "", 0)

        with patch.object(admin_services, "is_systemd_available", return_value=True):
            with patch.object(admin_services, "_systemctl", side_effect=fake_systemctl):
                status = asyncio.run(admin_services.show_unit("radon-api.service"))

        assert status.active_state == "active"
        assert status.sub_state == "running"
        assert status.last_active_at is not None
        assert status.last_active_at.startswith("2026-05-19T09:00:00")
        assert status.uptime_secs is not None and status.uptime_secs >= 0
        # Simple-daemon exit code is intentionally not surfaced.
        assert status.last_exit_code is None

    def test_oneshot_reports_last_exit_code_and_finish_time(self) -> None:
        """A completed ``Type=oneshot`` unit surfaces rc + last-finish time."""
        output = self._make_show_output(
            ActiveState="inactive",
            SubState="dead",
            Type="oneshot",
            ActiveEnterTimestamp="Tue 2026-05-19 11:55:00 UTC",
            InactiveEnterTimestamp="Tue 2026-05-19 11:55:30 UTC",
            ExecMainStartTimestamp="Tue 2026-05-19 11:55:00 UTC",
            ExecMainExitTimestamp="Tue 2026-05-19 11:55:30 UTC",
            ExecMainStatus="0",
        )

        async def fake_systemctl(*_args: str, **_kwargs: object) -> tuple[str, str, int]:
            return (output, "", 0)

        with patch.object(admin_services, "is_systemd_available", return_value=True):
            with patch.object(admin_services, "_systemctl", side_effect=fake_systemctl):
                status = asyncio.run(admin_services.show_unit("radon-cta-sync.service"))

        assert status.active_state == "inactive"
        assert status.last_exit_code == 0
        assert status.last_active_at == "2026-05-19T11:55:30Z"
        # Inactive oneshot doesn't have uptime semantics.
        assert status.uptime_secs is None

    def test_never_run_oneshot(self) -> None:
        """A unit that has never been started reports None across the board."""
        output = self._make_show_output(
            ActiveState="inactive",
            SubState="dead",
            Type="oneshot",
            ActiveEnterTimestamp="",
            InactiveEnterTimestamp="",
            ExecMainStartTimestamp="",
            ExecMainExitTimestamp="",
            ExecMainStatus="",
        )

        async def fake_systemctl(*_args: str, **_kwargs: object) -> tuple[str, str, int]:
            return (output, "", 0)

        with patch.object(admin_services, "is_systemd_available", return_value=True):
            with patch.object(admin_services, "_systemctl", side_effect=fake_systemctl):
                status = asyncio.run(admin_services.show_unit("radon-portfolio-sync.service"))

        assert status.last_active_at is None
        assert status.last_exit_code is None
        assert status.uptime_secs is None

    def test_failed_oneshot_propagates_nonzero_exit(self) -> None:
        output = self._make_show_output(
            ActiveState="failed",
            SubState="failed",
            Type="oneshot",
            ActiveEnterTimestamp="Tue 2026-05-19 11:55:00 UTC",
            InactiveEnterTimestamp="Tue 2026-05-19 11:55:05 UTC",
            ExecMainExitTimestamp="Tue 2026-05-19 11:55:05 UTC",
            ExecMainStatus="2",
        )

        async def fake_systemctl(*_args: str, **_kwargs: object) -> tuple[str, str, int]:
            return (output, "", 0)

        with patch.object(admin_services, "is_systemd_available", return_value=True):
            with patch.object(admin_services, "_systemctl", side_effect=fake_systemctl):
                status = asyncio.run(admin_services.show_unit("radon-cta-sync.service"))

        assert status.last_exit_code == 2
        assert status.active_state == "failed"


class TestDeriveHelpers:
    """Lower-level helpers used inside show_unit; pin behaviour directly."""

    def test_derive_last_active_prefers_exec_main_exit(self) -> None:
        parsed = {
            "ActiveEnterTimestamp": "Tue 2026-05-19 09:00:00 UTC",
            "InactiveEnterTimestamp": "Tue 2026-05-19 09:30:00 UTC",
            "ExecMainExitTimestamp": "Tue 2026-05-19 10:00:00 UTC",
        }
        assert admin_services._derive_last_active(parsed) == "2026-05-19T10:00:00Z"

    def test_derive_last_active_returns_none_for_empty_inputs(self) -> None:
        assert admin_services._derive_last_active({}) is None

    def test_derive_uptime_returns_none_for_non_running_units(self) -> None:
        parsed = {
            "ActiveState": "inactive",
            "SubState": "dead",
            "ActiveEnterTimestamp": "Tue 2026-05-19 09:00:00 UTC",
        }
        assert admin_services._derive_uptime_secs(parsed) is None

    def test_derive_last_exit_code_skips_non_oneshot(self) -> None:
        parsed = {"Type": "simple", "ExecMainStatus": "0"}
        assert admin_services._derive_last_exit_code(parsed) is None

    def test_derive_last_exit_code_parses_oneshot_status(self) -> None:
        parsed = {"Type": "oneshot", "ExecMainStatus": "0"}
        assert admin_services._derive_last_exit_code(parsed) == 0
        parsed["ExecMainStatus"] = "2"
        assert admin_services._derive_last_exit_code(parsed) == 2

    def test_derive_last_exit_code_handles_empty_status(self) -> None:
        parsed = {"Type": "oneshot", "ExecMainStatus": ""}
        assert admin_services._derive_last_exit_code(parsed) is None
