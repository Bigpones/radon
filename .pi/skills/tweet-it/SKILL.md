---
name: tweet-it
description: Generate tweet copy and a matching infographic image for sharing trades on X (Twitter). Use when the user says "tweet-it", "tweet this trade", "create a tweet", "X post", or wants to share a trade on social media. Produces tweet text (ready to copy), an infographic HTML file for screenshotting, and a preview page with a copy button.
---

# Tweet-It Skill

Generate shareable tweet copy + infographic for trade posts on X.

## When to Use

- After executing a trade — `tweet-it` generates the post
- When user says "tweet this", "share this trade", "X post", "create a tweet"
- After any trade fills — as part of the post-trade workflow

## What It Produces

1. **Tweet text** — formatted copy matching the user's X voice (see Template below)
2. **Infographic HTML** — a dark-themed card designed for screenshotting at 2x resolution
3. **Preview page** — HTML page showing both the tweet text (with copy button) and the infographic side-by-side

## Output Files

```
reports/tweet-{TICKER}-{DATE}.html          # Preview page with copy button
reports/tweet-{TICKER}-{DATE}-card.html     # Standalone infographic card (screenshot this)
```

## Tweet Text Template

The tweet voice is **direct, data-driven, educational**. Structure:

```
📉 [Hook question or statement]

[Anti-thesis — what NOT to do and why]

Best vehicle: $TICKER [structure].

> [bullet point 1 — key metric]
> [bullet point 2 — key metric]
> [bullet point 3 — key metric]
> [bullet point 4 — R:R]

[Exact position: qty × structure @ price.]

[Risk $X to make $Y.]

Analyzed by Radon

radon.run
```

### Rules
- Cashtags for tickers: `$OXY`, `$USO`, `$SCO`
- Use `>` prefix for bullet-style lines (renders as quote-style on X)
- Include "Analyzed by Radon" and "radon.run" at the bottom
- Keep under 280 chars if single tweet, or format as thread-ready blocks
- Numbers are precise — no rounding beyond what's meaningful
- No emojis except one relevant one at the start (📉 📈 🛢️ etc.)
- No hype words ("amazing", "incredible", "moon")
- Tone: calm, scientific, educational

## Infographic Card Design

The card is a standalone HTML file optimized for screenshotting:

- **Dimensions**: 600px wide × auto height (typically 700-900px)
- **Background**: `#0a0f14` (Radon bg-base)
- **Font**: Inter (headings) + IBM Plex Mono (numbers)
- **Border**: 1px `#1e293b` with 4px radius
- **Padding**: 32px internal
- **No scrolling** — everything visible in one screen

### Card Sections (top to bottom)
1. **Direction badge** — BEARISH/BULLISH in accent color
2. **Ticker + Company** — large ticker, small company name
3. **Structure line** — e.g. "P$55 / P$50 BEAR PUT SPREAD"
4. **Metrics strip** — Entry | Risk | Reward | R:R (4 columns)
5. **Payoff diagram** — SVG showing max gain/loss/breakeven zones
6. **Thesis** — 1-2 sentence thesis in a bordered box
7. **Vehicle comparison** — mini table showing why this vehicle won
8. **Footer** — "radon.run" + date

### Key Visual Rules
- Negative/bearish = `#E85D6C`
- Positive/bullish = `#05AD98`
- Warning/breakeven = `#F5A623`
- Muted text = `#475569`
- All numbers in IBM Plex Mono
- No gradients, no shadows, no rounded corners > 4px

## How to Generate

```bash
# 1. Agent generates tweet text from trade data
# 2. Agent generates card HTML from trade data
# 3. Agent generates preview HTML with copy button
# 4. Open preview in browser
open reports/tweet-{TICKER}-{DATE}.html
```

## Template Files

- `template-card.html` — Infographic card template (screenshot target)
- `template-preview.html` — Preview page with copy button + card embed

## Placeholders

### Card Template
| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{{DIRECTION}}` | BEARISH or BULLISH | BEARISH |
| `{{DIRECTION_EMOJI}}` | Chart emoji | 📉 |
| `{{DIRECTION_COLOR}}` | CSS color | #E85D6C |
| `{{TICKER}}` | Ticker symbol | OXY |
| `{{COMPANY}}` | Company name | Occidental Petroleum |
| `{{STRUCTURE_LINE}}` | Full structure | P$55 / P$50 BEAR PUT SPREAD |
| `{{EXPIRY_DESC}}` | Expiry description | Apr 17 · 222 Contracts · $0.98 |
| `{{ENTRY}}` | Entry price | $0.98 |
| `{{RISK_DOLLARS}}` | Max loss | $21.8K |
| `{{REWARD_DOLLARS}}` | Max gain | $89.2K |
| `{{RR_RATIO}}` | Risk:reward | 4.1 : 1 |
| `{{BREAKEVEN}}` | Breakeven price | $54.02 |
| `{{DTE}}` | Days to expiry | 35 |
| `{{THESIS_TEXT}}` | 1-2 sentence thesis | Oil at 52-week highs... |
| `{{VEHICLE_ROWS}}` | HTML rows for vehicle comparison | <tr>...</tr> |
| `{{PAYOFF_SVG}}` | SVG payoff diagram | <svg>...</svg> |
| `{{DATE}}` | Trade date | 2026-03-12 |

### Preview Template
| Placeholder | Description |
|-------------|-------------|
| `{{TWEET_TEXT}}` | The formatted tweet copy |
| `{{CARD_HTML}}` | The full card HTML (embedded) |
| `{{TICKER}}` | Ticker for title |
| `{{DATE}}` | Date for title |
