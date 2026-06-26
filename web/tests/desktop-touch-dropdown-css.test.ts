import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

function mediaBlock(query: string): string {
  const start = css.indexOf(`@media ${query}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  expect(open).toBeGreaterThan(start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated media block for ${query}`);
}

function ruleBlockByLastSelector(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`[^{}]*${escaped}\\s*\\{([^}]*)\\}`, "m"));
  expect(match, `rule not found ending with ${selector}`).not.toBeNull();
  return match![1];
}

describe("desktop touchscreen dropdown touch targets", () => {
  const hybridTouchBlock = mediaBlock(
    "(any-pointer: coarse), (pointer: coarse), (max-width: 1024px)",
  );

  it("includes hybrid desktop touchscreens in the dropdown target media query", () => {
    expect(css).toContain("@media (any-pointer: coarse)");
  });

  it("expands native selects and chain selects to touch-safe targets", () => {
    const selectRule = ruleBlockByLastSelector(
      hybridTouchBlock,
      ".filter-select",
    );
    expect(selectRule).toMatch(/min-height:\s*44px/);
    expect(selectRule).toMatch(/font-size:\s*16px/);
    expect(selectRule).toMatch(/padding-block:\s*8px/);
    expect(selectRule).toMatch(/pointer-events:\s*auto/);
    expect(selectRule).toMatch(/touch-action:\s*manipulation/);
  });

  it("expands dropdown-like buttons and menu rows to touch-safe targets", () => {
    const menuRule = ruleBlockByLastSelector(
      hybridTouchBlock,
      ".columns-toggle-item",
    );
    expect(menuRule).toMatch(/min-height:\s*44px/);
    expect(menuRule).toMatch(/pointer-events:\s*auto/);
    expect(menuRule).toMatch(/touch-action:\s*manipulation/);
  });
});
