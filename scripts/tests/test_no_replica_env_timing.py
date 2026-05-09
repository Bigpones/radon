"""Static guards: every long-running daemon entry point and every script
spawned from Next.js must set RADON_DB_NO_REPLICA=1 BEFORE the first
`db.writer` import.

The bug these tests prevent: when the env var is set late (e.g. inside a
helper that runs after handlers register), the libSQL singleton is already
cached in embedded-replica mode and the process becomes a second persistent
writer alongside `radon-nextjs`, racing on the same `replica.db-wal`.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def _line_index(source: str, needle: str) -> int:
    """Return zero-based line index of the first match, or -1 if absent."""
    for i, line in enumerate(source.splitlines()):
        if needle in line:
            return i
    return -1


class TestMonitorDaemonRunNoReplicaTiming:
    """`monitor_daemon/run.py` must set NO_REPLICA before any handler import."""

    SOURCE = "scripts/monitor_daemon/run.py"

    def test_setdefault_appears_in_file(self) -> None:
        source = _read(self.SOURCE)
        assert 'os.environ.setdefault("RADON_DB_NO_REPLICA"' in source or \
               '_os.environ.setdefault("RADON_DB_NO_REPLICA"' in source, \
            "RADON_DB_NO_REPLICA setdefault missing from monitor_daemon/run.py"

    def test_setdefault_is_above_handler_imports(self) -> None:
        source = _read(self.SOURCE)
        setdefault_line = _line_index(source, 'setdefault("RADON_DB_NO_REPLICA"')
        # First handler import we care about.
        handler_line = _line_index(source, "from monitor_daemon.handlers")
        assert setdefault_line >= 0, "setdefault not found"
        assert handler_line >= 0, "handler import not found"
        assert setdefault_line < handler_line, (
            f"NO_REPLICA setdefault on line {setdefault_line+1} must precede the "
            f"handler import on line {handler_line+1}, otherwise db.writer "
            f"caches an embedded-replica client before it can be bypassed."
        )

    def test_setdefault_is_above_daemon_import(self) -> None:
        source = _read(self.SOURCE)
        setdefault_line = _line_index(source, 'setdefault("RADON_DB_NO_REPLICA"')
        daemon_line = _line_index(source, "from monitor_daemon.daemon import")
        assert setdefault_line >= 0
        assert daemon_line >= 0
        assert setdefault_line < daemon_line


class TestCtaSyncServiceNoReplicaTiming:
    """`cta_sync_service.py` is spawned from Next.js (which has NO_REPLICA
    unset by design — it IS the replica reader). The subprocess must
    defensively set its own NO_REPLICA before the `db.writer` import so the
    spawned process doesn't open the replica file while Next.js holds it."""

    SOURCE = "scripts/cta_sync_service.py"

    def test_setdefault_appears_in_file(self) -> None:
        source = _read(self.SOURCE)
        assert 'setdefault("RADON_DB_NO_REPLICA"' in source, (
            "RADON_DB_NO_REPLICA setdefault missing from cta_sync_service.py"
        )

    def test_setdefault_is_above_db_writer_import(self) -> None:
        source = _read(self.SOURCE)
        setdefault_line = _line_index(source, 'setdefault("RADON_DB_NO_REPLICA"')
        db_writer_line = _line_index(source, "from db.writer import")
        assert setdefault_line >= 0
        assert db_writer_line >= 0
        assert setdefault_line < db_writer_line, (
            f"NO_REPLICA setdefault on line {setdefault_line+1} must precede "
            f"the db.writer import on line {db_writer_line+1}."
        )


class TestExistingNoReplicaWriters:
    """Regression guard: every other long-running writer entry point we
    have already protected must keep the setdefault above its db.writer
    import. Catches accidental refactors that move the import up."""

    @pytest.mark.parametrize(
        "source_path,db_import_pattern",
        [
            ("scripts/api/server.py", "from db.writer import"),
            ("scripts/monitor_daemon/daemon.py", "from db.writer import"),
            ("scripts/cri_scan.py", "from db.writer import"),
            ("scripts/cash_flow_sync.py", "from db.writer import"),
            ("scripts/journal_rehydrate.py", "from db.writer import"),
            ("scripts/ib_sync.py", "from db.writer import"),
            ("scripts/ib_orders.py", "from db.writer import"),
        ],
    )
    def test_setdefault_above_writer_import(
        self, source_path: str, db_import_pattern: str
    ) -> None:
        source = _read(source_path)
        setdefault_line = _line_index(source, 'setdefault("RADON_DB_NO_REPLICA"')
        if setdefault_line < 0:
            # Some scripts use `os.environ["RADON_DB_NO_REPLICA"] = "1"` form.
            setdefault_line = _line_index(source, '"RADON_DB_NO_REPLICA"')
        if setdefault_line < 0:
            pytest.skip(
                f"{source_path} doesn't set NO_REPLICA — separate audit needed"
            )
        writer_line = _line_index(source, db_import_pattern)
        if writer_line < 0:
            pytest.skip(
                f"{source_path} doesn't import db.writer at module level "
                f"(may use deferred import — that's also safe)"
            )
        assert setdefault_line < writer_line, (
            f"In {source_path}, NO_REPLICA setdefault on line "
            f"{setdefault_line+1} must precede db.writer import on line "
            f"{writer_line+1}."
        )
