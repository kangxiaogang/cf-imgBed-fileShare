import { describe, expect, it, vi } from "vitest";
import { MAX_GUEST_FILE_BYTES, MAX_GUEST_REQUEST_BYTES, MAX_GUEST_UPLOADS } from "@picoshare/shared";
import { create, upload } from "../src/domain/guest";
import { HttpError } from "../src/platform/http";
import type { GuestLinkRow } from "../src/types";
import { createEnv, formRequest, jsonRequest, type QueryCall } from "./helpers";

function guestEnv(link: GuestLinkRow | null, options: { reservationChanges?: number } = {}) {
  const runs: QueryCall[] = [];
  const puts: string[] = [];
  const batches: unknown[][] = [];
  const env = createEnv({
    first: (sql) => (sql.includes("FROM guest_links") ? link : null),
    run: (sql, args) => {
      runs.push({ sql, args });
      if (sql.includes("UPDATE guest_links")) {
        return { meta: { changes: options.reservationChanges ?? 1 } };
      }
      return {};
    },
    bucket: {
      put: async (key: string) => {
        puts.push(key);
      },
      delete: async () => {},
      get: async () => null,
    },
    batch: async (list) => {
      batches.push(list);
      return [];
    },
  });
  return { env, runs, puts, batches };
}

const linkRow = (overrides: Partial<GuestLinkRow> = {}): GuestLinkRow => ({
  id: "g1",
  label: null,
  created_time: "2026-09-26T00:00:00.000Z",
  max_file_bytes: MAX_GUEST_FILE_BYTES,
  max_file_lifetime_days: null,
  max_file_uploads: null,
  url_expires: null,
  upload_count: 0,
  ...overrides,
});

const jsonPut = (body: unknown) => jsonRequest("https://example.com/api/guest-links", body);

describe("createGuestLink", () => {
  it("falls back to real defaults for unusable limits", async () => {
    // An uncapped guest link used to accept 20 x 5GB in a single formData() call.
    const { env, runs } = guestEnv(null);
    await create(
      jsonPut({ label: "x", max_file_bytes: -5, max_file_lifetime_days: "abc", max_file_uploads: -1 }),
      env,
    );
    const insert = runs.find((run) => run.sql.includes("INSERT INTO guest_links"));
    expect(insert?.args.slice(2, 5)).toEqual([MAX_GUEST_FILE_BYTES, null, MAX_GUEST_UPLOADS]);
  });

  it("rejects a fractional limit that would floor to zero", async () => {
    const { env, runs } = guestEnv(null);
    await create(jsonPut({ max_file_bytes: 0.5, max_file_uploads: 0.9 }), env);
    const insert = runs.find((run) => run.sql.includes("INSERT INTO guest_links"));
    // 0 is falsy, so returning it would read as "no limit" and disable the cap entirely.
    expect(insert?.args[2]).toBe(MAX_GUEST_FILE_BYTES);
    expect(insert?.args[4]).toBe(MAX_GUEST_UPLOADS);
  });

  it("keeps a usable limit", async () => {
    const { env, runs } = guestEnv(null);
    await create(jsonPut({ max_file_bytes: 1024, max_file_uploads: 3 }), env);
    const insert = runs.find((run) => run.sql.includes("INSERT INTO guest_links"));
    expect(insert?.args.slice(2, 5)).toEqual([1024, null, 3]);
  });

  it("rejects a past expiration date", async () => {
    const { env } = guestEnv(null);
    const err = await create(jsonPut({ url_expires: "2020-01-01T00:00:00Z" }), env).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
  });
});

describe("guestUpload", () => {
  const uploadRequest = (bytes = "hello") =>
    formRequest("https://example.com/api/guest/g1/upload", {
      files: new File([bytes], "a.txt", { type: "text/plain" }),
    });

  const uploadImageRequest = (bytes = "hello") =>
    formRequest("https://example.com/api/guest/g1/upload", {
      files: new File([bytes], "a.png", { type: "image/png" }),
    });

  it("rejects a file over the link's per-file limit", async () => {
    const { env, puts } = guestEnv(linkRow({ max_file_bytes: 2 }));
    const err = await upload(uploadRequest("hello"), env, "g1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
    expect(puts).toHaveLength(0);
  });

  it("rejects an oversized request before formData() buffers it", async () => {
    const { env, puts } = guestEnv(linkRow());
    const request = formRequest("https://example.com/api/guest/g1/upload", {
      files: new File(["hello"], "a.txt", { type: "text/plain" }),
    });
    const oversized = MAX_GUEST_REQUEST_BYTES + 1;
    // formData() has already consumed the real body, so assert the check ran first.
    const formData = vi.spyOn(request, "formData");
    Object.defineProperty(request, "headers", {
      value: new Headers({ "content-length": String(oversized) }),
    });
    const err = await upload(request, env, "g1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
    expect(formData).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  it("loses the race safely when the upload limit was consumed concurrently", async () => {
    const { env, puts } = guestEnv(linkRow({ max_file_uploads: 1, upload_count: 0 }), {
      reservationChanges: 0,
    });
    const err = await upload(uploadRequest(), env, "g1").catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(429);
    expect(puts).toHaveLength(0);
  });

  it("gives an uploaded image an absolute url", async () => {
    // The image host exists to hand back a link, so an image has to come with one — and the url
    // addresses the share, not the entry, so it can be revoked later.
    const { env, puts } = guestEnv(linkRow());
    const res = await upload(uploadImageRequest(), env, "g1");
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      count: number;
      items: Array<{ url: string | null; markdown: string | null }>;
    };
    expect(body.count).toBe(1);
    expect(body.items[0].url).toMatch(/^https:\/\/example\.com\/img\//);
    expect(body.items[0].markdown).toContain(body.items[0].url!);
    expect(puts).toHaveLength(1);
  });

  it("stores an uploaded file and reports no link for it", async () => {
    // Nothing about sending a file through a guest link makes it public, and a guest has no
    // account with which to share it afterwards. So: no url, rather than a permanent one nobody
    // asked for.
    const { env, puts } = guestEnv(linkRow());
    const res = await upload(uploadRequest(), env, "g1");
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      count: number;
      items: Array<{ url: string | null; markdown: string | null; bbcode: string | null }>;
    };
    expect(body.count).toBe(1);
    expect(body.items[0].url).toBeNull();
    expect(body.items[0].markdown).toBeNull();
    expect(body.items[0].bbcode).toBeNull();
    expect(puts).toHaveLength(1);
  });
});
