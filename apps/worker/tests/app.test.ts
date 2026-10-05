import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { createEnv, entryRow } from "./helpers";

function makeEnv(
  options: {
    entry?: ReturnType<typeof entryRow> | null;
    /** The share the public URL resolves. Null means the token was never issued. */
    share?: Record<string, unknown> | null;
  } = {},
) {
  const puts: string[] = [];
  const env = createEnv({
    // A public link now takes two hops: token -> share -> entry. Mocking only the second is what
    // made every public route answer 404 the day shares arrived.
    first: (sql) =>
      sql.includes("FROM shares")
        ? ((options.share === undefined
            ? {
                id: "shr123",
                entry_id: "abc123",
                label: null,
                expires_at: null,
                created_time: "2026-09-26T00:00:00.000Z",
              }
            : options.share) as never)
        : sql.includes("FROM entries WHERE id")
          ? (options.entry ?? null)
          : null,
    bucket: {
      get: async () =>
        options.entry
          ? {
              writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "image/png"),
              body: new Blob(["abc"]).stream(),
            }
          : null,
      put: async (key: string) => {
        puts.push(key);
      },
      delete: async () => {},
    },
    assets: {
      fetch: async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("index.html")) {
          return new Response("<html>spa</html>", { status: 200, headers: { "Content-Type": "text/html" } });
        }
        return new Response("nope", { status: 404 });
      },
    },
  });
  return { env, puts };
}

describe("app routing", () => {
  it("answers CORS preflight without auth", async () => {
    const { env } = makeEnv();
    const res = await app.request("/api/entries", { method: "OPTIONS" }, env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects protected API requests without a secret", async () => {
    const { env } = makeEnv();
    const res = await app.request("/api/entries", {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "未授权，请检查访问密钥" });
  });

  it("rejects the token query parameter outside the image-host routes", async () => {
    const { env } = makeEnv();
    const res = await app.request("/api/settings?token=secret", {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects the token query parameter on destructive routes", async () => {
    const { env } = makeEnv({ entry: entryRow() });
    const res = await app.request("/api/entry/abc123?token=secret", { method: "DELETE" }, env);
    expect(res.status).toBe(401);
  });

  it("keeps guest info public", async () => {
    const { env } = makeEnv();
    const res = await app.request("/api/guest/missing/info", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "访客链接不存在" });
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const { env } = makeEnv();
    const res = await app.request("/api/nope", { headers: { Authorization: "secret" } }, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });

  it("returns 404 for malformed short links instead of crashing", async () => {
    const { env } = makeEnv();
    const res = await app.request("/-%E0%A4%A", {}, env);
    expect(res.status).toBe(404);
  });

  it("serves the SPA shell for navigation paths", async () => {
    const { env } = makeEnv();
    const res = await app.request("/some/page", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("spa");
  });

  it("rejects non-GET navigation fallbacks", async () => {
    const { env } = makeEnv();
    const res = await app.request("/some/page", { method: "POST" }, env);
    expect(res.status).toBe(405);
  });

  it("serves short links through the Hono route", async () => {
    const { env } = makeEnv({ entry: entryRow() });
    const res = await app.request("/-shr123", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("serves /img links through the Hono route", async () => {
    const { env } = makeEnv({ entry: entryRow() });
    const res = await app.request("/img/shr123/photo.png", {}, env);
    expect(res.status).toBe(200);
    // The filename is part of the validator, so a rename cannot be answered with a 304.
    expect(res.headers.get("ETag")).toBe('"deadbeef-photo.png"');
  });

  it("tells an expired share apart from an expired file", async () => {
    // Same status code, opposite consequences, and the owner can only act on one of them: the
    // share case leaves the file in the list, the file case has already deleted it.
    const { env } = makeEnv({
      entry: entryRow(),
      share: {
        id: "shr123",
        entry_id: "abc123",
        label: null,
        expires_at: "2020-01-01T00:00:00.000Z",
        created_time: "2026-09-26T00:00:00.000Z",
      },
    });

    const res = await app.request("/-shr123", {}, env);

    expect(res.status).toBe(410);
    expect(await res.text()).toContain("分享链接已失效");
  });

  it("rejects non-GET direct link methods", async () => {
    const { env } = makeEnv();
    const res = await app.request("/-shr123", { method: "POST" }, env);
    expect(res.status).toBe(405);
  });

  it("reads a raw body as the file, and takes the filename from the query", async () => {
    const { env, puts } = makeEnv();
    const res = await app.request(
      "/api/entry?filename=pic.png&token=secret",
      {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: new Uint8Array([1, 2, 3]),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { filename: string; url: string; markdown: string; deduped: boolean };
    expect(body.filename).toBe("pic.png");
    expect(body.url).toMatch(/^https?:\/\/[^/]+\/img\//);
    expect(body.markdown).toContain("![");
    expect(body.deduped).toBe(false);
    expect(puts).toHaveLength(1);
  });

  it("reads the same route as a form post when the content type says so", async () => {
    // One route, two encodings. The discriminator is the request's own Content-Type, so a
    // tool that posts a form and a script that posts bytes both land on the same entry
    // shape and the same response — which is the point of merging them.
    const { env, puts } = makeEnv();
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "form.png", { type: "image/png" }));
    const res = await app.request(
      "/api/entry",
      { method: "POST", body: form, headers: { Authorization: "secret" } },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { filename: string; url: string };
    expect(body.filename).toBe("form.png");
    expect(puts).toHaveLength(1);
  });

  it("falls back to a generated filename when a raw body carries none", async () => {
    // A raw body has no place to put a name, and a tool that omits `?filename=` still has
    // to get a usable link back.
    const { env } = makeEnv();
    const res = await app.request(
      "/api/entry",
      {
        method: "POST",
        headers: { "Content-Type": "image/png", Authorization: "secret" },
        body: new Uint8Array([1]),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { filename: string };
    expect(body.filename).toMatch(/^upload-[A-Za-z0-9]+\.bin$/);
  });

  it("stores a raw upload with no Content-Type as opaque bytes", async () => {
    // Nothing to warn about — the caller chose it — but the consequences are worth pinning:
    // a binary type is not rendered inline and, because dedup only applies to images, it
    // does not participate in it either.
    const { env } = makeEnv();
    const res = await app.request(
      "/api/entry?filename=blob",
      { method: "POST", headers: { Authorization: "secret" }, body: new Uint8Array([1, 2, 3]) },
      env,
    );
    expect(res.status).toBe(201);
  });

  it("still rejects an unknown /api/upload", async () => {
    // The route is gone, not aliased. A tool still pointing at it gets a JSON 404 rather
    // than a silent redirect that would hide the misconfiguration.
    const { env } = makeEnv();
    const res = await app.request(
      "/api/upload?filename=a.png",
      { method: "POST", headers: { Authorization: "secret" } },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("accepts raw binary uploads for image host tooling", async () => {
    const { env, puts } = makeEnv();
    const res = await app.request(
      "/api/entry?filename=pic.png&token=secret",
      {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: new Uint8Array([1, 2, 3]),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { url: string; markdown: string; deduped: boolean };
    expect(body.url).toMatch(/^https?:\/\/[^/]+\/img\//);
    expect(body.markdown).toContain("![");
    expect(body.deduped).toBe(false);
    expect(puts).toHaveLength(1);
  });
});
