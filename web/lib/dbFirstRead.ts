/**
 * DB-first read helper — Phase 0 of the Turso source-of-truth migration.
 *
 * Every disk-backed Next.js route follows the same shape:
 *   1. Try Turso first (latest snapshot row, parsed payload).
 *   2. Fall back to the on-disk JSON file when DB is empty / unreachable.
 *   3. Return null when neither is available; the route handler turns
 *      that into a 404.
 *
 * Centralizing the pattern in one place lets us:
 *   - swap to "DB-only" in Phase 5 with a single-file edit
 *   - log when the disk fallback fired (production drift signal)
 *   - keep the cache contract (force-dynamic + no-store) invariant
 */

export type DbFirstResult<T> =
  | { ok: true; source: "db" | "disk"; data: T }
  | { ok: false };

export type DbFirstReadOptions<T> = {
  /** Returns the parsed Turso payload, or null when no row exists. Throw to fall back to disk. */
  fromDb: () => Promise<T | null>;
  /** Returns the parsed disk payload, or null when the file is missing/empty. */
  fromDisk: () => Promise<T | null>;
  /**
   * Optional label used in console.warn when the disk fallback fires.
   * Helps identify which route is drifting in production logs.
   */
  label?: string;
};

export async function dbFirstRead<T>(
  options: DbFirstReadOptions<T>,
): Promise<DbFirstResult<T>> {
  const { fromDb, fromDisk, label } = options;

  try {
    const fromDbResult = await fromDb();
    if (fromDbResult !== null && fromDbResult !== undefined) {
      return { ok: true, source: "db", data: fromDbResult };
    }
  } catch (err) {
    // DB unreachable, schema missing, payload unparseable — log and fall through.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[dbFirstRead${label ? `:${label}` : ""}] DB read failed: ${message}`);
  }

  try {
    const diskResult = await fromDisk();
    if (diskResult !== null && diskResult !== undefined) {
      console.warn(
        `[dbFirstRead${label ? `:${label}` : ""}] DB empty or failed; serving disk fallback.`,
      );
      return { ok: true, source: "disk", data: diskResult };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[dbFirstRead${label ? `:${label}` : ""}] disk read failed: ${message}`);
  }

  return { ok: false };
}
