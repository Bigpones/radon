"""Tests for ReplicaWatchdogHandler — WalConflict death-spiral detection + self-heal.

We mock subprocess.run + os.unlink so the test environment never actually shells
out to journalctl/systemctl or touches files on disk.

`db.writer` depends on libsql_experimental which isn't installed in the test
environment, so we inject a fake `db.writer` module into sys.modules before
the handler imports it.
"""
from __future__ import annotations

import subprocess
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import pytest

# Make scripts/ importable.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


def _install_fake_db_writer() -> tuple[MagicMock, MagicMock]:
    """Stub `db.writer` so the handler's lazy import works in tests.

    Returns the (record_service_health, _now_iso) MagicMocks so callers
    can assert against them.
    """
    record_mock = MagicMock(name="record_service_health")
    now_iso_mock = MagicMock(name="_now_iso", return_value="2026-05-09T09:00:00Z")

    fake_writer = types.ModuleType("db.writer")
    fake_writer.record_service_health = record_mock  # type: ignore[attr-defined]
    fake_writer._now_iso = now_iso_mock  # type: ignore[attr-defined]

    fake_db_pkg = sys.modules.get("db") or types.ModuleType("db")
    fake_db_pkg.writer = fake_writer  # type: ignore[attr-defined]

    sys.modules["db"] = fake_db_pkg
    sys.modules["db.writer"] = fake_writer
    return record_mock, now_iso_mock


@pytest.fixture(autouse=True)
def fake_db_writer():
    """Reset db.writer mocks for every test."""
    record_mock, now_iso_mock = _install_fake_db_writer()
    yield record_mock, now_iso_mock


from monitor_daemon.handlers.replica_watchdog import ReplicaWatchdogHandler  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _journal_output(conflict_count: int) -> str:
    """Build fake journalctl output with N WalConflict lines."""
    base_lines = [
        "May 09 09:00:00 hetzner radon-nextjs[123]: ready - started server on 0.0.0.0:3000",
        "May 09 09:00:30 hetzner radon-nextjs[123]: GET /api/health 200",
    ]
    conflict_lines = [
        f"May 09 09:0{i}:30 hetzner radon-nextjs[123]: Error syncing database: WAL frame insert conflict (WalConflict)"
        for i in range(conflict_count)
    ]
    return "\n".join(base_lines + conflict_lines) + "\n"


def _journalctl_result(conflict_count: int) -> MagicMock:
    mock = MagicMock(spec=subprocess.CompletedProcess)
    mock.stdout = _journal_output(conflict_count)
    mock.stderr = ""
    mock.returncode = 0
    return mock


def _ok_result() -> MagicMock:
    mock = MagicMock(spec=subprocess.CompletedProcess)
    mock.stdout = ""
    mock.stderr = ""
    mock.returncode = 0
    return mock


def _build_subprocess_router(conflict_count: int):
    """Return a side_effect function that routes journalctl vs systemctl calls."""

    def _route(cmd, *args, **kwargs):
        if cmd and cmd[0] == "journalctl":
            return _journalctl_result(conflict_count)
        if cmd and cmd[0] == "sudo":
            return _ok_result()
        return _ok_result()

    return _route


# ---------------------------------------------------------------------------
# Healthy / below-threshold paths.
# ---------------------------------------------------------------------------
class TestHealthy:
    def test_zero_conflicts_returns_healthy(self):
        handler = ReplicaWatchdogHandler()
        with patch(
            "monitor_daemon.handlers.replica_watchdog.subprocess.run",
            side_effect=_build_subprocess_router(0),
        ) as run_mock, patch(
            "monitor_daemon.handlers.replica_watchdog.os.unlink"
        ) as unlink_mock:
            result = handler.execute()

        assert result == {"status": "healthy", "wal_conflicts_5m": 0}
        # Only the journalctl call should have happened.
        assert run_mock.call_count == 1
        assert run_mock.call_args_list[0][0][0][0] == "journalctl"
        unlink_mock.assert_not_called()

    def test_two_conflicts_below_threshold_is_healthy(self):
        """Two conflicts in 5min is noise, not a death spiral."""
        handler = ReplicaWatchdogHandler()
        with patch(
            "monitor_daemon.handlers.replica_watchdog.subprocess.run",
            side_effect=_build_subprocess_router(2),
        ) as run_mock, patch(
            "monitor_daemon.handlers.replica_watchdog.os.unlink"
        ) as unlink_mock:
            result = handler.execute()

        assert result == {"status": "healthy", "wal_conflicts_5m": 2}
        assert run_mock.call_count == 1
        unlink_mock.assert_not_called()


