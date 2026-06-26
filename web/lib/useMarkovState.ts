"use client";

import { useMemo } from "react";
import { computeCri, criLevel, type CriLevel } from "./criCalc";
import type { CriHistoryEntry } from "./useRegime";

/**
 * useMarkovState — discretize CRI history into the 4 regime bands the
 * production system already uses (LOW < 25 / ELEVATED < 50 / HIGH < 75 /
 * CRITICAL ≥ 75), count pairwise day-to-day transitions over a lookback
 * window, and surface the current state alongside its most-likely next
 * transition. Powers the Markov hero card and feeds MarkovStateGraph.
 *
 * Lookback defaults to 60 sessions per the brand mockup's "60d" basis.
 * Sample size shrinks gracefully when history is shorter than the window.
 */

export type MarkovBand = CriLevel;

export type MarkovTransitionMatrix = Record<
  MarkovBand,
  Record<MarkovBand, number>
>;

export type MarkovStateOutput = {
  /** Band of the most recent history entry. */
  currentBand: MarkovBand | null;
  /** Most likely transition target other than self. */
  nextLikelyBand: MarkovBand | null;
  /** Probability of staying in the current band (matrix[curr][curr]). */
  pCurrent: number | null;
  /** Probability of transitioning to nextLikelyBand. */
  pNext: number | null;
  /** Row-stochastic transition matrix over all four bands. */
  matrix: MarkovTransitionMatrix;
  /** Number of *transitions* sampled (history length minus one). */
  sampleSize: number;
};

const BANDS: readonly MarkovBand[] = ["LOW", "ELEVATED", "HIGH", "CRITICAL"];

function emptyMatrix(): MarkovTransitionMatrix {
  return {
    LOW: { LOW: 0, ELEVATED: 0, HIGH: 0, CRITICAL: 0 },
    ELEVATED: { LOW: 0, ELEVATED: 0, HIGH: 0, CRITICAL: 0 },
    HIGH: { LOW: 0, ELEVATED: 0, HIGH: 0, CRITICAL: 0 },
    CRITICAL: { LOW: 0, ELEVATED: 0, HIGH: 0, CRITICAL: 0 },
  };
}

const EMPTY_OUTPUT: MarkovStateOutput = {
  currentBand: null,
  nextLikelyBand: null,
  pCurrent: null,
  pNext: null,
  matrix: emptyMatrix(),
  sampleSize: 0,
};

/** Recompute the CRI band for a single history entry. */
function bandFor(entry: CriHistoryEntry, corr5dChange: number): MarkovBand {
  const vvixVixRatio = entry.vix > 0 ? entry.vvix / entry.vix : 0;
  const result = computeCri({
    vix: entry.vix,
    vix5dRoc: entry.vix_5d_roc,
    vvix: entry.vvix,
    vvixVixRatio,
    corr: entry.cor1m ?? 0.5,
    corr5dChange,
    spxDistancePct: entry.spx_vs_ma_pct,
  });
  return result.level;
}

/** Build a row-stochastic transition matrix from an ordered band sequence. */
function buildMatrix(bands: MarkovBand[]): MarkovTransitionMatrix {
  const counts = emptyMatrix();
  for (let i = 0; i < bands.length - 1; i += 1) {
    counts[bands[i]][bands[i + 1]] += 1;
  }
  for (const from of BANDS) {
    const rowTotal = BANDS.reduce((acc, to) => acc + counts[from][to], 0);
    if (rowTotal === 0) continue;
    for (const to of BANDS) {
      counts[from][to] = counts[from][to] / rowTotal;
    }
  }
  return counts;
}

/** Pick the row entry with the highest probability that isn't `excluded`. */
function argmaxExcluding(
  row: Record<MarkovBand, number>,
  excluded: MarkovBand,
): { band: MarkovBand | null; probability: number } {
  let best: MarkovBand | null = null;
  let bestP = -1;
  for (const band of BANDS) {
    if (band === excluded) continue;
    if (row[band] > bestP) {
      best = band;
      bestP = row[band];
    }
  }
  return { band: best, probability: bestP > 0 ? bestP : 0 };
}

/** Pure computation — exported for unit testing without a DOM. */
export function computeMarkovState(
  history: CriHistoryEntry[] | undefined,
  lookbackDays = 60,
): MarkovStateOutput {
  if (!history || history.length < 2) return EMPTY_OUTPUT;

  const recent = history.slice(-lookbackDays);
  const bands: MarkovBand[] = recent.map((entry, i, arr) => {
    const lookbackEntry = i >= 5 ? arr[i - 5] : null;
    const corr5dChange =
      lookbackEntry && entry.cor1m != null && lookbackEntry.cor1m != null
        ? entry.cor1m - lookbackEntry.cor1m
        : 0;
    return bandFor(entry, corr5dChange);
  });

  const matrix = buildMatrix(bands);
  const currentBand = bands[bands.length - 1];
  const pCurrent = matrix[currentBand][currentBand];
  const { band: nextLikelyBand, probability: pNext } = argmaxExcluding(
    matrix[currentBand],
    currentBand,
  );

  return {
    currentBand,
    nextLikelyBand,
    pCurrent,
    pNext,
    matrix,
    sampleSize: bands.length - 1,
  };
}

export function useMarkovState(
  history: CriHistoryEntry[] | undefined,
  lookbackDays = 60,
): MarkovStateOutput {
  return useMemo(
    () => computeMarkovState(history, lookbackDays),
    [history, lookbackDays],
  );
}

export const __testing = {
  bandFor,
  buildMatrix,
  argmaxExcluding,
  criLevel,
};
