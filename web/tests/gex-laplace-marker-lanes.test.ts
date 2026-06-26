/**
 * Collision tests for the GEX curvature-field strike markers.
 *
 * Regression: when several level markers (PUT WALL / CALL WALL / GAMMA FLIP /
 * MAGNET / ACCEL) land on or near the same strike, their centered text labels
 * used to render at the same x and smear into illegible overlap. The lane
 * assignment must guarantee that any two labels sharing a lane never overlap
 * horizontally, regardless of how close the strikes are.
 */

import { describe, expect, it } from "vitest";

import {
  assignMarkerLanes,
  MARKER_LABEL_LANE_GAP,
  type PlacedMarker,
} from "../components/instruments/GexLaplaceContour";

type StrikeDomain = { minStrike: number; maxStrike: number; maxAbsGex: number };

const DOMAIN: StrikeDomain = { minStrike: 5000, maxStrike: 6000, maxAbsGex: 100 };

function marker(label: string, strike: number) {
  return { testId: `gex-level-marker-${label}`, label, strike, color: "var(--signal-core)" };
}

function labelBox(m: PlacedMarker): { left: number; right: number } {
  return { left: m.x - m.labelWidth / 2, right: m.x + m.labelWidth / 2 };
}

function overlaps(a: PlacedMarker, b: PlacedMarker): boolean {
  const boxA = labelBox(a);
  const boxB = labelBox(b);
  return boxA.left < boxB.right - MARKER_LABEL_LANE_GAP && boxB.left < boxA.right - MARKER_LABEL_LANE_GAP;
}

function assertNoSameLaneOverlap(placed: PlacedMarker[]): void {
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (placed[i].lane === placed[j].lane) {
        expect(overlaps(placed[i], placed[j])).toBe(false);
      }
    }
  }
}

describe("assignMarkerLanes", () => {
  it("keeps well-separated markers on a single lane", () => {
    const placed = assignMarkerLanes(
      [marker("PUT WALL", 5100), marker("CALL WALL", 5900)],
      DOMAIN,
    );
    expect(placed.every((m) => m.lane === 0)).toBe(true);
    assertNoSameLaneOverlap(placed);
  });

  it("stacks three labels sharing one strike into separate lanes", () => {
    const placed = assignMarkerLanes(
      [marker("PUT WALL", 5500), marker("MAGNET", 5500), marker("CALL WALL", 5500)],
      DOMAIN,
    );
    const lanes = new Set(placed.map((m) => m.lane));
    expect(lanes.size).toBe(3);
    assertNoSameLaneOverlap(placed);
  });

  it("never overlaps labels for five near-colocated markers", () => {
    const placed = assignMarkerLanes(
      [
        marker("PUT WALL", 5498),
        marker("ACCEL", 5500),
        marker("FLIP", 5501),
        marker("MAGNET", 5502),
        marker("CALL WALL", 5503),
      ],
      DOMAIN,
    );
    assertNoSameLaneOverlap(placed);
  });

  it("processes markers left-to-right regardless of input order", () => {
    const placed = assignMarkerLanes(
      [marker("CALL WALL", 5900), marker("PUT WALL", 5100), marker("MAGNET", 5500)],
      DOMAIN,
    );
    const xs = placed.map((m) => m.x);
    const sorted = [...xs].sort((a, b) => a - b);
    expect(xs).toEqual(sorted);
  });

  it("reuses a shallow lane once the x-cursor clears the previous label", () => {
    const placed = assignMarkerLanes(
      [marker("PW", 5050), marker("CW", 5950), marker("MM", 5500)],
      DOMAIN,
    );
    // Short codes far apart all fit on lane 0.
    expect(placed.every((m) => m.lane === 0)).toBe(true);
    assertNoSameLaneOverlap(placed);
  });

  it("returns an empty layout for no markers", () => {
    expect(assignMarkerLanes([], DOMAIN)).toEqual([]);
  });
});
