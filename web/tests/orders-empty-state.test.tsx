/**
 * @vitest-environment jsdom
 *
 * Verifies the /orders page section bodies render the brand-aligned
 * SectionEmptyState (not the raw alert-item chevron) when no rows are
 * present.
 *
 * Also asserts the mobile variants in MobileOrderList /
 * MobileExecutedList swap their bare-text empty surfaces for the same
 * shared component (variant="compact").
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import MobileOrderList from "../components/mobile/MobileOrderList";
import MobileExecutedList from "../components/mobile/MobileExecutedList";

afterEach(() => cleanup());

const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/;
const EM_DASH = /—/;

describe("MobileOrderList — brand-aligned empty state", () => {
  it("renders SectionEmptyState compact variant when there are no rows", () => {
    render(
      <MobileOrderList
        rows={[]}
        canModify={() => false}
        onRequestCancel={() => {}}
        onRequestModify={() => {}}
      />,
    );
    const root = screen.getByTestId("mobile-order-list-empty");
    expect(root).toBeTruthy();
    expect(root.getAttribute("data-variant")).toBe("compact");
    // Headline + secondary visible.
    expect(screen.getByText("No working orders")).toBeTruthy();
    expect(
      screen.getByText("Place an order from a ticker view to see it here."),
    ).toBeTruthy();
    // Icon present.
    expect(screen.getByTestId("section-empty-state-icon")).toBeTruthy();
  });

  it("uses brand tokens (no raw hex) and no em dashes in the empty state markup", () => {
    const { container } = render(
      <MobileOrderList
        rows={[]}
        canModify={() => false}
        onRequestCancel={() => {}}
        onRequestModify={() => {}}
      />,
    );
    expect(container.outerHTML).not.toMatch(HEX_LITERAL);
    expect(container.textContent ?? "").not.toMatch(EM_DASH);
  });
});

describe("MobileExecutedList — brand-aligned empty state", () => {
  it("renders SectionEmptyState compact variant when there are no groups", () => {
    render(<MobileExecutedList groups={[]} />);
    const root = screen.getByTestId("mobile-executed-list-empty");
    expect(root).toBeTruthy();
    expect(root.getAttribute("data-variant")).toBe("compact");
    expect(screen.getByText("No fills today")).toBeTruthy();
    expect(
      screen.getByText("Today's executions will appear here as orders fill."),
    ).toBeTruthy();
    expect(screen.getByTestId("section-empty-state-icon")).toBeTruthy();
  });

  it("uses brand tokens (no raw hex) and no em dashes in the empty state markup", () => {
    const { container } = render(<MobileExecutedList groups={[]} />);
    expect(container.outerHTML).not.toMatch(HEX_LITERAL);
    expect(container.textContent ?? "").not.toMatch(EM_DASH);
  });
});
