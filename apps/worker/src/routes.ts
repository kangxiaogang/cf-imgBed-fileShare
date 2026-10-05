import type { Context, MiddlewareHandler } from "hono";
import {
  MAX_FILENAME_LENGTH,
  MAX_FORM_UPLOAD_BYTES,
  MAX_NOTE_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PASTE_LENGTH,
  MAX_SINGLE_UPLOAD_BYTES,
  MULTIPART_UPLOAD_THRESHOLD_BYTES,
  imageLinkPath,
  type BulkDeleteResponse,
  type EntryDownloadsResponse,
  type EntryMutationResponse,
  type OkResponse,
  type UpdateMetadataResponse,
} from "@picoshare/shared";
import { generateID } from "./platform/id";
import {
  HttpError,
  assertBodyWithinLimit,
  authorized,
  clientIp,
  cors,
  fireAndForget,
  json,
  rateLimit,
  readBodyWithinLimit,
  readJson,
  text,
  type JsonResponse,
} from "./platform/http";
import { asFile, parsePartNumber, str, tryDecode } from "./platform/parse";
import { FORCE_ATTACHMENT, parseImageLinkPath, serveObject } from "./platform/serve";
import * as downloads from "./domain/downloads";
import * as entries from "./domain/entries";
import * as guest from "./domain/guest";
import * as settings from "./domain/settings";
import * as shares from "./domain/shares";
import type { CreateShareBody, UpdateShareBody } from "./domain/shares";
import * as uploads from "./domain/uploads";
import * as versions from "./domain/versions";
import { run as runMaintenance } from "./domain/maintenance";
import type { Env, EntryRow } from "./types";

/*
 * The HTTP layer: everything that knows a request exists.
 *
 * A handler here may parse a body, read a path parameter, and pick a status code. It may not
 * contain a rule — where a limit is enforced, what a quota means, when a row is written.
 * That is the whole reason `app.ts` can stay a readable list of routes: the logic is in
 * `domain/`, one module per table.
 */

/* ------------------------------------------------------------------ middleware */

const CLEANUP_INTERVAL = 60 * 1000;
let lastCleanup = 0;

/**
 * Answers the browser's CORS preflight. Separate from `maintenance` because it is a routing
 * concern, not a cleanup one: every route can be preflighted, and the 204 has to come back
 * before any handler sees the request.
 */
export const corsPreflight: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  await next();
};

export const maintenance: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  // The cron only runs when the Worker is awake, so a deployment nobody visits could leave
  // expired files in place indefinitely. Running it on the way past costs one background
  // job per minute at most, and never delays the response.
  const now = Date.now();
  if (now - lastCleanup > CLEANUP_INTERVAL) {
    lastCleanup = now;
    fireAndForget(c, runMaintenance(c.env).catch((err) => console.error("maintenance failed", err)));
  }
  await next();
};

// The two public guest endpoints. Everything else under /api needs the secret.
const PUBLIC_API = /^\/api\/guest\/[^/]+\/(info|upload)$/;

export const authorize: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (PUBLIC_API.test(c.req.path)) return next();
  if (!authorized(c.req.raw, c.env)) {
    if (!rateLimit(`auth:${clientIp(c.req.raw)}`, 20, 5 * 60_000)) {
      throw new HttpError(429, "尝试过于频繁，请稍后再试");
    }
    throw new HttpError(401, "未授权，请检查访问密钥");
  }
  await next();
};

/**
 * A handler's context, narrowed to its route path so `c.req.param("id")` is a `string` and
 * not `string | undefined`. Without the path argument Hono cannot know which params exist,
 * and every call site would need a non-null assertion.
 */
export type Route<P extends string = string> = Context<{ Bindings: Env }, P>;

/* ------------------------------------------------------------------ uploads */

/**
 * One upload endpoint, two request encodings.
 *
 * `multipart/form-data` is what a browser and every mainstream image-host tool sends. A raw
 * body is what a shell one-liner sends: `curl --data-binary @shot.png`. They produce the
 * same entry and the same response, so they are one route rather than two — which also
 * means `?token=` auth has a single path it is allowed on, instead of one per encoding.
 */
