"""Tests for the Tier-3 OFF-BOX prober (scripts/health_probe).

Covers the pure logic: HTTP probe parsing (mocked urllib), ping+status
classification, row construction, the Turso HTTP pipeline body builder, and the
dead-man's-switch reader. No real network, no real Turso.
"""
import errno
import io
import json
import socket
import subprocess
import sys
import urllib.error
from datetime import datetime, timedelta, timezone

import pytest

from health_probe import probe, reader, turso_http


# ── isolation contract: stdlib-only, no trading stack, no libsql ─────────────

class TestStdlibOnlyIsolation:
    """Tier-3 runs on a generic GH runner with no native libsql and a
    zero-shared-fate mandate. Importing it must pull in NONE of the trading
    stack and NO libsql client."""

    def test_import_pulls_in_no_trading_stack(self):
        import os
        forbidden_roots = {"ib_insync", "uvicorn", "fastapi", "starlette",
                           "libsql", "libsql_experimental", "ibapi", "eventkit"}
        code = (
            "import sys; import health_probe.probe; import health_probe.reader;\n"
            "bad = sorted(m for m in sys.modules\n"
            "  if m.split('.')[0] in %r\n"
            "  or m.startswith('scripts.api') or m.startswith('api.')\n"
            "  or m == 'scripts.db' or m.startswith('scripts.db'));\n"
            "print(','.join(bad)); sys.exit(1 if bad else 0)" % (forbidden_roots,)
        )
        import os as _os
        repo_root = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), _os.pardir, _os.pardir))
        env = {**_os.environ, "PYTHONPATH": _os.pathsep.join(["scripts", "."])}
        r = subprocess.run([sys.executable, "-c", code], capture_output=True,
                           text=True, env=env, cwd=repo_root, timeout=30)
        assert r.returncode == 0, f"prober imported forbidden modules: {r.stdout.strip()} / {r.stderr.strip()}"


# ── probe_endpoint: mocked urllib ────────────────────────────────────────────

class _FakeResp:
    def __init__(self, body: bytes, status: int = 200):
        self._body = body
        self.status = status

    def read(self, _n=None):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestProbeEndpoint:
    def test_2xx_json_is_reachable_with_payload(self, monkeypatch):
        monkeypatch.setattr(probe.urllib.request, "urlopen",
                            lambda *a, **k: _FakeResp(b'{"ok": true, "state": "up"}', 200))
        result = probe.probe_endpoint("https://app.radon.run/edge-health/status")
        assert result["reachable"] is True
        assert result["http_status"] == 200
        assert result["payload"] == {"ok": True, "state": "up"}
        assert result["latency_ms"] >= 0

    def test_empty_body_yields_empty_payload(self, monkeypatch):
        monkeypatch.setattr(probe.urllib.request, "urlopen",
                            lambda *a, **k: _FakeResp(b"", 200))
        result = probe.probe_endpoint("https://app.radon.run/edge-health/ping")
        assert result["reachable"] is True
        assert result["payload"] == {}

    def test_non_json_body_yields_empty_payload(self, monkeypatch):
        monkeypatch.setattr(probe.urllib.request, "urlopen",
                            lambda *a, **k: _FakeResp(b"OK", 200))
        result = probe.probe_endpoint("https://app.radon.run/edge-health/ping")
        assert result["reachable"] is True
        assert result["payload"] == {}

    def test_http_error_is_reachable_with_status(self, monkeypatch):
        def _raise(*a, **k):
            raise urllib.error.HTTPError("u", 503, "down", {}, io.BytesIO(b""))
        monkeypatch.setattr(probe.urllib.request, "urlopen", _raise)
        result = probe.probe_endpoint("https://app.radon.run/edge-health/status")
        assert result["reachable"] is True
        assert result["http_status"] == 503

    def test_timeout_is_unreachable(self, monkeypatch):
        def _raise(*a, **k):
            raise socket.timeout()
        monkeypatch.setattr(probe.urllib.request, "urlopen", _raise)
        result = probe.probe_endpoint("https://app.radon.run/edge-health/ping")
        assert result == {"reachable": False, "detail": "timeout"}

    def test_connection_refused_is_unreachable_refused(self, monkeypatch):
        def _raise(*a, **k):
            raise urllib.error.URLError(ConnectionRefusedError())
        monkeypatch.setattr(probe.urllib.request, "urlopen", _raise)
        result = probe.probe_endpoint("https://app.radon.run/edge-health/ping")
        assert result["reachable"] is False
        assert result["detail"] == "refused"

    def test_dns_failure_is_unreachable(self, monkeypatch):
        def _raise(*a, **k):
            raise urllib.error.URLError("Name or service not known")
        monkeypatch.setattr(probe.urllib.request, "urlopen", _raise)
        result = probe.probe_endpoint("https://app.radon.run/edge-health/ping")
        assert result["reachable"] is False
        assert result["detail"] == "unreachable"


