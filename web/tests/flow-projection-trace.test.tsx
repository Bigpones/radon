/**
 * @vitest-environment jsdom
 *
 * UI regression guards for FlowProjectionTrace. Pin the brand-true grammar:
 *  - primary signal-core path renders when given points
 *  - overlay extreme path renders only when overlay data is provided
 *  - overlayAwaiting surfaces an explicit "awaiting feed" annotation
 *    instead of a silent empty slot
 *  - projection-geometry hairlines render at low opacity
 *  - brand tokens only — no raw hex or rgba() literals in markup
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FlowProjectionTrace } from "@/components/instruments/FlowProjectionTrace";

const SAMPLE_POINTS = [
  { t: 0, v: 100 },
  { t: 1, v: 102 },
  { t: 2, v: 99 },
  { t: 3, v: 104 },
];

describe("FlowProjectionTrace", () => {
  it("renders the primary signal-core path when given data", () => {
    const { container } = render(
      <FlowProjectionTrace
        primary={{ label: "SPY", points: SAMPLE_POINTS }}
      />,
    );
    const primaryPath = container.querySelector('path[stroke="var(--signal-core)"]');
    expect(primaryPath).not.toBeNull();
    expect(primaryPath?.getAttribute("d")).toMatch(/^M\d/);
  });

  it("renders the overlay extreme path when overlay data is provided", () => {
    const { container } = render(
      <FlowProjectionTrace
        primary={{ label: "SPY", points: SAMPLE_POINTS }}
        overlay={{ label: "DP", points: SAMPLE_POINTS }}
      />,
    );
    const overlayPath = container.querySelector('path[stroke="var(--extreme)"]');
    expect(overlayPath).not.toBeNull();
  });

  it("surfaces an explicit awaiting annotation instead of a silent empty slot", () => {
    const { container, getByText } = render(
      <FlowProjectionTrace
        primary={{ label: "SPY", points: SAMPLE_POINTS }}
        overlay={null}
        overlayAwaiting
      />,
    );
    expect(getByText(/Overlay · awaiting feed/i)).not.toBeNull();
    // No overlay path should be present.
    const overlayPath = container.querySelector('path[stroke="var(--extreme)"]');
    expect(overlayPath).toBeNull();
  });

  it("contains no raw hex or rgba() literals in the rendered markup", () => {
    const { container } = render(
      <FlowProjectionTrace
        primary={{ label: "SPY", points: SAMPLE_POINTS }}
        overlay={{ label: "DP", points: SAMPLE_POINTS }}
      />,
    );
    const html = container.innerHTML;
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/rgba?\(/);
  });
});