export const createEntryRoute = async (c: Route<"/api/entry">) => {
  const request = c.req.raw;
  const type = c.req.header("Content-Type") || "";
  return type.toLowerCase().startsWith("multipart/form-data")
    ? fromForm(request, c.env)
    : fromRawBody(request, c.env, new URL(request.url));
};

const TOO_LARGE = "文件过大，请使用分片上传";

async function fromForm(request: Request, env: Env): Promise<JsonResponse<EntryMutationResponse>> {
  assertBodyWithinLimit(request, MAX_FORM_UPLOAD_BYTES, TOO_LARGE);
  const fd = await request.formData();
  const file = asFile(fd.get("file"));
  const pasted = str(fd.get("pastedText"), MAX_PASTE_LENGTH).trim();
  if (!file && !pasted) throw new HttpError(400, "缺少文件或文本内容");
  // The threshold was once enforced only in the browser, so one request could ask for a
  // multi-hundred-megabyte allocation inside a 128 MB isolate.
  if (file && file.size >= MULTIPART_UPLOAD_THRESHOLD_BYTES) throw new HttpError(413, TOO_LARGE);

  const note = str(fd.get("note"), MAX_NOTE_LENGTH) || null;
  const expiresAt = await settings.resolveExpiration(env, str(fd.get("expirationDays"), 32) || null);

  let filename = `paste-${Date.now()}.txt`;
  let contentType = "text/plain";
  let bytes: ArrayBuffer | Uint8Array = new TextEncoder().encode(pasted);
  if (file) {
    bytes = await file.arrayBuffer();
    filename = str(file.name, MAX_FILENAME_LENGTH) || filename;
    contentType = str(file.type, 255) || "application/octet-stream";
  }

  const saved = await entries.create(
    env,
    { filename, contentType, bytes, note, expiresAt },
    { mode: "global" },
  );
  return json(
    await shares.mutationPayload(request, env, saved, contentType),
    saved.deduped ? 200 : 201,
  );
}

/**
 * The raw-body shape. The filename rides in the query string, because the body is the file.
 */
async function fromRawBody(
  request: Request,
  env: Env,
  url: URL,
): Promise<JsonResponse<EntryMutationResponse>> {
  assertBodyWithinLimit(request, MAX_SINGLE_UPLOAD_BYTES, TOO_LARGE);
  // A tool that omits Content-Type gets a binary entry: not rendered inline, no preview, and
  // no dedup, since dedup only applies to images. Nothing to warn about — the caller set it.
  const contentType = (request.headers.get("content-type") || "application/octet-stream")
    .split(";")[0]
    .trim();
  const saved = await entries.create(
    env,
    {
      filename: str(url.searchParams.get("filename"), MAX_FILENAME_LENGTH) || `upload-${generateID()}.bin`,
      contentType,
      // Streamed with a running cap rather than `arrayBuffer()`: a chunked body has no
      // `Content-Length` for `assertBodyWithinLimit` to check, so the size has to be enforced
      // while reading or the isolate allocates whatever the client sends.
      bytes: await readBodyWithinLimit(request, MAX_SINGLE_UPLOAD_BYTES, TOO_LARGE),
      note: null,
      expiresAt: await settings.resolveExpiration(env, url.searchParams.get("expirationDays")),
    },
    { mode: "global" },
  );
  return json(
    await shares.mutationPayload(request, env, saved, contentType),
    saved.deduped ? 200 : 201,
  );
}

