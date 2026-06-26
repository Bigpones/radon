/**
 * @vitest-environment jsdom
 *
 * Regression: React #418 hydration mismatch on production /portfolio.
 *
 * Root cause — `ThemeProvider`'s `useState` initialiser called
 * `readInitialTheme()` which read `localStorage.theme` / the
 * `<html data-theme>` attribute. On the server those are absent → returns
 * `"dark"`. On the client first render they exist → may return `"light"`.
 * Hydration runs the same render function on the server's HTML, so any
 * descendant component branching on `theme` (e.g. ClerkThemeBridge
 * choosing `baseTheme: dark` vs `undefined`) produced a different tree
 * during hydration than what was sent down from SSR.
 *
 * React hydration semantics: the client's first render MUST match the
 * SSR output exactly. Theme that lives in localStorage / DOM attrs has to
 * be applied AFTER mount, never during the initial render.
 *
 * Fix — `ThemeProvider` initialises `theme = "dark"` (matching SSR), and
 * a `useEffect` reads the real theme post-mount and updates state. The
 * pre-paint `ThemeBootstrap` script already sets `<html data-theme>`
 * synchronously so there's no visible flash before that effect runs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider, useTheme } from "@/lib/ThemeContext";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  // jsdom doesn't ship matchMedia; the provider calls it inside a
  // prefers-color-scheme listener effect.
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container.remove();
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
});

function ThemeProbe({ onTheme }: { onTheme: (t: string) => void }) {
  const { theme } = useTheme();
  onTheme(theme);
  return <span data-testid="probe">{theme}</span>;
}

describe("ThemeProvider hydration safety", () => {
  it("initialises theme to the SSR default ('dark') on first render even when localStorage prefers light", () => {
    // Simulate a returning user whose preference is 'light'.
    window.localStorage.setItem("theme", "light");
    document.documentElement.setAttribute("data-theme", "light");

    const captured: string[] = [];
    act(() => {
      root = createRoot(container);
      root.render(
        <ThemeProvider>
          <ThemeProbe onTheme={(t) => captured.push(t)} />
        </ThemeProvider>,
      );
    });

    // The FIRST render must match SSR ('dark'). A post-mount effect is
    // allowed to flip to 'light' on a subsequent render — that's a state
    // update, not a hydration mismatch.
    expect(captured[0]).toBe("dark");
  });

  it("initialises theme to 'dark' when neither localStorage nor data-theme are set (SSR parity)", () => {
    const captured: string[] = [];
    act(() => {
      root = createRoot(container);
      root.render(
        <ThemeProvider>
          <ThemeProbe onTheme={(t) => captured.push(t)} />
        </ThemeProvider>,
      );
    });
    expect(captured[0]).toBe("dark");
  });

  it("updates theme to the user's preference after mount", async () => {
    window.localStorage.setItem("theme", "light");

    const captured: string[] = [];
    act(() => {
      root = createRoot(container);
      root.render(
        <ThemeProvider>
          <ThemeProbe onTheme={(t) => captured.push(t)} />
        </ThemeProvider>,
      );
    });

    // After the post-mount effect runs, theme reflects localStorage.
    expect(captured.at(-1)).toBe("light");
    // And the very first render was still the SSR default.
    expect(captured[0]).toBe("dark");
  });
});
