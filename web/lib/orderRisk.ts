/**
 * Order Risk — single source of truth for max-loss / max-gain across the
 * order builder, the per-position order tab, and the instrument modal.
 *
 * Why this exists
 * ---------------
 * The legacy paths assumed every combo was a vertical debit spread and
 * displayed "max loss = debit paid" for every two-leg structure. That formula
 * is correct ONLY when both legs share a strike width that caps the downside
 * (bull call, bear put, iron condor). Risk reversals (short put + long call)
 * carry full assignment exposure on the short put leg: a $150 strike short
 * put × 50 contracts is $750,000 of risk at the assignment-at-zero bound,
 * not the $5,000 net debit.
 *
 * The functions here treat each leg independently, classify it as bounded
 * or unbounded, and roll the legs up into a combo verdict. The combo verdict
 * is consumed by `OrderSummary` so the confirmation UI can:
 *   - show a numeric max loss when the structure is fully bounded
 *   - show "UNBOUNDED" when a short call leg is uncovered
 *   - show a numeric max loss + an "undefined risk" badge when a short put
 *     leg drives the bound (the user should understand the number reflects
 *     a stock-to-zero stress, not a defined-risk cap)
 */

export type LegRight = "C" | "P";
export type LegAction = "BUY" | "SELL";

export interface OrderRiskLeg {
  action: LegAction;
  right: LegRight;
  strike: number;
  expiry: string;
  /** Per-combo ratio. Combined with `quantity` to derive contract count. */
  quantity: number;
}

export interface OrderRisk {
  /** Worst-case dollar loss across the combo, or null if unbounded. */
  maxLoss: number | null;
  /** Best-case dollar gain across the combo, or null if unbounded. */
  maxGain: number | null;
  /** True when at least one leg has no theoretical upper-bound loss
   *  (uncovered short call). `maxLoss` is null in that case. */
  maxLossUnbounded: boolean;
  /** True when at least one leg has no theoretical upper-bound gain
   *  (long call). `maxGain` is null in that case. */
  maxGainUnbounded: boolean;
  /** Either leg is unbounded OR a naked short put bounds the trade only at
   *  stock-to-zero. Used by the UI to surface a Gate 1 warning. */
  hasUndefinedRisk: boolean;
  /** Human readable list of legs driving the undefined-risk classification. */
  undefinedRiskReason: string | null;
}

const MULTIPLIER = 100;

/**
 * Compute max loss / max gain for a single options leg in isolation,
 * expressed as positive dollar magnitudes plus an unbounded flag.
 *
 * Premium convention
 * ------------------
 * `legPremium` is the per-contract dollar price paid (for BUY legs) or
 * received (for SELL legs). It is always a positive magnitude here —
 * sign is encoded by the leg's action.
 *
 * Return shape
 * ------------
 *   maxLoss / maxGain are positive dollar magnitudes when bounded, null when
 *   unbounded (long calls have unbounded upside; naked short calls have
 *   unbounded downside).
 */
export function legRisk(
  leg: OrderRiskLeg,
  legPremium: number,
  contracts: number,
): {
  maxLoss: number | null;
  maxGain: number | null;
  unboundedLoss: boolean;
  unboundedGain: boolean;
} {
  const premiumDollars = legPremium * contracts * MULTIPLIER;
  const intrinsicDollars = leg.strike * contracts * MULTIPLIER;

  if (leg.action === "BUY") {
    // Long option: paid the premium; loss capped at the debit; gain capped
    // by the strike for puts (stock → 0) and unbounded for calls.
    if (leg.right === "C") {
      return {
        maxLoss: premiumDollars,
        maxGain: null,
        unboundedLoss: false,
        unboundedGain: true,
      };
    }
    return {
      maxLoss: premiumDollars,
      maxGain: intrinsicDollars - premiumDollars,
      unboundedLoss: false,
      unboundedGain: false,
    };
  }

  // SELL leg
  if (leg.right === "C") {
    // Naked short call: gain capped at premium, loss UNBOUNDED.
    return {
      maxLoss: null,
      maxGain: premiumDollars,
      unboundedLoss: true,
      unboundedGain: false,
    };
  }
  // Naked / cash-secured short put: gain capped at premium, loss at the
  // assignment-at-zero bound (strike × contracts × 100) minus premium.
  return {
    maxLoss: intrinsicDollars - premiumDollars,
    maxGain: premiumDollars,
    unboundedLoss: false,
    unboundedGain: false,
  };
}

