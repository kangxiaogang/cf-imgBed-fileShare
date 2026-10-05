import type {
  Entry,
  EntryDetailResponse,
  EntryListItem,
  EntryListResponse,
  EntryMutationResponse,
} from "@picoshare/shared";
import {
  DEFAULT_PAGE_SIZE,
  MAX_EXPIRATION_DAYS,
  MAX_FILENAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PAGE_SIZE,
  isImageContentType,
} from "@picoshare/shared";
import { all, claim, one } from "../platform/db";
import { generateID } from "../platform/id";
import { HttpError } from "../platform/http";
import {
  bool,
  expirationToISO,
  isExpired,
  nonEmptyString,
  nowIso,
  strictPositiveInt,
  str,
} from "../platform/parse";
import { firstObjectKey, freshVersionKey, maybeHash } from "../platform/storage";
import * as downloads from "./downloads";
import * as shares from "./shares";
import * as versions from "./versions";
import type { EntryRow, Env } from "../types";

/*
 * The `entries` table, and the three invariants the rest of the app leans on.
 *
 * 1. `create` is the only way a new entry comes into existence. There are four upload shapes
 *    — a form post, a raw body, a guest form post, and a finished chunked upload — and they
 *    all converge here, so dedup, expiry and the version-1 bookkeeping cannot drift apart
 *    between them.
 *
 * 2. `require` is the only way an entry is read for use. Expiry is checked here rather than
 *    in the serving routes, because a route that reads the table directly can hand back a
 *    file already reported as gone — and a replacement would mint a fresh ETag for it.
 *    `list` is the deliberate exception: the list has to show expired rows, otherwise the
 *    owner cannot see what needs cleaning up.
 *
 * 3. `remove` is the only way an entry leaves. It is also the one function in the app that
 *    writes to tables it does not own, because a row outliving its referent is worse than
 *    the ownership rule: an orphaned version row points at bytes nothing will ever delete.
 */

export const CONFLICT = "文件已变更，请刷新后重试";

const MAX_BULK_DELETE = 100;
const MAX_SEARCH_LENGTH = 128;
// OFFSET degrades linearly, so an unbounded value lets one request ask D1 to walk the table.
const MAX_OFFSET = 100_000;

const COLUMNS = `id, filename, content_type, size, sha256, version, object_key,
  upload_time, updated_time, expiration_time, note, guest_link_id`;

/* ------------------------------------------------------------------ read */

export type Lookup =
  | { state: "ok"; entry: EntryRow }
  | { state: "missing" }
  | { state: "expired" };

/**
 * Resolve an id to a live entry, deleting it if it has expired.
 *
 * A result rather than a throw, because the public file links report expiry as a readable
 * page while the API reports it as a JSON error — the difference is presentation, and it
 * should not cost a second copy of the expiry rule.
 */
export async function lookup(env: Env, id: string): Promise<Lookup> {
  const entry = await one<EntryRow>(env, `SELECT ${COLUMNS} FROM entries WHERE id = ?`, id);
  if (!entry) return { state: "missing" };
  if (isExpired(entry.expiration_time)) {
    await remove(env, entry.id);
    return { state: "expired" };
  }
  return { state: "ok", entry };
}

export async function require(env: Env, id: string): Promise<EntryRow> {
  const found = await lookup(env, id);
  if (found.state === "missing") throw new HttpError(404, "文件不存在");
  if (found.state === "expired") throw new HttpError(410, "文件已过期");
  return found.entry;
}

/**
 * Drops the R2 key so it is never disclosed to a client.
 *
 * The concrete `Entry` return type is the point: a generic `Omit<T, "object_key">` accepted
 * any row shape, so a column added to or removed from `EntryRow` would be published to
 * clients unnoticed. Naming `Entry` makes the compiler reject both directions.
 *
 * `share_id` is passed in rather than read here. It is not a column — it is whichever share of
 * this entry still works right now, which is `shares`' knowledge to give and this module's to
 * ask for. Defaulting it to null would have been worse than the extra argument: the field has to
 * be answered, and a default invites the call site that forgets.
 */
const publicEntry = (row: EntryRow, shareId: string | null): Entry => {
  const { object_key: _key, ...rest } = row;
  return { ...rest, share_id: shareId };
};

/* ------------------------------------------------------------------ write */

/**
 * Where dedup is allowed to look.
 *
 * A discriminated union rather than `dedupe: boolean, guestLinkId: string | null`, because
 * the boolean form admits `true` with a null link and `false` with a link, and neither
 * combination means anything. "Guest uploads only dedupe inside their own link" is a
 * permission rule, not a filter, and it reads as one here.
 */
