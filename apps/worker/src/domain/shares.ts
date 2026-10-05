import type { EntryMutationResponse, Share } from "@picoshare/shared";
import {
  MAX_EXPIRATION_DAYS,
  MAX_LABEL_LENGTH,
  absoluteUrl,
  bbcodeImage,
  bbcodeLink,
  entryUrlPath,
  isImageContentType,
  markdownImage,
  markdownLink,
} from "@picoshare/shared";
import { all, one } from "../platform/db";
import { generateID } from "../platform/id";
import { HttpError, publicOrigin } from "../platform/http";
import { expirationToISO, isExpired, nowIso, strictPositiveInt, str } from "../platform/parse";
import type { Env } from "../types";

/*
 * Share links: a revocable, expiring handle on an entry.
 *
 * The entry's id used to be the share link, which fused two different questions. "How long do I
 * keep this file?" and "how long may this person have the link?" have different answers — the
 * second is usually much shorter, and acting on it by deleting the file destroys the thing the
 * owner wanted to keep. A share answers the second question on its own, so revoking one costs
 * nothing and the only thing lost is the link.
 *
 * The id is the whole security model, exactly as the entry id was: 16 characters from a CSPRNG,
 * about 93 bits, with no server-side session to revoke and no low-entropy secret beside it. An
 * extraction code would change that — 4 digits is 13 bits — so it is deliberately absent.
 *
 * Expiry is checked on read and never deletes anything. An expired share answers 410 and the
 * entry stays; a *file* expiry, a different column on a different table, still removes the row
 * and the bytes. Those are the two cases a visitor can tell apart, so they get two messages.
 */

const COLUMNS = `id, entry_id, label, expires_at, created_time`;

/**
 * Request bodies, declared here because the handlers read a bare `Request` through
 * `readJson` and cannot be inferred. Both have to be declared *and* paired with the response
 * type on the registration: declaring only the input drops the response generic to `any`, which
 * is a type that satisfies everything and knows nothing.
 */
export type CreateShareBody = { label?: string | null; expiresInDays?: number | null };

export type UpdateShareBody = { label?: string | null; expiresInDays?: number | null };

/* ------------------------------------------------------------------ reads */

/**
 * Resolves a share token to the entry behind it.
 *
 * 404 for a token that was never issued, 410 for one that has stopped working: they mean
 * different things to whoever holds the link, the first being a wrong or mistyped URL and the
 * second a link that used to work.
 */
export async function resolve(env: Env, id: string): Promise<{ share: Share; entryId: string }> {
  const share = await get(env, id);
  if (!share) throw new HttpError(404, "分享链接不存在");
  if (isExpired(share.expires_at)) throw new HttpError(410, "分享链接已失效");
  return { share, entryId: share.entry_id };
}

export const get = (env: Env, id: string): Promise<Share | null> =>
  one<Share>(env, `SELECT ${COLUMNS} FROM shares WHERE id = ?`, id);

/** Every share on an entry, newest first. Expired ones stay listed: the owner can still see them. */
export const list = (env: Env, entryId: string): Promise<Share[]> =>
  all<Share>(
    env,
    `SELECT ${COLUMNS} FROM shares WHERE entry_id = ? ORDER BY created_time DESC, id DESC`,
    entryId,
  );

/**
 * The share each entry would hand out, as `entry_id -> share_id`.
 *
 * The oldest share that still works, because the one an upload mints never expires and should
 * stay the answer for as long as it is the only one. Excluding expired ones is what makes a
 * revoked-and-expired link stop being copied out of the list, and it is why this cannot be a
 * stored column on `entries`: the moment a share is revoked, a denormalised copy would disagree
 * with the table it was copied from.
 *
 * A correlated subquery, served by the index on `(entry_id, created_time)`, over the ids the
 * caller already has in hand — one extra round trip rather than a JOIN inside somebody else's
 * query, so the knowledge of this schema stays in this file.
 */
