import type { MultipartInitRequest, MultipartInitResponse, OkResponse } from "@picoshare/shared";
import { MAX_FILENAME_LENGTH, MAX_NOTE_LENGTH, MULTIPART_CHUNK_SIZE_BYTES } from "@picoshare/shared";
import { all, claim, one } from "../platform/db";
import { generateID } from "../platform/id";
import { HttpError, assertBodyWithinLimit, json, readBodyWithinLimit, readJson } from "../platform/http";
import { nowIso, str, useMultipart } from "../platform/parse";
import { freshVersionKey, hashObject } from "../platform/storage";
import * as entries from "./entries";
import * as shares from "./shares";
import { resolveExpiration } from "./settings";
import type { Env, UploadSessionRow } from "../types";

/*
 * Chunked uploads: the `upload_sessions` and `upload_parts` tables.
 *
 * The only interesting part is how a `complete` is made to happen once. Two callers hitting
 * it at the same time would both pass a "does this session exist" check, and the loser's
 * error path would then tear down the object the winner had just published — leaving an
 * entry pointing at deleted bytes.
 *
 * The fix is a state column rather than a `DELETE ... RETURNING` claim. Flipping `pending`
 * to `completing` picks one winner, and the row survives the flip: if that request dies
 * mid-flight, the session is still there for the abandoned sweep to reclaim, instead of
 * being erased by the very statement that was supposed to protect it. A row that outlives
 * the request that owned it is recoverable; a deleted one is not.
 */

const ABANDONED_AGE_MS = 24 * 60 * 60 * 1000;
// R2 requires every non-final part to be at least 5 MiB; the client sends 8 MiB chunks, so
// this leaves room for a larger configured chunk while still bounding the buffer.
const MAX_PART_BYTES = MULTIPART_CHUNK_SIZE_BYTES * 4;

const COLUMNS = `id, entry_id, is_replace, expected_version, filename, content_type,
  size, object_key, note, expiration_time, state`;

const session = (env: Env, id: string) =>
  one<UploadSessionRow>(env, `SELECT ${COLUMNS} FROM upload_sessions WHERE id = ?`, id);

const requireUploadId = async (request: Request): Promise<string> => {
  const body = await readJson<{ uploadId?: string }>(request);
  const id = typeof body.uploadId === "string" ? body.uploadId : "";
  if (!id) throw new HttpError(400, "缺少 uploadId");
  return id;
};

const forget = (env: Env, id: string) =>
  env.DB.batch([
    env.DB.prepare("DELETE FROM upload_parts WHERE session_id = ?").bind(id),
    env.DB.prepare("DELETE FROM upload_sessions WHERE id = ?").bind(id),
  ]);

/**
 * Stops an in-flight R2 upload from billing further.
 *
 * Deliberately does not touch the object. Once `complete()` has run, `abort()` fails and a
 * blanket cleanup would delete bytes the entry may already reference — the failure this
 * function used to cause. Reclaiming the object is `reclaim`'s job, and only when nothing
 * points at it.
 */
async function stopBilling(env: Env, row: UploadSessionRow): Promise<void> {
  try {
    await env.BUCKET.resumeMultipartUpload(row.object_key, row.id).abort();
  } catch (err) {
    // Already completed, or never existed. Either way the sweep still has the row.
    console.warn("upload abort failed", row.id, err);
  }
}

/** Frees everything a dead session was holding, once nothing references its object. */
async function reclaim(env: Env, row: UploadSessionRow): Promise<void> {
  await stopBilling(env, row);
  const linked = await one(env, "SELECT 1 AS linked FROM entries WHERE object_key = ?", row.object_key);
  if (!linked) await env.BUCKET.delete(row.object_key).catch(() => {});
  await forget(env, row.id);
}

/* ------------------------------------------------------------------ lifecycle */

