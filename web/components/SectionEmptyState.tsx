"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";

/**
 * SectionEmptyState — calm, brand-aligned empty surface for section panels.
 *
 * Use when a section body has no rows. Replaces ad-hoc bare-text patterns
 * (alert-item chevron, naked spans) that collapsed the panel and leaked
 * raw glyphs into prose.
 *
 * Visual contract (see docs/brand-identity.md):
 *   - Icon (lucide, 16px) in --text-muted
 *   - Headline in regular case, --text-primary, sans
 *   - Secondary copy in --text-secondary, sans, narrow column
 *   - Optional ghost-style action button / link
 *   - Generous vertical breathing room (32-40px) so the panel does not
 *     read as collapsed
 *   - Brand tokens only — no raw hex
 *   - 4px max border-radius
 */

export type SectionEmptyStateVariant = "default" | "compact";

export type SectionEmptyStateAction = {
  label: string;
  href?: string;
  onClick?: () => void;
};

export type SectionEmptyStateProps = {
  icon: LucideIcon;
  headline: string;
  secondary?: string;
  action?: SectionEmptyStateAction;
  variant?: SectionEmptyStateVariant;
  testId?: string;
};

function ActionElement({ action }: { action: SectionEmptyStateAction }) {
  if (action.href) {
    return (
      <Link
        href={action.href}
        className="section-empty-state__action"
        data-testid="section-empty-state-action"
      >
        {action.label}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={action.onClick}
      className="section-empty-state__action"
      data-testid="section-empty-state-action"
    >
      {action.label}
    </button>
  );
}

export default function SectionEmptyState({
  icon: Icon,
  headline,
  secondary,
  action,
  variant = "default",
  testId = "section-empty-state",
}: SectionEmptyStateProps) {
  const iconSize = variant === "compact" ? 14 : 18;
  return (
    <div
      className="section-empty-state"
      data-testid={testId}
      data-variant={variant}
      role="status"
    >
      <span
        className="section-empty-state__icon"
        data-testid="section-empty-state-icon"
        aria-hidden="true"
      >
        <Icon size={iconSize} strokeWidth={1.75} />
      </span>
      <div className="section-empty-state__copy">
        <p className="section-empty-state__headline">{headline}</p>
        {secondary ? (
          <p className="section-empty-state__secondary">{secondary}</p>
        ) : null}
      </div>
      {action ? <ActionElement action={action} /> : null}
    </div>
  );
}
