/**
 * Unit test: options chain header z-index must be >= 10
 * to prevent tbody rows from overlapping sticky thead.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const CSS_PATH = path.resolve(__dirname, "../app/globals.css");

describe("chain sticky header CSS", () => {
  const css = fs.readFileSync(CSS_PATH, "utf-8");

  it(".chain-header z-index >= 10", () => {
    const match = css.match(/\.chain-header\s*\{[^}]*z-index:\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(10);
  });

  it(".chain-side-label z-index >= 10", () => {
    const match = css.match(/\.chain-side-label\s*\{[^}]*z-index:\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(10);
  });

  it(".chain-header has position: sticky", () => {
    const match = css.match(/\.chain-header\s*\{[^}]*position:\s*(sticky)/);
    expect(match).not.toBeNull();
  });

  it(".chain-side-label has position: sticky", () => {
    const match = css.match(/\.chain-side-label\s*\{[^}]*position:\s*(sticky)/);
    expect(match).not.toBeNull();
  });
});
