"use client";

import { useRef, useEffect, type ReactNode } from "react";
import { Maximize2, Minimize2, Moon, Sun } from "lucide-react";

type HeaderProps = {
  activeLabel: string;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onToggleTheme: () => void;
  theme?: "dark" | "light";
  children?: ReactNode;
};

export default function Header({
  activeLabel,
  isFullscreen,
  onToggleFullscreen,
  onToggleTheme,
  theme,
  children,
}: HeaderProps) {
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <header className="header">
      <div className="breadcrumb">
        WORKSPACE / <span>{activeLabel.toUpperCase()}</span>
      </div>
      <div className="header-actions" suppressHydrationWarning>
        {children}
        <input
          suppressHydrationWarning
          ref={searchRef}
          type="text"
          className="search-input"
          placeholder="CMD+K to search..."
          aria-label="Search"
        />
        <button
          suppressHydrationWarning
          className="fullscreen-toggle"
          onClick={onToggleFullscreen}
          title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        >
          {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button
          suppressHydrationWarning
          className="theme-toggle"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>
    </header>
  );
}