export const replaceContentRoute = async (c: Route<"/api/entry/:id/content">) => {
  const request = c.req.raw;
  const entry = await entries.require(c.env, c.req.param("id"));
  assertBodyWithinLimit(request, MAX_FORM_UPLOAD_BYTES, TOO_LARGE);
  const fd = await request.formData();
  const file = asFile(fd.get("file"));
  if (!file) throw new HttpError(400, "缺少文件");
  if (file.size >= MULTIPART_UPLOAD_THRESHOLD_BYTES) throw new HttpError(413, TOO_LARGE);
  if (!sameFilename(file.name, entry.filename)) {
    throw new HttpError(400, "替换文件必须保持相同文件名");
  }
  const expected = Number(fd.get("version") || entry.version);
  if (!Number.isInteger(expected) || expected !== entry.version) {
    throw new HttpError(409, entries.CONFLICT);
  }
  const contentType = str(file.type, 255) || "application/octet-stream";
  const { version, sha256 } = await entries.replace(c.env, entry, {
    bytes: await file.arrayBuffer(),
    contentType,
    expectedVersion: expected,
  });
  return json(
    await shares.mutationPayload(
      request,
      c.env,
      { id: entry.id, filename: entry.filename, version, sha256, deduped: false },
      contentType,
      // The entry's public link survives a replace by design, so hand back the same one rather
      // than a fresh token the recipient has never seen.
      { reuseShare: true },
    ),
  );
};

// Unicode normalisation: the same name can arrive as NFC from one client and NFD from
// another, and a raw string compare would reject a legitimate replacement.
const sameFilename = (a: string, b: string): boolean => a.normalize("NFC") === b.normalize("NFC");

/* ------------------------------------------------------------------ file serving */

/**
 * The object to serve for an entry.
 *
 * The filename is inside the ETag because it is inside `Content-Disposition`: without it, a
 * rename followed by a conditional request gets a 304 and the client saves the file under
 * its previous name.
 */
const targetOf = (entry: EntryRow, filename = entry.filename) => ({
  key: entry.object_key,
  size: entry.size,
  contentType: entry.content_type,
  filename,
  etag: `${entry.sha256 || `${entry.size}-${entry.version}`}-${encodeURIComponent(filename)}`,
});

/**
 * The public link, in the shape a browser needs: a plain-text 404/410 rather than the JSON
 * error the API would return, because these are navigated to directly.
 *
 * Two lookups, because the token in the URL is a share and the share is not the file. They can
 * fail independently, and the two failures mean opposite things to the owner:
 *
 * - The share is gone. Revoked, or its own deadline passed. The file is untouched and still in
 *   the list; only this link stopped working. 410 分享链接已失效.
 * - The share is fine but the file expired. That deletes the entry and its bytes, so the link
 *   stays dead even if a new share is minted. 410 文件已过期.
 *
 * Before the share existed these were the same check, which is exactly why there was no way to
 * take back a link without deleting the file behind it.
 */
async function resolvePublic(env: Env, shareId: string): Promise<Response | EntryRow> {
  let entryId: string;
  try {
    ({ entryId } = await shares.resolve(env, shareId));
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    // Plain English for the token-never-existed case, as before: this is a mistyped or truncated
    // URL, and it is the only one of the three a browser is likely to reach by accident.
    return text(err.status === 404 ? "Not Found" : err.message, err.status);
  }

  const found = await entries.lookup(env, entryId);
  if (found.state === "missing") return text("Not Found", 404);
  if (found.state === "expired") return text("文件已过期", 410);
  return found.entry;
}

export const shortLinkRoute = async (c: Route) => {
  // `-` is part of the link shape, not a separator, so the share id is the rest of the
  // first segment: `/-abc123`. Unchanged in shape; only what the token points at moved.
  const url = new URL(c.req.raw.url);
  const shareId = tryDecode(url.pathname.slice(2).split("/")[0] || "");
  if (!shareId) return text("Not Found", 404);

  const found = await resolvePublic(c.env, shareId);
  if (found instanceof Response) return found;

  fireAndForget(c, downloads.record(c.env, found.id, c.req.raw));
  return serveObject(c.req.raw, c.env, targetOf(found));
};