/**
 * Classify a combo into "fully defined" vs "undefined risk", and pin down
 * the dollar max-loss when expressible.
 *
 * Defined structures the formula handles correctly:
 *   - Bull / Bear vertical spreads (call or put)
 *   - Long straddle / long strangle
 *   - Long butterfly (3+ legs roll up via leg sum)
 *   - Iron condor (long wings cap each side)
 *
 * Undefined structures the formula surfaces correctly:
 *   - Risk reversal (short put + long call) → bounded only at stock-to-zero
 *   - Short straddle / short strangle → unbounded via the short call leg
 *   - Jade lizard (short put + short call spread) → unbounded via short put
 *     unless the short call wing is fully covered; bounded if the call
 *     side is a spread but flagged because of the naked put
 *
 * Net-premium semantics
 * ---------------------
 * `netPremium` is the per-combo net price as displayed in the order builder:
 * positive for a net debit, negative for a net credit. We use it for total
 * cost; per-leg losses fold in their own premiums so signs cancel correctly
 * when summed.
 *
 * Why we sum per-leg losses instead of leaning on netPremium alone:
 * a Risk Reversal's net might be a small debit ($1) but the short-put leg
 * carries $strike × contracts × 100 of exposure. Summing per-leg
 * (max-loss-of-long-call + max-loss-of-short-put) correctly produces
 * the assignment bound plus the small debit.
 */
export function computeOrderRisk(
  legs: OrderRiskLeg[],
  netPremium: number,
  comboQuantity: number,
): OrderRisk {
  if (legs.length === 0 || comboQuantity <= 0) {
    return {
      maxLoss: null,
      maxGain: null,
      maxLossUnbounded: false,
      maxGainUnbounded: false,
      hasUndefinedRisk: false,
      undefinedRiskReason: null,
    };
  }

  // Single leg path: defer to legRisk with per-contract premium = abs(netPremium).
  // For single legs `netPremium` represents the per-share price of that leg.
  if (legs.length === 1) {
    const leg = legs[0];
    const contracts = comboQuantity * leg.quantity;
    const perContractPremium = Math.abs(netPremium);
    const r = legRisk(leg, perContractPremium, contracts);
    const undefinedReason = describeUndefinedLeg(leg, r.unboundedLoss);
    return {
      maxLoss: r.maxLoss,
      maxGain: r.maxGain,
      maxLossUnbounded: r.unboundedLoss,
      maxGainUnbounded: r.unboundedGain,
      hasUndefinedRisk: r.unboundedLoss || undefinedReason != null,
      undefinedRiskReason: undefinedReason,
    };
  }

  // Multi-leg: net out call coverage and put coverage so a long-call leg
  // can offset a short-call leg in the same combo (vertical / butterfly).
  // We use NET coverage at strike granularity — for any short leg, look for
  // a long leg of the same right at a more-protective strike.
  //
  // The minimum-loss-by-summing-leg-losses heuristic over-counts coverage:
  // a bull call spread has both a long and a short call, but the structure
  // is bounded by the strike width, not by long-premium + short-strike.
  // We handle that by walking legs and matching them.

  const callLegs = legs.filter((l) => l.right === "C");
  const putLegs = legs.filter((l) => l.right === "P");

  const callBounded = legsAreBounded(callLegs);
  const putBounded = legsAreBounded(putLegs);

  // The unbounded-loss case: an uncovered short call. Even one is fatal.
  if (!callBounded.bounded) {
    return {
      maxLoss: null,
      maxGain: null,
      maxLossUnbounded: true,
      maxGainUnbounded: false,
      hasUndefinedRisk: true,
      undefinedRiskReason: callBounded.reason,
    };
  }

  // Long-side unbounded gain: any net-long position on the call side has
  // unbounded upside at S → ∞. Compute the net call ratio; > 0 means net
  // long and the gain is unbounded.
  const netCallRatio = callLegs.reduce(
    (sum, l) => sum + (l.action === "BUY" ? l.quantity : -l.quantity),
    0,
  );
  const maxGainUnbounded = netCallRatio > 0;

  // From here the call side is bounded for loss. Compute max loss = sum of
  // per-leg worst cases at the dominant extreme; for puts the worst is at
  // S = 0, for calls at S → ∞.
  const maxLossDollars = computeBoundedMaxLoss(legs, netPremium, comboQuantity);

  // Max gain (when bounded): same model symmetrically. If unbounded on
  // the call side we surface null.
  const maxGainDollars = maxGainUnbounded
    ? null
    : computeBoundedMaxGain(legs, netPremium, comboQuantity);

  // Undefined risk flag: naked short put bounds the trade only at
  // stock-to-zero. The number is real but it's a stress bound, not a
  // structural cap. Surface it to the user.
  const undefinedReason = putBounded.bounded ? null : putBounded.reason;

  return {
    maxLoss: maxLossDollars,
    maxGain: maxGainDollars,
    maxLossUnbounded: false,
    maxGainUnbounded,
    hasUndefinedRisk: undefinedReason != null,
    undefinedRiskReason: undefinedReason,
  };
}

