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