# ── classify_probes ──────────────────────────────────────────────────────────

def _ok_probe(status=200, payload=None):
    return {"reachable": True, "http_status": status, "latency_ms": 12, "payload": payload or {}}


class TestClassifyProbes:
    def test_both_healthy_is_ok(self):
        result = probe.classify_probes(_ok_probe(), _ok_probe(payload={"ok": True, "state": "up"}))
        assert result == {"ok": 1, "detail": "edge_ok"}

    def test_ping_unreachable_fails(self):
        result = probe.classify_probes({"reachable": False, "detail": "timeout"}, _ok_probe())
        assert result["ok"] == 0
        assert result["detail"].startswith("ping_unreachable")

    def test_ping_5xx_fails(self):
        result = probe.classify_probes(_ok_probe(status=502), _ok_probe())
        assert result == {"ok": 0, "detail": "ping_http_502"}

    def test_status_unreachable_fails_even_if_ping_ok(self):
        result = probe.classify_probes(_ok_probe(), {"reachable": False, "detail": "refused"})
        assert result["ok"] == 0
        assert result["detail"].startswith("status_unreachable")

    def test_status_503_fails(self):
        result = probe.classify_probes(_ok_probe(), _ok_probe(status=503))
        assert result == {"ok": 0, "detail": "status_http_503"}

    def test_aggregate_ok_false_fails(self):
        result = probe.classify_probes(_ok_probe(), _ok_probe(payload={"ok": False}))
        assert result == {"ok": 0, "detail": "aggregate_unhealthy"}

    def test_aggregate_state_down_fails(self):
        result = probe.classify_probes(_ok_probe(), _ok_probe(payload={"state": "down"}))
        assert result == {"ok": 0, "detail": "aggregate_unhealthy"}

    def test_aggregate_state_unknown_is_not_fatal(self):
        # 'unknown' is not proof of death — the edge answered 200.
        result = probe.classify_probes(_ok_probe(), _ok_probe(payload={"state": "unknown"}))
        assert result["ok"] == 1

    def test_opaque_200_payload_is_healthy(self):
        result = probe.classify_probes(_ok_probe(), _ok_probe(payload={}))
        assert result["ok"] == 1


# ── build_probe_row ──────────────────────────────────────────────────────────

class TestBuildProbeRow:
    def test_healthy_row_uses_status_code_and_max_latency(self):
        ping = {"reachable": True, "http_status": 200, "latency_ms": 30, "payload": {}}
        status = {"reachable": True, "http_status": 200, "latency_ms": 90, "payload": {"ok": True}}
        row = probe.build_probe_row("src", ping, status, "2026-05-29T12:00:00Z")
        assert row == {
            "source": "src",
            "ok": 1,
            "http_status": 200,
            "latency_ms": 90,  # worst-case of the two
            "detail": "edge_ok",
            "checked_at": "2026-05-29T12:00:00Z",
        }

    def test_transport_failure_yields_null_status_and_latency(self):
        ping = {"reachable": False, "detail": "timeout"}
        status = {"reachable": False, "detail": "timeout"}
        row = probe.build_probe_row("src", ping, status, "2026-05-29T12:00:00Z")
        assert row["ok"] == 0
        assert row["http_status"] is None
        assert row["latency_ms"] is None
        assert row["detail"].startswith("ping_unreachable")

    def test_status_unreachable_keeps_null_http_status(self):
        ping = {"reachable": True, "http_status": 200, "latency_ms": 10, "payload": {}}
        status = {"reachable": False, "detail": "refused"}
        row = probe.build_probe_row("src", ping, status, "2026-05-29T12:00:00Z")
        assert row["http_status"] is None
        assert row["latency_ms"] == 10  # only the reachable ping contributes