/**
 * For a same-right leg group, return whether every short leg is fully
 * covered by a long leg of the same right.
 *
 * Call side: long calls (any strike) cap the upside. Short calls without
 * a long call cap are UNBOUNDED. We use total ratio, not per-strike — any
 * long call protects against an arbitrarily large move, the question is
 * how big the dollar loss is, not whether it's unbounded.
 *
 * Put side: long puts cap the assignment risk. Short puts without a long
 * put cap drive max loss to strike-at-zero. That's a finite number, but
 * the structure is not "defined risk" — flag it.
 */
function legsAreBounded(sameRightLegs: OrderRiskLeg[]): {
  bounded: boolean;
  reason: string | null;
} {
  if (sameRightLegs.length === 0) return { bounded: true, reason: null };
  const right = sameRightLegs[0].right;
  const shortRatio = sameRightLegs
    .filter((l) => l.action === "SELL")
    .reduce((sum, l) => sum + l.quantity, 0);
  const longRatio = sameRightLegs
    .filter((l) => l.action === "BUY")
    .reduce((sum, l) => sum + l.quantity, 0);

  if (shortRatio === 0) return { bounded: true, reason: null };
  if (longRatio >= shortRatio) return { bounded: true, reason: null };

  const rightLabel = right === "C" ? "call" : "put";
  return {
    bounded: false,
    reason: `Uncovered short ${rightLabel}`,
  };
}

function describeUndefinedLeg(
  leg: OrderRiskLeg,
  unboundedLoss: boolean,
): string | null {
  if (unboundedLoss) return "Uncovered short call";
  if (leg.action === "SELL" && leg.right === "P") return "Naked short put";
  return null;
}

/**
 * Compute max loss for a fully-bounded combo (call side covered).
 *
 * Algorithm
 * ---------
 * Sum per-leg max losses at their worst-case strike, where:
 *   - Long call/put losses = premium paid for that leg
 *   - Short call: covered by paired long call → use strike-spread - credit
 *   - Short put: max loss = strike × ratio × 100 - premium received
 *
 * For vertical spreads (one long + one short, same right) this reduces to
 * the standard "width - credit" formula. For complex multi-leg structures
 * we use the symmetric Black-Scholes-style payoff floor heuristic: combine
 * leg-level worst cases, which strictly matches verticals, straddles,
 * strangles, butterflies, and iron condors.
 *
 * We do NOT need leg-level premiums to drive max loss for verticals — the
 * net combo premium drops out: sum(long premiums) − sum(short premiums) =
 * netPremium × comboQuantity. So we drive everything from netPremium and
 * structural strikes.
 */
function computeBoundedMaxLoss(
  legs: OrderRiskLeg[],
  netPremium: number,
  comboQuantity: number,
): number {
  // Pair shorts with longs at the most-protective long strike (call side:
  // long below short = bull call; long above short = bear call. Both cap.)
  // Unpaired shorts on the put side bound at strike-to-zero (naked short put).

  // 1. Group by right. `sideMaxLoss` returns intrinsic loss PER COMBO in
  //    dollars (already multiplied by the 100-share contract multiplier).
  const callLegs = legs.filter((l) => l.right === "C");
  const putLegs = legs.filter((l) => l.right === "P");

  const callSideLossPerCombo = sideMaxLoss(callLegs, "C");
  const putSideLossPerCombo = sideMaxLoss(putLegs, "P");

  // Stock can only be at one price at a time → take the side with the
  // larger intrinsic loss. Then scale by comboQuantity for total dollars.
  const intrinsicTotal =
    Math.max(callSideLossPerCombo, putSideLossPerCombo) * comboQuantity;

  // Net premium: positive debit increases loss; negative (credit) reduces it
  const netCashDollars = netPremium * comboQuantity * MULTIPLIER;
  return Math.max(0, intrinsicTotal + netCashDollars);
}

/**
 * Worst-case INTRINSIC loss on one side of the strike chain.
 *
 * Call side: at stock → +∞, every short call loses (S - K_short), every
 * long call gains (S - K_long). Net = -(K_short - K_long) × ratio.
 * Sorted by strike, the worst intrinsic is the sum over each short of
 * (K_long_pair - K_short), where the pair is the long call protecting it.
 *
 * Put side: at stock → 0, every short put loses K_short, every long put
 * gains K_long. Net = K_short - K_long per pair (or K_short if uncovered).
 *
 * This is the strike-only piece; premiums are added back via netPremium.
 */
