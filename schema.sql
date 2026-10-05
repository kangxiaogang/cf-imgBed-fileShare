-- PicoShare D1 schema. Idempotent: safe to re-run on a fresh database.
--
-- Single source of truth. There is no migration directory and no runtime DDL, so a column
-- can only be added by re-initialising the database. `CREATE TABLE IF NOT EXISTS` applies a
-- new *index* to an existing database but never a new *column*, and renaming a table or
-- column does not carry its data across.
--
-- Column names that also appear in an API response are kept identical to the response field
-- (`upload_time`, `expiration_time`, `entry_id`), so a read path has no mapping layer to get
-- wrong. Only internal columns are free to differ.

-- One row per upload. `object_key` always points at the current content in R2.
CREATE TABLE IF NOT EXISTS entries (
  id               TEXT PRIMARY KEY,
  filename         TEXT NOT NULL,
  content_type     TEXT,
  size             INTEGER NOT NULL,
  -- Null for objects above HASH_LIMIT_BYTES: hashing one means buffering it whole in the
  -- isolate, so large files are stored un-hashed and do not participate in dedup.
  sha256           TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  object_key       TEXT NOT NULL,
  note             TEXT,
  -- No foreign key. Deleting a guest link must leave its uploads in place (they fall back to
  -- the link's retention days), so the reference is cleared explicitly by `guest.ts`.
  guest_link_id    TEXT,
  upload_time      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_time     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Null means "keep forever".
  expiration_time  TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_recent   ON entries(upload_time DESC);
-- Partial: the cleanup scan only ever looks at rows that have an expiry, and on a
-- keep-forever deployment that is none of them.
CREATE INDEX IF NOT EXISTS idx_entries_expiry   ON entries(expiration_time) WHERE expiration_time IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_dedupe   ON entries(sha256, size) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_guest    ON entries(guest_link_id);

-- One row per retained version, including the current one. `systemInfo` sums `size` here
-- rather than on `entries` so historical versions count towards storage.
CREATE TABLE IF NOT EXISTS file_versions (
  entry_id     TEXT NOT NULL,
  version      INTEGER NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT,
  size         INTEGER NOT NULL,
  sha256       TEXT,
  object_key   TEXT NOT NULL,
  created_time TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (entry_id, version)
);

CREATE TABLE IF NOT EXISTS guest_links (
  id                     TEXT PRIMARY KEY,
  -- Private note. Never sent to the guest upload page.
  label                  TEXT,
  -- Not null with a product default rather than null: a null cap would read as "no limit"
  -- and let one guest submit 20 files of arbitrary size in a single request.
  max_file_bytes         INTEGER NOT NULL,
  -- Null means the uploaded files do not expire.
  max_file_lifetime_days INTEGER,
  max_file_uploads       INTEGER,
  -- Bounds when more uploads are *accepted*. It does not affect files already uploaded.
  url_expires            TEXT,
  upload_count           INTEGER NOT NULL DEFAULT 0,
  created_time           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_guest_links_recent ON guest_links(created_time DESC);

-- One row per share link: a revocable, expiring handle on an entry.
--
-- The entry's id used to be the share link. That made the two inseparable — the only way to stop
-- somebody downloading was to delete the file, because the id *was* the file. A share separates
-- them: expiring or revoking one leaves the entry and its bytes untouched, which is the whole
-- reason this table exists.
--
-- No foreign key, like every other reference here. `entries.remove` deletes a deleted entry's
-- shares explicitly, so a share cannot outlive the bytes it points at.
CREATE TABLE IF NOT EXISTS shares (
  id           TEXT PRIMARY KEY,
  entry_id     TEXT NOT NULL,
  -- Private note: who this link is for. Never sent to whoever opens it.
  label        TEXT,
  -- Null means the link does not expire. Bounds *the link*, not the file: an expired share
  -- answers 410 and nothing else, and the entry stays exactly where it was.
  expires_at   TEXT,
  created_time TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Serves both the detail page's list and the "newest share that still works" lookup the entry
-- list does per row, so entry_id leads.
CREATE INDEX IF NOT EXISTS idx_shares_entry ON shares(entry_id, created_time);
-- The sweep that reclaims rows is optional here — an expired share is already refused on read —
-- but an unreferenced share is still a row and a token in somebody's chat history.
CREATE INDEX IF NOT EXISTS idx_shares_expiry ON shares(expires_at) WHERE expires_at IS NOT NULL;

-- An in-flight chunked upload. `state` is what makes concurrent `complete` calls converge:
-- the session is claimed by flipping it from 'pending' to 'completing', and the row survives
-- that claim so a crash mid-complete leaves something diagnosable and reclaimable rather
-- than a silently lost upload.
CREATE TABLE IF NOT EXISTS upload_sessions (
  id                TEXT PRIMARY KEY,
  -- Set when this upload replaces an existing entry's content.
  entry_id          TEXT,
  is_replace        INTEGER NOT NULL DEFAULT 0,
  -- Optimistic lock for the replacement: the entry version the client last saw.
  expected_version  INTEGER,
  filename          TEXT NOT NULL,
  content_type      TEXT NOT NULL,
  size              INTEGER NOT NULL DEFAULT 0,
  object_key        TEXT NOT NULL,
  note              TEXT,
  expiration_time   TEXT,
  state             TEXT NOT NULL DEFAULT 'pending',
  created_time      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_created ON upload_sessions(created_time);
-- deleteEntry has to clear an entry's in-flight uploads, or their R2 parts are billed until
-- the abandoned-upload sweep runs.
CREATE INDEX IF NOT EXISTS idx_upload_sessions_entry   ON upload_sessions(entry_id);

CREATE TABLE IF NOT EXISTS upload_parts (
  session_id TEXT NOT NULL,
  part_no    INTEGER NOT NULL,
  etag       TEXT NOT NULL,
  PRIMARY KEY (session_id, part_no)
);

-- Written by unauthenticated GETs on the public file links, so it grows independently of the
-- entry's lifetime. Retention is the only thing that reclaims the visitor IP it stores.
CREATE TABLE IF NOT EXISTS download_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id      TEXT NOT NULL,
  downloaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_download_events_recent
  ON download_events(entry_id, downloaded_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO settings(key, value) VALUES ('store_forever', '1');
-- Seeds for a fresh database only: OR IGNORE leaves an existing row alone, so re-running this on a
-- live database never changes what the owner configured. Same number as
-- DEFAULT_EXPIRATION_DAYS in packages/shared/src/constants.ts, which SQL cannot import;
-- contract.test.ts reads the seeded value and fails if the two drift apart.
INSERT OR IGNORE INTO settings(key, value) VALUES ('default_expiration_days', '14');
