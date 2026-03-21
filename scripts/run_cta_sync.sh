#!/bin/bash
#
# MenthorQ CTA refresh wrapper for launchd
#
# Runs at the scheduled post-close windows, with `RunAtLoad` handling
# reboot/login/wake catch-up. The target date is always the latest closed US
# trading session, so if the machine slept through the scheduled run the next
# load-triggered execution backfills the missing session automatically.
#

cd "$(dirname "$0")/.."

_load_env() {
    local f="$1"
    [ -f "$f" ] || return
    local tmp
    tmp=$(mktemp)
    grep -v '^#' "$f" | grep -v '^\s*$' | sed 's/^export //' > "$tmp"
    set -a
    # shellcheck disable=SC1090
    . "$tmp"
    set +a
    rm -f "$tmp"
}

_load_env "web/.env"
_load_env ".env"

mkdir -p data/menthorq_cache logs

resolve_python() {
    local candidate
    for candidate in "${RADON_PYTHON_BIN:-}" python3.13 python3.9 /usr/bin/python3 python3; do
        [ -n "$candidate" ] || continue
        command -v "$candidate" >/dev/null 2>&1 || continue
        "$candidate" - <<'PY' >/dev/null 2>&1
import importlib.util
raise SystemExit(0 if importlib.util.find_spec("playwright") else 1)
PY
        if [ $? -eq 0 ]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

PYTHON_BIN=$(resolve_python)
if [ -z "$PYTHON_BIN" ]; then
    echo "$(date): No Python interpreter with Playwright available for CTA sync"
    exit 1
fi

SOURCE="${RADON_CTA_SYNC_SOURCE:-${CTA_SYNC_TRIGGER:-launchd}}"

echo "$(date): Running hardened CTA sync runtime (source=$SOURCE)..."
"$PYTHON_BIN" scripts/cta_sync_service.py --source "$SOURCE" "$@"
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
    echo "$(date): CTA sync runtime complete (OK)"
else
    echo "$(date): CTA sync runtime failed (exit $EXIT_CODE)"
fi
exit "$EXIT_CODE"
