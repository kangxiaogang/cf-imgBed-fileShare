import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_EXPIRATION_DAYS } from "@picoshare/shared";
import type {
  DownloadEvent,
  EntryDetailResponse,
  EntryDownloadsResponse,
  EntryListItem,
  EntryVersionsResponse,
  FileVersion,
  GuestInfo,
  GuestLink,
  Settings,
  SystemInfo,
} from "@picoshare/shared";
import * as entries from "../src/domain/entries";
import { detail, list } from "../src/domain/entries";
import { history } from "../src/domain/downloads";
import { entryVersionsPayload } from "../src/routes";
import { info, list as listGuestLinks } from "../src/domain/guest";
import { getSettings, systemInfo } from "../src/domain/settings";
import * as shares from "../src/domain/shares";
import { HttpError } from "../src/platform/http";
import type { EntryRow } from "../src/types";
import { keysOf, sqliteEnv, type SqliteEnv } from "./sqlite";

/**
 * Contract tests: the response body of a real query, checked against the type the frontend
 * consumes.
 *
 * The type parameters in `api.get<EntryListResponse>()` and `.all<Entry>()` are assertions,
 * not checks, so nothing else in the suite can see a field that was renamed on one side
 * only. Declaring the expectation as `Record<keyof T, 1>` ties the two together: the
 * compiler rejects a missing or extra key (so the list cannot rot), and the runtime
 * assertion catches a row whose columns no longer match the type.
 */

/**
 * A key list that only compiles when it is exactly `keyof T`, and yields the keys at
 * runtime. The literal must be written out: a cast would defeat the point, since the whole
 * value of this is that adding a field to the type without updating every contract fails
 * the build instead of silently passing.
 */
const ENTRY_LIST_ITEM_KEYS: Record<keyof EntryListItem, 1> = {
  id: 1,
  filename: 1,
  content_type: 1,
  size: 1,
  sha256: 1,
  version: 1,
  upload_time: 1,
  updated_time: 1,
  expiration_time: 1,
  note: 1,
  guest_link_id: 1,
  share_id: 1,
  download_count: 1,
};

const ENTRY_DETAIL_KEYS: Record<keyof EntryDetailResponse, 1> = { ...ENTRY_LIST_ITEM_KEYS };

const ENTRY_ROW_KEYS: Record<keyof EntryRow, 1> = {
  id: 1,
  filename: 1,
  content_type: 1,
  size: 1,
  sha256: 1,
  version: 1,
  upload_time: 1,
  updated_time: 1,
  expiration_time: 1,
  note: 1,
  guest_link_id: 1,
  object_key: 1,
};

const FILE_VERSION_KEYS: Record<keyof FileVersion, 1> = {
  entry_id: 1,
  version: 1,
  filename: 1,
  content_type: 1,
  size: 1,
  sha256: 1,
  created_time: 1,
};

const DOWNLOAD_EVENT_KEYS: Record<keyof DownloadEvent, 1> = {
  downloaded_at: 1,
  ip: 1,
  user_agent: 1,
};

const ENTRY_VERSIONS_KEYS: Record<keyof EntryVersionsResponse, 1> = { versions: 1 };

const ENTRY_DOWNLOADS_KEYS: Record<keyof EntryDownloadsResponse, 1> = { total: 1, events: 1 };

const GUEST_LINK_KEYS: Record<keyof GuestLink, 1> = {
  id: 1,
  label: 1,
  created_time: 1,
  max_file_bytes: 1,
  max_file_lifetime_days: 1,
  max_file_uploads: 1,
  url_expires: 1,
  upload_count: 1,
  entry_count: 1,
};

const GUEST_INFO_KEYS: Record<keyof GuestInfo, 1> = {
  max_file_bytes: 1,
  max_file_lifetime_days: 1,
  max_file_uploads: 1,
  remaining_uploads: 1,
  max_files: 1,
  url_expires: 1,
};

const SETTINGS_KEYS: Record<keyof Settings, 1> = { storeForever: 1, defaultDays: 1 };

const SYSTEM_INFO_KEYS: Record<keyof SystemInfo, 1> = {
  upload_data_bytes: 1,
  entry_count: 1,
  guest_link_count: 1,
  download_count: 1,
};

