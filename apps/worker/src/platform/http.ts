import type { TypedResponse } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { JSONParsed } from "hono/utils/types";
import type { Env } from "../types";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  "Access-Control-Expose-Headers": "Content-Disposition, Content-Range, Accept-Ranges",
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function cors(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) result.set(key, value);
  return result;
}

/**
 * A JSON response that still remembers what it carried.
 *
 * `TypedResponse` is a phantom carrier — it exists only in the type system, and structurally a
 * `Response`. Hono reads it off a handler's return type to derive what the endpoint answers,
 * which is what lets the browser type its own calls. A plain `Response` carries no such
 * record, so a route whose handler returns one is opaque: every caller ends up casting.
 *
 * The runtime value is unchanged — a `Response`, with the same CORS and content-type headers.
 */
export type JsonResponse<
  T,
  U extends ContentfulStatusCode = ContentfulStatusCode,
> = Response & TypedResponse<JSONParsed<T>, U, "json">;

export const json = <T, U extends ContentfulStatusCode = ContentfulStatusCode>(
  data: T,
  status: U = 200 as U,
): JsonResponse<T, U> =>
  new Response(JSON.stringify(data), {
    status,
    headers: cors({ "Content-Type": "application/json" }),
  }) as JsonResponse<T, U>;

export const text = (body: string, status = 200): Response =>
  new Response(body, { status, headers: cors({ "Content-Type": "text/plain; charset=utf-8" }) });

export const MAX_JSON_BYTES = 64 * 1024;

/**
 * Body size known up front from `Content-Length`, or 0 when it is missing (chunked).
 */
export const declaredBodySize = (request: Request): number => {
  const n = Number(request.headers.get("content-length"));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Reject an oversized body from its `Content-Length` *before* it is buffered. Without
 * this, `arrayBuffer()`/`formData()` will happily allocate the whole thing inside a
 * 128 MB isolate. A missing header means the body is chunked, where the platform cap
 * applies instead.
 */
export const assertBodyWithinLimit = (request: Request, max: number, message: string): void => {
  if (declaredBodySize(request) > max) throw new HttpError(413, message);
};

/**
 * Buffer a request body, refusing to grow past `max`.
 *
 * `assertBodyWithinLimit` only catches a body whose `Content-Length` is present and honest,
 * which a chunked upload never sends. Reading the stream in chunks and aborting the moment the
 * running total crosses `max` gives the same guarantee without trusting a header, and without
 * ever materialising the oversized body inside the 128 MB isolate.
 */
export const readBodyWithinLimit = async (
  request: Request,
  max: number,
  message: string,
): Promise<ArrayBuffer> => {
  const body = request.body;
  if (!body) return request.arrayBuffer();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, message);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
};

export const readJson = async <T = Record<string, unknown>>(request: Request): Promise<T> => {
  // Bounded while reading, not after: `request.text()` buffers the whole body first, so a
  // 64 KB check on the resulting string never stopped a client from sending gigabytes.
  const bytes = await readBodyWithinLimit(request, MAX_JSON_BYTES, "请求体过大");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new HttpError(400, "请求体格式错误");
  }
};

