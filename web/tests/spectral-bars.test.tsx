/**
 * @vitest-environment jsdom
 *
 * UI regression guards for SpectralBars (real-signal spectral renderer,
 * not to be confused with SpectralLoader / awaiting state).
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SpectralBars } from "@/components/instruments/SpectralBars";

describe("SpectralBars", () => {
  it("renders one bar per data point and tones by sign", () => {
    const { container } = render(
      <SpectralBars
        bars={[
          { label: "09:30", value: 1.2 },
          { label: "10:00", value: -0.8 },
          { label: "10:30", value: 0.5 },
        ]}
      />,
    );
    const pos = container.querySelectorAll(".spectral-bars__bar--pos");
    const neg = container.querySelectorAll(".spectral-bars__bar--neg");
    expect(pos.length).toBe(2);
    expect(neg.length).toBe(1);
  });

  it("renders the awaiting state when awaiting=true", () => {
    const { getByText, container } = render(
      <SpectralBars bars={[]} awaiting />,
    );
    expect(getByText(/Awaiting decomposition feed/i)).not.toBeNull();
    expect(container.querySelector(".spectral-bars--awaiting")).not.toBeNull();
  });

  it("renders the optional caption when provided", () => {
    const { getByText } = render(
      <SpectralBars
        bars={[{ label: "09:30", value: 1 }]}
        caption="30m buckets · today"
      />,
    );
    expect(getByText(/30m buckets · today/i)).not.toBeNull();
  });

  it("contains no raw hex or rgba() literals in the rendered markup", () => {
    const { container } = render(
      <SpectralBars
        bars={[
          { label: "09:30", value: 1.2 },
          { label: "10:00", value: -0.8 },
        ]}
      />,
    );
    const html = container.innerHTML;
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/rgba?\(/);
  });
});
