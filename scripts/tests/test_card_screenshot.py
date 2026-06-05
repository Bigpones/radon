"""Unit tests for the shared card-screenshot helper.

These mock subprocess.run; they never launch a real chromium. Real card
rendering is verified live post-deploy.
"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils import card_screenshot
from utils.card_screenshot import PROJECT_ROOT, screenshot_card


class TestScreenshotCard(unittest.TestCase):
    def test_invokes_node_helper_with_repo_cwd_and_args(self):
        with tempfile.NamedTemporaryFile(suffix=".png") as png:
            Path(png.name).write_bytes(b"\x89PNG\r\n")  # non-empty PNG
            with patch.object(card_screenshot.shutil, "which", return_value="/usr/bin/node"):
                with patch.object(card_screenshot.subprocess, "run") as run:
                    run.return_value = MagicMock(returncode=0, stderr="")
                    ok = screenshot_card("/tmp/card.html", png.name, ".card")

            self.assertTrue(ok)
            args, kwargs = run.call_args
            cmd = args[0]
            self.assertEqual(
                cmd,
                ["/usr/bin/node", "scripts/screenshot_card.cjs", "/tmp/card.html", png.name, ".card"],
            )
            self.assertEqual(kwargs["cwd"], str(PROJECT_ROOT))

    def test_default_selector_is_dot_card(self):
        with tempfile.NamedTemporaryFile(suffix=".png") as png:
            Path(png.name).write_bytes(b"\x89PNG\r\n")
            with patch.object(card_screenshot.shutil, "which", return_value="/usr/bin/node"):
                with patch.object(card_screenshot.subprocess, "run") as run:
                    run.return_value = MagicMock(returncode=0, stderr="")
                    screenshot_card("/tmp/card.html", png.name)
            self.assertEqual(run.call_args[0][0][-1], ".card")

    def test_returns_false_on_nonzero_returncode(self):
        with tempfile.NamedTemporaryFile(suffix=".png") as png:
            Path(png.name).write_bytes(b"\x89PNG\r\n")
            with patch.object(card_screenshot.shutil, "which", return_value="/usr/bin/node"):
                with patch.object(card_screenshot.subprocess, "run") as run:
                    run.return_value = MagicMock(returncode=1, stderr="boom")
                    ok = screenshot_card("/tmp/card.html", png.name)
            self.assertFalse(ok)

    def test_returns_false_when_png_missing(self):
        missing = str(Path(tempfile.gettempdir()) / "does-not-exist-card.png")
        Path(missing).unlink(missing_ok=True)
        with patch.object(card_screenshot.shutil, "which", return_value="/usr/bin/node"):
            with patch.object(card_screenshot.subprocess, "run") as run:
                run.return_value = MagicMock(returncode=0, stderr="")
                ok = screenshot_card("/tmp/card.html", missing)
        self.assertFalse(ok)

    def test_returns_false_when_png_empty(self):
        with tempfile.NamedTemporaryFile(suffix=".png") as png:
            # empty file
            with patch.object(card_screenshot.shutil, "which", return_value="/usr/bin/node"):
                with patch.object(card_screenshot.subprocess, "run") as run:
                    run.return_value = MagicMock(returncode=0, stderr="")
                    ok = screenshot_card("/tmp/card.html", png.name)
            self.assertFalse(ok)

    def test_returns_false_when_node_missing(self):
        with patch.object(card_screenshot.shutil, "which", return_value=None):
            ok = screenshot_card("/tmp/card.html", "/tmp/out.png")
        self.assertFalse(ok)

    def test_returns_false_on_timeout(self):
        with patch.object(card_screenshot.shutil, "which", return_value="/usr/bin/node"):
            with patch.object(
                card_screenshot.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(cmd="node", timeout=30),
            ):
                ok = screenshot_card("/tmp/card.html", "/tmp/out.png")
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
