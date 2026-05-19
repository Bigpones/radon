"""Auto-heal stale ``service_health`` rows after IB Gateway recovers.

When IB Gateway sits at the 2FA push prompt, IB-dependent writers
(``fill-monitor``, ``journal-sync``, ``watchdog-alerts``, ...) record
``state=error`` rows for every cycle that fails to reach the API. When
2FA is finally approved and the pool reconnects, those rows remain in
``state=error`` until the writer's next natural cycle — which may be
hours away (off-hours for market-gated writers). The UI banner keeps
showing the outage long after IB is back.

The P0-2 auth-transition handler already kicks the pool back to life on
``awaiting_2fa → authenticated``. These tests pin the follow-up
contract: the same handler ALSO clears stale ``state=error`` rows for
IB-dependent services that look like they failed due to IB
unreachability.

Critical correctness constraint: we only clear errors whose
``last_error`` message plausibly indicates an IB-connection issue
(``"Failed to connect to IB"``, ``"127.0.0.1:4001"``,
``"TimeoutError"``, ...). A row that's in error because of a schema bug
or unrelated failure stays in error — auto-clearing it would mask a
real problem.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import sys
from pathlib import Path
from typing import Iterator
from unittest.mock import AsyncMock, MagicMock

import pytest


_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_SCRIPTS_DIR = _PROJECT_ROOT / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))


from scripts.api import ib_gateway  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


_MIGRATIONS = [
    _SCRIPTS_DIR / "db" / "migrations" / "0001_init.sql",
]


def _split_statements(sql: str) -> list[str]:
    import re
    stripped = "\n".join(re.sub(r"^\s*--.*$", "", line) for line in sql.splitlines())
    return [s.strip() for s in re.split(r";\s*$", stripped, flags=re.MULTILINE) if s.strip()]


@pytest.fixture
def db_conn(monkeypatch: pytest.MonkeyPatch) -> Iterator[sqlite3.Connection]:
    """In-memory sqlite with the service_health schema; patched into the
    libsql singleton so ``record_service_health`` writes here.
    """
    # check_same_thread=False — production libsql is thread-safe; we use
    # ``asyncio.to_thread`` for the writer/reader calls so the connection
    # may be touched from the event loop's worker pool.
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    for migration in _MIGRATIONS:
        sql = migration.read_text(encoding="utf-8")
        for stmt in _split_statements(sql):
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError as exc:
                if "duplicate column" in str(exc):
                    continue
                raise
    conn.commit()

    import db.client as client_mod
    monkeypatch.setattr(client_mod, "_cached", conn, raising=False)
    monkeypatch.setattr(client_mod, "get_db", lambda: conn)

    import importlib
    import db.writer as writer_mod
    importlib.reload(writer_mod)

    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def _reset_module_state(tmp_path, monkeypatch):
    """Each test starts with clean transition state and an isolated 2FA lock."""
    monkeypatch.setenv("IB_2FA_LOCK_PATH", str(tmp_path / "ib-2fa-push-lock.json"))
    ib_gateway._auth_transition_state["previous_auth_state"] = None
    ib_gateway._auth_transition_state["last_reconnect_at"] = 0.0
    yield
    ib_gateway._auth_transition_state["previous_auth_state"] = None
    ib_gateway._auth_transition_state["last_reconnect_at"] = 0.0


def _make_mock_pool(connected_roles: dict[str, bool], accounts: list[str] | None = None):
    accounts = accounts if accounts is not None else ["U1234567"]
    pool = MagicMock()

    def status() -> dict:
        return {
            role: {
                "connected": connected_roles.get(role, False),
                "client_id": idx + 3,
                "managed_accounts": accounts if connected_roles.get(role, False) else [],
            }
            for idx, role in enumerate(("sync", "orders", "data"))
        }

    pool.status.side_effect = status
    pool.reconnect_all = AsyncMock(return_value={r: True for r in connected_roles})
    return pool


def _insert_health(
    conn: sqlite3.Connection,
    service: str,
    state: str,
    error_message: str | None = None,
) -> None:
    last_error = json.dumps({"message": error_message}) if error_message else None
    conn.execute(
        """
        INSERT INTO service_health (service, state, last_attempt_started_at,
                                    last_attempt_finished_at, last_error, updated_at)
        VALUES (?, ?, NULL, NULL, ?, ?)
        """,
        (service, state, last_error, "2026-05-19T12:00:00Z"),
    )
    conn.commit()


def _read_health(conn: sqlite3.Connection, service: str) -> tuple[str, str | None]:
    row = conn.execute(
        "SELECT state, last_error FROM service_health WHERE service=?",
        (service,),
    ).fetchone()
    assert row is not None, f"service_health row missing for {service}"
    return row[0], row[1]


# ---------------------------------------------------------------------------
# Test 1: three IB-dependent services with IB-connection errors → all healed
# ---------------------------------------------------------------------------


def test_clears_ib_dependent_services_with_ib_connection_errors(db_conn, caplog):
    """fill-monitor / journal-sync / watchdog-alerts (synthetic IB error) all clear."""
    _insert_health(
        db_conn, "fill-monitor", "error",
        "Failed to connect to IB on 127.0.0.1:4001 after 3 attempts",
    )
    _insert_health(
        db_conn, "journal-sync", "error",
        "TimeoutError: API connection failed (host=127.0.0.1 port=4001)",
    )
    # Use orders-sync (also requires_ib) to stand in for the cascaded
    # watchdog-alerts case from today's incident — watchdog-alerts itself
    # is requires_ib=False, so it would not be in the heal-set.
    _insert_health(
        db_conn, "orders-sync", "error",
        "Failed to connect to IB on 127.0.0.1:4001",
    )

    ib_gateway._auth_transition_state["previous_auth_state"] = "awaiting_2fa"
    pool = _make_mock_pool({"sync": True, "orders": True, "data": True})

    caplog.set_level(logging.INFO, logger="radon.ib_gateway")
    asyncio.run(
        ib_gateway.handle_auth_state_transition(
            new_auth_state="authenticated",
            pool=pool,
        )
    )

    for svc in ("fill-monitor", "journal-sync", "orders-sync"):
        state, last_error = _read_health(db_conn, svc)
        assert state == "ok", f"{svc} should have been cleared to ok"
        assert last_error is None, f"{svc} last_error should be NULL"

    heal_logs = [r for r in caplog.records if "auth recovered" in r.getMessage()]
    assert heal_logs, "expected structured 'auth recovered' info log"
    msg = heal_logs[-1].getMessage()
    assert "fill-monitor" in msg and "journal-sync" in msg and "orders-sync" in msg
    assert "3 stale error rows" in msg


# ---------------------------------------------------------------------------
# Test 2: IB-dependent service with NON-IB error (schema bug) stays in error
# ---------------------------------------------------------------------------


def test_does_not_clear_ib_dependent_service_with_unrelated_error(db_conn):
    """fill-monitor in error from a schema bug must NOT be auto-cleared."""
    _insert_health(
        db_conn, "fill-monitor", "error",
        "sqlite3.OperationalError: no such column: realized_pnl",
    )

    ib_gateway._auth_transition_state["previous_auth_state"] = "awaiting_2fa"
    pool = _make_mock_pool({"sync": True, "orders": True, "data": True})

    asyncio.run(
        ib_gateway.handle_auth_state_transition(
            new_auth_state="authenticated",
            pool=pool,
        )
    )

    state, last_error = _read_health(db_conn, "fill-monitor")
    assert state == "error", "non-IB error must stay in error"
    assert last_error is not None
    parsed = json.loads(last_error)
    assert "no such column" in parsed["message"]


# ---------------------------------------------------------------------------
# Test 3: non-IB-dependent service in error → stays in error (out of scope)
# ---------------------------------------------------------------------------


def test_does_not_clear_non_ib_dependent_service(db_conn):
    """newsfeed-scraper is requires_ib=False — IB recovery is irrelevant to it.

    Even with an IB-connection-shaped error message, we must not touch a
    service that's not classified as IB-dependent.
    """
    _insert_health(
        db_conn, "newsfeed-scraper", "error",
        "Failed to connect to IB on 127.0.0.1:4001",  # nonsensical but inert
    )

    ib_gateway._auth_transition_state["previous_auth_state"] = "awaiting_2fa"
    pool = _make_mock_pool({"sync": True, "orders": True, "data": True})

    asyncio.run(
        ib_gateway.handle_auth_state_transition(
            new_auth_state="authenticated",
            pool=pool,
        )
    )

    state, last_error = _read_health(db_conn, "newsfeed-scraper")
    assert state == "error", "non-IB-dependent service must stay in error"
    assert last_error is not None


# ---------------------------------------------------------------------------
# Test 4: no error rows → no-op, no log spam
# ---------------------------------------------------------------------------


def test_no_error_rows_is_silent_noop(db_conn, caplog):
    """When no IB-dependent service is in error, no heal action and no log."""
    _insert_health(db_conn, "fill-monitor", "ok")
    _insert_health(db_conn, "journal-sync", "ok")

    ib_gateway._auth_transition_state["previous_auth_state"] = "awaiting_2fa"
    pool = _make_mock_pool({"sync": True, "orders": True, "data": True})

    caplog.set_level(logging.INFO, logger="radon.ib_gateway")
    asyncio.run(
        ib_gateway.handle_auth_state_transition(
            new_auth_state="authenticated",
            pool=pool,
        )
    )

    heal_logs = [r for r in caplog.records if "auth recovered" in r.getMessage()]
    assert not heal_logs, "no 'auth recovered' log when there's nothing to heal"

    # Rows are untouched
    for svc in ("fill-monitor", "journal-sync"):
        state, _ = _read_health(db_conn, svc)
        assert state == "ok"


# ---------------------------------------------------------------------------
# Test 5: DB write hangs → wait_for times out cleanly, handler still completes
# ---------------------------------------------------------------------------


def test_db_write_hang_does_not_block_transition_handler(db_conn, caplog, monkeypatch):
    """If record_service_health hangs forever, the heal step bails out via
    wait_for and the transition handler returns without raising.
    """
    _insert_health(
        db_conn, "fill-monitor", "error",
        "Failed to connect to IB on 127.0.0.1:4001",
    )

    # Replace the writer's record_service_health with one that hangs forever
    # via threading.Event.wait(). asyncio.to_thread + a long block would also
    # work but threading.Event makes the intent explicit.
    import db.writer as writer_mod
    import threading
    hang_event = threading.Event()

    def hanging_writer(*_args, **_kwargs):
        # > our heal timeout, but short enough that the test finishes quickly
        # even though asyncio.wait_for cannot cancel a running threadpool task.
        # The thread is joined at interpreter exit.
        hang_event.wait(timeout=2.0)
        return None

    monkeypatch.setattr(writer_mod, "record_service_health", hanging_writer)

    ib_gateway._auth_transition_state["previous_auth_state"] = "awaiting_2fa"
    pool = _make_mock_pool({"sync": True, "orders": True, "data": True})

    caplog.set_level(logging.WARNING, logger="radon.ib_gateway")
    # Pass a tiny timeout to make the test fast.
    triggered = asyncio.run(
        ib_gateway.handle_auth_state_transition(
            new_auth_state="authenticated",
            pool=pool,
            heal_timeout=0.05,
        )
    )

    # Release the hanging worker so the thread exits cleanly.
    hang_event.set()

    # Even if the heal hung, the transition handler must return.
    assert triggered in (True, False)
    timeout_logs = [
        r for r in caplog.records
        if "heal" in r.getMessage().lower() and "timed out" in r.getMessage().lower()
    ]
    assert timeout_logs, "expected a warning about the heal step timing out"


# ---------------------------------------------------------------------------
# Test 6: cold-start to authenticated is NOT a transition; no heal fires
# ---------------------------------------------------------------------------


def test_cold_start_does_not_clear_error_rows(db_conn):
    """If previous_auth_state is None (first probe), we record but take no action.

    Even if IB-dependent services are in IB-connection-error state, no clear
    happens — a real awaiting_2fa→authenticated edge is required.
    """
    _insert_health(
        db_conn, "fill-monitor", "error",
        "Failed to connect to IB on 127.0.0.1:4001",
    )

    assert ib_gateway._auth_transition_state["previous_auth_state"] is None
    pool = _make_mock_pool({"sync": True, "orders": True, "data": True})

    asyncio.run(
        ib_gateway.handle_auth_state_transition(
            new_auth_state="authenticated",
            pool=pool,
        )
    )

    state, last_error = _read_health(db_conn, "fill-monitor")
    assert state == "error", "cold-start must not heal — only real transitions do"
    assert last_error is not None


# ---------------------------------------------------------------------------
# Test 7: heal uses record_service_health (writer interface), no raw SQL
# ---------------------------------------------------------------------------


def test_heal_uses_writer_interface(db_conn, monkeypatch):
    """Mock record_service_health and assert it's called per IB-dependent error
    service. This pins the API surface — a refactor that bypasses the writer
    and goes straight to SQL is a contract break.
    """
    _insert_health(
        db_conn, "fill-monitor", "error",
        "Failed to connect to IB on 127.0.0.1:4001",
    )
    _insert_health(
        db_conn, "journal-sync", "error",
        "TimeoutError on 127.0.0.1:4001",
    )

    import db.writer as writer_mod
    calls: list[tuple] = []
    real_writer = writer_mod.record_service_health

    def spy_writer(service: str, state: str, **kwargs):
        calls.append((service, state, kwargs))
        return real_writer(service, state, **kwargs)

    monkeypatch.setattr(writer_mod, "record_service_health", spy_writer)

    ib_gateway._auth_transition_state["previous_auth_state"] = "awaiting_2fa"
    pool = _make_mock_pool({"sync": True, "orders": True, "data": True})

    asyncio.run(
        ib_gateway.handle_auth_state_transition(
            new_auth_state="authenticated",
            pool=pool,
        )
    )

    assert len(calls) == 2, f"expected 2 writer calls, got {len(calls)}: {calls}"
    seen_services = {c[0] for c in calls}
    assert seen_services == {"fill-monitor", "journal-sync"}
    for service, state, kwargs in calls:
        assert state == "ok"
        assert kwargs.get("error") is None, "error must be cleared to NULL"
