import type { GuestInfo, GuestLink, GuestUploadItem, GuestUploadResponse } from "@picoshare/shared";
import {
  MAX_EXPIRATION_DAYS,
  MAX_GUEST_FILE_BYTES,
  MAX_GUEST_REQUEST_BYTES,
  MAX_GUEST_UPLOADS,
  MAX_LABEL_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PASTE_LENGTH,
  MAX_GUEST_UPLOAD_FILES,
  formatMiB,
} from "@picoshare/shared";
import { all, claim, one } from "../platform/db";
import { generateID } from "../platform/id";
import { HttpError, assertBodyWithinLimit, json, readJson } from "../platform/http";
import { asFile, expirationToISO, isExpired, nowIso, parseDate, positiveInt, str } from "../platform/parse";
import * as entries from "./entries";
import * as shares from "./shares";
import type { Env, GuestLinkRow } from "../types";

/*
 * Guest links: a time-boxed, quota-boxed upload opening handed to somebody who has no
 * account here.
 *
 * Two things are load-bearing. The quota is reserved with a conditional `UPDATE`, so N
 * guests submitting at once cannot collectively exceed the cap, and a submission that then
 * fails gives the reservation back. And deleting a link does not delete what it collected —
 * the uploads go back to the main list and keep the retention days they were given, because
 * the link's expiry bounds *further uploads*, not the files already accepted.
 */

const COLUMNS = `g.id, g.label, g.created_time, g.max_file_bytes, g.max_file_lifetime_days,
  g.max_file_uploads, g.url_expires, g.upload_count`;

/* ------------------------------------------------------------------ the link */

export const get = (env: Env, id: string): Promise<GuestLinkRow | null> =>
  one<GuestLinkRow>(env, `SELECT ${COLUMNS} FROM guest_links g WHERE g.id = ?`, id);

export async function require(env: Env, id: string): Promise<GuestLinkRow> {
  const link = await get(env, id);
  if (!link) throw new HttpError(404, "访客链接不存在");
  if (isExpired(link.url_expires)) throw new HttpError(410, "访客链接已过期");
  return link;
}

export const list = (env: Env): Promise<GuestLink[]> =>
  all<GuestLink>(
    env,
    `SELECT ${COLUMNS}, (SELECT COUNT(*) FROM entries e WHERE e.guest_link_id = g.id) AS entry_count
     FROM guest_links g
     ORDER BY g.created_time DESC`,
  );