export const imageLinkRoute = async (c: Route) => {
  const url = new URL(c.req.raw.url);
  const parsed = parseImageLinkPath(url.pathname);
  if (!parsed) return text("Not Found", 404);

  const found = await resolvePublic(c.env, parsed.shareId);
  if (found instanceof Response) return found;

  // A renamed file's old link redirects rather than 404s: the filename is there for the
  // reader, and links get pasted into places nobody edits. The comparison is on the decoded
  // filename, NFC-normalised, so a client that sends the same name in a different byte order
  // is served directly instead of being bounced through a redirect (and two encodings of the
  // same name cannot disagree with the canonical link the redirect would send it to).
  if (found.filename.normalize("NFC") !== parsed.filename.normalize("NFC")) {
    return new Response(null, {
      status: 302,
      // The share the visitor already arrived on, not the entry: bouncing them to a URL built
      // from the entry id would hand out a link they never had, and one that is not revocable.
      headers: cors({
        Location: new URL(imageLinkPath(parsed.shareId, found.filename), url).toString(),
      }),
    });
  }

  fireAndForget(c, downloads.record(c.env, found.id, c.req.raw));
  return serveObject(c.req.raw, c.env, targetOf(found));
};

/** Preview does not count as a download: the owner looking at their own file is not reach. */
export const previewRoute = async (c: Route<"/api/entry/:id/preview">) => {
  const entry = await entries.require(c.env, c.req.param("id"));
  return serveObject(c.req.raw, c.env, targetOf(entry));
};

export const versionContentRoute = async (c: Route<"/api/entry/:id/versions/:version/content">) => {
  const version = parsePartNumber(c.req.param("version"));
  if (!version) throw new HttpError(400, "版本号无效");
  const id = c.req.param("id");
  await entries.require(c.env, id);
  const row = await versions.get(c.env, id, version);
  if (!row) throw new HttpError(404, "版本不存在");
  return serveObject(c.req.raw, c.env, {
    key: row.object_key,
    size: row.size,
    contentType: row.content_type,
    filename: row.filename,
    etag: `${row.sha256 || `${row.size}-${version}`}-${encodeURIComponent(row.filename)}`,
    ...FORCE_ATTACHMENT,
  });
};

/* ------------------------------------------------------------------ api */

export const listEntriesRoute = async (c: Route<"/api/entries">) => {
  const params = new URL(c.req.url).searchParams;
  const limit = Number(params.get("limit"));
  const offset = Number(params.get("offset"));
  return json(
    await entries.list(c.env, {
      kind: params.get("kind") === "image" ? "image" : "all",
      q: params.get("q") || undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    }),
  );
};

export const bulkDeleteRoute = async (c: Route<"/api/entries/delete">) => {
  const body = await readJson<{ ids?: unknown }>(c.req.raw);
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
  if (!ids.length) throw new HttpError(400, "缺少要删除的文件 ID");
  return json({ ok: true, deleted: await entries.removeMany(c.env, ids) } satisfies BulkDeleteResponse);
};

export const deleteEntryRoute = async (c: Route<"/api/entry/:id">) => {
  await entries.remove(c.env, c.req.param("id"));
  return json({ ok: true } satisfies OkResponse);
};

export const updateMetadataRoute = async (
  c: Route<"/api/entry/:id">,
): Promise<JsonResponse<UpdateMetadataResponse>> => {
  // `readJson` rather than `c.req.json()`: it caps the body and reports a malformed one as a
  // 400 with a Chinese message. Hono cannot infer the input from a raw `Request`, so the
  // route declares it explicitly.
  const filename = await entries.updateMetadata(
    c.env,
    c.req.param("id"),
    await readJson<entries.UpdateMetadataBody>(c.req.raw),
  );
  return json({ ok: true, filename });
};

export const entryDownloadsRoute = async (c: Route<"/api/entry/:id/downloads">) =>
  json(await downloads.history(c.env, c.req.param("id"), c.req.query("uniqueIps") === "1"));

/**
 * Split out from the route so the contract test can exercise the read against real SQL
 * without going through the HTTP layer.
 */
export const entryVersionsPayload = async (env: Env, id: string) => {
  await entries.require(env, id);
  return { versions: await versions.list(env, id) };
};