const safeEqual = (a: string, b: string): boolean => {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const length = Math.max(x.length, y.length);
  for (let i = 0; i < length; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
};

type RateBucket = { count: number; resetAt: number };

const rateBuckets = new Map<string, RateBucket>();

// Best-effort in-memory limiter: scoped to a single isolate, not a global guarantee.
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    // Evict only the buckets whose window has already elapsed. `clear()` freed the whole map,
    // which an attacker could trigger on demand: one burst fills it past the cap, every
    // existing counter resets, and the limit it was protecting stops applying.
    if (rateBuckets.size >= MAX_RATE_BUCKETS) pruneBuckets(now);
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

const MAX_RATE_BUCKETS = 10_000;

/**
 * Drops expired buckets, oldest window first, and only falls back to an unconditional clear
 * if the map is somehow still full — which needs every one of `MAX_RATE_BUCKETS` windows to
 * be live at once, not a single attacker-driven burst.
 */
function pruneBuckets(now: number): void {
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
  if (rateBuckets.size >= MAX_RATE_BUCKETS) rateBuckets.clear();
}

// CF-Connecting-IP is injected by the edge and cannot be spoofed. X-Forwarded-For is
// client-controlled, so it must never key a rate limit: rotating it defeats the limit
// entirely. Deployments without the header share one bucket, which is the safe default.
export const clientIp = (request: Request): string => request.headers.get("cf-connecting-ip") || "unknown";

// Query-string auth exists for one route: the image-host upload endpoint, reached from
// tools whose config screen has no field for a request header. Anywhere else the secret
// would land in access logs, analytics and Referer headers, and — since the API is
// `Access-Control-Allow-Origin: *` — a link like `/api/entry/abc?token=…` would be a
// one-click delete.
//
// One route, not two: form uploads and raw-body uploads are the same endpoint, so the
// allowlist has a single entry and there is a single path where the secret can appear in a
// URL. Adding a second entry here needs a reason stronger than convenience.
const TOKEN_QUERY_ROUTES = new Set(["/api/entry"]);

export function authorized(request: Request, env: Env): boolean {
  const secret = env.PS_SHARED_SECRET;
  if (!secret) return false;
  const header = request.headers.get("Authorization") || request.headers.get("X-Api-Key");
  if (header && safeEqual(header, secret)) return true;
  const { pathname, searchParams } = new URL(request.url);
  if (!TOKEN_QUERY_ROUTES.has(pathname)) return false;
  const token = searchParams.get("token");
  return !!token && safeEqual(token, secret);
}

/**
 * The origin that goes into generated share links.
 *
 * `PUBLIC_ORIGIN` wins. The image-host endpoint exists to hand back a URL that gets pasted
 * into a README or a forum post, so it outlives the request that produced it: a spoofed
 * `Host`, or a proxy that forwards the original one, would otherwise bake a hostile origin
 * into the artifact the caller publishes.
 */
export const publicOrigin = (request: Request, env: Env): string =>
  env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, "") || new URL(request.url).origin;

/**
 * Runs a side effect after the response is on its way, when an execution context is
 * available.
 *
 * `c.executionCtx` throws when a handler is invoked without one — which is exactly what the
 * unit tests do — so every caller would otherwise need its own try/catch around bookkeeping
 * it does not care about.
 */
export function fireAndForget(
  ctx: { executionCtx?: { waitUntil(promise: Promise<unknown>): void } },
  promise: Promise<unknown>,
): void {
  try {
    ctx.executionCtx?.waitUntil(promise);
  } catch {
    // No execution context (unit tests, or a direct handler call). Drop it.
  }
}

/**
 * Whether a thrown error is the database disagreeing with the code rather than the code
 * being wrong.
 *
 * Worth separating because the two need opposite responses: a bug gets fixed, a stale
 * database gets `pnpm d1:init`. From the outside they are the same 500.
 */
const isSchemaMismatch = (err: unknown): boolean =>
  err instanceof Error && /no such (?:column|table):?\s|has no column named/i.test(err.message);

const SCHEMA_MISMATCH = [
  "数据库结构与代码不匹配：代码查询了一个当前数据库里不存在的列或表。",
  "",
  "本地开发：pnpm d1:init（重建空库；schema.sql 没有迁移路径，改列名后旧库必须重建）。",
  "生产环境：pnpm d1:init:remote（上线前用新 schema 建库即可）。",
].join("\n");

export function handleError(err: unknown): Response {
  if (err instanceof HttpError) {
    // The status is whatever a handler chose at runtime, so it cannot be narrowed to Hono's
    // literal union here. Only the type brand is lost, and this is the error path: it is not
    // one of the routes a typed client calls.
    return json({ error: err.message }, err.status as ContentfulStatusCode);
  }
  // Everything else is a bug, not a malformed request. Reporting a genuine internal TypeError
  // as `400 请求体格式错误` both misled the caller and hid the failure from the logs, since
  // only the 500 branch logged anything. JSON parse failures are turned into an HttpError by
  // readJson, at the call site that can actually attribute them.
  console.error("unhandled worker error", err);
  if (isSchemaMismatch(err)) {
    return new Response(SCHEMA_MISMATCH, {
      status: 500,
      headers: cors({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  }
  return text("Internal Server Error", 500);
}