export async function liveShareIds(env: Env, entryIds: string[]): Promise<Map<string, string>> {
  if (!entryIds.length) return new Map();
  const placeholders = entryIds.map(() => "?").join(", ");
  const rows = await all<{ entry_id: string; share_id: string | null }>(
    env,
    `SELECT e.id AS entry_id,
            (SELECT s.id FROM shares s
              WHERE s.entry_id = e.id AND (s.expires_at IS NULL OR s.expires_at > ?)
              ORDER BY s.created_time ASC LIMIT 1) AS share_id
       FROM entries e
      WHERE e.id IN (${placeholders})`,
    // Bound in the order the placeholders appear: the subquery's cutoff first, then the id list.
    nowIso(),
    ...entryIds,
  );
  return new Map(rows.filter((row) => row.share_id).map((row) => [row.entry_id, row.share_id!]));
}

/* ------------------------------------------------------------------ writes */

/**
 * Issues a share.
 *
 * `expiresInDays === null` is a link that never expires, which is what an upload mints: the
 * image-host contract returns a URL the caller can use immediately, so an entry with no share
 * would hand back a dead link. It is also why a deduplicated re-upload mints a *new* share on
 * the entry it matched rather than reusing the existing one — otherwise pasting the same
 * screenshot twice would return a link the first recipient might already have had revoked.
 */
