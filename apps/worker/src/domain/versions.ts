import type { FileVersion } from "@picoshare/shared";
import { HASH_LIMIT_BYTES } from "@picoshare/shared";
import { all, one } from "../platform/db";
import { HttpError } from "../platform/http";
import { nowIso } from "../platform/parse";
import { archiveKey } from "../platform/storage";
import { sha256Hex } from "../platform/hash";
import type { EntryRow, Env, VersionRow } from "../types";

/*
 * The `file_versions` table. One row per version ever published, including the current one —
 * `systemInfo` sums its `size` column to report disk use, so a version that is not listed
 * is a version whose bytes nobody is counting.
 *
 * The write order matters and is the reason this is its own module rather than part of the
 * replacement path: on a replacement the outgoing version is archived *before* the entry's
 * version is bumped, and the incoming version is recorded *after*. Recording it before would
 * leave a row for a version the entry had not reached, which is wrong data in the version
 * list; recording it after means a crash leaves a gap that the next archive fills.
 */

const COLUMNS = "entry_id, version, filename, content_type, size, sha256, created_time, object_key";

/* ------------------------------------------------------------------ reads */

export const get = (env: Env, entryId: string, version: number): Promise<VersionRow | null> =>
  one<VersionRow>(
    env,
    `SELECT ${COLUMNS} FROM file_versions WHERE entry_id = ? AND version = ?`,
    entryId,
    version,
  );

export const rows = (env: Env, entryId: string): Promise<VersionRow[]> =>
  all<VersionRow>(
    env,
    `SELECT ${COLUMNS} FROM file_versions WHERE entry_id = ? ORDER BY version DESC`,
    entryId,
  );

/**
 * Drops the R2 key so it is never disclosed to a client.
 *
 * The concrete `FileVersion` return type is the point: a generic `Omit<T, "object_key">`
 * signature accepts any row shape, so a column added to or removed from `VersionRow` would
 * be published to clients unnoticed.
 */
const toPublic = (row: VersionRow): FileVersion => {
  const { object_key: _key, ...rest } = row;
  return rest;
};

export const list = async (env: Env, entryId: string): Promise<FileVersion[]> =>
  (await rows(env, entryId)).map(toPublic);

export const objectKeys = async (env: Env, entryId: string): Promise<string[]> =>
  (await all<{ object_key: string }>(
    env,
    "SELECT object_key FROM file_versions WHERE entry_id = ?",
    entryId,
  )).map((row) => row.object_key);

/* ------------------------------------------------------------------ writes */

/** The version-1 row, written together with the entry itself. */
export const insertInitial = (
  env: Env,
  entry: { id: string; filename: string; contentType: string; size: number; sha256: string | null; objectKey: string },
  now: string,
): D1PreparedStatement =>
  env.DB.prepare(
    `INSERT INTO file_versions (entry_id, version, filename, content_type, size, sha256, created_time, object_key)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    entry.id,
    entry.filename,
    entry.contentType,
    entry.size,
    entry.sha256,
    now,
    entry.objectKey,
  );

/**
 * Records the entry's *current* version, copying its bytes aside if they are not already
 * stored under the archive key.
 *
 * Returns the R2 key it created, or `null` when it only refreshed the version-1 row in place
 * (nothing was copied, so there is nothing for a caller to undo). The key is returned rather
 * than assumed because a caller that loses its version claim has to remove exactly this copy.
 *
 * Version 1's bytes live at the bare entry id and its row already points there, so there is
 * nothing to copy — writing `archiveKey(id, 1)` would leave the original referenced by
 * nothing and double the stored bytes for the life of the entry. Only the row's metadata
 * needs refreshing, because a rename updates `entries` and not `file_versions`.
 */
export async function archive(env: Env, entry: EntryRow): Promise<string | null> {
  if (entry.version === 1 && entry.object_key === entry.id) {
    await env.DB.prepare(
      `UPDATE file_versions SET filename = ?, content_type = ?, size = ?, sha256 = ?
       WHERE entry_id = ? AND version = 1`,
    )
      .bind(entry.filename, entry.content_type, entry.size, entry.sha256, entry.id)
      .run();
    return null;
  }

  const object = await env.BUCKET.get(entry.object_key);
  if (!object) throw new HttpError(500, "当前文件内容不存在");

  // Small enough to hash while already in memory; a large object would be re-read whole, so
  // it keeps whatever hash the entry was created with.
  let body: ArrayBuffer | ReadableStream = object.body;
  let sha256 = entry.sha256;
  if (entry.size <= HASH_LIMIT_BYTES) {
    const buffer = await object.arrayBuffer();
    body = buffer;
    sha256 = await sha256Hex(buffer);
  }

  const key = archiveKey(entry.id, entry.version);
  await env.BUCKET.put(key, body, {
    httpMetadata: { contentType: entry.content_type || "application/octet-stream" },
  });
  await write(env, {
    entryId: entry.id,
    version: entry.version,
    filename: entry.filename,
    contentType: entry.content_type,
    size: entry.size,
    sha256,
    createdTime: entry.updated_time || entry.upload_time || nowIso(),
    objectKey: key,
  });
  return key;
}

/**
 * Undoes an `archive` whose version claim was lost.
 *
 * The archive is written before the claim because the outgoing bytes have to be safe before
 * they are overwritten (see `publish`), so a lost race leaves a copy behind. When the two
 * callers expected *different* versions — the case a same-version race does not hit, since
 * both would write the identical deterministic key — the loser's key belongs to a version
 * the entry never took, and nothing would ever reclaim it. Removing exactly that key and its
 * row restores the state the loser found.
 */
export async function unarchive(env: Env, entryId: string, version: number, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM file_versions WHERE entry_id = ? AND version = ?")
    .bind(entryId, version)
    .run();
  await env.BUCKET.delete(key).catch(() => {});
}

/**
 * Records the version a replacement has just published. Idempotent, because the entry's
 * version bump and this insert are not one transaction: a crash between them leaves the row
 * missing, and the next archive writes it.
 */
export const recordIncoming = (
  env: Env,
  row: {
    entryId: string;
    version: number;
    filename: string;
    contentType: string;
    size: number;
    sha256: string | null;
    objectKey: string;
  },
  now: string,
): Promise<D1Result> =>
  write(env, { ...row, createdTime: now });

/** Replaces the row for a version if one is already there. */
const write = (
  env: Env,
  row: {
    entryId: string;
    version: number;
    filename: string;
    contentType: string | null;
    size: number;
    sha256: string | null;
    createdTime: string;
    objectKey: string;
  },
): Promise<D1Result> =>
  env.DB.prepare(
    `INSERT INTO file_versions (entry_id, version, filename, content_type, size, sha256, created_time, object_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id, version) DO UPDATE SET
       filename = excluded.filename,
       content_type = excluded.content_type,
       size = excluded.size,
       sha256 = excluded.sha256,
       object_key = excluded.object_key`,
  )
    .bind(
      row.entryId,
      row.version,
      row.filename,
      row.contentType,
      row.size,
      row.sha256,
      row.createdTime,
      row.objectKey,
    )
    .run();

/* ------------------------------------------------------------------ removal */

export async function remove(env: Env, entryId: string, version: number): Promise<void> {
  const row = await get(env, entryId, version);
  if (!row) throw new HttpError(404, "版本不存在");
  await env.BUCKET.delete(row.object_key);
  await env.DB.prepare("DELETE FROM file_versions WHERE entry_id = ? AND version = ?")
    .bind(entryId, version)
    .run();
}
