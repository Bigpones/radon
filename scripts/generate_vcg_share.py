#!/usr/bin/env python3
"""
Generate VCG (Volatility-Credit Gap) share cards + preview page for X.
Reads from data/vcg.json, produces 4 PNG cards and a self-contained HTML preview.

Cards:
  1. VCG Signal — z-score, div-adjusted, interpretation
  2. HDR Conditions — 3 conditions, RO signal status
  3. Regime & Attribution — VVIX vs VIX contribution, betas
  4. 10-Day History — rolling VCG values

Usage:
  python3 scripts/generate_vcg_share.py
  python3 scripts/generate_vcg_share.py --json
"""
from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.resolve()
DATA_DIR = PROJECT_ROOT / "data"
CACHE_PATH = DATA_DIR / "vcg.json"
REPORTS_DIR = PROJECT_ROOT / "reports"
REPORTS_DIR.mkdir(exist_ok=True)

FONTS = '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">'

BASE_CSS = """
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', sans-serif; background: #0a0f14; color: #e2e8f0; width: 600px; }
.card { width: 600px; background: #0a0f14; border: 1px solid #1e293b; overflow: hidden; }
.card-inner { padding: 28px 32px; }
.footer { display: flex; justify-content: space-between; align-items: center;
          padding-top: 16px; border-top: 1px solid #1e293b; }
.footer-brand { font-size: 12px; font-weight: 600; color: #05AD98;
                font-family: 'IBM Plex Mono', monospace; }
.footer-tag { font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: #475569;
              letter-spacing: 0.08em; text-transform: uppercase; }
.footer-date { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: #475569; }
"""


# ── Data loading ──────────────────────────────────────────────────

def load_vcg() -> dict:
    """Load VCG data from cache."""
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text())
        except Exception:
            pass
    print("No VCG data found. Run: curl -X POST http://localhost:8321/vcg/scan", file=sys.stderr)
    sys.exit(1)


# ── Helpers ───────────────────────────────────────────────────────

def interp_color(interpretation: str) -> str:
    return {
        "CREDIT_ARTIFICIALLY_CALM": "#E85D6C",
        "CREDIT_OVERSHOT": "#F5A623",
        "NORMAL": "#05AD98",
    }.get(interpretation, "#94a3b8")


def interp_bg(interpretation: str) -> str:
    return {
        "CREDIT_ARTIFICIALLY_CALM": "rgba(232,93,108,0.12)",
        "CREDIT_OVERSHOT": "rgba(245,166,35,0.12)",
        "NORMAL": "rgba(5,173,152,0.12)",
    }.get(interpretation, "rgba(100,116,139,0.1)")


def interp_label(interpretation: str) -> str:
    return {
        "CREDIT_ARTIFICIALLY_CALM": "CREDIT ARTIFICIALLY CALM",
        "CREDIT_OVERSHOT": "CREDIT OVERSHOT",
        "NORMAL": "NORMAL",
        "INSUFFICIENT_DATA": "INSUFFICIENT DATA",
    }.get(interpretation, interpretation)


def regime_color(regime: str) -> str:
    return {"PANIC": "#8B5CF6", "TRANSITION": "#F5A623"}.get(regime, "#05AD98")


def fmt_z(v) -> str:
    if v is None:
        return "---"
    return f"+{v:.2f}" if v >= 0 else f"{v:.2f}"


def fmt_pct(v) -> str:
    if v is None:
        return "---"
    return f"+{v:.2f}%" if v >= 0 else f"{v:.2f}%"


# ── Card wrapper ─────────────────────────────────────────────────

def card_wrap(title: str, body: str, card_n: int, total: int, ds: str) -> str:
    d = datetime.strptime(ds, "%Y-%m-%d")
    date_str = d.strftime("%b %-d, %Y")
    footer = f"""
    <div class="footer">
      <div class="footer-brand">radon.run</div>
      <div class="footer-tag">Analyzed by Radon · {card_n}/{total}</div>
      <div class="footer-date">{date_str}</div>
    </div>"""
    return f"""<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=600">
<title>{title}</title>{FONTS}
<style>{BASE_CSS}</style></head>
<body><div class="card"><div class="card-inner">
{body}
{footer}
</div></div></body></html>"""


# ── Card 1: VCG Signal ──────────────────────────────────────────

