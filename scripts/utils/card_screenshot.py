"""Shared card-screenshot helper.

Screenshots a card element from a local HTML file to a PNG by shelling out to
the Playwright-backed Node helper (`scripts/screenshot_card.cjs`). This replaces
the missing `agent-browser` CLI; Playwright + chromium are already installed on
the production VPS via `deploy.sh` (`npx playwright install chromium`).

The Node process is run with cwd at the repo root so Node resolves Playwright
from the in-tree `node_modules`.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
NODE_HELPER = PROJECT_ROOT / "scripts" / "screenshot_card.cjs"
NODE_TIMEOUT_S = 30


def screenshot_card(html_path: str, png_path: str, selector: str = ".card") -> bool:
    """Render the card at `selector` in `html_path` to `png_path`.

    Returns True only when Node exits 0 AND the PNG exists and is non-empty.
    Logs any Node stderr to our stderr on failure.
    """
    node = shutil.which("node")
    if not node:
        print("screenshot_card: node not found on PATH", file=sys.stderr)
        return False

    try:
        result = subprocess.run(
            [node, "scripts/screenshot_card.cjs", html_path, png_path, selector],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=NODE_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        print(f"screenshot_card: timed out after {NODE_TIMEOUT_S}s for {html_path}", file=sys.stderr)
        return False
    except Exception as exc:  # pragma: no cover - defensive
        print(f"screenshot_card: failed to launch node: {exc}", file=sys.stderr)
        return False

    if result.returncode != 0:
        if result.stderr:
            print(result.stderr, file=sys.stderr, end="")
        return False

    out = Path(png_path)
    return out.exists() and out.stat().st_size > 0
