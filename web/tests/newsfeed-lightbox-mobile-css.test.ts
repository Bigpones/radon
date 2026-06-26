import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

function mediaBlockRange(query: string): { body: string; full: string } {
  const start = css.indexOf(`@media ${query}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  expect(open).toBeGreaterThan(start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          body: css.slice(open + 1, i),
          full: css.slice(start, i + 1),
        };
      }
    }
  }
  throw new Error(`unterminated media block for ${query}`);
}

function ruleBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m"));
  expect(match, `rule not found for ${selector}`).not.toBeNull();
  return match![1];
}

describe("newsfeed lightbox touch-mobile controls", () => {
  const touchMobileRange = mediaBlockRange(
    "(max-width: 900px) and (pointer: coarse)",
  );
  const touchMobile = touchMobileRange.body;
  const cssWithoutTouchMobile = css.replace(touchMobileRange.full, "");

  it("hides prev/next chevrons only for coarse-pointer mobile viewports", () => {
    expect(ruleBlock(touchMobile, ".newsfeed-lightbox__nav")).toMatch(
      /display:\s*none/,
    );
    expect(cssWithoutTouchMobile).not.toMatch(
      /@media\s*\(max-width:\s*900px\)[\s\S]*?\.newsfeed-lightbox__nav\s*\{[^}]*display:\s*none/,
    );
    expect(cssWithoutTouchMobile).not.toMatch(
      /@media\s*\(max-width:\s*900px\)\s*and\s*\(hover:\s*none\)[\s\S]*?\.newsfeed-lightbox__nav\s*\{[^}]*display:\s*none/,
    );
    expect(cssWithoutTouchMobile).not.toMatch(
      /@media\s*\(max-width:\s*900px\)\s*and\s*\(any-pointer:\s*coarse\)[\s\S]*?\.newsfeed-lightbox__nav\s*\{[^}]*display:\s*none/,
    );
    expect(cssWithoutTouchMobile).not.toMatch(
      /@media\s*\(max-width:\s*900px\)\s*and\s*\(pointer:\s*fine\)[\s\S]*?\.newsfeed-lightbox__nav\s*\{[^}]*display:\s*none/,
    );
  });
});