def card1_signal(data: dict, ds: str) -> str:
    sig = data.get("signal", {})
    vcg = sig.get("vcg")
    vcg_div = sig.get("vcg_div")
    interp = sig.get("interpretation", "INSUFFICIENT_DATA")
    col = interp_color(interp)
    bg = interp_bg(interp)
    proxy = data.get("credit_proxy", "HYG")

    body = f"""
    <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:{col};margin-bottom:10px;display:flex;align-items:center;gap:8px">
      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:{col}"></span>
      VOLATILITY-CREDIT GAP · {ds}
    </div>
    <div style="display:flex;align-items:baseline;gap:16px;margin-bottom:6px">
      <div style="font-size:56px;font-weight:800;letter-spacing:-.04em;color:{col};line-height:1">{fmt_z(vcg)}</div>
      <div>
        <div style="font-size:13px;color:#64748b;margin-bottom:4px">z-score</div>
        <div style="display:inline-block;background:{bg};color:{col};border:1px solid {col}40;border-radius:999px;padding:3px 12px;font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">{interp_label(interp)}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:20px">
      <div style="background:#0f1519;border:1px solid #1e293b;border-radius:3px;padding:12px">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#475569;margin-bottom:6px">VCG Div (Panic-Adj)</div>
        <div style="font-size:24px;font-weight:700;color:#e2e8f0">{fmt_z(vcg_div)}</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:#475569;margin-top:4px">{"π = " + f"{sig.get('pi_panic', 0):.2f}" + " SUPPRESSED" if sig.get("pi_panic", 0) > 0 else "NO SUPPRESSION"}</div>
      </div>
      <div style="background:#0f1519;border:1px solid #1e293b;border-radius:3px;padding:12px">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#475569;margin-bottom:6px">Credit 5d Return</div>
        <div style="font-size:24px;font-weight:700;color:{'#05AD98' if sig.get('credit_5d_return_pct', 0) >= 0 else '#E85D6C'}">{fmt_pct(sig.get("credit_5d_return_pct"))}</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:#475569;margin-top:4px">{proxy} @ ${sig.get('credit_price', 0):.2f}</div>
      </div>
    </div>"""
    return card_wrap("VCG Signal", body, 1, 4, ds)


# ── Card 2: HDR Conditions ──────────────────────────────────────

def card2_hdr(data: dict, ds: str) -> str:
    sig = data.get("signal", {})
    hdr = sig.get("hdr", 0)
    ro = sig.get("ro", 0)
    conds = sig.get("hdr_conditions", {})

    status_col = "#E85D6C" if ro else ("#F5A623" if hdr else "#05AD98")
    status_label = "RISK-OFF" if ro else ("HDR ACTIVE" if hdr else "NORMAL")

    def cond_row(label: str, met: bool, val: str) -> str:
        icon = "✓" if met else "✗"
        icon_col = "#05AD98" if met else "#E85D6C"
        return f"""
        <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #1e293b">
          <div style="width:24px;height:24px;border-radius:50%;background:{'rgba(5,173,152,0.15)' if met else 'rgba(232,93,108,0.15)'};display:flex;align-items:center;justify-content:center;font-size:14px;color:{icon_col}">{icon}</div>
          <div style="flex:1">
            <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;color:#e2e8f0">{label}</div>
            <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#64748b;margin-top:2px">{val}</div>
          </div>
        </div>"""

    conds_met = sum([conds.get("vvix_gt_110", False), conds.get("credit_5d_gt_neg05pct", False), conds.get("vix_lt_40", False)])

    body = f"""
    <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:{status_col};margin-bottom:16px;display:flex;align-items:center;gap:8px">
      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:{status_col}"></span>
      HIGH DIVERGENCE RISK · {conds_met}/3 CONDITIONS
    </div>
    <div style="display:inline-block;background:{status_col}20;color:{status_col};border:1px solid {status_col}40;border-radius:999px;padding:4px 14px;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.06em;margin-bottom:16px">{status_label}</div>
    {cond_row("VVIX > 110", conds.get("vvix_gt_110", False), f"VVIX = {sig.get('vvix', 0):.2f}")}
    {cond_row("Credit 5d > -0.5%", conds.get("credit_5d_gt_neg05pct", False), f"5d Return = {fmt_pct(sig.get('credit_5d_return_pct'))}")}
    {cond_row("VIX < 40 (non-panic)", conds.get("vix_lt_40", False), f"VIX = {sig.get('vix', 0):.2f}")}
    <div style="background:#0f1519;border:1px solid #1e293b;border-left:2px solid {status_col};border-radius:0 3px 3px 0;padding:10px 12px;margin-top:16px">
      <div style="font-size:11px;color:#94a3b8;line-height:1.55">
        {"All 3 HDR conditions met AND VCG > +2.0 → <span style='color:#E85D6C;font-weight:700'>RISK-OFF signal active</span>." if ro else "HDR " + ("active" if hdr else "inactive") + " — " + ("VCG below +2.0 threshold." if hdr else "conditions not fully met.")}
      </div>
    </div>"""
    return card_wrap("HDR Conditions", body, 2, 4, ds)