# ── turso_http: URL rewrite + pipeline body + error surfacing ────────────────

class TestHttpBaseUrl:
    def test_libsql_scheme_becomes_https(self):
        assert turso_http.http_base_url("libsql://radon.turso.io") == "https://radon.turso.io"

    def test_https_passthrough(self):
        assert turso_http.http_base_url("https://radon.turso.io") == "https://radon.turso.io"

    def test_ws_dev_becomes_http(self):
        assert turso_http.http_base_url("ws://127.0.0.1:8080") == "http://127.0.0.1:8080"


class TestBuildUpsertPipeline:
    def test_upsert_has_conflict_clause_and_named_args(self):
        row = {"source": "s", "ok": 1, "http_status": 200,
               "latency_ms": 42, "detail": "edge_ok", "checked_at": "2026-05-29T12:00:00Z"}
        body = turso_http.build_upsert_pipeline(row)
        stmt = body["requests"][0]["stmt"]
        assert "ON CONFLICT(source) DO UPDATE" in stmt["sql"]
        names = {a["name"]: a["value"] for a in stmt["named_args"]}
        assert names["source"] == {"type": "text", "value": "s"}
        assert names["ok"] == {"type": "integer", "value": "1"}
        assert names["http_status"] == {"type": "integer", "value": "200"}
        assert names["checked_at"] == {"type": "text", "value": "2026-05-29T12:00:00Z"}
        assert body["requests"][-1] == {"type": "close"}

    def test_none_encodes_as_null(self):
        row = {"source": "s", "ok": 0, "http_status": None,
               "latency_ms": None, "detail": "timeout", "checked_at": "2026-05-29T12:00:00Z"}
        names = {a["name"]: a["value"] for a in turso_http.build_upsert_pipeline(row)["requests"][0]["stmt"]["named_args"]}
        assert names["http_status"] == {"type": "null"}
        assert names["latency_ms"] == {"type": "null"}


class TestUpsertErrorSurfacing:
    def test_missing_env_raises(self, monkeypatch):
        monkeypatch.delenv("TURSO_DB_URL", raising=False)
        monkeypatch.delenv("TURSO_AUTH_TOKEN", raising=False)
        with pytest.raises(turso_http.TursoHttpError):
            turso_http.upsert_external_probe({"source": "s", "ok": 1, "checked_at": "x"})

    def test_pipeline_error_result_raises(self, monkeypatch):
        monkeypatch.setenv("TURSO_DB_URL", "libsql://radon.turso.io")
        monkeypatch.setenv("TURSO_AUTH_TOKEN", "tok")
        err_body = json.dumps({"results": [{"type": "error", "error": {"message": "no such table"}}]}).encode()
        monkeypatch.setattr(turso_http.urllib.request, "urlopen",
                            lambda *a, **k: _FakeResp(err_body, 200))
        with pytest.raises(turso_http.TursoHttpError) as exc:
            turso_http.upsert_external_probe({
                "source": "s", "ok": 1, "http_status": 200,
                "latency_ms": 1, "detail": "edge_ok", "checked_at": "x"})
        assert "no such table" in str(exc.value)

    def test_http_error_raises(self, monkeypatch):
        monkeypatch.setenv("TURSO_DB_URL", "libsql://radon.turso.io")
        monkeypatch.setenv("TURSO_AUTH_TOKEN", "tok")

        def _raise(*a, **k):
            raise urllib.error.HTTPError("u", 401, "unauthorized", {}, io.BytesIO(b"bad token"))
        monkeypatch.setattr(turso_http.urllib.request, "urlopen", _raise)
        with pytest.raises(turso_http.TursoHttpError) as exc:
            turso_http.upsert_external_probe({
                "source": "s", "ok": 1, "http_status": 200,
                "latency_ms": 1, "detail": "edge_ok", "checked_at": "x"})
        assert "401" in str(exc.value)

    def test_success_does_not_raise(self, monkeypatch):
        monkeypatch.setenv("TURSO_DB_URL", "libsql://radon.turso.io")
        monkeypatch.setenv("TURSO_AUTH_TOKEN", "tok")
        ok_body = json.dumps({"results": [{"type": "ok"}, {"type": "ok"}]}).encode()
        monkeypatch.setattr(turso_http.urllib.request, "urlopen",
                            lambda *a, **k: _FakeResp(ok_body, 200))
        turso_http.upsert_external_probe({
            "source": "s", "ok": 1, "http_status": 200,
            "latency_ms": 1, "detail": "edge_ok", "checked_at": "x"})


