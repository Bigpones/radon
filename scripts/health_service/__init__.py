"""Standalone Radon health daemon — isolated from the trading stack.

By contract, NOTHING in this package may import the trading stack
(scripts.api.server, ib_pool, ib_gateway, ib_insync, libsql, uvicorn, ...). The
daemon's entire purpose is zero shared fate with what it monitors, so it must
stay stdlib-only and probe every service from the outside.
"""
