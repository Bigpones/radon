-- 0010_user_profiles_bookmarks_watchlist.sql
-- User-scoped feature foundation: profile, saved newsfeed posts (bookmarks),
-- and tracked tickers (watchlist). Keyed by the Clerk user_id (TEXT).
--
-- Conventions mirror 0001_init.sql: ISO-8601 TEXT timestamps (UTC),
-- nullable optional columns, JSON payloads stored as TEXT.

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id     TEXT    PRIMARY KEY,
  username    TEXT,                 -- nullable: display name
  avatar_url  TEXT,                 -- nullable: data: URL or https URL
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id        TEXT    PRIMARY KEY,
  user_id   TEXT    NOT NULL,
  post_id   TEXT    NOT NULL,
  snapshot  TEXT,                   -- nullable: JSON snapshot of the saved post
  saved_at  TEXT    NOT NULL,
  UNIQUE (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS bookmarks_user_date ON bookmarks(user_id, saved_at DESC);

-- NB: a `watchlist` table already exists (migration 0004 — the surveillance
-- ticker store keyed by `ticker`). This user-scoped per-account table is
-- therefore named `user_watchlist` to avoid clobbering it.
CREATE TABLE IF NOT EXISTS user_watchlist (
  id        TEXT    PRIMARY KEY,
  user_id   TEXT    NOT NULL,
  symbol    TEXT    NOT NULL,
  sector    TEXT,                   -- nullable
  added_at  TEXT    NOT NULL,
  UNIQUE (user_id, symbol)
);
CREATE INDEX IF NOT EXISTS user_watchlist_user_date ON user_watchlist(user_id, added_at DESC);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES (10, datetime('now'));
