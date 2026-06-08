"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { LayoutDashboard, Circle, ClipboardList, Sparkles, Menu } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { useProfile } from "@/lib/useProfile";

type MobileTab = {
  label: string;
  href?: string;
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;
  matchPaths?: string[];
  action?: "openMore";
};

const TABS: MobileTab[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, matchPaths: ["/dashboard", "/"] },
  { label: "Positions", href: "/portfolio", icon: Circle, matchPaths: ["/portfolio", "/performance"] },
  { label: "Orders", href: "/orders", icon: ClipboardList, matchPaths: ["/orders"] },
  { label: "Scanner", href: "/scanner", icon: Sparkles, matchPaths: ["/scanner", "/discover", "/flow-analysis"] },
  { label: "More", icon: Menu, action: "openMore" },
];

function monogramFor(name: string | null, email: string | null): string {
  const source = (name ?? email ?? "").trim();
  if (!source) return "·";
  const parts = source.replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return source.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

type MobileTabBarProps = {
  onOpenMore: () => void;
};

function isActive(pathname: string, paths: string[] | undefined): boolean {
  if (!paths) return false;
  return paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export default function MobileTabBar({ onOpenMore }: MobileTabBarProps) {
  const pathname = usePathname() ?? "";
  const { profile } = useProfile();
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const avatarUrl = profile?.avatar_url ?? user?.imageUrl ?? null;
  const monogram = monogramFor(profile?.username ?? null, email);
  const profileActive = isActive(pathname, ["/profile"]);

  return (
    <nav className="mobile-tab-bar" aria-label="Primary mobile navigation" data-testid="mobile-tab-bar">
      <Link
        href="/profile"
        className={`mobile-tab-bar__item mobile-tab-bar__item--profile${profileActive ? " mobile-tab-bar__item--active" : ""}`}
        data-testid="mobile-tab-profile"
        aria-label="Profile"
      >
        <span className="mobile-tab-bar__avatar">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" width={22} height={22} />
          ) : (
            <span className="mobile-tab-bar__monogram">{monogram}</span>
          )}
        </span>
        <span className="mobile-tab-bar__label">Profile</span>
      </Link>
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = isActive(pathname, tab.matchPaths);
        const className = `mobile-tab-bar__item${active ? " mobile-tab-bar__item--active" : ""}`;

        if (tab.action === "openMore") {
          return (
            <button
              key={tab.label}
              type="button"
              className={className}
              onClick={onOpenMore}
              aria-label="Open more navigation"
              data-testid="mobile-tab-more"
            >
              <Icon size={20} strokeWidth={2} aria-hidden />
              <span className="mobile-tab-bar__label">{tab.label}</span>
            </button>
          );
        }

        return (
          <Link
            key={tab.label}
            href={tab.href ?? "#"}
            className={className}
            data-testid={`mobile-tab-${tab.label.toLowerCase()}`}
          >
            <Icon size={20} strokeWidth={2} aria-hidden />
            <span className="mobile-tab-bar__label">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
