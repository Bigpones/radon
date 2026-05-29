"""Tests for Clerk JWT auth middleware and WebSocket ticket system."""

import os
import sys
import time
import uuid
from unittest.mock import patch

import pytest

# Ensure the scripts/ directory is on sys.path so `from api.*` imports resolve.
_scripts_dir = os.path.join(os.path.dirname(__file__), os.pardir, os.pardir)
sys.path.insert(0, os.path.abspath(_scripts_dir))

# --- ws_ticket tests ---

from api.ws_ticket import create_ticket, validate_ticket, _ticket_store, TICKET_TTL_SECONDS


class TestCreateTicket:
    def setup_method(self):
        _ticket_store.clear()

    def test_returns_valid_uuid(self):
        ticket = create_ticket("user_123")
        uuid.UUID(ticket)  # raises if not valid UUID

    def test_stores_user_id_and_expiry(self):
        ticket = create_ticket("user_abc")
        assert ticket in _ticket_store
        assert _ticket_store[ticket]["user_id"] == "user_abc"
        assert _ticket_store[ticket]["expires"] > time.time()


class TestValidateTicket:
    def setup_method(self):
        _ticket_store.clear()

    def test_valid_ticket_returns_user_id(self):
        ticket = create_ticket("user_xyz")
        assert validate_ticket(ticket) == "user_xyz"

    def test_ticket_is_single_use(self):
        ticket = create_ticket("user_once")
        assert validate_ticket(ticket) == "user_once"
        assert validate_ticket(ticket) is None

    def test_invalid_ticket_returns_none(self):
        assert validate_ticket("nonexistent-ticket") is None

    def test_expired_ticket_returns_none(self):
        ticket = create_ticket("user_exp")
        _ticket_store[ticket]["expires"] = time.time() - 1
        assert validate_ticket(ticket) is None

    def test_cleanup_removes_expired(self):
        t1 = create_ticket("user_old")
        _ticket_store[t1]["expires"] = time.time() - 1
        t2 = create_ticket("user_new")
        # validate triggers cleanup via _cleanup_expired
        validate_ticket("dummy")
        assert t1 not in _ticket_store
        assert t2 in _ticket_store


# --- auth.py tests ---

from api.auth import _get_allowed_users, _get_issuer


# --- security perimeter: the bypass boundary + JWT validator + API-key scope ---

from types import SimpleNamespace

import jwt as pyjwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException

from api import auth as auth_mod
from api.auth import (
    API_KEY_ALLOWED_PATHS,
    is_local_or_tailnet,
    verify_api_key,
    verify_clerk_jwt,
)

# One RSA keypair for the whole module — keygen is the slow part, do it once.
_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PRIVATE_PEM = _PRIVATE_KEY.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption(),
).decode()
_PUBLIC_PEM = (
    _PRIVATE_KEY.public_key()
    .public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    .decode()
)

_ISSUER = "https://clerk.radon.test"


class _FakeRequest:
    """Minimal stand-in for starlette Request: .client.host, .headers, .url.path."""

    def __init__(self, host=None, auth_header=None, path="/", api_key=None):
        self.client = SimpleNamespace(host=host) if host is not None else None
        headers = {}
        if auth_header is not None:
            headers["Authorization"] = auth_header
        if api_key is not None:
            headers["X-API-Key"] = api_key
        self.headers = headers
        self.url = SimpleNamespace(path=path)


def _make_token(*, sub="user_ok", issuer=_ISSUER, algorithm="RS256", key=None, exp_delta=3600):
    payload = {"sub": sub}
    if issuer is not None:
        payload["iss"] = issuer
    if exp_delta is not None:
        payload["exp"] = int(time.time()) + exp_delta
    if key is None:
        key = _PRIVATE_PEM if algorithm == "RS256" else ("x" * 40)
    if algorithm == "none":
        return pyjwt.encode(payload, None, algorithm="none")
    return pyjwt.encode(payload, key, algorithm=algorithm)