# ── Card 3: Regime & Attribution ─────────────────────────────────

def card3_attribution(data: dict, ds: str) -> str:
    sig = data.get("signal", {})
    regime = sig.get("regime", "DIVERGENCE")
    attr = sig.get("attribution", {})
    vvix_pct = attr.get("vvix_pct", 0)
    vix_pct = attr.get("vix_pct", 0)
    rcol = regime_color(regime)

    body = f"""
    <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:{rcol};margin-bottom:16px;display:flex;align-items:center;gap:8px">
      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:{rcol}"></span>
      REGIME: {regime}
    </div>
    <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#475569;margin-bottom:12px">Divergence Attribution</div>
    <div style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;color:#8B5CF6">VVIX Component</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;color:#8B5CF6">{vvix_pct:.0f}%</span>
      </div>
      <div style="height:10px;background:#0f1519;border:1px solid #1e293b;border-radius:2px;overflow:hidden">
        <div style="height:100%;width:{max(vvix_pct, 0):.0f}%;background:#8B5CF6;border-radius:1px"></div>
      </div>
    </div>
    <div style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;color:#05AD98">VIX Component</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;color:#05AD98">{vix_pct:.0f}%</span>
      </div>
      <div style="height:10px;background:#0f1519;border:1px solid #1e293b;border-radius:2px;overflow:hidden">
        <div style="height:100%;width:{max(vix_pct, 0):.0f}%;background:#05AD98;border-radius:1px"></div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div style="background:#0f1519;border:1px solid #1e293b;border-radius:3px;padding:12px">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#475569;margin-bottom:6px">β₁ (VVIX)</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:16px;font-weight:700;color:#e2e8f0">{sig.get('beta1_vvix', 0):.6f if sig.get('beta1_vvix') is not None else '---'}</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:#475569;margin-top:4px">{"SIGN OK" if sig.get("sign_ok") else "⚠ SIGN REVERSED"}</div>
      </div>
      <div style="background:#0f1519;border:1px solid #1e293b;border-radius:3px;padding:12px">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#475569;margin-bottom:6px">β₂ (VIX)</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:16px;font-weight:700;color:#e2e8f0">{sig.get('beta2_vix', 0):.6f if sig.get('beta2_vix') is not None else '---'}</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:#475569;margin-top:4px">Panic π = {sig.get("pi_panic", 0):.2f}</div>
      </div>
    </div>"""
    return card_wrap("Regime & Attribution", body, 3, 4, ds)


# ── Card 4: 10-Day History ──────────────────────────────────────

def card4_history(data: dict, ds: str) -> str:
    history = data.get("history", [])[-10:]

    rows = ""
    for h in history:
        vcg = h.get("vcg")
        vcg_col = "#E85D6C" if (vcg or 0) > 2 else ("#F5A623" if (vcg or 0) < -2 else "#e2e8f0")
        rows += f"""
        <tr>
          <td style="padding:6px 8px;font-size:10px;color:#64748b">{h.get('date','')}</td>
          <td style="padding:6px 8px;font-size:11px;font-weight:600;color:{vcg_col};text-align:right">{fmt_z(vcg)}</td>
          <td style="padding:6px 8px;font-size:10px;color:#94a3b8;text-align:right">{fmt_z(h.get('vcg_div'))}</td>
          <td style="padding:6px 8px;font-size:10px;color:#64748b;text-align:right">{h.get('vix', 0):.2f}</td>
          <td style="padding:6px 8px;font-size:10px;color:#64748b;text-align:right">{h.get('vvix', 0):.2f}</td>
          <td style="padding:6px 8px;font-size:10px;color:#64748b;text-align:right">{h.get('credit', 0):.2f}</td>
        </tr>"""

    body = f"""
    <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:#475569;margin-bottom:16px">
      VCG 10-DAY ROLLING HISTORY · {data.get('credit_proxy', 'HYG')}
    </div>
    <table style="width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace">
      <thead>
        <tr style="border-bottom:1px solid #1e293b">
          <th style="padding:6px 8px;font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#334155;text-align:left">Date</th>
          <th style="padding:6px 8px;font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#334155;text-align:right">VCG</th>
          <th style="padding:6px 8px;font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#334155;text-align:right">Div</th>
          <th style="padding:6px 8px;font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#334155;text-align:right">VIX</th>
          <th style="padding:6px 8px;font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#334155;text-align:right">VVIX</th>
          <th style="padding:6px 8px;font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#334155;text-align:right">{data.get('credit_proxy', 'HYG')}</th>
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>"""
    return card_wrap("VCG History", body, 4, 4, ds)


