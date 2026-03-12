---
name: tweet-it
description: Generate tweet copy and a matching infographic image for sharing trades on X (Twitter). Use when the user says "tweet-it", "tweet this trade", "create a tweet", "X post", or wants to share a trade on social media. Produces tweet text (ready to copy), an infographic card image, and a self-contained preview page with copy buttons for both text and image.
---

# Tweet-It Skill

Generate shareable tweet copy + infographic for trade posts on X.

## When to Use

- After executing a trade — `tweet-it` generates the post
- When user says "tweet this", "share this trade", "X post", "create a tweet"
- After any trade fills — as part of the post-trade workflow

## What It Produces

1. **Tweet text** — formatted copy matching the user's X voice (see Template below)
2. **Infographic card HTML** — dark-themed card rendered at 600px, used to generate the PNG
3. **Card PNG** — browser-screenshotted from the card HTML (pixel-perfect, no AI generation)
4. **Self-contained preview page** — the card PNG base64-embedded inline, with COPY TEXT and COPY IMAGE buttons

## Output Files

```
reports/tweet-{TICKER}-{DATE}.html          # Self-contained preview (PNG inlined as base64)
reports/tweet-{TICKER}-{DATE}-card.html     # Source card HTML (kept for re-screenshotting)
reports/tweet-{TICKER}-{DATE}-card.png      # Screenshot artifact (inlined into preview)
```

## Generation Workflow (6 Steps — MANDATORY)

Every `tweet-it` invocation MUST follow these steps in order:

```
Step 1: Generate tweet text from trade data
Step 2: Generate card HTML → reports/tweet-{TICKER}-{DATE}-card.html
Step 3: Screenshot card via browser automation → reports/tweet-{TICKER}-{DATE}-card.png
Step 4: Base64-encode PNG into a data URI (CRITICAL — see below)
Step 5: Generate preview HTML with data URI embedded → reports/tweet-{TICKER}-{DATE}.html
Step 6: Open preview in browser
```

### Step 3 — Screenshot

```bash
agent-browser open file:///path/to/reports/tweet-{TICKER}-{DATE}-card.html
agent-browser screenshot .card /path/to/reports/tweet-{TICKER}-{DATE}-card.png
```

### Step 4 — Base64 Embed (CRITICAL)

**⚠️ Chrome blocks `file://` → `file://` cross-origin requests (CORS).** Relative paths, absolute paths, and `file:///` URIs all fail when loading images in local HTML files. The ONLY reliable method is to base64-encode the PNG directly into the HTML as a data URI.

```python
import base64

with open('reports/tweet-{TICKER}-{DATE}-card.png', 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('ascii')
data_uri = f"data:image/png;base64,{b64}"
```

Then inject `data_uri` into the preview HTML for:
- `<img src="{{CARD_DATA_URI}}">`  — displays the card image inline
- `<a href="{{CARD_DATA_URI}}" download="...">` — enables Download PNG button

Typical card PNG is ~100KB base64 — well within HTML size limits.

### Step 5 — Preview Generation

Write the preview HTML with the data URI already substituted. The template uses `{{CARD_DATA_URI}}` as a placeholder — replace it with the actual `data:image/png;base64,...` string before writing the file.

**Do NOT write the template placeholder to disk.** The final HTML file must contain the actual base64 data.

### Step 6 — Open

```bash
open reports/tweet-{TICKER}-{DATE}.html
```

The user sees:
- **Left**: Tweet text with COPY TEXT button (clipboard API)
- **Right**: Card PNG (right-clickable) with COPY IMAGE button (Canvas → ClipboardItem API) and Download PNG button

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
7. **Vehicle comparison** — mini table showing why this vehicle won (if applicable)
8. **Footer** — "radon.run" (left) · "Analyzed by Radon" (center, teal) · date (right)

### Key Visual Rules
- Negative/bearish = `#E85D6C`
- Positive/bullish = `#05AD98`
- Warning/breakeven = `#F5A623`
- Muted text = `#475569`
- All numbers in IBM Plex Mono
- No gradients, no shadows, no rounded corners > 4px
- Footer always shows "Analyzed by Radon" centered in teal

## Template Files

- `template-card.html` — Infographic card template (screenshot target)
- `template-preview.html` — Preview page with copy buttons + base64 image embed

## Placeholders

### Card Template (`template-card.html`)
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
| `{{VEHICLE_ROWS}}` | HTML rows for vehicle comparison | `<div class="v-row">...</div>` |
| `{{PAYOFF_SVG}}` | SVG payoff diagram | `<svg>...</svg>` |
| `{{DATE}}` | Trade date | 2026-03-12 |

### Preview Template (`template-preview.html`)
| Placeholder | Description |
|-------------|-------------|
| `{{TWEET_TEXT_HTML}}` | Formatted tweet copy (HTML spans for cashtags/bold) |
| `{{TWEET_TEXT_RAW}}` | Raw tweet copy (plain text for clipboard — escaped for JS template literal) |
| `{{CARD_DATA_URI}}` | **Base64 data URI** (`data:image/png;base64,...`) — NOT a file path |
| `{{CARD_FILE}}` | Relative path to card HTML (for "Open Card HTML" link) |
| `{{TICKER}}` | Ticker for title |
| `{{DATE}}` | Date for title |

### ⚠️ `{{CARD_DATA_URI}}` — NOT a File Path

This placeholder must be replaced with the actual base64-encoded PNG data URI before writing the file. It appears in two places:
1. `<img id="card-img" src="{{CARD_DATA_URI}}">`
2. `<a href="{{CARD_DATA_URI}}" download="...">`

**Never write a file path here.** Chrome CORS policy blocks all `file://` image loads in local HTML.