function sideMaxLoss(sameRightLegs: OrderRiskLeg[], right: LegRight): number {
  if (sameRightLegs.length === 0) return 0;

  // Build per-strike net ratio: positive = net long, negative = net short
  const ratioByStrike = new Map<number, number>();
  for (const leg of sameRightLegs) {
    const sign = leg.action === "BUY" ? 1 : -1;
    ratioByStrike.set(
      leg.strike,
      (ratioByStrike.get(leg.strike) ?? 0) + sign * leg.quantity,
    );
  }

  // Sort strikes ascending; for puts we sweep low → high (worst case at 0
  // is bounded by lowest long-put strike); for calls we sweep high → low
  // (worst case at +∞ is bounded by highest long-call strike).
  const strikes = Array.from(ratioByStrike.keys()).sort((a, b) => a - b);

  // Walk strikes computing the cumulative open short position at each
  // boundary. Multiply by strike-width segments to get intrinsic loss.
  //
  // Concrete derivation for a CALL bull spread (long 100C, short 110C):
  //   strikes ascending: 100, 110
  //   ratio at 100: +1 (long)
  //   ratio at 110: −1 (short)
  //   net ratio above 110: 0  → bounded
  //   intrinsic worst case at any S above 110: (S-100) - (S-110) = 10
  //   ⇒ loss = (K_short - K_long) × 100 (per contract) = 10 × 100 = $1000
  //
  // For a PUT bull spread (short 100P, long 90P):
  //   strikes ascending: 90, 100
  //   ratio at 90: +1 (long)
  //   ratio at 100: −1 (short)
  //   net ratio below 90: 0 → bounded
  //   intrinsic worst case at S=0: max(0, 100-S) - max(0, 90-S) = 10
  //   ⇒ loss = (K_short - K_long) × 100 = $1000

  let maxIntrinsicLoss = 0;

  if (right === "C") {
    // Sweep ascending. At each segment [K_i, K_{i+1}], the cumulative net
    // ratio above K_i determines slope. If net ratio above some K_i is < 0
    // (net short), and there are no further long calls above it, the
    // intrinsic loss is unbounded — but `legsAreBounded` already guards
    // against that case. So if we get here, the integral converges.
    //
    // The structural max loss in dollars = max over strikes of:
    //   sum_{j: K_j <= K_i} (net_short_above_K_j × (K_j - K_long_strike))
    //
    // Simpler closed form: the worst case occurs at the strike where
    // remaining net ratio first becomes ≥ 0 walking up. We compute the
    // integral via trapezoidal accumulation.
    let cumulativeRatio = 0;
    let lastStrike = 0;
    let intrinsicAtStrike = 0;
    let worstSoFar = 0;
    for (const k of strikes) {
      // Between lastStrike and k, every contract above k contributes
      // (k - lastStrike) × cumulativeRatio. Negative ratio = losing.
      if (lastStrike > 0) {
        intrinsicAtStrike += (k - lastStrike) * cumulativeRatio;
      }
      // Update worst BEFORE applying this strike's ratio so we capture
      // pre-strike loss at large stock prices going down.
      // (Loss is the negative of intrinsicAtStrike.)
      worstSoFar = Math.max(worstSoFar, -intrinsicAtStrike);
      cumulativeRatio += ratioByStrike.get(k) ?? 0;
      lastStrike = k;
    }
    // After the highest strike, cumulativeRatio should be ≥ 0 (bounded).
    // The worst point is the local minimum of the intrinsic curve which
    // we already tracked.
    maxIntrinsicLoss = worstSoFar * MULTIPLIER;
  } else {
    // Put side — sweep descending so worst case at S→0 is captured.
    // Equivalent: compute intrinsic loss at S=0 directly. Each short put
    // contributes +K_short to loss; each long put contributes −K_long.
    // For a put bull spread (short 100, long 90): loss at 0 = 100 - 90 = 10
    //
    // But if shorts and longs are mismatched at intermediate strikes we
    // need the same trapezoidal walk on the put side. Easier: at every
    // strike S = 0, the intrinsic loss is:
    //
    //   loss(0) = sum over short puts (K_short × ratio)
    //           − sum over long puts (K_long × ratio)
    //
    // For a covered put spread the long ratio matches short ratio with
    // K_long ≤ K_short, yielding a positive (bounded) loss. For naked
    // short puts (no long protection) the loss is K_short × ratio.
    let lossAtZero = 0;
    for (const leg of sameRightLegs) {
      const sign = leg.action === "SELL" ? 1 : -1;
      lossAtZero += sign * leg.strike * leg.quantity;
    }
    maxIntrinsicLoss = Math.max(0, lossAtZero) * MULTIPLIER;
  }

  return maxIntrinsicLoss;
}