export async function create(
  env: Env,
  entryId: string,
  opts: {
    label?: string | null;
    /** An absolute instant, or null for a link that never ends. */
    expiresAt?: string | null;
  } = {},
): Promise<Share> {
  const share: Share = {
    id: generateID(),
    entry_id: entryId,
    label: str(opts.label ?? "", MAX_LABEL_LENGTH) || null,
    expires_at: opts.expiresAt ?? null,
    created_time: nowIso(),
  };
  await env.DB.prepare(
    `INSERT INTO shares (id, entry_id, label, expires_at, created_time) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(share.id, share.entry_id, share.label, share.expires_at, share.created_time)
    .run();
  return share;
}

/**
 * The links an upload hands back, and the share behind them.
 *
 * An image is minted one. The image-host contract returns a URL the caller can paste somewhere
 * immediately, so a hosted image with no link is not a hosted image — and the deduplicated case
 * comes out right for free, because `entries.create` returns the *existing* entry when the bytes
 * are already stored and minting against `saved.id` gives the second paste its own link rather
 * than the first one's, which the first recipient may already have revoked.
 *
 * A file gets none, and says so with a null url. That is the whole distinction: an image exists on
 * the web the moment it is uploaded, while a file in your library is not public until you decide
 * to share it. Creating the link is the owner's move, on the entry's share page.
 *
 * `reuseShare` covers replacing an entry's content, which promises the public URL keeps working.
 * A file that already has a share therefore still reports it here; one that has none reports null
 * rather than having a link invented for it.
 */
export async function mutationPayload(
  request: Request,
  env: Env,
  saved: { id: string; filename: string; sha256: string | null; version: number; deduped: boolean },
  contentType: string | null,
  opts: { reuseShare?: boolean } = {},
): Promise<EntryMutationResponse> {
  // Replacing an entry's content promises that the public URL keeps working, so handing back a
  // different one would contradict it. Every other caller mints, which is what makes a
  // deduplicated re-upload its own act of sharing rather than a second handle on the first
  // recipient's link.
  const reusable = opts.reuseShare ? await liveShare(env, saved.id) : null;
  const shareId = reusable ?? (isImageContentType(contentType) ? (await create(env, saved.id)).id : null);
  if (shareId === null) {
    return {
      id: saved.id,
      filename: saved.filename,
      version: saved.version,
      sha256: saved.sha256,
      deduped: saved.deduped,
      url: null,
      markdown: null,
      bbcode: null,
    };
  }
  const url = absoluteUrl(
    publicOrigin(request, env),
    entryUrlPath(shareId, saved.filename, contentType),
  );
  return {
    id: saved.id,
    filename: saved.filename,
    version: saved.version,
    sha256: saved.sha256,
    deduped: saved.deduped,
    ...(isImageContentType(contentType)
      ? { url, markdown: markdownImage(url, saved.filename), bbcode: bbcodeImage(url) }
      : { url, markdown: markdownLink(url, saved.filename), bbcode: bbcodeLink(url) }),
  };
}

export function expiryFromDays(value: unknown): string | null {
  if (value === null) return null;
  // `strictPositiveInt`, not `positiveInt`: `Number(true)` is 1, so `{"expiresInDays": true}`
  // would quietly mint a link that dies tomorrow and `{"expiresInDays": "7"}` would be accepted
  // on a field documented as a number. Guest-link fields still coerce — this one decides when
  // somebody loses access, so it is checked.
  const days = strictPositiveInt(value, MAX_EXPIRATION_DAYS);
  if (days === null) throw new HttpError(400, `链接有效天数必须是 1-${MAX_EXPIRATION_DAYS} 之间的数字`);
  return expirationToISO(days);
}

/** The entry's oldest share that still works, or null. What the list and detail report. */
export const liveShare = async (env: Env, entryId: string): Promise<string | null> => {
  const row = await one<{ share_id: string | null }>(
    env,
    `SELECT (SELECT s.id FROM shares s
              WHERE s.entry_id = e.id AND (s.expires_at IS NULL OR s.expires_at > ?)
              ORDER BY s.created_time ASC LIMIT 1) AS share_id
         FROM entries e WHERE e.id = ?`,
    nowIso(),
    entryId,
  );
  return row?.share_id ?? null;
};

export async function require(env: Env, id: string): Promise<Share> {
  const share = await get(env, id);
  if (!share) throw new HttpError(404, "分享不存在");
  return share;
}

/**
 * Re-points a share's label and expiry, for the owner's own view of it.
 *
 * `expiresInDays` absent leaves the expiry alone, so renaming a link cannot quietly make it
 * permanent. Sending null *does* clear it, which is the one way to un-expire a link.
 */
export async function update(
  env: Env,
  id: string,
  body: { label?: unknown; expiresInDays?: unknown },
): Promise<Share> {
  const share = await require(env, id);
  const sets: string[] = [];
  const args: unknown[] = [];
  let { label, expires_at: expiresAt } = share;

  if (body.label !== undefined) {
    label = str(body.label, MAX_LABEL_LENGTH) || null;
    sets.push("label = ?");
    args.push(label);
  }
  if (body.expiresInDays !== undefined) {
    expiresAt = expiryFromDays(body.expiresInDays);
    sets.push("expires_at = ?");
    args.push(expiresAt);
  }
  if (!sets.length) throw new HttpError(400, "没有需要更新的字段");

  args.push(id);
  await env.DB.prepare(`UPDATE shares SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
  return { ...share, label, expires_at: expiresAt };
}

/**
 * Revokes a share.
 *
 * The row goes rather than gaining a `revoked_at`: nothing reads a revoked share, and a row
 * whose only remaining job is to record that a token used to work is a token-shaped thing left
 * lying around. The owner's record of what they handed out is the entry, not the link.
 */
export async function remove(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM shares WHERE id = ?").bind(id).run();
}

/* ------------------------------------------------------------------ sweep */

/**
 * Drops shares that expired long enough ago that nobody can still be following the link.
 *
 * Housekeeping rather than correctness — an expired share is already refused on read — but a row
 * that outlives its usefulness is a working-looking token in somebody's chat history forever. The
 * grace period keeps "the link stopped working" and "the row disappeared" from being the same
 * instant, which would make the owner's own list flap.
 */
export async function prune(env: Env, graceDays = 30): Promise<number> {
  // One statement, like `downloads.prune`. The loop this replaces ran one DELETE per row — up to
  // a thousand round trips in a single maintenance run — and every row it targets shares the same
  // cutoff, so there is nothing per-row to decide. The inner SELECT keeps the batch bounded.
  const result = await env.DB.prepare(
    `DELETE FROM shares WHERE id IN (
       SELECT id FROM shares
        WHERE expires_at IS NOT NULL AND expires_at <= ?
        ORDER BY expires_at ASC LIMIT 1000
     )`,
  )
    .bind(expirationToISO(-graceDays))
    .run();
  return result.meta.changes ?? 0;
}