const expectSameKeys = (actual: unknown, expected: Record<string, 1>) => {
  expect(keysOf(actual)).toEqual(Object.keys(expected).sort());
};

let open: SqliteEnv | null = null;
const seed = (options?: Parameters<typeof sqliteEnv>[0]) => {
  open = sqliteEnv(options);
  return open;
};

afterEach(() => {
  open?.close();
  open = null;
});

const seedEntry = (env: SqliteEnv) => {
  env.exec(
    `INSERT INTO entries (id, filename, content_type, size, sha256, version, object_key, upload_time, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    "abc123",
    "photo.png",
    "image/png",
    3,
    "deadbeef",
    1,
    "abc123",
    "2026-09-26T00:00:00.000Z",
    "a note",
  );
};

describe("contract: entries", () => {
  it("listEntries returns exactly the EntryListItem keys", async () => {
    const env = seed();
    seedEntry(env);
    env.exec("INSERT INTO download_events (entry_id) VALUES (?)", "abc123");

    const page = await list(env.env);

    expect(page.total).toBe(1);
    expectSameKeys(page.items[0], ENTRY_LIST_ITEM_KEYS);
    // A subquery alias that silently stopped being selected would still satisfy the type.
    expect(page.items[0].download_count).toBe(1);
  });

  it("entryDetail returns exactly the EntryDetailResponse keys", async () => {
    const env = seed();
    seedEntry(env);
    env.exec("INSERT INTO download_events (entry_id) VALUES (?)", "abc123");

    const body = await detail(env.env, "abc123");

    expectSameKeys(body, ENTRY_DETAIL_KEYS);
    // object_key is an internal R2 key and must never reach a client.
    expect(body).not.toHaveProperty("object_key");
    expect(body.download_count).toBe(1);
  });

  it("entryVersions returns exactly the EntryVersionsResponse keys", async () => {
    const env = seed();
    seedEntry(env);
    env.exec(
      `INSERT INTO file_versions (entry_id, version, filename, content_type, size, sha256, object_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "abc123",
      1,
      "photo.png",
      "image/png",
      3,
      "deadbeef",
      "abc123",
    );

    const body = await entryVersionsPayload(env.env, "abc123");

    expectSameKeys(body, ENTRY_VERSIONS_KEYS);
    const versions = body.versions as FileVersion[];
    expect(versions[0].entry_id).toBe("abc123");
    expect(versions[0]).not.toHaveProperty("object_key");
  });

  it("entryDownloads returns exactly the EntryDownloadsResponse keys", async () => {
    const env = seed();
    seedEntry(env);
    env.exec(
      "INSERT INTO download_events (entry_id, downloaded_at, ip, user_agent) VALUES (?, ?, ?, ?)",
      "abc123",
      "2026-09-26T00:00:00.000Z",
      "1.1.1.1",
      "curl/8",
    );

    const body = await history(env.env, "abc123", false);

    expectSameKeys(body, ENTRY_DOWNLOADS_KEYS);
    expectSameKeys((body.events as DownloadEvent[])[0], DOWNLOAD_EVENT_KEYS);
    expect(body.total).toBe(1);
  });
});