# ── Tweet text ───────────────────────────────────────────────────

def build_tweet(data: dict, ds: str) -> str:
    sig = data.get("signal", {})
    vcg = sig.get("vcg")
    interp = sig.get("interpretation", "INSUFFICIENT_DATA")
    regime = sig.get("regime", "DIVERGENCE")
    hdr = sig.get("hdr", 0)
    ro = sig.get("ro", 0)
    proxy = data.get("credit_proxy", "HYG")

    vcg_str = fmt_z(vcg) if vcg is not None else "N/A"
    interp_str = interp_label(interp)

    return f"""Radon VCG Scan — {ds}

> Volatility-Credit Gap: {vcg_str} ({interp_str})
> Regime: {regime} · HDR: {"ACTIVE" if hdr else "INACTIVE"} · RO: {"⚠ TRIGGERED" if ro else "CLEAR"}

> VIX: {sig.get('vix', 0):.2f} · VVIX: {sig.get('vvix', 0):.2f}
> {proxy}: ${sig.get('credit_price', 0):.2f} ({fmt_pct(sig.get('credit_5d_return_pct'))} 5d)

> Attribution: VVIX {sig.get('attribution', {}).get('vvix_pct', 0):.0f}% / VIX {sig.get('attribution', {}).get('vix_pct', 0):.0f}%

{"⚠ RISK-OFF signal active — credit artificially calm relative to vol complex." if ro else "No risk-off signal. Vol-credit relationship within normal bounds." if interp == "NORMAL" else "Monitoring divergence."}

Analyzed by Radon
radon.run"""


# ── Screenshot ───────────────────────────────────────────────────

def screenshot_card(html_path: str, png_path: str) -> bool:
    try:
        r1 = subprocess.run(
            ["agent-browser", "open", f"file://{html_path}"],
            capture_output=True, text=True, timeout=15,
        )
        if r1.returncode != 0:
            return False
        r2 = subprocess.run(
            ["agent-browser", "screenshot", ".card", png_path],
            capture_output=True, text=True, timeout=15,
        )
        return r2.returncode == 0 and Path(png_path).exists()
    except Exception:
        return False


# ── Preview HTML ─────────────────────────────────────────────────

def build_preview(cards_b64: list, tweet_text: str, ds: str) -> str:
    labels = [
        ("VCG Signal", "vcg-card-1-signal.png"),
        ("HDR Conditions", "vcg-card-2-hdr.png"),
        ("Regime & Attribution", "vcg-card-3-attribution.png"),
        ("VCG History", "vcg-card-4-history.png"),
    ]
    imgs_html = ""
    for i, (b64, (title, fname)) in enumerate(zip(cards_b64, labels), 1):
        imgs_html += f"""
    <div style="margin-bottom:20px">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#334155;margin-bottom:8px;display:flex;justify-content:space-between">
        <span>Card {i}/4 —</span><span style="color:#05AD98">{title}</span>
      </div>
      <img style="width:100%;border:1px solid #1e293b;border-radius:3px;display:block" src="{b64}" alt="{title}" id="img{i}">
      <div style="display:flex;gap:8px;margin-top:8px">
        <button onclick="copyImg('img{i}',this)" style="flex:1;padding:7px;background:#0f1519;border:1px solid #1e293b;border-radius:3px;font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;color:#94a3b8;text-align:center">Copy Image</button>
        <a href="{b64}" download="{fname}" style="flex:1;padding:7px;background:#0f1519;border:1px solid #1e293b;border-radius:3px;font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;color:#94a3b8;text-decoration:none;text-align:center;display:block;line-height:1.4">Download PNG ↓</a>
      </div>
    </div>"""

    tweet_escaped = tweet_text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VCG Report — X Share · {ds}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:#07090d;color:#e2e8f0;font-family:'Inter',sans-serif;min-height:100vh;padding:32px 24px}}
