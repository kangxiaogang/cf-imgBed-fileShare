import { describe, expect, it, vi } from "vitest";
import { MULTIPART_UPLOAD_THRESHOLD_BYTES } from "@picoshare/shared";
import { HttpError } from "../src/platform/http";
import {
  abort,
  cleanupAbandoned,
  complete,
  init,
  part,
} from "../src/domain/uploads";
import { createEnv, entryRow, jsonRequest, type QueryCall } from "./helpers";

const BIG = MULTIPART_UPLOAD_THRESHOLD_BYTES + 1;

const uploadRow = (overrides: Record<string, unknown> = {}) => ({
  id: "up-1",
  entry_id: "abc123",
  filename: "big.bin",
  content_type: "application/octet-stream",
  size: BIG,
  expiration_time: null,
  note: null,
  is_replace: 0,
  expected_version: null,
  object_key: "abc123",
  ...overrides,
});

type BucketOp = { op: string; args: unknown[] };

function multipartEnv(
  options: {
    upload?: Record<string, unknown> | null;
    stale?: Array<Record<string, unknown>>;
    parts?: Array<{ partNumber: number; etag: string }>;
    entry?: ReturnType<typeof entryRow> | null;
    objectSize?: number;
    completeFails?: boolean;
    insertFails?: boolean;
    abortFails?: boolean;
    /** What `liveShare`'s subquery finds, so a replace's share-reuse can be observed. */
    shareId?: string | null;
    run?: (sql: string, args: unknown[]) => unknown;
  } = {},
) {
  const queries: QueryCall[] = [];
  const batched: QueryCall[] = [];
  const bucket: BucketOp[] = [];
  let created = 0;

  const record = (sql: string, args: unknown[]) => queries.push({ sql, args });

  const env = createEnv({
    first: (sql) => {
      if (sql.includes("upload_sessions")) return (options.upload ?? null) as never;
      // `liveShare` reads the share out of a subquery over `entries`, so answer it before the
      // plain entry row this mock otherwise hands back for anything touching `entries`.
      if (sql.includes("share_id")) return { share_id: options.shareId ?? null } as never;
      if (sql.includes("FROM entries")) return (options.entry ?? null) as never;
      return null;
    },
    all: (sql) => {
      if (sql.includes("FROM upload_parts")) return { results: options.parts ?? [] };
      if (sql.includes("FROM upload_sessions")) return { results: options.stale ?? [] };
      return { results: [] };
    },
    run: (sql, args) => {
      record(sql, args);
      if (options.insertFails && sql.includes("INSERT INTO upload_sessions")) {
        throw new Error("d1 unavailable");
      }
      return options.run?.(sql, args) ?? { success: true, meta: { changes: 1, last_row_id: 0 } };
    },
    onQuery: record,
    bucket: {
      createMultipartUpload: async (key: string) => {
        created += 1;
        bucket.push({ op: "create", args: [key] });
        return { uploadId: `up-${created}`, key };
      },
      resumeMultipartUpload: (key: string, uploadId: string) => ({
        uploadPart: async (partNumber: number) => {
          bucket.push({ op: "uploadPart", args: [key, uploadId, partNumber] });
          return { partNumber, etag: `etag-${partNumber}` };
        },
        complete: async (parts: unknown) => {
          bucket.push({ op: "complete", args: [key, uploadId, parts] });
          if (options.completeFails) throw new Error("NoSuchUpload");
          return { object: null };
        },
        abort: async () => {
          bucket.push({ op: "abort", args: [key, uploadId] });
          if (options.abortFails) throw new Error("NoSuchUpload");
        },
      }),
      head: async () => ({ size: options.objectSize ?? BIG }),
      get: async () => null,
      put: async (key: string) => bucket.push({ op: "put", args: [key] }),
      delete: async (key: unknown) => bucket.push({ op: "delete", args: [key] }),
    },
    batch: (statements) => {
      for (const statement of statements as Array<{ sql: string; args: unknown[] }>) {
        batched.push({ sql: statement.sql, args: statement.args });
      }
      return statements.map(() => ({ success: true, meta: { changes: 1, last_row_id: 0 } }));
    },
  });

  return { env, queries, batched, bucket, ops: () => bucket.map((call) => call.op) };
}

const initRequest = (body: Record<string, unknown>) =>
  jsonRequest("https://example.com/api/entry/multipart/init", body);
