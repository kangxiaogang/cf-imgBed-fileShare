import { isInlineSafe, normalizeContentType } from "@picoshare/shared";
import { cors, text } from "./http";
import { tryDecode } from "./parse";
import type { Env } from "../types";

/*
 * How a stored object is presented in a browser, and how a range request against it is
 * answered. Both are properties of the bytes, not of the route that fetched them, so all
 * four file routes (short link, image link, preview, historical version) go through here.
 */

/* ------------------------------------------------------------------ content policy */

const asciiFallback = (filename: string): string =>
  filename
    .replaceAll('"', "")
    .replaceAll("\\", "_")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim() || "download";

/** RFC 6266: an ASCII fallback for old clients plus the percent-encoded real name. */
export const disposition = (mode: "inline" | "attachment", filename: string): string => {
  const encoded = encodeURIComponent(filename.replaceAll('"', ""));
  return `${mode}; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encoded}`;
};

export const cacheControlFor = (contentType: string | null | undefined): string =>
  normalizeContentType(contentType).startsWith("image/") ? "public, max-age=86400" : "no-cache, must-revalidate";

/**
 * Headers for content that may be rendered in the browser.
 *
 * SVG is excluded from `isInlineSafe` and additionally gets a `sandbox` CSP: an uploaded
 * SVG is a document that can carry script, so serving it inline from the same origin as the
 * management UI would be stored XSS with no user interaction required.
 */
export const applyContentHeaders = (headers: Headers, contentType: string | null, filename: string): void => {
  headers.set("Content-Disposition", disposition(isInlineSafe(contentType) ? "inline" : "attachment", filename));
  headers.set("Cache-Control", cacheControlFor(contentType));
  headers.set("X-Content-Type-Options", "nosniff");
  if (normalizeContentType(contentType) === "image/svg+xml") {
    headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
};

/* ------------------------------------------------------------------ range and etag */

export type ParsedRange = { start: number; end: number } | "unsatisfiable";

/**
 * RFC 9110 §14.2: a Range header that cannot be parsed, or that names a unit we do not
 * understand, MUST be ignored — the response is then a normal 200. Only a range that is
 * well-formed but outside the representation is unsatisfiable, and only that becomes 416.
 */
export function parseRange(header: string | null, size: number): ParsedRange | null {
  if (!header) return null;
  const unit = /^([A-Za-z]+)=(.*)$/.exec(header.trim());
  if (!unit || unit[1].toLowerCase() !== "bytes") return null;
  // Multi-range is legal; we do not implement multipart/byteranges, so serve the whole
  // representation instead of failing a request every PDF viewer and ffmpeg can send.
  if (unit[2].includes(",")) return null;
  const match = /^(\d*)-(\d*)$/.exec(unit[2]);
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return null;
  let start: number;
  let end: number;
  if (!startRaw) {
    const length = Number(endRaw);
    if (!Number.isFinite(length) || length <= 0) return null;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(startRaw);
    if (!Number.isFinite(start)) return null;
    if (endRaw) {
      end = Number(endRaw);
      // An explicitly inverted range is malformed, so it is ignored.
      if (!Number.isFinite(end) || start > end) return null;
      end = Math.min(end, size - 1);
    } else {
      end = size - 1;
    }
  }
  // Distinguish "no such byte" (416) from "cannot be parsed" (ignore). Note this has to come
  // after the inverted-range check above, otherwise `bytes=10-` on a 10-byte object looks
  // inverted and would be ignored instead of answered with 416.
  if (size === 0 || start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** RFC 9110 §13.1.2 weak comparison, so a proxy that rewrites `W/` still revalidates. */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const target = etag.replace(/^W\//, "");
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value.replace(/^W\//, "") === target;
  });
}

/* ------------------------------------------------------------------ serving */

/** A historical version is a download, never a render: it can be anything the entry once was. */
export const FORCE_ATTACHMENT = { forceAttachment: true } as const;

export type StoredObject = {
  key: string;
  size: number;
  contentType: string | null;
  filename: string;
  etag: string;
  forceAttachment?: boolean;
};

export async function serveObject(
  request: Request,
  env: Env,
  stored: StoredObject,
): Promise<Response> {
  const etag = `"${stored.etag}"`;
  const headers = cors({
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  });
  if (stored.forceAttachment) {
    headers.set("Content-Disposition", disposition("attachment", stored.filename));
    headers.set("Cache-Control", "no-cache, must-revalidate");
  } else {
    applyContentHeaders(headers, stored.contentType, stored.filename);
  }
  headers.set("ETag", etag);
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? parseRange(rangeHeader, stored.size) : null;
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${stored.size}`);
    return new Response(null, { status: 416, headers });
  }

  const object = await env.BUCKET.get(
    stored.key,
    range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined,
  );
  if (!object) return text("Not Found", 404);
  if (stored.contentType) headers.set("Content-Type", stored.contentType);
  if (!range) headers.set("Content-Length", String(stored.size));
  else headers.set("Content-Range", `bytes ${range.start}-${range.end}/${stored.size}`);
  const status = range ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  return new Response(object.body, { status, headers });
}

/* ------------------------------------------------------------------ link paths */

/**
 * `/img/<shareId>/<filename>`. The first segment is a *share* id, not an entry id — the same
 * shape as before, pointing at a revocable token rather than at the file itself.
 */
export function parseImageLinkPath(
  pathname: string,
): { shareId: string; filename: string } | null {
  const parts = pathname.split("/");
  if (parts[1] !== "img" || !parts[2] || parts.length < 4) return null;
  const shareId = tryDecode(parts[2]);
  const decoded = parts.slice(3).map(tryDecode);
  if (shareId === null || decoded.some((part) => part === null)) return null;
  return { shareId, filename: decoded.join("/") };
}