class TestIsLocalOrTailnet:
    """Pins the loopback + Tailscale CGNAT (100.64.0.0/10) bypass boundary.

    A widened CIDR here silently exposes the entire FastAPI surface to the
    public internet, so the /10 edges are asserted exactly.
    """

    def test_loopback_true(self):
        assert is_local_or_tailnet("127.0.0.1") is True
        assert is_local_or_tailnet("::1") is True

    def test_tailnet_lower_bound_true(self):
        assert is_local_or_tailnet("100.64.0.1") is True

    def test_tailnet_upper_bound_true(self):
        assert is_local_or_tailnet("100.127.255.255") is True

    def test_just_below_tailnet_false(self):
        assert is_local_or_tailnet("100.63.255.255") is False

    def test_just_above_tailnet_false(self):
        assert is_local_or_tailnet("100.128.0.1") is False

    def test_public_ip_false(self):
        assert is_local_or_tailnet("8.8.8.8") is False

    def test_none_and_empty_false(self):
        assert is_local_or_tailnet(None) is False
        assert is_local_or_tailnet("") is False

    def test_garbage_false(self):
        assert is_local_or_tailnet("not-an-ip") is False


class TestVerifyClerkJwt:
    """End-to-end JWT validation with real signing/verification.

    Only the JWKS lookup is mocked (network); pyjwt.decode runs for real so
    alg-pinning, expiry, and issuer checks are genuinely exercised.
    """

    def _patch_jwks(self):
        signing_key = SimpleNamespace(key=_PUBLIC_PEM)
        fake_client = SimpleNamespace(get_signing_key_from_jwt=lambda token: signing_key)
        return patch.object(auth_mod, "_get_jwks_client", return_value=fake_client)

    def _env(self, allowed="user_ok"):
        return patch.dict(os.environ, {"CLERK_ISSUER": _ISSUER, "ALLOWED_USER_IDS": allowed})

    @pytest.mark.asyncio
    async def test_local_host_bypasses_validation(self):
        # No token at all, but loopback → server-to-server bypass.
        req = _FakeRequest(host="127.0.0.1")
        result = await verify_clerk_jwt(req)
        assert result == {"sub": "localhost", "local": True}

    @pytest.mark.asyncio
    async def test_tailnet_host_bypasses_validation(self):
        req = _FakeRequest(host="100.100.5.5")
        result = await verify_clerk_jwt(req)
        assert result["local"] is True

    @pytest.mark.asyncio
    async def test_valid_allowlisted_token_returns_payload(self):
        req = _FakeRequest(host="8.8.8.8", auth_header="Bearer " + _make_token(sub="user_ok"))
        with self._patch_jwks(), self._env(allowed="user_ok"):
            payload = await verify_clerk_jwt(req)
        assert payload["sub"] == "user_ok"

    @pytest.mark.asyncio
    async def test_sub_not_allowlisted_403(self):
        req = _FakeRequest(host="8.8.8.8", auth_header="Bearer " + _make_token(sub="intruder"))
        with self._patch_jwks(), self._env(allowed="user_ok"):
            with pytest.raises(HTTPException) as exc:
                await verify_clerk_jwt(req)
        assert exc.value.status_code == 403

    @pytest.mark.asyncio
    async def test_empty_allowlist_accepts_any_valid_user(self):
        req = _FakeRequest(host="8.8.8.8", auth_header="Bearer " + _make_token(sub="anyone"))
        with self._patch_jwks(), self._env(allowed=""):
            payload = await verify_clerk_jwt(req)
        assert payload["sub"] == "anyone"

    @pytest.mark.asyncio
    async def test_missing_bearer_401(self):
        req = _FakeRequest(host="8.8.8.8")  # no Authorization header
        with self._patch_jwks(), self._env():
            with pytest.raises(HTTPException) as exc:
                await verify_clerk_jwt(req)
        assert exc.value.status_code == 401

    @pytest.mark.asyncio
    async def test_non_bearer_scheme_401(self):
        req = _FakeRequest(host="8.8.8.8", auth_header="Basic abc123")
        with self._patch_jwks(), self._env():
            with pytest.raises(HTTPException) as exc:
                await verify_clerk_jwt(req)
        assert exc.value.status_code == 401

    @pytest.mark.asyncio
    async def test_expired_token_401(self):
        token = _make_token(sub="user_ok", exp_delta=-10)
        req = _FakeRequest(host="8.8.8.8", auth_header="Bearer " + token)
        with self._patch_jwks(), self._env():
            with pytest.raises(HTTPException) as exc:
                await verify_clerk_jwt(req)
        assert exc.value.status_code == 401

    @pytest.mark.asyncio
    async def test_hs256_token_rejected_401(self):
        # Symmetric-algo token must NOT validate against the RS256 pin.
        token = _make_token(sub="user_ok", algorithm="HS256")
        req = _FakeRequest(host="8.8.8.8", auth_header="Bearer " + token)
        with self._patch_jwks(), self._env():
            with pytest.raises(HTTPException) as exc:
                await verify_clerk_jwt(req)
        assert exc.value.status_code == 401

    @pytest.mark.asyncio
    async def test_alg_none_token_rejected_401(self):
        token = _make_token(sub="user_ok", algorithm="none")
        req = _FakeRequest(host="8.8.8.8", auth_header="Bearer " + token)
        with self._patch_jwks(), self._env():
            with pytest.raises(HTTPException) as exc:
                await verify_clerk_jwt(req)
        assert exc.value.status_code == 401

    @pytest.mark.asyncio
    async def test_issuer_mismatch_401(self):
        token = _make_token(sub="user_ok", issuer="https://evil.example")
        req = _FakeRequest(host="8.8.8.8", auth_header="Bearer " + token)
        with self._patch_jwks(), self._env():
            with pytest.raises(HTTPException) as exc:
                await verify_clerk_jwt(req)
        assert exc.value.status_code == 401


