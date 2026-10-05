import { imageLinkPath } from "@picoshare/shared";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { parseImageLinkPath } from "../src/platform/serve";
import { createEnv, entryRow } from "./helpers";
import type { Env } from "../src/types";

/**
 * These go through `app.request` rather than a handler function.
 *
 * The image link is the one public route whose behaviour is almost entirely headers and
 * status codes, so exercising the registered route is what actually pins them: a change to
 * the path pattern or the middleware order shows up here rather than in a browser.
 */
function envWith(
  entry: ReturnType<typeof entryRow> | null,
  share: Record<string, unknown> | null = liveShare(),
) {
  const deleted: string[] = [];
  const env = createEnv({
    // Two lookups now, on two tables: the URL carries a share id, and the share points at the
    // entry. Answering only one of them is what made every request 404 when shares arrived.
    first: (sql) =>
      sql.includes("FROM shares")
        ? (share as never)
        : sql.includes("FROM entries WHERE id")
          ? (entry as never)
          : null,
    bucket: {
      get: async () => ({
        writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "image/png"),
        body: new Blob(["abc"]).stream(),
      }),
      delete: async (keys: string | string[]) => {
        deleted.push(...(Array.isArray(keys) ? keys : [keys]));
      },
    },
  });
  return { env, deleted };
}

const get = (env: Env, url: string, init?: RequestInit) =>
  app.request(new Request(url, init), undefined, env);

/** The token in the URL is a share; `abc123` is the entry it resolves to. */
const SHARE = "shr123";
const ENTRY = "abc123";

/** A share that works. `expiresAt` past, or `null` for a token that was never issued. */
const liveShare = (expiresAt: string | null = null) => ({
  id: SHARE,
  entry_id: ENTRY,
  label: null,
  expires_at: expiresAt,
  created_time: "2026-09-26T00:00:00.000Z",
});

const A_PNG = `https://example.com/img/${SHARE}/a.png`;
const B_PNG = `https://example.com/img/${SHARE}/b.png`;
const PHOTO = `https://example.com/img/${SHARE}/%E7%85%A7%E7%89%87.png`;

describe("parseImageLinkPath", () => {
  it("parses id and filename segments", () => {
    expect(parseImageLinkPath("/img/abc123/photo.png")).toEqual({
      shareId: "abc123",
      filename: "photo.png",
    });
  });

  it("decodes percent-encoded filenames", () => {
    expect(parseImageLinkPath("/img/abc123/%E7%85%A7%E7%89%87.png")).toEqual({
      shareId: "abc123",
      filename: "照片.png",
    });
  });

  it("rejects malformed paths", () => {
    expect(parseImageLinkPath("/img")).toBeNull();
    expect(parseImageLinkPath("/img/abc123")).toBeNull();
    expect(parseImageLinkPath("/other/abc123/a.png")).toBeNull();
    expect(parseImageLinkPath("/img//a.png")).toBeNull();
    expect(parseImageLinkPath("/img/abc123/%E0%A4%A.png")).toBeNull();
  });
});

describe("imageLinkPath", () => {
  it("builds the canonical path", () => {
    expect(imageLinkPath("abc123", "照片.png")).toBe("/img/abc123/%E7%85%A7%E7%89%87.png");
  });
});