# ── run_probe orchestration (mocked transport + DB) ──────────────────────────

class TestRunProbe:
    def test_writes_classified_row(self, monkeypatch):
        monkeypatch.setattr(probe, "probe_endpoint",
                            lambda url, **k: _ok_probe(payload={"ok": True}))
        written = {}
        monkeypatch.setattr(probe, "upsert_external_probe", lambda row: written.update(row))
        row = probe.run_probe(source="test/edge")
        assert row["source"] == "test/edge"
        assert row["ok"] == 1
        assert written == row  # the exact classified row reached the writer

    def test_main_returns_1_when_write_fails(self, monkeypatch):
        monkeypatch.setattr(probe, "probe_endpoint", lambda url, **k: _ok_probe(payload={"ok": True}))

        def _boom(_row):
            raise turso_http.TursoHttpError("down")
        monkeypatch.setattr(probe, "upsert_external_probe", _boom)
        assert probe.main() == 1


# ── dead-man's-switch reader ─────────────────────────────────────────────────

_NOW = datetime(2026, 5, 29, 12, 0, 0, tzinfo=timezone.utc)


def _row(ok=1, ago_seconds=60, detail="edge_ok"):
    checked = (_NOW - timedelta(seconds=ago_seconds)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return {"source": "github-actions/edge", "ok": ok, "http_status": 200,
            "latency_ms": 50, "detail": detail, "checked_at": checked}


class TestDeadMansSwitch:
    def test_fresh_ok_row_is_healthy(self):
        result = reader.classify_external_probe(_row(ok=1, ago_seconds=60), now=_NOW)
        assert result["verdict"] == reader.VERDICT_HEALTHY

    def test_fresh_failed_row_is_down(self):
        result = reader.classify_external_probe(_row(ok=0, ago_seconds=60, detail="status_http_503"), now=_NOW)
        assert result["verdict"] == reader.VERDICT_DOWN
        assert result["reason"] == "status_http_503"

    def test_stale_ok_row_is_stale_not_healthy(self):
        # The critical case: a frozen ok=1 must NOT read as green.
        result = reader.classify_external_probe(_row(ok=1, ago_seconds=30 * 60), now=_NOW)
        assert result["verdict"] == reader.VERDICT_STALE
        assert result["reason"] == "prober_silent"

    def test_missing_row_is_stale(self):
        assert reader.classify_external_probe(None, now=_NOW)["verdict"] == reader.VERDICT_STALE
        assert reader.classify_external_probe({}, now=_NOW)["verdict"] == reader.VERDICT_STALE

    def test_boundary_just_inside_window_is_trusted(self):
        result = reader.classify_external_probe(_row(ok=1, ago_seconds=reader.STALE_AFTER_SECONDS - 1), now=_NOW)
        assert result["verdict"] == reader.VERDICT_HEALTHY

    def test_boundary_just_past_window_is_stale(self):
        result = reader.classify_external_probe(_row(ok=1, ago_seconds=reader.STALE_AFTER_SECONDS + 1), now=_NOW)
        assert result["verdict"] == reader.VERDICT_STALE

    def test_age_seconds_clamps_future_timestamps_to_zero(self):
        future = (_NOW + timedelta(seconds=120)).isoformat().replace("+00:00", "Z")
        assert reader.age_seconds(future, now=_NOW) == 0.0