# ---------------------------------------------------------------------------
# Self-heal at threshold.
# ---------------------------------------------------------------------------
class TestSelfHeal:
    def test_three_conflicts_triggers_full_heal_sequence(self, fake_db_writer):
        record_mock, _ = fake_db_writer
        handler = ReplicaWatchdogHandler()

        with patch(
            "monitor_daemon.handlers.replica_watchdog.subprocess.run",
            side_effect=_build_subprocess_router(3),
        ) as run_mock, patch(
            "monitor_daemon.handlers.replica_watchdog.os.unlink"
        ) as unlink_mock:
            result = handler.execute()

        assert result == {"status": "healed", "wal_conflicts_5m": 3}

        # Subprocess call order: journalctl → sudo systemctl stop → sudo systemctl start.
        commands = [c[0][0] for c in run_mock.call_args_list]
        assert commands[0][0] == "journalctl"
        assert commands[1] == [
            "sudo",
            ReplicaWatchdogHandler.SYSTEMCTL_BIN,
            "stop",
            ReplicaWatchdogHandler.SERVICE_NAME,
        ]
        assert commands[2] == [
            "sudo",
            ReplicaWatchdogHandler.SYSTEMCTL_BIN,
            "start",
            ReplicaWatchdogHandler.SERVICE_NAME,
        ]
        assert len(commands) == 3, "Expected exactly journalctl + stop + start"

        # Unlink each replica sidecar in order, between stop and start.
        expected_unlinks = [
            call(f"{ReplicaWatchdogHandler.DATA_DIR}/{f}")
            for f in ReplicaWatchdogHandler.REPLICA_FILES
        ]
        assert unlink_mock.call_args_list == expected_unlinks

        # service_health called twice — syncing then ok.
        assert record_mock.call_count == 2
        first_args, first_kwargs = record_mock.call_args_list[0]
        assert first_args == ("replica-watchdog", "syncing")
        assert "started_at" in first_kwargs

        second_args, second_kwargs = record_mock.call_args_list[1]
        assert second_args == ("replica-watchdog", "ok")
        assert "finished_at" in second_kwargs
        assert second_kwargs["error"]["wal_conflicts_observed"] == 3

        # Throttle should now be set.
        assert handler._last_heal_at is not None

    def test_five_conflicts_also_heals(self):
        handler = ReplicaWatchdogHandler()
        with patch(
            "monitor_daemon.handlers.replica_watchdog.subprocess.run",
            side_effect=_build_subprocess_router(5),
        ), patch(
            "monitor_daemon.handlers.replica_watchdog.os.unlink"
        ):
            result = handler.execute()

        assert result["status"] == "healed"
        assert result["wal_conflicts_5m"] == 5


# ---------------------------------------------------------------------------
# Throttle behavior.
# ---------------------------------------------------------------------------
class TestThrottle:
    def test_throttled_when_recent_heal_under_30min(self):
        handler = ReplicaWatchdogHandler()
        # Heal happened 10 minutes ago.
        handler._last_heal_at = datetime.now(timezone.utc) - timedelta(minutes=10)

        with patch(
            "monitor_daemon.handlers.replica_watchdog.subprocess.run",
            side_effect=_build_subprocess_router(5),
        ) as run_mock, patch(
            "monitor_daemon.handlers.replica_watchdog.os.unlink"
        ) as unlink_mock:
            result = handler.execute()

        assert result["status"] == "throttled"
        assert 590 <= result["since_last_heal_s"] <= 610  # ~10 min
        # journalctl ran but no systemctl/unlink.
        assert run_mock.call_count == 1
        unlink_mock.assert_not_called()

    def test_heal_runs_again_after_throttle_expires(self):
        handler = ReplicaWatchdogHandler()
        # Last heal was 31 minutes ago — throttle window is 30 min.
        handler._last_heal_at = datetime.now(timezone.utc) - timedelta(minutes=31)

        with patch(
            "monitor_daemon.handlers.replica_watchdog.subprocess.run",
            side_effect=_build_subprocess_router(5),
        ), patch(
            "monitor_daemon.handlers.replica_watchdog.os.unlink"
        ):
            result = handler.execute()

        assert result["status"] == "healed"
        assert result["wal_conflicts_5m"] == 5