describe("contract: shares", () => {
  /**
   * Every one of these runs against SQLite built from `schema.sql`. The distinction the whole
   * table exists for is that a share's expiry is checked on read and deletes nothing, while an
   * entry's expiry removes the row and the bytes — and a mock cannot tell those apart, because
   * both are "a lookup that throws".
   */
  const seedShare = (env: SqliteEnv, id: string, entryId: string, expiresAt: string | null) =>
    env.exec(
      "INSERT INTO shares (id, entry_id, expires_at, created_time) VALUES (?, ?, ?, ?)",
      id,
      entryId,
      expiresAt,
      "2026-09-26T00:00:00.000Z",
    );

  /** Rows, read straight off the handle: these assertions are about what is still in the table. */
  const idsIn = (env: SqliteEnv, table: string): string[] =>
    (env.db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>).map(
      (row) => row.id,
    );

  /** Relative to now, because the sweep's grace period is a moving window. */
  const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

  it("issues a share that resolves to its entry", async () => {
    const env = seed();
    seedEntry(env);
    const share = await shares.create(env.env, "abc123");

    const found = await shares.resolve(env.env, share.id);
    expect(found.entryId).toBe("abc123");
    expect(found.share.label).toBeNull();
  });

  it("refuses an expired share without touching the entry", async () => {
    // The whole point. A 410 here must leave the row in place, so the owner can still see the
    // file and mint another link — where an entry expiry would have removed both.
    const env = seed();
    seedEntry(env);
    const share = await shares.create(env.env, "abc123", { expiresAt: shares.expiryFromDays(1) });
    env.exec("UPDATE shares SET expires_at = ? WHERE id = ?", "2020-01-01T00:00:00.000Z", share.id);

    const err = await shares.resolve(env.env, share.id).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(410);
    expect(idsIn(env, "entries")).toEqual(["abc123"]);
    expect(idsIn(env, "shares")).toEqual([share.id]);
  });

  it("404s a token that was never issued, which is a different thing to the holder", async () => {
    const env = seed();
    const err = await shares.resolve(env.env, "nope").catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(404);
  });

  it("keeps an entry reachable through a share that has not expired", async () => {
    const env = seed();
    seedEntry(env);
    const share = await shares.create(env.env, "abc123", { label: "给同事", expiresAt: shares.expiryFromDays(7) });

    const found = await shares.resolve(env.env, share.id);
    expect(found.share.label).toBe("给同事");
    expect(found.share.expires_at).not.toBeNull();
  });

  it("hands out the oldest share that still works, and null once none do", async () => {
    const env = seed();
    seedEntry(env);
    // Two live shares and one dead: the dead one must not become the answer just by being first.
    seedShare(env, "old-live", "abc123", null);
    seedShare(env, "new-live", "abc123", null);
    seedShare(env, "gone", "abc123", "2020-01-01T00:00:00.000Z");

    let page = await list(env.env);
    expect(page.items[0].share_id).toBe("old-live");

    env.exec("DELETE FROM shares WHERE id IN ('old-live', 'new-live')");
    page = await list(env.env);
    expect(page.items[0].share_id).toBeNull();
    expect((await detail(env.env, "abc123")).share_id).toBeNull();
  });

  it("survives revoking the share the entry was handing out", async () => {
    // Revoking has to be possible without losing the file, or the table buys nothing.
    const env = seed();
    seedEntry(env);
    const share = await shares.create(env.env, "abc123");
    expect((await detail(env.env, "abc123")).share_id).toBe(share.id);

    await shares.remove(env.env, share.id);

    expect((await detail(env.env, "abc123")).share_id).toBeNull();
    expect(idsIn(env, "entries")).toEqual(["abc123"]);
  });

  it("clears an entry's shares when the entry is removed", async () => {
    // No foreign key anywhere in this schema, so nothing does this for us. A share outliving its
    // entry would be a token that resolves to nothing, and the bytes it named are already gone.
    const env = seed();
    seedEntry(env);
    await shares.create(env.env, "abc123");
    await shares.create(env.env, "abc123");

    await entries.remove(env.env, "abc123");

    expect(idsIn(env, "shares")).toEqual([]);
  });

  it("prunes shares well after they stopped working, not the moment they did", async () => {
    // An expired share is already refused on read, so pruning is housekeeping. Doing it at the
    // instant of expiry would make the owner's list flap between "expired" and "gone".
    const env = seed();
    seedEntry(env);
    seedShare(env, "recent", "abc123", daysAgo(10));
    seedShare(env, "ancient", "abc123", daysAgo(90));

    const pruned = await shares.prune(env.env);

    expect(pruned).toBe(1);
    expect(idsIn(env, "shares")).toEqual(["recent"]);
  });
});