/**
 * Symmetric to computeBoundedMaxLoss: sum per-leg upside potential.
 *
 * For most defined-risk structures gain is bounded by long-strike spreads
 * (bull put: credit + spread width; iron condor: net credit + best wing).
 * Pure long calls have unbounded upside — handled at the leg level.
 *
 * Returns a positive dollar magnitude.
 */
function computeBoundedMaxGain(
  legs: OrderRiskLeg[],
  netPremium: number,
  comboQuantity: number,
): number {
  // Symmetric to computeBoundedMaxLoss: per-side intrinsic gain at the
  // favorable extreme strike, scaled by comboQuantity.
  const callLegs = legs.filter((l) => l.right === "C");
  const putLegs = legs.filter((l) => l.right === "P");

  const callGainPerCombo = sideMaxGain(callLegs, "C");
  const putGainPerCombo = sideMaxGain(putLegs, "P");

  const intrinsicTotal =
    Math.max(callGainPerCombo, putGainPerCombo) * comboQuantity;

  // netPremium > 0 = debit (we paid → reduces gain).
  // netPremium < 0 = credit (we received → adds to gain).
  const netCashDollars = -netPremium * comboQuantity * MULTIPLIER;
  return Math.max(0, intrinsicTotal + netCashDollars);
}

function sideMaxGain(sameRightLegs: OrderRiskLeg[], right: LegRight): number {
  if (sameRightLegs.length === 0) return 0;

  // Mirror of sideMaxLoss: find the worst gain ceiling reachable at any
  // single stock price S on this side of the chain.
  //
  // For CALL side at S → +∞:
  //   intrinsic value of leg = sign × max(0, S - K) = sign × (S - K)
  //   total = sum(sign × (S - K)) = S × net_ratio − sum(sign × K)
  //   If net_ratio == 0 (covered): total collapses to −sum(sign × K),
  //     which is +sum(K_short) − sum(K_long) — positive when shorts have
  //     higher strikes (bull spread). At S=K_short the long is ITM and
  //     short OTM, then short kicks in. Maximum intrinsic on the call side
  //     is bounded by spread width — equivalent to integrating up.
  //
  // For a bull call spread (long 100C, short 110C):
  //   intrinsic gain at S→∞: (S-100) − (S-110) = 10 → $1000
  //
  // The trapezoidal walk used in sideMaxLoss applies symmetrically here:
  // worst case at the highest strike when sweeping ascending, before the
  // short leg starts losing back the gains.

  const ratioByStrike = new Map<number, number>();
  for (const leg of sameRightLegs) {
    const sign = leg.action === "BUY" ? 1 : -1;
    ratioByStrike.set(
      leg.strike,
      (ratioByStrike.get(leg.strike) ?? 0) + sign * leg.quantity,
    );
  }
  const strikes = Array.from(ratioByStrike.keys()).sort((a, b) => a - b);

  if (right === "C") {
    // Sweep ascending. Intrinsic value above each strike grows by
    // (segment_width × cumulative_long_ratio). Peak gain = highest point
    // on the curve before short legs reverse it.
    let cumulativeRatio = 0;
    let lastStrike = 0;
    let intrinsic = 0;
    let bestSoFar = 0;
    for (const k of strikes) {
      if (lastStrike > 0) {
        intrinsic += (k - lastStrike) * cumulativeRatio;
      }
      bestSoFar = Math.max(bestSoFar, intrinsic);
      cumulativeRatio += ratioByStrike.get(k) ?? 0;
      lastStrike = k;
    }
    return bestSoFar * MULTIPLIER;
  }

  // PUT side: intrinsic value at S = 0 across each long leg.
  // For a bear put spread (long 110P, short 100P): max gain = (110-100) = 10
  // = +K_long − K_short = +110 − 100 at S=0.
  // Walking descending strikes, accumulate net LONG put ratio gains.
  let lossAtZero = 0;
  for (const leg of sameRightLegs) {
    const sign = leg.action === "BUY" ? 1 : -1;
    lossAtZero += sign * leg.strike * leg.quantity;
  }
  return Math.max(0, lossAtZero) * MULTIPLIER;
}