describe("GET /img/:shareId/:filename", () => {
  it("serves the image with safe headers", async () => {
    const res = await get(envWith(entryRow({ filename: "照片.png" })).env, PHOTO);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline; /);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(res.headers.get("ETag")).toBe('"deadbeef-%E7%85%A7%E7%89%87.png"');
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("3");
  });

  it("answers 304 for a matching If-None-Match", async () => {
    const res = await get(envWith(entryRow({ filename: "a.png" })).env, A_PNG, {
      headers: { "If-None-Match": '"deadbeef-a.png"' },
    });
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
  });

  it("uses weak comparison for If-None-Match", async () => {
    // RFC 9110 §13.1.2 requires the weak comparison function; a proxy that rewrites a strong
    // validator to `W/` would otherwise defeat revalidation for everyone behind it.
    const res = await get(envWith(entryRow({ filename: "a.png" })).env, A_PNG, {
      headers: { "If-None-Match": 'W/"deadbeef-a.png"' },
    });
    expect(res.status).toBe(304);
  });

  it("matches any entry in an If-None-Match list and honours *", async () => {
    for (const header of ['"x", "deadbeef-a.png"', "*"]) {
      const res = await get(envWith(entryRow({ filename: "a.png" })).env, A_PNG, {
        headers: { "If-None-Match": header },
      });
      expect(res.status, header).toBe(304);
    }
  });

  it("does not reuse a cached ETag after a rename", async () => {
    const res = await get(envWith(entryRow({ filename: "b.png" })).env, B_PNG, {
      headers: { "If-None-Match": '"deadbeef-a.png"' },
    });
    expect(res.status).toBe(200);
  });

  it("ignores a Range header naming an unknown unit", async () => {
    // RFC 9110 §14.2: an unrecognised range unit MUST be ignored, not rejected.
    const res = await get(envWith(entryRow({ filename: "a.png" })).env, A_PNG, {
      headers: { Range: "items=0-1" },
    });
    expect(res.status).toBe(200);
  });

  it("serves the whole representation for a multi-range request", async () => {
    const res = await get(envWith(entryRow({ filename: "a.png" })).env, A_PNG, {
      headers: { Range: "bytes=0-1,3-4" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
  });

  it("answers 416 only for a well-formed but unsatisfiable range", async () => {
    const res = await get(envWith(entryRow({ filename: "a.png" })).env, A_PNG, {
      headers: { Range: "bytes=10-" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */3");
  });

  it("supports range requests", async () => {
    const res = await get(envWith(entryRow({ filename: "照片.png" })).env, PHOTO, {
      headers: { Range: "bytes=1-2" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 1-2/3");
  });

  it("answers HEAD without a body", async () => {
    const res = await get(envWith(entryRow({ filename: "照片.png" })).env, PHOTO, {
      method: "HEAD",
    });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("redirects to the canonical filename", async () => {
    const res = await get(
      envWith(entryRow({ filename: "照片.png" })).env,
      `https://example.com/img/${SHARE}/wrong.png`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(PHOTO);
  });

  it("returns 404 for unknown entries", async () => {
    const res = await get(envWith(null).env, A_PNG);
    expect(res.status).toBe(404);
  });

  it("returns 410 for expired entries, and deletes them", async () => {
    const { env, deleted } = envWith(entryRow({ expiration_time: "2020-01-01T00:00:00.000Z" }));
    const res = await get(env, PHOTO);
    expect(res.status).toBe(410);
    expect(deleted).toContain(ENTRY);
  });

  it("returns 410 for an expired share without deleting anything", async () => {
    // The distinction the whole table exists for. The same status code as the file being gone,
    // the opposite consequence: the bytes stay, the owner's list stays, and they can mint another
    // link. Before shares there was no way to say this — taking back a link deleted the file.
    const { env, deleted } = envWith(
      entryRow({ filename: "照片.png" }),
      liveShare("2020-01-01T00:00:00.000Z"),
    );
    const res = await get(env, PHOTO);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("分享链接已失效");
    expect(deleted).toEqual([]);
  });

  it("answers 404 for a token that was never issued", async () => {
    // Distinct from an expired one: this is a wrong or truncated URL, and it is the only one of
    // the three a browser reaches by accident.
    const res = await get(envWith(entryRow({ filename: "照片.png" }), null).env, PHOTO);
    expect(res.status).toBe(404);
  });

  it("does not need the entry to still have a share", async () => {
    // A revoked link is a dead token, not a deleted file, so nothing here touches the entry.
    const { env } = envWith(entryRow({ filename: "a.png" }));
    expect((await get(env, A_PNG)).status).toBe(200);
  });

  it("returns 404 when the filename segment is missing", async () => {
    // The SPA catch-all would otherwise answer 200 with the application shell, which a
    // browser reports as a broken image with no indication of why.
    const res = await get(envWith(entryRow({ filename: "照片.png" })).env, "https://example.com/img/abc123");
    expect(res.status).toBe(404);
  });

  it("needs no secret", async () => {
    // The id in the URL is the credential. A 401 here would mean the public links stopped
    // working for every image already pasted into a README.
    const res = await get(envWith(entryRow({ filename: "a.png" })).env, A_PNG);
    expect(res.status).toBe(200);
  });
});
