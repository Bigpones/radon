"""One-shot migration: clear legacy alert payloads from the
``watchdog-alerts`` service_health row.

Background
==========

Before 2026-05-19 the watchdog wrote the dispatched alert's content
into ``service_health.last_error`` whenever it fired — see the
``notify._emit_service_health`` removed in the same change. That made
the row's ``state=error`` until another alert with different severity
fired, leaving the UI banner showing stale downstream service detail
long after recovery.

The new dispatcher contract (``scripts/watchdog/notify.py``) writes
only DISPATCHER HEALTH into the row. To stop legacy rows from
showing in the banner after the contract change, this script:

  1. Reads the current ``watchdog-alerts`` row, if any
  2. If ``last_error`` parses as JSON and contains the legacy alert
     keys (``service``, ``severity``, ``kind``) → reset the row to
     ``state=ok``, ``last_error=NULL``
  3. Otherwise leave the row alone — opaque strings are real
     dispatcher errors (e.g. ``"pushover 500: …"``) and must be
     preserved so the banner keeps surfacing actionable failures

The script is idempotent. Running it twice is a no-op the second
time; running it on a fresh install (no row yet) is a no-op.

Usage
=====

  PYTHONPATH=. .venv/bin/python -m scripts.db.migrate_watchdog_alerts_row

Returns a dict ``{"cleared": bool, "reason": str}`` for programmatic
callers (e.g. the deploy script).
"""
from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


log = logging.getLogger("migrate_watchdog_alerts_row")


_LEGACY_ALERT_KEYS = frozenset({"service", "severity", "kind"})


def _get_db():
    """Resolve the libsql client whether this script is run as
    ``python -m scripts.db.migrate_watchdog_alerts_row`` (where
    ``scripts.db.client`` is importable) or after a ``sys.path.insert``
    that exposes flat ``db.client``.
    """
    try:
        from db.client import get_db  # type: ignore[import-not-found]
        return get_db()
    except ImportError:
        from scripts.db.client import get_db  # type: ignore[no-redef]
        return get_db()


def _looks_like_legacy_alert_payload(last_error: str | None) -> bool:
    """True iff ``last_error`` parses as JSON and carries the legacy
    alert keys we used to splat into the row pre-2026-05-19.
    """
    if not last_error:
        return False
    try:
        parsed = json.loads(last_error)
    except (json.JSONDecodeError, TypeError):
        return False
    if not isinstance(parsed, dict):
        return False
    # Heartbeat payloads carry {heartbeat_at, bucket} and must NOT be
    # cleared — they're the new contract's structurally-distinct shape.
    return _LEGACY_ALERT_KEYS.issubset(parsed.keys())


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def clean_watchdog_alerts_row() -> dict[str, Any]:
    """Reset the ``watchdog-alerts`` row to ``state=ok`` if and only if
    ``last_error`` carries a legacy alert payload. Idempotent.

    Returns ``{"cleared": bool, "reason": str}``.
    """
    db = _get_db()
    row = db.execute(
        "SELECT state, last_error FROM service_health WHERE service='watchdog-alerts'"
    ).fetchone()
    if row is None:
        return {"cleared": False, "reason": "no watchdog-alerts row"}

    state, last_error = row[0], row[1]
    if not _looks_like_legacy_alert_payload(last_error):
        return {
            "cleared": False,
            "reason": f"last_error is not a legacy alert payload (state={state!r})",
        }

    db.execute(
        """
        UPDATE service_health
        SET state = 'ok', last_error = NULL, updated_at = ?
        WHERE service = 'watchdog-alerts'
        """,
        (_now_iso(),),
    )
    db.commit()
    return {"cleared": True, "reason": "legacy alert payload cleared"}


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    outcome = clean_watchdog_alerts_row()
    log.info("[migrate_watchdog_alerts_row] %s", outcome)
    return 0


if __name__ == "__main__":
    # Allow both ``python -m scripts.db.migrate_watchdog_alerts_row`` and
    # ``python scripts/db/migrate_watchdog_alerts_row.py`` invocations.
    _PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
    if str(_PROJECT_ROOT / "scripts") not in sys.path:
        sys.path.insert(0, str(_PROJECT_ROOT / "scripts"))
    sys.exit(main())
