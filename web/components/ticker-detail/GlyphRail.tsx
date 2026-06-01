"use client";

import type { DeckKey } from "./AssetCockpit";

type GlyphDef = { key: DeckKey; label: string };

const GLYPHS: GlyphDef[] = [
  { key: "c", label: "Chain" },
  { key: "p", label: "Posn" },
  { key: "n", label: "News" },
  { key: "r", label: "Rate" },
  { key: "s", label: "Seas" },
  { key: "i", label: "Info" },
  { key: ":", label: "Cmd" },
];

type GlyphRailProps = {
  activeDeck: DeckKey | null;
  onDeckChange: (deck: DeckKey | null) => void;
  /** Unread-news count for the `n` badge. Omitted/0 renders no badge. */
  newsCount?: number;
};

export default function GlyphRail({ activeDeck, onDeckChange, newsCount }: GlyphRailProps) {
  return (
    <div className="glyph-rail">
      {GLYPHS.map((g) => {
        const pressed = activeDeck === g.key;
        const showBadge = g.key === "n" && typeof newsCount === "number" && newsCount > 0;
        return (
          <button
            key={g.key}
            type="button"
            className="glyph"
            aria-pressed={pressed}
            onClick={() => onDeckChange(pressed ? null : g.key)}
          >
            {showBadge && <span className="glyph-dot">{`•${newsCount}`}</span>}
            <span className="glyph-k">{g.key}</span>
            <span className="glyph-l">{g.label}</span>
          </button>
        );
      })}
    </div>
  );
}
