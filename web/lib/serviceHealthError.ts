/**
 * Normalize ``service_health.last_error`` payloads into a single human-
 * readable line of plain text suitable for direct rendering inside the
 * dashboard banner.
 *
 * Why this exists
 * ---------------
 * The DB column stores ``last_error`` as a JSON-stringified object — the
 * Python writer at ``scripts/db/writer.py`` and the JS writer in
 * ``lib/serviceHealth.ts`` both hand the row whatever the worker raised
 * (Exception, dict, string) wrapped in ``json.dumps`` /
 * ``JSON.stringify``. The banner used to concatenate that raw string into
 * its copy, leaking ``{"message": "..."}`` braces and quotes to users —
 * worse, when the payload exceeded the visible width it would mid-word
 * cut off, exposing a syntactically broken JSON fragment.
 *
 * This helper:
 *   1. Accepts the raw value (string, object, or null/undefined).
 *   2. Parses JSON strings into objects when possible.
 *   3. Pulls a human-readable message from one of the conventional keys
 *      — ``message``, ``error``, ``detail``, ``reason`` — in that order.
 *   4. Falls back to ``"service unavailable"`` when nothing useful is
 *      present (null payload, empty object, parse failure with no string
 *      content to surface).
 *   5. Truncates cleanly at a word boundary with an ellipsis so we never
 *      mid-cut a word into the visible UI.
 *   6. Strips structural JSON characters defensively so even an exotic
 *      payload shape can't leak ``{``, ``"``, or ``}`` into the banner.
 */

const FALLBACK_MESSAGE = "service unavailable";
const DEFAULT_MAX_LENGTH = 80;
const ELLIPSIS = "...";
// Conventional keys, MOST common first. The first present and non-empty
// wins — order matters because some rows ship multiple fields.
const MESSAGE_KEYS = ["message", "error", "detail", "reason"] as const;

export type ServiceHealthErrorInput =
  | string
  | Record<string, unknown>
  | null
  | undefined;

export type FormatOptions = {
  maxLength?: number;
};

/**
 * Public entry point. Always returns a string suitable for direct
 * rendering — never null, never an object, never a JSON fragment.
 */
export function formatServiceHealthError(
  raw: ServiceHealthErrorInput,
  options: FormatOptions = {},
): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const candidate = extractCandidate(raw);
  const sanitized = sanitize(candidate);
  if (!sanitized) return FALLBACK_MESSAGE;
  return truncateAtWordBoundary(sanitized, maxLength);
}

/**
 * Resolve the raw input down to a candidate string. Returns ``""`` when
 * nothing meaningful is available — callers translate that into the
 * fallback copy.
 */
function extractCandidate(raw: ServiceHealthErrorInput): string {
  if (raw == null) return "";
  if (typeof raw === "string") {
    const parsed = tryParseJson(raw);
    if (parsed && typeof parsed === "object") {
      // Successfully parsed JSON: trust the structured shape. If no
      // recognised message key exists, surface the fallback rather
      // than dumping the raw string back through the sanitiser — that
      // would expose internal field names like ``wal_conflicts_observed``.
      return pickFromObject(parsed as Record<string, unknown>) ?? "";
    }
    return raw;
  }
  if (typeof raw === "object") {
    return pickFromObject(raw as Record<string, unknown>) ?? "";
  }
  return String(raw);
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Walk the conventional message keys and return the first non-empty
 * string value. Numeric and boolean values are coerced; nested objects
 * are skipped so we never bubble structure back into the banner.
 */
function pickFromObject(obj: Record<string, unknown>): string | null {
  for (const key of MESSAGE_KEYS) {
    const value = obj[key];
    if (value == null) continue;
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return null;
}

/**
 * Strip JSON structural characters and collapse whitespace so the final
 * string is a single clean line of plain text. Defensive — covers cases
 * where the candidate is a JSON fragment we couldn't parse.
 */
function sanitize(candidate: string): string {
  if (!candidate) return "";
  return candidate
    .replace(/[{}"\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Trim to ``maxLength`` characters, preferring the last whitespace
 * boundary to avoid mid-word cuts. Falls back to a hard cut when the
 * remainder is so short the boundary would lose too much context.
 */
function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const budget = Math.max(1, maxLength - ELLIPSIS.length);
  const slice = text.slice(0, budget);
  const lastSpace = slice.lastIndexOf(" ");
  // Only honor the boundary when it preserves meaningful context — at
  // least two-thirds of the budget. Otherwise hard-cut.
  if (lastSpace >= Math.floor(budget * 0.66)) {
    return `${slice.slice(0, lastSpace).trimEnd()}${ELLIPSIS}`;
  }
  return `${slice.trimEnd()}${ELLIPSIS}`;
}