export type Dedupe =
  | { mode: "off" }
  | { mode: "global" }
  | { mode: "guest"; linkId: string };

export type NewEntry = {
  filename: string;
  contentType: string;
  bytes: ArrayBuffer | Uint8Array;
  note: string | null;
  expiresAt: string | null;
  guestLinkId?: string | null;
};

export type Created = {
  id: string;
  filename: string;
  version: number;
  sha256: string | null;
  deduped: boolean;
};

type RowInput = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string | null;
  objectKey: string;
  expiresAt: string | null;
  note: string | null;
  guestLinkId?: string | null;
};

/**
 * The entry row and its version-1 row, together.
 *
 * Shared by `create` and `adopt` because they must produce an identical pair: a version-1
 * row missing from `file_versions` is a version the settings page does not count towards
 * disk use, and nothing else would notice.
 */
const insertRows = (env: Env, row: RowInput) => {
  const now = nowIso();
  return env.DB.batch([
    env.DB.prepare(
      `INSERT INTO entries
        (id, filename, content_type, size, sha256, version, object_key,
         upload_time, updated_time, expiration_time, note, guest_link_id)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      row.filename,
      row.contentType,
      row.size,
      row.sha256,
      row.objectKey,
      now,
      now,
      row.expiresAt,
      row.note,
      row.guestLinkId ?? null,
    ),
    versions.insertInitial(env, row, now),
  ]);
};

/**
 * The single point where a new entry is created.
 *
 * An image whose bytes are already stored is not stored again; the caller gets the existing
 * link under the name they just uploaded. The filename has to be the new one because it ends
 * up as the alt text of the generated Markdown — a re-upload called `shot-2.png` should not
 * produce alt text from whatever the first upload was called.
 */
export async function create(env: Env, input: NewEntry, dedupe: Dedupe): Promise<Created> {
  const size = input.bytes.byteLength;
  const sha256 = await maybeHash(input.bytes, size);

  if (sha256 && dedupe.mode !== "off" && isImageContentType(input.contentType)) {
    const hit = await findDuplicate(env, sha256, size, dedupe);
    if (hit) {
      return {
        id: hit.id,
        filename: input.filename,
        version: hit.version,
        sha256: hit.sha256,
        deduped: true,
      };
    }
  }

  const id = generateID();
  const objectKey = firstObjectKey(id);
  try {
    // The object goes in before the row. The reverse order leaves a visible row pointing at
    // bytes that were never stored; this order leaves, in the worst case, an object no row
    // references — unreachable, since the id is unguessable, and reclaimable by a sweep.
    await env.BUCKET.put(objectKey, input.bytes, {
      httpMetadata: { contentType: input.contentType },
    });
    await insertRows(env, {
      id,
      filename: input.filename,
      contentType: input.contentType,
      size,
      sha256,
      objectKey,
      expiresAt: input.expiresAt,
      note: input.note,
      guestLinkId: input.guestLinkId,
    });
  } catch (err) {
    await env.BUCKET.delete(objectKey).catch(() => {});
    throw err;
  }
  return { id, filename: input.filename, version: 1, sha256, deduped: false };
}

/**
 * Registers an entry for content that is already in the bucket.
 *
 * The chunked-upload path cannot use `create`: `complete()` has just written the object, and
 * storing it again would cost the bytes twice. No dedup check either, and not as an
 * oversight — the chunked path only triggers above 100 MB while dedup only applies below
 * 32 MB, so there is no overlap to miss.
 */
export const adopt = async (env: Env, input: RowInput): Promise<Created> => {
  await insertRows(env, input);
  return {
    id: input.id,
    filename: input.filename,
    version: 1,
    sha256: input.sha256,
    deduped: false,
  };
};

async function findDuplicate(
  env: Env,
  sha256: string,
  size: number,
  scope: Exclude<Dedupe, { mode: "off" }>,
): Promise<EntryRow | null> {
  // An expired row with the same hash is not a match: handing back its link would answer
  // with a link that is already gone.
  const live = "(expiration_time IS NULL OR expiration_time > ?)";
  if (scope.mode === "global") {
    return one<EntryRow>(
      env,
      `SELECT ${COLUMNS} FROM entries WHERE sha256 = ? AND size = ? AND ${live} LIMIT 1`,
      sha256,
      size,
      nowIso(),
    );
  }
  return one<EntryRow>(
    env,
    `SELECT ${COLUMNS} FROM entries
      WHERE sha256 = ? AND size = ? AND guest_link_id = ? AND ${live} LIMIT 1`,
    sha256,
    size,
    scope.linkId,
    nowIso(),
  );
}

type Staged = {
  objectKey: string;
  contentType: string;
  size: number;
  sha256: string | null;
};

/**
 * Publishes staged content as the entry's new current version.
 *
 * The version bump is the serialisation point: it is guarded on the version the caller
 * expected, so of two concurrent replacements exactly one wins and the other gets a 409.
 * Everything here is ordered around that fact — the outgoing version is archived first
 * (its bytes are still the current ones), and the incoming version's row is written after
 * (a crash in between leaves a gap that the next archive fills, rather than a row for a
 * version the entry never reached).
 *
 * The two steps are not one transaction, deliberately: making them atomic requires the
 * version row's insert to be guarded on a subquery over the entry, which is true even when
 * the update matched nothing, so a lost race turns into a duplicate-key error instead of a
 * 409. Trading a self-healing gap for a clearer failure is the better deal — and the loser's
 * archive is undone by `versions.unarchive` so the gap does not also leave orphaned bytes.
 */
async function publish(
  env: Env,
  entry: EntryRow,
  staged: Staged,
  expectedVersion: number,
): Promise<number> {
  const version = expectedVersion + 1;
  const now = nowIso();

  const archived = await versions.archive(env, entry);

  const won = await claim(
    env,
    `UPDATE entries
        SET content_type = ?, size = ?, sha256 = ?, version = ?, object_key = ?, updated_time = ?
      WHERE id = ? AND version = ?`,
    staged.contentType,
    staged.size,
    staged.sha256,
    version,
    staged.objectKey,
    now,
    entry.id,
    expectedVersion,
  );
  if (!won) {
    // A concurrent replacement took the version first. The archive we just wrote belongs to
    // a version the entry never reached, so undo it rather than leave bytes and a row that
    // nothing references and the sweeps do not know about.
    if (archived) await versions.unarchive(env, entry.id, entry.version, archived);
    throw new HttpError(409, CONFLICT);
  }

  await versions.recordIncoming(
    env,
    {
      entryId: entry.id,
      version,
      filename: entry.filename,
      contentType: staged.contentType,
      size: staged.size,
      sha256: staged.sha256,
      objectKey: staged.objectKey,
    },
    now,
  );
  return version;
}

/** Replaces an entry's content with bytes the caller is holding. */
export async function replace(
  env: Env,
  entry: EntryRow,
  input: { bytes: ArrayBuffer | Uint8Array; contentType: string; expectedVersion: number },
): Promise<{ version: number; sha256: string | null }> {
  const size = input.bytes.byteLength;
  const sha256 = await maybeHash(input.bytes, size);
  const objectKey = freshVersionKey(entry.id, input.expectedVersion + 1);
  await env.BUCKET.put(objectKey, input.bytes, {
    httpMetadata: { contentType: input.contentType },
  });
  try {
    const version = await publish(
      env,
      entry,
      { objectKey, contentType: input.contentType, size, sha256 },
      input.expectedVersion,
    );
    return { version, sha256 };
  } catch (err) {
    await env.BUCKET.delete(objectKey).catch(() => {});
    throw err;
  }
}

/**
 * Replaces an entry's content with an object the caller has already stored, as the chunked
 * path does. The caller owns the object and is responsible for removing it if this throws.
 */
export const replaceStaged = (env: Env, entry: EntryRow, staged: Staged, expectedVersion: number) =>
  publish(env, entry, staged, expectedVersion);

/** The body `updateMetadata` accepts. Named so the route can declare its input to Hono. */
export type UpdateMetadataBody = {
  filename?: unknown;
  note?: unknown;
  expirationDays?: unknown;
  deleteAfterExpiration?: unknown;
};

/**
 * Updates only the fields the caller sent.
 *
 * Treating this as "overwrite everything" meant a partial call — a script sending just
 * `{filename}` — silently erased the note and the expiry.
 */
export async function updateMetadata(
  env: Env,
  id: string,
  body: UpdateMetadataBody,
): Promise<string> {
  const entry = await require(env, id);
  const sets: string[] = [];
  const args: unknown[] = [];
  let filename = entry.filename;

  if (body.filename !== undefined) {
    const next = nonEmptyString(body.filename, MAX_FILENAME_LENGTH);
    if (next === null) throw new HttpError(400, "文件名无效");
    filename = next;
    sets.push("filename = ?");
    args.push(filename);
  }
  if (body.note !== undefined) {
    sets.push("note = ?");
    args.push(str(body.note, MAX_NOTE_LENGTH) || null);
  }
  if (body.deleteAfterExpiration !== undefined) {
    // Type-checked, not presence-checked: any truthy value used to reach the "set an expiry"
    // branch, so `{"deleteAfterExpiration": "false"}` switched the expiry on.
    const flag = bool(body.deleteAfterExpiration);
    if (flag === null) throw new HttpError(400, "deleteAfterExpiration 必须为布尔值");
    if (flag) {
      // Clamped rather than rejected, to match the create path. This used to accept any
      // positive number, so 9999 days became a decade here and ten years over there, and nothing
      // in the response said which had happened.
      const days = strictPositiveInt(body.expirationDays, MAX_EXPIRATION_DAYS);
      if (days === null) throw new HttpError(400, "过期天数无效");
      sets.push("expiration_time = ?");
      args.push(expirationToISO(days));
    } else {
      sets.push("expiration_time = NULL");
    }
  }
  if (!sets.length) throw new HttpError(400, "没有需要更新的字段");

  // Always bumped so a rename invalidates the cached ETag, which embeds the filename.
  sets.push("updated_time = ?");
  args.push(nowIso(), id);
  await env.DB.prepare(`UPDATE entries SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
  return filename;
}

/* ------------------------------------------------------------------ remove */

/**
 * Clears an entry's guest-link reference without touching the entry.
 *
 * Called when a guest link is deleted. Its uploads are not deleted with it — they fall back
 * to the retention days they were given and reappear in the main list — so this is a
 * reference to clear, not a cascade. It lives here rather than in `guest.ts` so that the
 * `entries` table keeps exactly one writer.
 */
export const detachGuestLink = (env: Env, linkId: string): Promise<D1Result> =>
  env.DB.prepare("UPDATE entries SET guest_link_id = NULL WHERE guest_link_id = ?")
    .bind(linkId)
    .run();

/**
 * Removes an entry, every version of it, its events, and its in-flight uploads.
 *
 * Returns whether an entry row was actually there, so a caller deleting a batch can report a
 * real count instead of guessing from a separate `SELECT` (which also raced the delete).
 */
export async function remove(env: Env, id: string): Promise<boolean> {
  const [versionKeys, entry, sessions] = await Promise.all([
    versions.objectKeys(env, id),
    one<{ object_key: string }>(env, "SELECT object_key FROM entries WHERE id = ?", id),
    // Read before deleting: once the rows are gone the R2 upload ids exist nowhere, so the
    // abandoned sweep can never find them and their parts are billed until R2 expires them.
    all<{ id: string; object_key: string }>(
      env,
      "SELECT id, object_key FROM upload_sessions WHERE entry_id = ?",
      id,
    ),
  ]);

  // Stop each in-flight upload billing before its row disappears. A failure here (the upload
  // already completed, or never existed) must not abort the delete, so it is logged and the
  // delete proceeds.
  await Promise.all(
    sessions.map((session) =>
      env.BUCKET.resumeMultipartUpload(session.object_key, session.id)
        .abort()
        .catch((err) => console.warn("entry upload abort failed", session.id, err)),
    ),
  );

  const keys = new Set<string>([id, ...versionKeys]);
  if (entry) keys.add(entry.object_key);
  await env.BUCKET.delete([...keys]);
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM download_events WHERE entry_id = ?").bind(id),
    env.DB.prepare("DELETE FROM file_versions WHERE entry_id = ?").bind(id),
    env.DB.prepare("DELETE FROM upload_sessions WHERE entry_id = ?").bind(id),
    // Shares last, and in this batch rather than through `shares`: the reference is cleared by
    // the table being deleted, and `entries.remove` is the one place allowed to write outside its
    // own table for exactly this. A share outliving its entry would be a token still resolving in
    // somebody's chat history, pointing at bytes that are already gone.
    env.DB.prepare("DELETE FROM shares WHERE entry_id = ?").bind(id),
    env.DB.prepare("DELETE FROM entries WHERE id = ?").bind(id),
  ]);
  // The last statement in the batch is the entry delete; its row count is the whole answer.
  return (results[results.length - 1]?.meta.changes ?? 0) > 0;
}

export async function removeMany(env: Env, ids: string[]): Promise<number> {
  const unique = [...new Set(ids.map((id) => str(id, 64)).filter(Boolean))];
  // Rejecting rather than slicing: a silent truncation reports ids as deleted that were
  // never touched, and the caller has no way to notice.
  if (unique.length > MAX_BULK_DELETE) {
    throw new HttpError(400, `一次最多删除 ${MAX_BULK_DELETE} 个文件`);
  }
  let deleted = 0;
  for (const id of unique) {
    if (await remove(env, id)) deleted += 1;
  }
  return deleted;
}

/**
 * Deletes entries whose expiry has passed.
 *
 * The limit is low on purpose: `remove` costs roughly four subrequests per id, and a request
 * that exceeds the plan's subrequest cap throws for the whole batch. The trade-off is that a
 * large backlog drains over several hourly cycles — bounded by design, not by oversight.
 */
export async function cleanupExpired(env: Env, now = nowIso(), limit = 25): Promise<number> {
  const stale = await all<{ id: string }>(
    env,
    `SELECT id FROM entries
      WHERE expiration_time IS NOT NULL AND expiration_time <= ?
      ORDER BY expiration_time ASC LIMIT ?`,
    now,
    Math.max(1, Math.min(1000, limit)),
  );
  for (const row of stale) await remove(env, row.id);
  return stale.length;
}

/* ------------------------------------------------------------------ list and detail */

export type EntryQuery = {
  kind?: "all" | "image";
  q?: string;
  limit?: number;
  offset?: number;
};

const buildFilter = (query: EntryQuery): { where: string; params: string[] } => {
  const conditions: string[] = [];
  const params: string[] = [];
  if (query.kind === "image") conditions.push("e.content_type LIKE 'image/%'");
  // Capped: the leading wildcard makes this unindexable, so an unbounded term turns every
  // keystroke into a full table scan.
  const term = str(query.q, MAX_SEARCH_LENGTH).trim();
  if (term) {
    conditions.push("e.filename LIKE ? ESCAPE '\\'");
    params.push(`%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
};

/**
 * The one read that is allowed to see expired rows — the owner has to be able to see what
 * needs cleaning up. Everything else goes through `require`.
 */
export async function list(env: Env, query: EntryQuery = {}): Promise<EntryListResponse> {
  const limit = Math.max(
    1,
    Math.min(MAX_PAGE_SIZE, Math.floor(query.limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE),
  );
  const offset = Math.min(MAX_OFFSET, Math.max(0, Math.floor(query.offset ?? 0) || 0));
  const { where, params } = buildFilter(query);

  // A correlated subquery plus a separate COUNT, not a LEFT JOIN over an aggregated derived
  // table with COUNT(*) OVER(): the derived table is uncorrelated, so SQLite materialised
  // every download_events row, and the window function blocked idx_entries_recent from
  // satisfying the ORDER BY, turning a 50-row page into a full scan of both tables.
  const items = await all<EntryListItem>(
    env,
    `SELECT e.id, e.filename, e.content_type, e.size, e.sha256, e.version,
            e.upload_time, e.updated_time, e.expiration_time, e.note, e.guest_link_id,
            (SELECT COUNT(*) FROM download_events d WHERE d.entry_id = e.id) AS download_count
     FROM entries e
     ${where}
     ORDER BY e.upload_time DESC
     LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  // The COUNT runs even for an empty page: an offset past the end still has rows behind it,
  // and reporting `total: 0` there made the caller's "is there more" answer wrong.
  const counted = await one<{ count: number }>(
    env,
    `SELECT COUNT(*) AS count FROM entries e ${where}`,
    ...params,
  );
  // One extra round trip for the whole page rather than a correlated subquery per row, and the
  // knowledge of the `shares` schema stays in the module that owns it. The list is capped at 100
  // rows, so the id list is bounded by the same limit the caller already agreed to.
  const shareIds = await shares.liveShareIds(
    env,
    items.map((item) => item.id),
  );
  return {
    // `items` are already public-shaped: the query above selects the columns by name and never
    // fetches `object_key`, so this only has to graft the share on.
    items: items.map((item) => ({ ...item, share_id: shareIds.get(item.id) ?? null })),
    total: Number(counted?.count || 0),
  };
}

export async function detail(env: Env, id: string): Promise<EntryDetailResponse> {
  const entry = await require(env, id);
  const shareIds = await shares.liveShareIds(env, [id]);
  return {
    ...publicEntry(entry, shareIds.get(id) ?? null),
    download_count: await downloads.count(env, id),
  };
}