# ---------------------------------------------------------------------------
# State persistence.
# ---------------------------------------------------------------------------
class TestStateRoundTrip:
    def test_get_state_includes_last_heal_at(self):
        handler = ReplicaWatchdogHandler()
        ts = datetime(2026, 5, 9, 9, 0, 0, tzinfo=timezone.utc)
        handler._last_heal_at = ts

        state = handler.get_state()

        assert "last_heal_at" in state
        assert state["last_heal_at"] == ts.isoformat()

    def test_get_state_with_no_heal_yet(self):
        handler = ReplicaWatchdogHandler()
        state = handler.get_state()
        assert state["last_heal_at"] is None

    def test_set_state_restores_last_heal_at(self):
        handler = ReplicaWatchdogHandler()
        ts = datetime(2026, 5, 9, 9, 0, 0, tzinfo=timezone.utc)

        handler.set_state({"last_heal_at": ts.isoformat()})

        assert handler._last_heal_at == ts

    def test_set_state_handles_missing_last_heal_at(self):
        handler = ReplicaWatchdogHandler()
        handler._last_heal_at = datetime.now(timezone.utc)

        handler.set_state({"last_heal_at": None})

        assert handler._last_heal_at is None


# ---------------------------------------------------------------------------
# Failure paths.
# ---------------------------------------------------------------------------
class TestHealFailure:
    def test_stop_fails_returns_heal_failed_and_throttle_not_advanced(self, fake_db_writer):
        record_mock, _ = fake_db_writer
        handler = ReplicaWatchdogHandler()

        def _route(cmd, *args, **kwargs):
            if cmd and cmd[0] == "journalctl":
                return _journalctl_result(5)
            if cmd[:3] == ["sudo", ReplicaWatchdogHandler.SYSTEMCTL_BIN, "stop"]:
                raise subprocess.CalledProcessError(
                    returncode=1, cmd=cmd, stderr="systemd unit not found"
                )
            return _ok_result()

        with patch(
            "monitor_daemon.handlers.replica_watchdog.subprocess.run",
            side_effect=_route,
        ), patch(
            "monitor_daemon.handlers.replica_watchdog.os.unlink"
        ) as unlink_mock:
            result = handler.execute()

        assert result["status"] == "heal_failed"
        assert "error" in result
        # Throttle MUST NOT advance — operator wants the next cycle to retry.
        assert handler._last_heal_at is None
        # No unlinks should have happened (stop failed before delete step).
        unlink_mock.assert_not_called()
        # service_health called with syncing (start) + error (failure).
        states = [c[0][1] for c in record_mock.call_args_list]
        assert "syncing" in states
        assert "error" in states


class TestUnlinkMissingFile:
    def test_unlink_filenotfounderror_is_swallowed(self):
        """Replica sidecar files may already be gone — that's fine."""
        handler = ReplicaWatchdogHandler()

        def _unlink_side_effect(path):
            if path.endswith("replica.db-shm"):
                raise FileNotFoundError(path)
            return None

        with patch(
            "monitor_daemon.handlers.replica_watchdog.subprocess.run",
            side_effect=_build_subprocess_router(3),
        ), patch(
            "monitor_daemon.handlers.replica_watchdog.os.unlink",
            side_effect=_unlink_side_effect,
        ) as unlink_mock:
            result = handler.execute()

        assert result["status"] == "healed"
        # All four unlinks attempted, missing one didn't abort the loop.
        assert unlink_mock.call_count == 4


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