class TestVerifyApiKey:
    """API key is read-only and path-scoped — must never reach trading routes."""

    def test_no_key_returns_none(self):
        with patch.dict(os.environ, {"MDW_API_KEY": "secret"}):
            assert verify_api_key(_FakeRequest(path="/historical/bars")) is None

    def test_no_server_key_returns_none(self):
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("MDW_API_KEY", None)
            req = _FakeRequest(path="/historical/bars", api_key="secret")
            assert verify_api_key(req) is None

    def test_wrong_key_returns_none(self):
        with patch.dict(os.environ, {"MDW_API_KEY": "secret"}):
            req = _FakeRequest(path="/historical/bars", api_key="wrong")
            assert verify_api_key(req) is None

    def test_valid_key_allowed_path(self):
        with patch.dict(os.environ, {"MDW_API_KEY": "secret"}):
            req = _FakeRequest(path="/historical/bars", api_key="secret")
            assert verify_api_key(req) == {"sub": "mdw-service", "service": True}

    def test_valid_key_disallowed_path_returns_none(self):
        with patch.dict(os.environ, {"MDW_API_KEY": "secret"}):
            req = _FakeRequest(path="/orders/place", api_key="secret")
            assert verify_api_key(req) is None

    def test_allowlist_excludes_trading_surfaces(self):
        # Regression pin: the API key must never gain a trading/order/exec/pi path.
        forbidden_fragments = ("/orders", "/order", "/exec", "/pi", "/portfolio", "/ib/")
        for path in API_KEY_ALLOWED_PATHS:
            assert not any(frag in path for frag in forbidden_fragments), path
    def test_empty_env(self):
        with patch.dict(os.environ, {"ALLOWED_USER_IDS": ""}):
            assert _get_allowed_users() == set()

    def test_single_user(self):
        with patch.dict(os.environ, {"ALLOWED_USER_IDS": "user_123"}):
            assert _get_allowed_users() == {"user_123"}

    def test_multiple_users(self):
        with patch.dict(os.environ, {"ALLOWED_USER_IDS": "user_1,user_2,user_3"}):
            assert _get_allowed_users() == {"user_1", "user_2", "user_3"}

    def test_trims_whitespace(self):
        with patch.dict(os.environ, {"ALLOWED_USER_IDS": " user_1 , user_2 "}):
            assert _get_allowed_users() == {"user_1", "user_2"}


class TestGetIssuer:
    def test_returns_env_value(self):
        with patch.dict(os.environ, {"CLERK_ISSUER": "https://app.clerk.dev"}):
            assert _get_issuer() == "https://app.clerk.dev"

    def test_returns_empty_when_not_set(self):
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("CLERK_ISSUER", None)
            assert _get_issuer() == ""
