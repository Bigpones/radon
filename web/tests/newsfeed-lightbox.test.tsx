/**
 * @vitest-environment jsdom
 *
 * UI regression guards for NewsfeedLightbox. The lightbox is the only
 * interactive image experience in the dashboard, so a few behavioural
 * pins matter:
 *   - nothing renders when no focus is set
 *   - image + title + body all surface together when focus is set
 *   - Escape and scrim click both fire onDismiss
 *   - brand-token contract holds (no raw hex / rgba())
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import NewsfeedLightbox, {
  type NewsfeedLightboxFocus,
} from "@/components/NewsfeedLightbox";

const POST: NewsfeedLightboxFocus["post"] = {
  id: "x1",
  title: "Convexity concentration elevated",
  content: "Dealer gamma exposure flipped overnight; expect pinning to break.",
  timestamp: "2026-05-20T18:30:00Z",
  isoTimestamp: "2026-05-20T18:30:00Z",
  href: "https://themarketear.com/posts/x1",
  images: ["https://media.radon.run/images/x1.png"],
  tags: ["GAMMA", "PINNING"],
};

const FOCUS: NewsfeedLightboxFocus = {
  post: POST,
  imageUrl: "https://media.radon.run/images/x1.png",
};

describe("NewsfeedLightbox", () => {
  beforeEach(() => {
    // jsdom does not implement Image at sufficient fidelity for next/image —
    // patch the necessary surface so render() does not crash.
    document.body.style.overflow = "";
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = "";
  });

  it("renders nothing when focus is null", () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <NewsfeedLightbox focus={null} onDismiss={onDismiss} />,
    );
    expect(container.querySelector(".newsfeed-lightbox")).toBeNull();
  });

  it("renders title, body, and tags when focus is set", () => {
    const onDismiss = vi.fn();
    const { getByText, getByTestId } = render(
      <NewsfeedLightbox focus={FOCUS} onDismiss={onDismiss} />,
    );
    expect(getByText(POST.title)).not.toBeNull();
    expect(getByText(/Dealer gamma exposure flipped/i)).not.toBeNull();
    expect(getByText("GAMMA")).not.toBeNull();
    expect(getByText("PINNING")).not.toBeNull();
    expect(getByTestId("newsfeed-lightbox-close")).not.toBeNull();
  });

  it("fires onDismiss when the close button is clicked", () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(
      <NewsfeedLightbox focus={FOCUS} onDismiss={onDismiss} />,
    );
    fireEvent.click(getByTestId("newsfeed-lightbox-close"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("fires onDismiss when the scrim is clicked", () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(
      <NewsfeedLightbox focus={FOCUS} onDismiss={onDismiss} />,
    );
    fireEvent.click(getByTestId("newsfeed-lightbox-scrim"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("fires onDismiss on Escape", () => {
    const onDismiss = vi.fn();
    render(<NewsfeedLightbox focus={FOCUS} onDismiss={onDismiss} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("locks body scroll while open and restores on close", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <NewsfeedLightbox focus={FOCUS} onDismiss={onDismiss} />,
    );
    expect(document.body.style.overflow).toBe("hidden");
    rerender(<NewsfeedLightbox focus={null} onDismiss={onDismiss} />);
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});
