"use client";

import Link from "next/link";
import type { WorkspaceSection } from "@/lib/types";
import { navItems } from "@/lib/data";
import { useIBStatusContext, type IBDisplayStatus } from "@/lib/IBStatusContext";

type SidebarProps = {
  activeSection: WorkspaceSection;
  actionTone: string;
  /** @deprecated kept for callers that haven't migrated. The authoritative
   *  status now comes from useIBStatusContext().displayStatus inside this
   *  component — see the IB Gateway 2FA contradictions fix. */
  ibConnected?: boolean;
  lastSync?: string | null;
};

/** Footer label per derived display status. Keep tight — overflowing the
 *  sidebar reflows the status row. */
function statusLabel(status: IBDisplayStatus): { text: string; cls: "live" | "warn" | "dead" } {
  switch (status) {
    case "connected":
      return { text: "NOMINAL", cls: "live" };
    case "awaiting_2fa":
      return { text: "AWAITING 2FA", cls: "warn" };
    case "unhealthy":
      return { text: "DEGRADED", cls: "warn" };
    case "unreachable":
      return { text: "UNREACHABLE", cls: "dead" };
    case "ib_offline":
      return { text: "OFFLINE", cls: "dead" };
    case "relay_offline":
      return { text: "RELAY OFFLINE", cls: "dead" };
  }
}

export default function Sidebar({ activeSection, actionTone, lastSync }: SidebarProps) {
  const { displayStatus } = useIBStatusContext();
  const { text, cls } = statusLabel(displayStatus);
  const dotClass =
    cls === "live" ? "status-dot-live" : cls === "warn" ? "status-dot-warn" : "status-dot-dead";
  const syncTime = lastSync ? new Date(lastSync).toLocaleTimeString() : "—";

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <img
          src="/brand/radon-monogram.svg"
          alt=""
          width={22}
          height={22}
          className="logo-mark"
          aria-hidden
        />
        <span className="logo-text">
          Radon
          <span className="logo-text-sub">terminal</span>
        </span>
      </div>

      <nav className="sidebar-nav">
        {navItems.filter((item) => !item.hidden).map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.label}
              href={item.href}
              className={item.route === activeSection ? "nav-item active" : "nav-item"}
            >
              <span className="nav-icon">
                <Icon size={14} color={actionTone} strokeWidth={2} />
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="status-row">
          <span>Uplink</span>
          <span className="status-dot-wrap">
            <span className={`status-dot ${dotClass}`} />
            {text}
          </span>
        </div>
        <div className="status-row">
          <span>Last Sample</span>
          <span>{syncTime}</span>
        </div>
        <div className="status-row">
          <span>Source</span>
          <span>IB · UW</span>
        </div>
      </div>
    </aside>
  );
}
