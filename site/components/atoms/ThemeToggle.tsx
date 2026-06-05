"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DEFAULT_SITE_THEME,
  resolveInitialTheme,
  SITE_THEME_STORAGE_KEY,
  siteThemeMetaColor,
  getNextTheme,
  type SiteTheme,
} from "@/lib/theme";

function applySiteTheme(theme: SiteTheme) {
  document.documentElement.setAttribute("data-theme", theme);
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute("content", siteThemeMetaColor[theme]);
  }
}

export function ThemeToggle() {
  // SSR and the first client render must agree, so both start from the default.
  // The pre-hydration bootstrap script in layout.tsx has already applied the real
  // theme to <html>; this effect only syncs the button's state to it after mount.
  const [theme, setTheme] = useState<SiteTheme>(DEFAULT_SITE_THEME);

  useEffect(() => {
    setTheme(
      resolveInitialTheme(
        document.documentElement.getAttribute("data-theme") ||
          window.localStorage.getItem(SITE_THEME_STORAGE_KEY),
        window.matchMedia("(prefers-color-scheme: dark)").matches,
      ),
    );
  }, []);

  const nextTheme = getNextTheme(theme);
  const label = nextTheme === "light" ? "Light" : "Dark";
  const ariaLabel = `Switch to ${nextTheme} mode`;

  return (
    <button
      type="button"
      data-testid="site-theme-toggle"
      suppressHydrationWarning
      aria-label={ariaLabel}
      title={ariaLabel}
      className="inline-flex items-center gap-2 rounded-[999px] border border-grid bg-panel px-3 py-2 min-h-[44px] min-w-[44px] font-mono text-[10px] uppercase tracking-[0.16em] text-primary transition-colors hover:bg-panel-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
      onClick={() => {
        const upcomingTheme = getNextTheme(theme);
        setTheme(upcomingTheme);
        applySiteTheme(upcomingTheme);
        window.localStorage.setItem(SITE_THEME_STORAGE_KEY, upcomingTheme);
      }}
    >
      {nextTheme === "light" ? <Sun size={14} /> : <Moon size={14} />}
      <span suppressHydrationWarning>{label}</span>
    </button>
  );
}
