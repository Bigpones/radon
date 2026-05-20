"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { useIBStatusContext, type IBDisplayStatus } from "@/lib/IBStatusContext";

type MobileAppBarProps = {
  title: string;
  /** @deprecated read from useIBStatusContext().displayStatus directly. */
  ibConnected?: boolean;
  onOpenSearch?: () => void;
};

function mobileStatusChip(status: IBDisplayStatus): {
  text: string;
  cls: "live" | "warn" | "offline";
  aria: string;
} {
  switch (status) {
    case "connected":
      return { text: "LIVE", cls: "live", aria: "IB Gateway connected" };
    case "awaiting_2fa":
      return { text: "2FA", cls: "warn", aria: "IB Gateway awaiting 2FA approval" };
    case "unhealthy":
      return { text: "DEG", cls: "warn", aria: "IB Gateway degraded" };
    case "unreachable":
    case "ib_offline":
    case "relay_offline":
      return { text: "OFF", cls: "offline", aria: "IB Gateway offline" };
  }
}

export default function MobileAppBar({ title, onOpenSearch }: MobileAppBarProps) {
  const { displayStatus } = useIBStatusContext();
  const chip = mobileStatusChip(displayStatus);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let lastY = typeof window !== "undefined" ? window.scrollY : 0;
    let frame = 0;

    const handleScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        const y = window.scrollY;
        const delta = y - lastY;
        if (y < 16) setCollapsed(false);
        else if (delta > 4) setCollapsed(true);
        else if (delta < -4) setCollapsed(false);
        lastY = y;
        frame = 0;
      });
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  const className = `mobile-app-bar${collapsed ? " mobile-app-bar--collapsed" : ""}`;

  return (
    <header className={className} data-testid="mobile-app-bar">
      <div className="mobile-app-bar__inner">
        <div className="mobile-app-bar__brand">
          <span className="mobile-app-bar__logo" aria-hidden />
          <span className="mobile-app-bar__title">{title}</span>
        </div>
        <div className="mobile-app-bar__actions">
          <span
            className={`mobile-app-bar__status mobile-app-bar__status--${chip.cls}`}
            aria-label={chip.aria}
          >
            <span className="mobile-app-bar__status-dot" aria-hidden />
            {chip.text}
          </span>
          {onOpenSearch ? (
            <button
              type="button"
              className="mobile-app-bar__search"
              onClick={onOpenSearch}
              aria-label="Open ticker search"
              data-testid="mobile-app-bar-search"
            >
              <Search size={18} strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
