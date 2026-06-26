#!/usr/bin/env bash
# apply-forge-mods.sh — re-apply Forge's modifications after a Radon upstream update.
#
# WHY THIS EXISTS
# ---------------
# Joe McCann squashed Radon's git history, so there is no common ancestor to
# `git merge` against. Updating Radon = replace files with Joe's, then run this
# script to re-apply the handful of Forge-specific changes.
#
# UPDATE PROCEDURE
# ----------------
#   cd ~/radon
#   git fetch upstream main
#   git checkout upstream/main -- scripts/   # ONLY scripts/ (Python/FastAPI) — NOT web/
#   ./apply-forge-mods.sh               # re-apply the changes below
#   cd web && npm run dev               # test: curl 'localhost:8321/historical?symbol=AAPL'
#
# WHAT FORGE DEPENDS ON (survives automatically — Joe never has these files):
#   - scripts/ib_historical.py            (OHLCV subprocess)
#   - scripts/api/routes/forge_ohlcv.py   (GET /historical router)
#
# WHAT THIS SCRIPT RE-APPLIES (Joe's files overwrite these every update):
#   1. server.py: import + include the forge_ohlcv router (2 lines)
#   2. scripts/dev + web/package.json: venv python path + IB_GATEWAY_MODE=native
#
# WHY web/ STAYS ON OUR VERSION:
#   Joe upgraded Radon's web dashboard to Next.js 16 (Turbopack). Forge does
#   NOT use Radon's dashboard (port 3000) — Forge only calls the FastAPI backend
#   (port 8321). So we keep web/ on Next 15.5 (stable) and only pull Joe's
#   scripts/ improvements. Never `git checkout upstream/main -- web/`.
#
# NOTE: Clerk-optional and launchd IB-gateway mode are now NATIVE in Joe's code
# (is_trusted_local_request + IB_GATEWAY_MODE env var), so they no longer need
# re-applying. Forge's surgical surface is just the 2 items above.

set -euo pipefail
cd "$(dirname "$0")"

SERVER="scripts/api/server.py"
DEV="scripts/dev"
WEB_PKG="web/package.json"
VENV_PY="/Users/misskitty/radon/.venv/bin/python3.13"

echo "→ Forge mods: re-applying..."

# ── 1. forge_ohlcv router into server.py ────────────────────────────────────
if ! grep -q "forge_ohlcv_router" "$SERVER"; then
  # add import right after Joe's historical router import
  perl -0pi -e 's{(from api\.routes\.historical import router as historical_router\n)}{$1from api.routes.forge_ohlcv import router as forge_ohlcv_router  # FORGE\n}' "$SERVER"
  # add include right after Joe's historical router include
  perl -0pi -e 's{(app\.include_router\(historical_router\)\n)}{$1app.include_router(forge_ohlcv_router)  # FORGE OHLCV /historical\n}' "$SERVER"
  echo "  ✓ forge_ohlcv router wired into server.py"
else
  echo "  • forge_ohlcv router already present"
fi

# ── 2. venv python path + IB_GATEWAY_MODE in scripts/dev ────────────────────
if grep -q '"python3.13 -m uvicorn' "$DEV"; then
  perl -pi -e 's{"python3\.13 -m uvicorn}{"IB_GATEWAY_MODE=native '"$VENV_PY"' -m uvicorn}g' "$DEV"
  echo "  ✓ scripts/dev: venv path + IB_GATEWAY_MODE applied"
else
  echo "  • scripts/dev already patched"
fi

# ── 3. venv python path + IB_GATEWAY_MODE in web/package.json verbose variants ─
if grep -q 'python3.13 -m uvicorn scripts.api.server:app' "$WEB_PKG"; then
  perl -pi -e 's{python3\.13 -m uvicorn scripts\.api\.server:app}{IB_GATEWAY_MODE=native '"$VENV_PY"' -m uvicorn scripts.api.server:app}g' "$WEB_PKG"
  echo "  ✓ web/package.json: venv path + IB_GATEWAY_MODE applied"
else
  echo "  • web/package.json already patched"
fi


# ── 4. bash 3.2 compat: empty-array expansion in scripts/dev (macOS ships bash 3.2) ─
if grep -q 'concurrently "\${HIDE_ARGS\[@\]}"' "$DEV"; then
  perl -pi -e 's{concurrently "\$\{HIDE_ARGS\[\@\]\}"}{concurrently \$\{HIDE_ARGS[\@]+"\$\{HIDE_ARGS[\@]\}"\}}g' "$DEV"
  echo "  ✓ scripts/dev: bash 3.2 empty-array fix applied"
else
  echo "  • scripts/dev bash 3.2 fix already present"
fi

echo "→ Forge mods applied. Test: curl 'http://localhost:8321/historical?symbol=AAPL'"