const completeRequest = () =>
  jsonRequest("https://example.com/api/entry/multipart/complete", { uploadId: "up-1" });
const abortRequest = (uploadId: unknown) =>
  jsonRequest("https://example.com/api/entry/multipart/abort", { uploadId });
const partRequest = () => new Request("https://example.com/x", { method: "POST", body: "chunk" });

describe("init", () => {
  it("rejects a file below the multipart threshold", async () => {
    const { env, ops } = multipartEnv();
    const err = await init(initRequest({ filename: "a.bin", size: 1024 }), env).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect(ops()).toEqual([]);
  });

  it("creates the R2 upload and records it", async () => {
    const { env, queries, ops } = multipartEnv();
    const res = await init(
      initRequest({ filename: "big.bin", contentType: "application/octet-stream", size: BIG }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { uploadId: string; chunkSize: number };
    expect(body.uploadId).toBe("up-1");
    expect(body.chunkSize).toBeGreaterThan(0);
    expect(ops()).toEqual(["create"]);
    expect(queries.some((q) => q.sql.includes("INSERT INTO upload_sessions"))).toBe(true);
  });

  it("aborts the R2 upload when the D1 insert fails", async () => {
    // Otherwise the upload id exists nowhere, and cleanupAbandonedUploads only scans
    // upload_sessions, so the parts could never be reclaimed.
    const { env, ops } = multipartEnv({ insertFails: true });
    await expect(
      init(initRequest({ filename: "big.bin", size: BIG }), env),
    ).rejects.toThrow("d1 unavailable");
    expect(ops()).toEqual(["create", "abort"]);
  });
});

describe("part", () => {
  it("stores the part and its etag", async () => {
    const { env, queries, bucket } = multipartEnv({ upload: uploadRow() });
    const res = await part(partRequest(), env, "up-1", 1);
    expect(res.status).toBe(200);
    expect(bucket[0]).toMatchObject({ op: "uploadPart", args: ["abc123", "up-1", 1] });
    expect(queries.some((q) => q.sql.includes("INSERT OR REPLACE INTO upload_parts"))).toBe(
      true,
    );
  });

  it("404s for an unknown upload", async () => {
    const { env, ops } = multipartEnv({ upload: null });
    const err = await part(partRequest(), env, "nope", 1).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(404);
    expect(ops()).toEqual([]);
  });
});

describe("complete", () => {
  it("claims the session by flipping its state, and leaves the row in place", async () => {
    // `DELETE ... RETURNING` also picks one winner, but it erases the row — so a request
    // that dies between the claim and the R2 complete leaves nothing for the sweep to find
    // and the upload is silently lost. The state column keeps the evidence.
    const { env, queries } = multipartEnv({
      upload: uploadRow(),
      parts: [{ partNumber: 1, etag: "e" }],
    });
    await complete(completeRequest(), env);

    const claim = queries.find((q) => q.sql.includes("SET state = 'completing'"));
    expect(claim?.sql).toContain("WHERE id = ? AND state = 'pending'");
    expect(claim?.args).toEqual(["up-1"]);
    // Read the row first, then claim: the claim cannot be the statement that supplies it.
    expect(queries.findIndex((q) => q.sql.includes("FROM upload_sessions WHERE id = ?"))).toBeLessThan(
      queries.findIndex((q) => q.sql.includes("SET state = 'completing'")),
    );
  });

  it("loses cleanly when another complete already claimed the session", async () => {
    // changes = 0 on the guarded UPDATE is the only signal D1 can give, and it has to be
    // read as "someone else won" rather than as success.
    const { env, ops } = multipartEnv({
      upload: uploadRow(),
      parts: [{ partNumber: 1, etag: "e" }],
      run: (sql: string) => ({
        success: true,
        meta: { changes: sql.includes("SET state = 'completing'") ? 0 : 1, last_row_id: 0 },
      }),
    });
    const err = await complete(completeRequest(), env).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(404);
    expect(ops()).not.toContain("complete");
  });

  it("404s when the upload was already claimed, without touching R2", async () => {
    const { env, ops } = multipartEnv({ upload: null });
    const err = await complete(completeRequest(), env).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(404);
    expect(ops()).toEqual([]);
  });

  it("rejects when no parts were uploaded", async () => {
    const { env, ops } = multipartEnv({ upload: uploadRow(), parts: [] });
    const err = await complete(completeRequest(), env).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
    expect(ops()).toContain("abort");
  });

  it("uses the stored object size, not the client-declared one", async () => {
    // The declared size is what Content-Range and the 416 boundary are computed from when
    // the entry is served later, so it has to come from R2.
    const { env, batched } = multipartEnv({
      upload: uploadRow(),
      parts: [{ partNumber: 1, etag: "e" }],
      objectSize: 4242,
    });
    await complete(completeRequest(), env);
    const insert = batched.find((q) => q.sql.includes("INSERT INTO entries"));
    expect(insert?.args[3]).toBe(4242);
  });

  it("reclaims the R2 upload when completion fails", async () => {
    const { env, ops } = multipartEnv({
      upload: uploadRow(),
      parts: [{ partNumber: 1, etag: "e" }],
      completeFails: true,
    });
    await expect(complete(completeRequest(), env)).rejects.toThrow("NoSuchUpload");
    expect(ops()).toContain("abort");
  });

  it("rejects a stale expected version before completing", async () => {
    const { env, ops } = multipartEnv({
      upload: uploadRow({ is_replace: 1, expected_version: 2 }),
      parts: [{ partNumber: 1, etag: "e" }],
      entry: entryRow({ version: 5 }),
    });
    const err = await complete(completeRequest(), env).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(409);
    expect(ops()).not.toContain("complete");
    expect(ops()).toContain("abort");
  });

  it("hands back the entry's existing share when replacing, like the small-file path", async () => {
    // `replaceContentRoute` passes `reuseShare`, and this is its chunked twin. Without it a
    // replacement over 100MB would answer with a freshly minted token while one under 100MB
    // returned the link the owner had already handed out — the same act, two answers.
    const { env } = multipartEnv({
      upload: uploadRow({ is_replace: 1, expected_version: 1 }),
      parts: [{ partNumber: 1, etag: "e" }],
      entry: entryRow({ version: 1 }),
      shareId: "sharekeepme000000",
    });
    const res = await complete(completeRequest(), env);
    const body = (await res.json()) as { url: string | null };
    expect(body.url).toContain("sharekeepme000000");
  });
});

describe("abort", () => {
  it("aborts and clears a tracked upload", async () => {
    const { env, ops } = multipartEnv({ upload: uploadRow() });
    const res = await abort(abortRequest("up-1"), env);
    expect(res.status).toBe(200);
    // The object was never published, so both halves go immediately rather than waiting a
    // day for the sweep.
    expect(ops()).toEqual(["abort", "delete"]);
  });

  it("is a no-op for an unknown upload", async () => {
    const { env, ops } = multipartEnv({ upload: null });
    const res = await abort(abortRequest("nope"), env);
    expect(res.status).toBe(200);
    expect(ops()).toEqual([]);
  });

  it("requires an uploadId", async () => {
    const { env } = multipartEnv();
    const err = await abort(abortRequest(undefined), env).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
  });
});

describe("cleanupAbandoned", () => {
  it("reclaims every stale session, in any state", async () => {
    const { env, ops } = multipartEnv({
      stale: [
        { id: "up-1", entry_id: "e1", object_key: "k1", state: "pending" },
        { id: "up-2", entry_id: "e2", object_key: "k2", state: "completing" },
      ],
    });

    const count = await cleanupAbandoned(env, "2026-01-01T00:00:00.000Z", 50);

    expect(count).toBe(2);
    expect(ops()).toEqual(["abort", "delete", "abort", "delete"]);
  });

  it("does not delete an object an entry already points at", async () => {
    // A session stuck in 'completing' may have published its object before dying. The old
    // error path deleted the object on its way out, which is how a live entry ends up
    // pointing at bytes that are gone.
    const { env, ops } = multipartEnv({
      stale: [{ id: "up-1", entry_id: "e1", object_key: "k1", state: "completing" }],
      entry: entryRow({ object_key: "k1" }),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await cleanupAbandoned(env, "2026-01-01T00:00:00.000Z", 50);

    expect(ops()).toEqual(["abort"]);
  });

  it("still reclaims the object when the R2 upload can no longer be aborted", async () => {
    const { env, ops } = multipartEnv({
      stale: [{ id: "up-1", entry_id: "e1", object_key: "k1" }],
      abortFails: true,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await cleanupAbandoned(env, "2026-01-01T00:00:00.000Z", 50);

    // abort() on a finished upload throws; the finished object must still be reclaimed.
    expect(ops()).toEqual(["abort", "delete"]);
  });
});
