/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MarkovStateGraph } from "../components/instruments/MarkovStateGraph";

const fourStates = [
  { id: "s1", label: "REGIME 1" },
  { id: "s2", label: "REGIME 2", current: true },
  { id: "s3", label: "REGIME 3" },
  { id: "s4", label: "REGIME 4" },
];

const sixTransitions = [
  { from: "s1", to: "s2", probability: 0.55 },
  { from: "s2", to: "s3", probability: 0.27 },
  { from: "s2", to: "s2", probability: 0.62 },
  { from: "s3", to: "s4", probability: 0.41 },
  { from: "s3", to: "s2", probability: 0.18 },
  { from: "s4", to: "s1", probability: 0.9 },
];

describe("MarkovStateGraph", () => {
  afterEach(() => cleanup());

  it("renders one node circle per state", () => {
    const { container } = render(
      <MarkovStateGraph states={fourStates} transitions={sixTransitions} />,
    );
    const nodes = container.querySelectorAll("circle[data-markov-node]");
    expect(nodes.length).toBe(fourStates.length);
  });

  it("marks the current state with the signal-core ring", () => {
    const { container } = render(
      <MarkovStateGraph states={fourStates} transitions={sixTransitions} />,
    );
    const currentNode = container.querySelector(
      'circle[data-markov-node][data-current="true"]',
    );
    expect(currentNode).not.toBeNull();
    expect(currentNode?.getAttribute("stroke")).toContain("--signal-core");
  });

  it("scales transition arc stroke width with probability", () => {
    const { container } = render(
      <MarkovStateGraph states={fourStates} transitions={sixTransitions} />,
    );
    const highProb = container.querySelector(
      'path[data-markov-arc][data-from="s4"][data-to="s1"]',
    );
    const lowProb = container.querySelector(
      'path[data-markov-arc][data-from="s3"][data-to="s2"]',
    );
    expect(highProb).not.toBeNull();
    expect(lowProb).not.toBeNull();
    const high = parseFloat(highProb!.getAttribute("stroke-width") ?? "0");
    const low = parseFloat(lowProb!.getAttribute("stroke-width") ?? "0");
    expect(high).toBeGreaterThan(low);
  });

  it("renders probability labels as integer percent (no decimal)", () => {
    const { container } = render(
      <MarkovStateGraph states={fourStates} transitions={sixTransitions} />,
    );
    const labels = Array.from(
      container.querySelectorAll("text[data-markov-prob]"),
    ).map((node) => node.textContent ?? "");
    expect(labels).toContain("62%");
    expect(labels).toContain("90%");
    expect(labels.every((text) => /^\d+%$/.test(text))).toBe(true);
  });

  it("renders an optional caption when provided", () => {
    const { container } = render(
      <MarkovStateGraph
        states={fourStates}
        transitions={sixTransitions}
        caption="60d sample"
      />,
    );
    const caption = container.querySelector("[data-markov-caption]");
    expect(caption?.textContent).toBe("60d sample");
  });
});