describe("contract: guest", () => {
  const seedGuest = (env: SqliteEnv, overrides: Record<string, unknown> = {}) => {
    const link = {
      label: "同事小王",
      max_file_bytes: 1024,
      max_file_lifetime_days: 7,
      max_file_uploads: 3,
      url_expires: "2026-12-31T00:00:00.000Z",
      ...overrides,
    };
    env.exec(
      `INSERT INTO guest_links (id, label, max_file_bytes, max_file_lifetime_days, max_file_uploads, url_expires, created_time, upload_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "g1",
      link.label,
      link.max_file_bytes,
      link.max_file_lifetime_days,
      link.max_file_uploads,
      link.url_expires,
      "2026-09-26T00:00:00.000Z",
      1,
    );
  };

  it("listGuestLinks returns exactly the GuestLink keys", async () => {
    const env = seed();
    seedGuest(env);
    seedEntry(env);
    env.exec("UPDATE entries SET guest_link_id = ? WHERE id = ?", "g1", "abc123");

    const links = await listGuestLinks(env.env);

    expectSameKeys(links[0], GUEST_LINK_KEYS);
    expect(links[0].entry_count).toBe(1);
  });

  it("guestInfo returns exactly the GuestInfo keys", async () => {
    // This is the endpoint that drifted: the server emitted camelCase while the view read
    // snake_case off a `GuestLink`, so every field resolved to undefined and the page
    // rendered "大小不限" for a limit that was being enforced.
    const env = seed();
    seedGuest(env);

    const body = await info(env.env, "g1");

    expectSameKeys(body, GUEST_INFO_KEYS);
    expect(body.max_file_bytes).toBe(1024);
    expect(body.max_file_uploads).toBe(3);
    // 3 allowed, 1 already spent.
    expect(body.remaining_uploads).toBe(2);
    expect(body.url_expires).toBe("2026-12-31T00:00:00.000Z");
    // The creator's private note must not be disclosed to the guest.
    expect(body).not.toHaveProperty("label");
  });

  it("guestInfo reports a null quota when the link is unlimited", async () => {
    const env = seed();
    seedGuest(env, { max_file_uploads: null, url_expires: null });

    const body = await info(env.env, "g1");

    expect(body.max_file_uploads).toBeNull();
    expect(body.remaining_uploads).toBeNull();
    expect(body.url_expires).toBeNull();
  });
});

describe("contract: settings", () => {
  it("getSettings returns exactly the Settings keys", async () => {
    const env = seed();
    env.exec("UPDATE settings SET value = ? WHERE key = ?", "0", "store_forever");
    env.exec("UPDATE settings SET value = ? WHERE key = ?", "7", "default_expiration_days");

    const settings = await getSettings(env.env);

    expectSameKeys(settings, SETTINGS_KEYS);
    expect(settings.storeForever).toBe(false);
    expect(settings.defaultDays).toBe(7);
  });

  it("seeds a fresh database with the same days the fallback returns", async () => {
    // schema.sql writes the seed row out as text because SQL cannot import from packages/shared.
    // Nothing else could have noticed the two drifting apart: a database built from the schema
    // would answer "14" to "how long do files live" while a database missing the row — or one
    // holding a value this build no longer recognises — answered with whatever the constant had
    // since become. Same question, two answers, depending on which row survived.
    const env = seed();

    const settings = await getSettings(env.env);

    expect(settings.storeForever).toBe(true);
    expect(settings.defaultDays).toBe(DEFAULT_EXPIRATION_DAYS);
  });

  it("systemInfo returns exactly the SystemInfo keys", async () => {
    const env = seed();
    seedEntry(env);
    // systemInfo sums file_versions, not entries, so a bare entry row totals nothing.
    env.exec(
      `INSERT INTO file_versions (entry_id, version, filename, content_type, size, sha256, object_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "abc123",
      1,
      "photo.png",
      "image/png",
      3,
      "deadbeef",
      "abc123",
    );

    const body = await systemInfo(env.env);

    expectSameKeys(body, SYSTEM_INFO_KEYS);
    expect(body.entry_count).toBe(1);
    expect(body.upload_data_bytes).toBe(3);
  });
});

describe("contract: the row types match schema.sql", () => {
  it("an Entry is spelled the way the entries table is", async () => {
    // Guards the underlying assumption of every `.all<Entry>()` call: the SELECT list and the
    // row type agree. A column renamed in schema.sql leaves both the query and the type
    // compiling while the value comes back undefined.
    const env = seed();
    seedEntry(env);

    const row = await env.env.DB
      .prepare(
        "SELECT id, filename, content_type, size, sha256, version, object_key, upload_time, updated_time, expiration_time, note, guest_link_id FROM entries WHERE id = ?",
      )
      .bind("abc123")
      .first<EntryRow>();

    expectSameKeys(row, ENTRY_ROW_KEYS);
    expect(row?.filename).toBe("photo.png");
  });
});