export async function create(request: Request, env: Env) {
  const body = await readJson<{
    label?: unknown;
    max_file_bytes?: unknown;
    max_file_lifetime_days?: unknown;
    max_file_uploads?: unknown;
    url_expires?: unknown;
  }>(request);

  const urlExpires = parseDate(body.url_expires);
  if (body.url_expires && (!urlExpires || Date.parse(urlExpires) <= Date.now())) {
    throw new HttpError(400, "链接失效日期无效");
  }

  const id = generateID();
  await env.DB.prepare(
    `INSERT INTO guest_links
      (id, label, max_file_bytes, max_file_lifetime_days, max_file_uploads, url_expires, created_time, upload_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      id,
      str(body.label, MAX_LABEL_LENGTH) || null,
      // Real defaults, not null: the size cap is applied with a truthiness check, so a null
      // would read as "unlimited" and let one guest fill the bucket in a single request.
      positiveInt(body.max_file_bytes, MAX_GUEST_FILE_BYTES) ?? MAX_GUEST_FILE_BYTES,
      positiveInt(body.max_file_lifetime_days, MAX_EXPIRATION_DAYS),
      positiveInt(body.max_file_uploads, MAX_GUEST_UPLOADS) ?? MAX_GUEST_UPLOADS,
      urlExpires,
      nowIso(),
    )
    .run();
  return json({ id }, 201);
}

/**
 * Deletes the link and detaches its uploads.
 *
 * The second statement is the one that matters. With no foreign key to cascade, dropping
 * only the link row left the entries fully reachable at their public URLs while the list
 * query stopped counting them — revoked in appearance, still live in fact. Detaching makes
 * them ownerless and visible in the main list, where they can be deleted.
 */
export async function remove(env: Env, id: string) {
  // Two statements, two tables, and the first one is not this module's to write: the
  // reference is cleared through `entries`, so that table has a single writer.
  await entries.detachGuestLink(env, id);
  await env.DB.prepare("DELETE FROM guest_links WHERE id = ?").bind(id).run();
  return json({ ok: true as const });
}

/* ------------------------------------------------------------------ what a guest is told */

/**
 * The limits, not the bookkeeping.
 *
 * `label` is withheld because it is the creator's private note ("同事小王"). `url_expires`
 * is disclosed: knowing when your own access ends is not a leak.
 */
export async function info(env: Env, id: string): Promise<GuestInfo> {
  const link = await require(env, id);
  return {
    max_file_bytes: link.max_file_bytes,
    max_file_lifetime_days: link.max_file_lifetime_days,
    max_file_uploads: link.max_file_uploads,
    // The remainder rather than the raw counter, so a page cannot render a quota that is
    // already spent from a value it read before the last upload.
    remaining_uploads:
      link.max_file_uploads === null
        ? null
        : Math.max(0, link.max_file_uploads - (link.upload_count || 0)),
    max_files: MAX_GUEST_UPLOAD_FILES,
    url_expires: link.url_expires,
  };
}

/* ------------------------------------------------------------------ uploading */

type Candidate = {
  filename: string;
  contentType: string;
  size: number;
  read: () => Promise<ArrayBuffer | Uint8Array>;
};

const candidatesFrom = (fd: FormData): Candidate[] => {
  const files = fd.getAll("files").map(asFile).filter((file): file is File => file !== null);
  if (files.length > MAX_GUEST_UPLOAD_FILES) {
    throw new HttpError(413, `一次最多上传 ${MAX_GUEST_UPLOAD_FILES} 个文件`);
  }
  const candidates: Candidate[] = files.map((file) => ({
    filename: str(file.name, 255) || `guest-file-${generateID(6)}`,
    contentType: str(file.type, 255) || "application/octet-stream",
    size: file.size,
    read: () => file.arrayBuffer(),
  }));

  const pasted = str(fd.get("pastedText"), MAX_PASTE_LENGTH).trim();
  if (pasted) {
    const bytes = new TextEncoder().encode(pasted);
    candidates.push({
      filename: `guest-paste-${generateID(6)}.txt`,
      contentType: "text/plain",
      size: bytes.byteLength,
      read: async () => bytes,
    });
  }
  return candidates;
};

/**
 * Reserves `count` slots against the link's cap.
 *
 * The check and the increment are one statement, so a guest cannot pass the check and then
 * be pre-empted by another guest before the write lands. Uncapped links still get a counter
 * bumped: the owner's list shows how much a link has actually been used.
 */
const reserve = (env: Env, link: GuestLinkRow, count: number): Promise<boolean> =>
  link.max_file_uploads
    ? claim(
        env,
        `UPDATE guest_links SET upload_count = COALESCE(upload_count, 0) + ?
          WHERE id = ? AND COALESCE(upload_count, 0) + ? <= ?`,
        count,
        link.id,
        count,
        link.max_file_uploads,
      )
    : claim(
        env,
        "UPDATE guest_links SET upload_count = COALESCE(upload_count, 0) + ? WHERE id = ?",
        count,
        link.id,
      );

export async function upload(request: Request, env: Env, id: string) {
  const link = await require(env, id);
  // Before `formData()`: the per-file cap below is worthless for memory safety once the
  // whole body has been buffered.
  assertBodyWithinLimit(request, MAX_GUEST_REQUEST_BYTES, "访客单次上传总量超出上限");
  const fd = await request.formData();
  const note = str(fd.get("note"), MAX_NOTE_LENGTH) || null;
  const candidates = candidatesFrom(fd);
  if (!candidates.length) throw new HttpError(400, "请先选择文件或粘贴文本");

  const tooLarge = candidates.find((item) => item.size > link.max_file_bytes);
  if (tooLarge) {
    throw new HttpError(
      413,
      `文件 ${tooLarge.filename} 超过上限 ${formatMiB(link.max_file_bytes)}MB`,
    );
  }

  const count = candidates.length;
  if (!(await reserve(env, link, count))) {
    throw new HttpError(429, "该访客链接的上传次数已达上限");
  }

  // The link's retention days, not the global setting: a guest's files belong to that link's
  // terms, and a global "keep forever" must not silently extend someone else's quota.
  const expiresAt = link.max_file_lifetime_days ? expirationToISO(link.max_file_lifetime_days) : null;
  const items: GuestUploadItem[] = [];
  let deduped = 0;

  try {
    for (const candidate of candidates) {
      const saved = await entries.create(
        env,
        {
          filename: candidate.filename,
          contentType: candidate.contentType,
          bytes: await candidate.read(),
          note,
          expiresAt,
          guestLinkId: link.id,
        },
        // Scoped to this link: the public URL *is* the credential, so reusing another
        // guest's upload would hand this guest a link that is not theirs.
        { mode: "guest", linkId: link.id },
      );
      if (saved.deduped) deduped += 1;
      items.push({
        ...(await shares.mutationPayload(request, env, saved, candidate.contentType)),
        contentType: candidate.contentType,
      });
    }
  } catch (err) {
    // Give back what was taken for the files that did not land, so a guest that hits an
    // error on file three is not charged for all four.
    await env.DB.prepare(
      "UPDATE guest_links SET upload_count = MAX(0, COALESCE(upload_count, 0) - ?) WHERE id = ?",
    )
      .bind(count - items.length, link.id)
      .run();
    throw err;
  }

  return json(
    {
      count: items.length,
      items,
      upload_count: (link.upload_count || 0) + items.length,
      deduped,
    } satisfies GuestUploadResponse,
    201,
  );
}
