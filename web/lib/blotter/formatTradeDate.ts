const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Render a journal-derived trade time as a calendar date in the user's
 * locale. Handles the journal's date-only persistence (`filled_at` =
 * "YYYY-MM-DD") without the UTC-midnight tz shift that drops the day
 * back by one in any zone west of UTC. ISO inputs with a time component
 * pass through to the standard local-tz formatter.
 */
export function formatTradeDate(input: string | null | undefined): string {
  if (!input) return "";
  const dateOnly = DATE_ONLY_RE.exec(input);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString();
  }
  return new Date(input).toLocaleDateString();
}