export async function init(request: Request, env: Env) {
  const body = await readJson<MultipartInitRequest>(request);
  const filename = str(body.filename, MAX_FILENAME_LENGTH) || `upload-${generateID()}.bin`;
  const contentType = str(body.contentType, 255) || "application/octet-stream";
  // `Number(...)` on purpose: this is a public image-hosting endpoint, so a client sending
  // `"size": "104857600"` must keep working. Finiteness is what matters below — a boolean
  // body yields 1 and is rejected by the threshold check with a less precise message, which
  // is a wording nit rather than a hole.
  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 0) throw new HttpError(400, "文件大小无效");
  if (!useMultipart(size)) throw new HttpError(400, "小于 100MB 的文件请使用普通上传");

  const note = str(body.note, MAX_NOTE_LENGTH) || null;
  const expirationTime = await resolveExpiration(env, body.expirationDays);

  const requestedId = str(body.entryId, 64);
  let entryId: string;
  let objectKey: string;
  let isReplace = 0;
  let expectedVersion: number | null = null;

  if (requestedId) {
    const existing = await entries.require(env, requestedId);
    if (filename !== existing.filename) throw new HttpError(400, "替换文件必须保持相同文件名");
    const expected = Number(body.version ?? existing.version);
    if (!Number.isInteger(expected) || expected !== existing.version) {
      throw new HttpError(409, entries.CONFLICT);
    }
    entryId = existing.id;
    expectedVersion = expected;
    objectKey = freshVersionKey(existing.id, expected + 1);
    isReplace = 1;
  } else {
    entryId = generateID();
    objectKey = entryId;
  }

  const upload = await env.BUCKET.createMultipartUpload(objectKey, {
    httpMetadata: { contentType },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO upload_sessions
        (id, entry_id, is_replace, expected_version, filename, content_type, size,
         object_key, note, expiration_time, state, created_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
      .bind(
        upload.uploadId,
        entryId,
        isReplace,
        expectedVersion,
        filename,
        contentType,
        Math.floor(size),
        objectKey,
        note,
        expirationTime,
        nowIso(),
      )
      .run();
  } catch (err) {
    // Without this the R2 upload id exists nowhere, and the abandoned sweep can only find
    // sessions by their row, so these parts would be billed forever.
    await env.BUCKET.resumeMultipartUpload(objectKey, upload.uploadId).abort().catch(() => {});
    throw err;
  }

  return json({ uploadId: upload.uploadId, id: entryId, chunkSize: MULTIPART_CHUNK_SIZE_BYTES }, 201);
}

export async function part(request: Request, env: Env, uploadId: string, partNumber: number) {
  const row = await session(env, uploadId);
  if (!row) throw new HttpError(404, "分片上传不存在");
  assertBodyWithinLimit(request, MAX_PART_BYTES, "分片过大");

  const uploaded = await env.BUCKET.resumeMultipartUpload(row.object_key, row.id).uploadPart(
    partNumber,
    // Same running cap as the raw-body path: a chunk sent without `Content-Length` would
    // otherwise be buffered whole before the header check could have rejected it.
    await readBodyWithinLimit(request, MAX_PART_BYTES, "分片过大"),
  );
  await env.DB.prepare(
    "INSERT OR REPLACE INTO upload_parts (session_id, part_no, etag) VALUES (?, ?, ?)",
  )
    .bind(uploadId, uploaded.partNumber, uploaded.etag)
    .run();
  return json({ ok: true as const, partNumber: uploaded.partNumber });
}

export async function complete(request: Request, env: Env) {
  const uploadId = await requireUploadId(request);
  const row = await session(env, uploadId);
  if (!row) throw new HttpError(404, "分片上传不存在或已完成");

  // The claim. Exactly one caller flips this row, and the other gets 0 rows changed.
  const won = await claim(
    env,
    "UPDATE upload_sessions SET state = 'completing' WHERE id = ? AND state = 'pending'",
    uploadId,
  );
  if (!won) throw new HttpError(404, "分片上传不存在或已完成");

  // From here the session is dead to everyone else: no retry, no abort. The row stays until
  // the end so that a throw below is still reclaimable by the sweep.
  let completed = false;
  try {
    const parts = await all<{ partNumber: number; etag: string }>(
      env,
      "SELECT part_no AS partNumber, etag FROM upload_parts WHERE session_id = ? ORDER BY part_no ASC",
      uploadId,
    );
    if (!parts.length) throw new HttpError(400, "没有已上传的分片");

    // A replace session whose entry is gone fails here with 404 (require throws) rather than
    // falling into the `adopt` branch below, which mints a new entry under the session's id.
    const existing = row.is_replace ? await entries.require(env, row.entry_id || "") : null;
    if (existing && row.expected_version !== null && existing.version !== row.expected_version) {
      throw new HttpError(409, entries.CONFLICT);
    }

    await env.BUCKET.resumeMultipartUpload(row.object_key, row.id).complete(parts);
    completed = true;

    // Trust the object, not the client: `init` only checked that the *declared* size was
    // above the threshold, and that number is what the 416 boundary and `Content-Range` are
    // computed from when the entry is later served.
    const head = await env.BUCKET.head(row.object_key);
    const size = head?.size ?? row.size;
    if (row.size > 0 && size !== row.size) {
      console.warn("upload size mismatch", uploadId, row.size, size);
    }

    const contentType = row.content_type || "application/octet-stream";
    const sha256 = await hashObject(env, row.object_key, size);
    let version = 1;

    if (existing) {
      version = await entries.replaceStaged(
        env,
        existing,
        { objectKey: row.object_key, contentType, size, sha256 },
        row.expected_version ?? existing.version,
      );
    } else {
      await entries.adopt(env, {
        id: row.entry_id || "",
        filename: row.filename,
        contentType,
        size,
        sha256,
        objectKey: row.object_key,
        expiresAt: row.expiration_time,
        note: row.note,
      });
    }
    await forget(env, uploadId);
    return json(
      await shares.mutationPayload(
        request,
        env,
        { id: row.entry_id || "", filename: row.filename, version, sha256, deduped: false },
        contentType,
        // A replace promises the public URL keeps working, and this path is the chunked twin of
        // `replaceContentRoute`. Without `reuseShare` a large replacement would answer with a
        // freshly minted token while the small one hands back the existing link — the same
        // operation giving two different answers depending only on the file's size.
        { reuseShare: existing !== null },
      ),
    );
  } catch (err) {
    if (completed) {
      // The upload is finished, so there is nothing left to stop billing and the object may
      // already be an entry's content. Leave both alone; the sweep reclaims whatever the
      // object turns out not to be.
      throw err;
    }
    // Still in flight: stop it billing and drop the partial object now, rather than leaving
    // it for the 24-hour sweep.
    await stopBilling(env, row);
    await env.BUCKET.delete(row.object_key).catch(() => {});
    throw err;
  }
}

export async function abort(request: Request, env: Env) {
  const uploadId = await requireUploadId(request);
  const row = await session(env, uploadId);
  if (row) {
    // The client gave up, so nothing was ever published and both the upload and the object
    // can go immediately.
    await env.BUCKET.resumeMultipartUpload(row.object_key, row.id).abort().catch(() => {});
    await env.BUCKET.delete(row.object_key).catch(() => {});
    await forget(env, uploadId);
  }
  return json({ ok: true } satisfies OkResponse);
}

/* ------------------------------------------------------------------ sweep */

export async function cleanupAbandoned(
  env: Env,
  olderThan = new Date(Date.now() - ABANDONED_AGE_MS).toISOString(),
  limit = 50,
): Promise<number> {
  // Any state, not just 'pending': a session stuck in 'completing' holds a finished object
  // that nothing references, and that is the expensive kind to leave behind.
  const stale = await all<UploadSessionRow>(
    env,
    `SELECT ${COLUMNS} FROM upload_sessions
      WHERE created_time < ? ORDER BY created_time ASC LIMIT ?`,
    olderThan,
    Math.max(1, Math.min(500, limit)),
  );
  for (const row of stale) await reclaim(env, row);
  return stale.length;
}
