/**
 * @vitest-environment jsdom
 *
 * Brand-aligned shared empty-state pattern.
 *
 * The orders page (and other section panels) used to render bare text like
 * "No open orders" with the generic alert-item chevron. That collapses
 * the panel and leaks raw chevron glyphs into prose. This component
 * follows docs/brand-identity.md: lucide icon, calm headline in regular
 * case, secondary context line in muted text, brand tokens only.
 *
 * Contract:
 *   - renders a lucide icon (data-testid="section-empty-state-icon")
 *   - renders a headline + secondary copy
 *   - emits brand-token CSS class names (no raw hex literals in markup)
 *   - no em dashes in user-facing copy
 *   - exposes data-testid="section-empty-state" for E2E selection
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { Inbox, History } from "lucide-react";
import SectionEmptyState from "../components/SectionEmptyState";

afterEach(() => cleanup());

const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/;
const EM_DASH = /—/; // U+2014 EM DASH

describe("<SectionEmptyState />", () => {
  it("renders the icon, headline, and secondary copy", () => {
    render(
      <SectionEmptyState
        icon={Inbox}
        headline="No working orders"
        secondary="Place an order from any ticker view to populate this list."
      />,
    );

    expect(screen.getByTestId("section-empty-state")).toBeTruthy();
    expect(screen.getByTestId("section-empty-state-icon")).toBeTruthy();
    expect(screen.getByText("No working orders")).toBeTruthy();
    expect(
      screen.getByText("Place an order from any ticker view to populate this list."),
    ).toBeTruthy();
  });

  it("contains no raw hex color literals in the rendered DOM", () => {
    const { container } = render(
      <SectionEmptyState
        icon={History}
        headline="No fills today"
        secondary="Executions during today's session will appear here."
      />,
    );
    // outerHTML covers inline style + class attributes. Brand-token usage
    // means colors come from CSS variables, not inline hex.
    expect(container.outerHTML).not.toMatch(HEX_LITERAL);
  });

  it("uses no em dashes in user-facing copy", () => {
    const { container } = render(
      <SectionEmptyState
        icon={History}
        headline="No fills today"
        secondary="Executions during today's session will appear here."
      />,
    );
    expect(container.textContent ?? "").not.toMatch(EM_DASH);
  });

  it("renders an optional ghost-style action when provided", () => {
    render(
      <SectionEmptyState
        icon={Inbox}
        headline="No working orders"
        secondary="Place an order from any ticker view to populate this list."
        action={{ label: "Open dashboard", href: "/dashboard" }}
      />,
    );
    const link = screen.getByRole("link", { name: "Open dashboard" });
    expect(link.getAttribute("href")).toBe("/dashboard");
    // Action should sit inside the empty-state surface.
    expect(screen.getByTestId("section-empty-state").contains(link)).toBe(true);
  });

  it("exposes a hook for compact (mobile) variants via the variant prop", () => {
    render(
      <SectionEmptyState
        icon={Inbox}
        headline="No working orders"
        secondary="Place an order to populate this list."
        variant="compact"
      />,
    );
    const root = screen.getByTestId("section-empty-state");
    expect(root.getAttribute("data-variant")).toBe("compact");
  });

  it("marks danger-toned empties with role=alert and data-tone=danger", () => {
    render(
      <SectionEmptyState
        icon={History}
        tone="danger"
        headline="Couldn't load historical trades"
        secondary="Network unreachable."
      />,
    );
    const root = screen.getByTestId("section-empty-state");
    expect(root.getAttribute("data-tone")).toBe("danger");
    expect(root.getAttribute("role")).toBe("alert");
  });

  it("supports disabling the action button", () => {
    render(
      <SectionEmptyState
        icon={Inbox}
        headline="No working orders"
        action={{ label: "Refreshing", onClick: () => {}, disabled: true }}
      />,
    );
    const button = screen.getByRole("button", { name: "Refreshing" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