.layout{{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:380px 1fr;gap:32px;align-items:start}}
.intro{{font-family:'IBM Plex Mono',monospace;font-size:11px;color:#475569;padding:0 0 20px;line-height:1.6;grid-column:1/-1;border-bottom:1px solid #1e293b;margin-bottom:8px}}
.intro strong{{color:#e2e8f0}}
.panel{{background:#0f1519;border:1px solid #1e293b;border-radius:4px;padding:20px;position:sticky;top:24px}}
.panel-hdr{{font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#475569;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #1e293b}}
.tweet-body{{font-size:13px;line-height:1.65;color:#e2e8f0;white-space:pre-wrap;margin-bottom:14px;word-break:break-word}}
.copy-btn{{width:100%;padding:10px;background:#05AD98;color:#000;border:none;border-radius:3px;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:opacity 150ms}}
.copy-btn:hover{{opacity:.85}}.copy-btn.copied{{background:#1e293b;color:#05AD98}}
.char{{font-family:'IBM Plex Mono',monospace;font-size:10px;color:#475569;margin-top:8px;text-align:right}}
.cards-hdr{{font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#475569;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #1e293b}}
</style>
</head><body>
<div class="layout">
  <div class="intro"><strong>VCG Report — X Share</strong><br>Tweet text + 4 infographic cards · {ds} · Analyzed by Radon</div>
  <div class="panel">
    <div class="panel-hdr">Tweet Copy</div>
    <div class="tweet-body" id="tweet-text">{tweet_escaped}</div>
    <button class="copy-btn" id="copy-btn" onclick="copyTweet()">Copy Tweet Text</button>
    <div class="char">{len(tweet_text)} chars</div>
  </div>
  <div>
    <div class="cards-hdr">4 Infographic Cards — attach to tweet</div>
    {imgs_html}
  </div>
</div>
<script>
function copyTweet(){{
  const t=document.getElementById('tweet-text').innerText;
  navigator.clipboard.writeText(t).then(()=>{{
    const b=document.getElementById('copy-btn');
    b.textContent='Copied!';b.classList.add('copied');
    setTimeout(()=>{{b.textContent='Copy Tweet Text';b.classList.remove('copied')}},2000);
  }});
}}
function copyImg(id,btn){{
  const img=document.getElementById(id);
  const c=document.createElement('canvas');
  c.width=img.naturalWidth;c.height=img.naturalHeight;
  c.getContext('2d').drawImage(img,0,0);
  c.toBlob(b=>{{
    navigator.clipboard.write([new ClipboardItem({{'image/png':b}})]).then(()=>{{
      const orig=btn.textContent;btn.textContent='Copied!';
      setTimeout(()=>{{btn.textContent=orig}},2000);
    }});
  }});
}}
</script>
</body></html>"""


# ── Main ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Generate VCG X share report")
    parser.add_argument("--json", action="store_true", help="Print output as JSON")
    parser.add_argument("--no-open", action="store_true", help="Don't open browser")
    args = parser.parse_args()

    data = load_vcg()
    ds = date.today().strftime("%Y-%m-%d")

    generators = [card1_signal, card2_hdr, card3_attribution, card4_history]
    card_html_paths = []
    png_paths = []

    for i, gen in enumerate(generators, 1):
        html_content = gen(data, ds)
        html_path = str(REPORTS_DIR / f"tweet-vcg-{ds}-card-{i}.html")
        with open(html_path, "w") as f:
            f.write(html_content)
        card_html_paths.append(html_path)

        png_path = str(REPORTS_DIR / f"tweet-vcg-{ds}-card-{i}.png")
        ok = screenshot_card(html_path, png_path)
        if not ok:
            print(f"Warning: Screenshot failed for card {i}", file=sys.stderr)
        png_paths.append(png_path if ok else "")

    cards_b64 = []
    for p in png_paths:
        if p and Path(p).exists():
            with open(p, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("ascii")
            cards_b64.append(f"data:image/png;base64,{b64}")
        else:
            cards_b64.append("")

    tweet_text = build_tweet(data, ds)
    preview_html = build_preview(cards_b64, tweet_text, ds)
    preview_path = str(REPORTS_DIR / f"tweet-vcg-{ds}.html")
    with open(preview_path, "w") as f:
        f.write(preview_html)

    if not args.no_open:
        subprocess.Popen(["open", preview_path])

    result = {
        "preview_path": preview_path,
        "card_paths": card_html_paths,
        "png_paths": [p for p in png_paths if p],
        "date": ds,
        "tweet_length": len(tweet_text),
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"VCG share report generated: {preview_path}")
        print(f"   Cards: {len(card_html_paths)} HTML, {len([p for p in png_paths if p])} PNG")
        print(f"   Tweet: {len(tweet_text)} chars")

    return result


if __name__ == "__main__":
    main()