export const entryVersionsRoute = async (c: Route<"/api/entry/:id/versions">) =>
  json(await entryVersionsPayload(c.env, c.req.param("id")));

export const deleteVersionRoute = async (c: Route<"/api/entry/:id/versions/:version">) => {
  const version = parsePartNumber(c.req.param("version"));
  if (!version) throw new HttpError(400, "版本号无效");
  const id = c.req.param("id");
  const entry = await entries.require(c.env, id);
  if (version === entry.version) throw new HttpError(400, "不能删除当前版本");
  await versions.remove(c.env, id, version);
  return json({ ok: true } satisfies OkResponse);
};

export const guestUploadRoute = (c: Route<"/api/guest/:id/upload">) => {
  if (!rateLimit(`guest:${clientIp(c.req.raw)}`, 30, 60_000)) {
    throw new HttpError(429, "上传过于频繁，请稍后再试");
  }
  return guest.upload(c.req.raw, c.env, c.req.param("id"));
};

/* ------------------------------------------------------------------ shares */

/**
 * Every share on an entry, expired ones included.
 *
 * The owner's view of what they handed out, which is the reason a revoked link is a deleted row
 * rather than a flag on a kept one: without this list there would be no way to tell a link that is
 * merely off from one that never existed.
 */
export const entrySharesRoute = async (c: Route<"/api/entry/:id/shares">) => {
  const entry = await entries.require(c.env, c.req.param("id"));
  return json(await shares.list(c.env, entry.id));
};

/**
 * Mints another link for an entry that already has one.
 *
 * `entries.require` first, so a share can never be issued for an entry that is gone or already
 * expired. The check lives there because that is the module that knows what expiry means; deciding
 * it again here is how the two answers would drift.
 */
export const createShareRoute = async (c: Route<"/api/entry/:id/shares">) => {
  const body = await readJson<CreateShareBody>(c.req.raw);
  const entry = await entries.require(c.env, c.req.param("id"));
  return json(
    await shares.create(c.env, entry.id, {
      label: str(body.label ?? "", MAX_LABEL_LENGTH) || null,
      expiresAt: shares.expiryFromDays(body.expiresInDays ?? null),
    }),
    201,
  );
};

/** Rename a link, or change when it stops working. */
export const updateShareRoute = async (c: Route<"/api/shares/:id">) =>
  json(
    await shares.update(
      c.env,
      c.req.param("id"),
      await readJson<UpdateShareBody>(c.req.raw),
    ),
  );

/** Takes a link back. The file is untouched — that is the point of it being a share. */
export const revokeShareRoute = async (c: Route<"/api/shares/:id">) => {
  await shares.remove(c.env, c.req.param("id"));
  return json({ ok: true });
};

export const multipartPartRoute = async (c: Route<"/api/entry/multipart/part/:uploadId/:part">) => {
  const partNumber = parsePartNumber(c.req.param("part"));
  if (!partNumber) throw new HttpError(400, "分片参数无效");
  return uploads.part(c.req.raw, c.env, c.req.param("uploadId"), partNumber);
};

/* ------------------------------------------------------------------ fallbacks */

export const apiNotFound = (): Response => json({ error: "Not Found" }, 404);

/** Serves the SPA, and answers the file routes that were never matched. */
export const spaFallback = async (c: Route) => {
  const path = c.req.path;
  const isGet = c.req.method === "GET" || c.req.method === "HEAD";
  // `/-…` and `/img/…` are file routes, not application routes: reaching this point with
  // one means no id resolved, and a 200 here would serve the login page with a 200 for a
  // broken image.
  if (path.startsWith("/-") || path === "/img" || path.startsWith("/img/")) {
    return isGet ? text("Not Found", 404) : text("Method Not Allowed", 405);
  }
  if (!isGet) return text("Method Not Allowed", 405);
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (asset.status !== 404) return asset;
  return c.env.ASSETS.fetch(new URL("/index.html", c.req.url).toString());
};
