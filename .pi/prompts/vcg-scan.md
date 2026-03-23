Run the Cross-Asset Volatility-Credit Gap v2 (VCG-R) scan:

**Full strategy spec:** `docs/strategies.md` (Strategy 5)
**Math spec:** `docs/cross_asset_volatility_credit_gap_spec_(VCG).md`

**STEP 1: RUN THE VCG-R SCANNER**
```bash
python3.13 scripts/vcg_scan.py --json
```
This fetches 1Y daily bars for VIX, VVIX, and HYG (IB primary, Yahoo fallback), runs the rolling 21-day OLS regression, computes the VCG z-score, and evaluates the VCG-R v2 binary signals (RO, EDR, BOUNCE).

**STEP 2: PARSE THE SIGNAL**
From the JSON output, extract and present:

| Field | What to check |
|-------|---------------|
| `signal.vcg` | VCG z-score. > +2.5 with VIX>28 = RO trigger. +2.0–2.5 with VIX>25 = EDR. < -3.5 = BOUNCE. ±2.0 = normal. |
| `signal.vcg_adj` | Panic-adjusted VCG. Same as VCG when VIX < 40. Suppressed toward 0 as VIX → 48. Replaces `vcg_div`. |
| `signal.regime` | DIVERGENCE (VIX<25), WATCH (25-28), ACTIVE (28-40), TRANSITION (40-48), PANIC (≥48) |
| `signal.ro` | Risk-Off trigger (VIX>28 AND VCG>2.5 AND sign_ok) |
| `signal.edr` | Early Divergence Risk (VIX>25 AND VCG 2.0–2.5 AND sign_ok) |
| `signal.bounce` | Counter-signal (VCG < -3.5 AND sign_ok) |
| `signal.tier` | 1=Severe (VIX>30, VVIX>120), 2=High (VIX>28), 3=Elevated/EDR, null=no signal |
| `signal.vvix_severity` | EXTREME/VERY_HIGH/HIGH/ELEVATED/NORMAL (amplifier, not a gate) |
| `signal.sign_suppressed` | If true, beta signs wrong — signal suppressed regardless of VCG |

**STEP 3: EVALUATE SIGNAL STATE**
VCG-R v2 uses TWO conditions (not three like v1):
- `signal.vix > 28` — VIX is in stress zone (INVERTED from v1's VIX < 40)
- `signal.vcg > 2.5` — Statistical divergence confirmed (raised from v1's 2.0)

Note what is NO LONGER a gate: VVIX > 110 (now severity amplifier), credit 5d return > -0.5% (removed), HDR state flag (removed).

If RO = 0 but VIX is between 25–28 and VCG > 2.0, state the EDR (Early Divergence Risk) conditions and why we are in the watch zone but not yet at full trigger.

**STEP 4: DETERMINE SEVERITY TIER**
When RO = 1, determine the tier:
- Tier 1 (Severe): VIX > 30 AND VVIX > 120 → maximum hedging protocol
- Tier 2 (High): VIX > 28 (default RO tier) → standard hedging protocol
- Tier 3 / EDR: VIX > 25 + VCG 2.0–2.5 → half-Kelly watch position

VVIX severity label:
- EXTREME (>140), VERY_HIGH (120-140), HIGH (100-120), ELEVATED (90-100), NORMAL (<90)

**STEP 5: ASSESS MODEL QUALITY**
- `signal.beta1_vvix` — Expected negative. If positive, model unreliable (21-day noise).
- `signal.beta2_vix` — Expected negative. If positive, same issue.
- `signal.attribution.vvix_pct` vs `signal.attribution.vix_pct` — Is the gap driven by convexity demand (VVIX) or broad vol (VIX)?

**STEP 6: CHECK BOUNCE SIGNAL**
If VCG < -3.5 (BOUNCE = 1):
- Credit has substantially overshot the vol model
- Close existing HYG put positions (protect profits from prior RO trade)
- Consider small tactical long credit: HYG calls (2–3 week expiry), size = 25% of what RO position would have been
- Exit bounce when VCG normalizes above -2.0

**STEP 7: GENERATE HTML REPORT**
The script auto-generates `reports/vcg-scan-{YYYY-MM-DD}.html`. If it didn't open automatically:
```bash
python3.13 scripts/vcg_scan.py
```
(Without `--json`, it generates and opens the HTML report.)

**STEP 8: DECISION**

| Signal State | Tier | Action |
|-------------|------|--------|
| `RO = 1` | Tier 1 (VIX>30, VVIX>120) | RISK-OFF SEVERE: Reduce credit beta, preserve ALL hedges, add ATM HYG puts (2–3 wk), full Kelly ≤2.5% |
| `RO = 1` | Tier 2 (VIX>28) | RISK-OFF HIGH: Reduce credit beta, preserve hedges, add OTM HYG puts (1–2 wk), full Kelly ≤2.5% |
| `EDR = 1` | Tier 3 (VIX>25) | EARLY DIVERGENCE: Monitor, half-Kelly position (≤1.25%), promote to full on tier increase |
| `BOUNCE = 1` | — | COUNTER-SIGNAL: Close HYG puts if held, optional tactical long credit (25% RO size) |
| No RO/EDR/BOUNCE | — | NORMAL: No signal. At least one gate fails. |
| `sign_suppressed = true` | — | UNRELIABLE: Wrong beta signs. Do not trade on VCG-R today. |

**STEP 9: PORTFOLIO OVERLAY (if RO = 1)**
- Review current positions for credit-sensitive exposure
- Preserve existing equity downside hedges — do NOT monetize early
- Tier 1: ATM HYG puts (2–3 week expiry) + preserve all existing hedges
- Tier 2: OTM HYG puts (5% OTM, 1–2 week) + preserve existing hedges
- Size: ≤2.5% bankroll cap, fractional Kelly on gap-closure probability
- Exit when: VCG adj normalizes < 1.0, credit sells off (5d < -1.5%), VIX > 48, or BOUNCE fires

Present the scan results as:

```
VCG-R SCAN — {DATE}
═══════════════════════════════════════════
VCG:       {vcg} ({interpretation})
VCG adj:   {vcg_adj}
Regime:    {regime} (VIX={vix}, Π={pi_panic})

VCG-R SIGNAL GATES:
  VIX > 28:      {vix} → {PASS/FAIL} (RO gate — inverted from v1)
  VCG > 2.5:     {vcg} → {PASS/FAIL}
  EDR (VCG>2.0): {vcg} → {PASS/FAIL} (with VIX>25)
  Sign OK:       β₁={beta1}, β₂={beta2} → {OK/SUPPRESSED}

SEVERITY:
  VVIX: {vvix} ({vvix_severity})
  Tier: {tier} ({tier_label})

MODEL:
  β₁ (VVIX): {beta1}  β₂ (VIX): {beta2}
  Residual: {residual}
  Attribution: VVIX {vvix_pct}% / VIX {vix_pct}%

SIGNAL: {RISK_OFF Tier N / EDR / WATCH / BOUNCE / NORMAL}
═══════════════════════════════════════════
```
