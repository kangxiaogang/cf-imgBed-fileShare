import { describe, expect, it } from "vitest";
import {
  cleanupExpired,
  removeMany,
  replace,
  require,
  updateMetadata,
} from "../src/domain/entries";
import { history, prune, RETENTION_DAYS } from "../src/domain/downloads";
import { archive } from "../src/domain/versions";
import { HttpError } from "../src/platform/http";
import type { Env } from "../src/types";
import { createEnv, entryRow, type QueryCall } from "./helpers";

const bytes = (text = "new") => new TextEncoder().encode(text);

/**
 * Whole days from now until the expiry an UPDATE carries, read back off the ISO string it stores.
 * `expirationToISO` adds the count to today's date, so the instant lands a fraction of a day short
 * of a whole multiple of 86400000 — rounding recovers the count that was asked for, which is the
 * thing under test. The expiry is the third-from-last argument: `updated_time` and the id are
 * pushed after it, unconditionally.
 */
const daysUntil = (call: QueryCall) =>
  Math.round((Date.parse(call.args.at(-3) as string) - Date.now()) / 86400000);

function mockEnv(handlers: {
  selectExpired?: () => { results: Array<{ id: string }> };
}): Env {
  return createEnv({
    all: (sql) => {
      if (sql.includes("SELECT id") && sql.includes("FROM entries")) {
        return handlers.selectExpired ? handlers.selectExpired() : { results: [] };
      }
      return { results: [] };
    },
    first: () => null,
    bucket: { delete: async () => {} },
  });
}

describe("cleanupExpired", () => {
  it("deletes expired entries and their objects", async () => {
    const deleted: unknown[] = [];
    const env = mockEnv({
      selectExpired: () => ({ results: [{ id: "exp-1" }, { id: "exp-2" }] }),
    });
    (env.BUCKET as unknown as { delete: (keys: string[]) => Promise<void> }).delete = async (keys) =>
      void deleted.push(...keys);

    expect(await cleanupExpired(env, "2026-02-11T00:00:00.000Z", 100)).toBe(2);
    expect(deleted).toEqual(["exp-1", "exp-2"]);
  });

  it("returns 0 when nothing expired", async () => {
    expect(await cleanupExpired(mockEnv({}), "2026-02-11T00:00:00.000Z", 10)).toBe(0);
  });
});

describe("removeMany", () => {
  it("refuses to silently truncate an oversized request", async () => {
    // Slicing reported ids as deleted that were never touched, with nothing to notice.
    const err = await removeMany(createEnv(), Array.from({ length: 150 }, (_, i) => `id-${i}`)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
  });

  // `remove` no longer guesses from a separate SELECT: it returns whether the entry's own
  // DELETE matched. The mock has to model that, or every id looks deleted.
  const envWithEntries = (ids: string[]) =>
    createEnv({
      batch: (statements) =>
        statements.map((statement) => {
          // Every statement in the batch binds the entry id as its first argument, so the
          // entry DELETE (and the cascades) match exactly when that id was stored.
          const target = (statement as { args: unknown[] }).args[0];
          const matched = ids.includes(String(target));
          return { success: true, meta: { changes: matched ? 1 : 0, last_row_id: 0 } };
        }),
      bucket: { delete: async () => {} },
    });

  it("counts only ids that existed, and de-duplicates the request", async () => {
    const env = envWithEntries(["a", "b"]);
    await expect(removeMany(env, ["a", "b", "a"])).resolves.toBe(2);
  });

  it("does not count ids that were never stored", async () => {
    const env = envWithEntries([]);
    await expect(removeMany(env, ["gone"])).resolves.toBe(0);
  });
});

describe("require", () => {
  it("rejects an expired entry instead of letting it be edited", async () => {
    // Expiry used to be checked only in the serving handlers, so a client that had already
    // received 410 could still read metadata and replace the content, minting a fresh ETag.
    const deleted: string[] = [];
    const env = createEnv({
      first: () => entryRow({ expiration_time: "2020-01-01T00:00:00.000Z" }) as never,
      bucket: { delete: async (keys: string[]) => deleted.push(...keys) },
    });
    const err = await require(env, "abc123").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(410);
    expect(deleted).toContain("abc123");
  });

  it("404s for a missing entry", async () => {
    const err = await require(createEnv({ first: () => null }), "nope").catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(404);
  });

  it("passes through a live entry", async () => {
    const env = createEnv({ first: () => entryRow() as never });
    await expect(require(env, "abc123")).resolves.toMatchObject({ id: "abc123" });
  });
});

describe("updateMetadata", () => {
  const envWithEntry = (updates: QueryCall[]) =>
    createEnv({
      first: () =>
        entryRow({ note: "keep me", expiration_time: "2030-01-01T00:00:00.000Z" }) as never,
      onBind: (sql, args) => {
        if (sql.includes("UPDATE entries")) updates.push({ sql, args });
      },
    });

  it("only touches the fields present in the body", async () => {
    // Treating the call as a full overwrite silently erased the note and the expiry for any
    // partial body, such as a script sending just {filename}.
    const updates: QueryCall[] = [];
    await expect(updateMetadata(envWithEntry(updates), "abc123", { filename: "new.png" })).resolves.toBe(
      "new.png",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toBe("UPDATE entries SET filename = ?, updated_time = ? WHERE id = ?");
    expect(updates[0].args[0]).toBe("new.png");
    expect(updates[0].args.at(-1)).toBe("abc123");
  });

  it("keeps the note when it is not part of the body", async () => {
    const updates: QueryCall[] = [];
    await updateMetadata(envWithEntry(updates), "abc123", { filename: "new.png" });
    expect(updates[0].sql).not.toContain("note = ?");
  });

  it("clears the expiry when expiration is switched off", async () => {
    const updates: QueryCall[] = [];
    await updateMetadata(envWithEntry(updates), "abc123", { deleteAfterExpiration: false });
    expect(updates[0].sql).toContain("expiration_time = NULL");
  });

  it("always bumps updated_time so a rename invalidates the ETag", async () => {
    const updates: QueryCall[] = [];
    await updateMetadata(envWithEntry(updates), "abc123", { filename: "new.png" });
    expect(updates[0].sql).toContain("updated_time = ?");
    expect(updates[0].args.at(-2)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects an empty body", async () => {
    const err = await updateMetadata(envWithEntry([]), "abc123", {}).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
  });

  it("rejects an invalid expiry", async () => {
    const err = await updateMetadata(envWithEntry([]), "abc123", {
      deleteAfterExpiration: true,
      expirationDays: 0,
    }).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
  });

  it("rejects a non-boolean deleteAfterExpiration instead of trusting its truthiness", async () => {
    // The field decided whether an expiry was set, but was only presence-checked: any truthy
    // value reached the "set an expiry" branch, so this string switched the expiry ON. The
    // same-shaped field in updateSettings was rejected with a typeof check.
    for (const value of ["false", "true", 1, 0, {}, []]) {
      const updates: QueryCall[] = [];
      const err = await updateMetadata(envWithEntry(updates), "abc123", {
        deleteAfterExpiration: value,
        expirationDays: 7,
      }).catch((e: unknown) => e);
      expect((err as HttpError).status, `accepted ${JSON.stringify(value)}`).toBe(400);
      expect(updates).toHaveLength(0);
    }
  });

  it("sets the expiry for a real boolean", async () => {
    const updates: QueryCall[] = [];
    await updateMetadata(envWithEntry(updates), "abc123", {
      deleteAfterExpiration: true,
      expirationDays: 7,
    });
    expect(updates[0].sql).toContain("expiration_time = ?");
  });

  it("clamps an expiry past the maximum, the way the create path does", async () => {
    // POST has always answered 9999 days with 3650. The update path stored it as typed, so the
    // same number meant a decade through one endpoint and ten years through the other.
    const updates: QueryCall[] = [];
    await updateMetadata(envWithEntry(updates), "abc123", {
      deleteAfterExpiration: true,
      expirationDays: 9999,
    });
    expect(daysUntil(updates[0])).toBe(3650);
  });

  it("stores the count it was given when that is already a whole number in range", async () => {
    // The clamp has to leave ordinary values alone. 7.9 lands on 7 either way — `expirationToISO`
    // truncates through `setUTCDate`, so that case never depended on the reader — but nothing
    // else pins the in-range path down, and a bound applied to the wrong side of the comparison
    // would clamp every day count down to the minimum.
    for (const days of [1, 7, 365, 3650]) {
      const updates: QueryCall[] = [];
      await updateMetadata(envWithEntry(updates), "abc123", {
        deleteAfterExpiration: true,
        expirationDays: days,
      });
      expect(daysUntil(updates[0]), `stored ${days} days as something else`).toBe(days);
    }
  });

  it("rejects an expiry that rounds away to nothing", async () => {
    // Half a day is a real span of time but not a schedulable expiry, and it used to be accepted.
    const updates: QueryCall[] = [];
    const err = await updateMetadata(envWithEntry(updates), "abc123", {
      deleteAfterExpiration: true,
      expirationDays: 0.5,
    }).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("rejects a non-numeric expirationDays", async () => {
    // Number("30") === 30, so a string used to be silently accepted on a JSON number field.
    const updates: QueryCall[] = [];
    const err = await updateMetadata(envWithEntry(updates), "abc123", {
      deleteAfterExpiration: true,
      expirationDays: "30",
    }).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("rejects a whitespace-only filename", async () => {
    const updates: QueryCall[] = [];
    const err = await updateMetadata(envWithEntry(updates), "abc123", { filename: "   " }).catch(
      (e: unknown) => e,
    );
    expect((err as HttpError).status).toBe(400);
    expect(updates).toHaveLength(0);
  });
});

describe("replace", () => {
  const entry = () =>
    entryRow({ id: "abc", version: 3, object_key: "abc/versions/3" }) as never;
  const input = { bytes: bytes(), contentType: "text/plain", expectedVersion: 3 };

  it("publishes the next version and records it", async () => {
    const statements: QueryCall[] = [];
    const puts: string[] = [];
    const env = createEnv({
      bucket: {
        put: async (key: string) => void puts.push(key),
        get: async () => ({ arrayBuffer: async () => new ArrayBuffer(3) }),
      },
      onQuery: (sql, args) => statements.push({ sql, args }),
    });

    const result = await replace(env, entry(), input);
    expect(result.version).toBe(4);

    // Staged under a fresh key, never the outgoing one: a retry after a failure must not be
    // able to read a leftover object as the new content.
    expect(puts[0]).toMatch(/^abc\/versions\/4-/);

    // The bump is guarded on the version the caller expected. That guard is the only thing
    // making two concurrent replacements resolve to one winner and one 409.
    const bump = statements.find((q) => q.sql.includes("UPDATE entries"));
    expect(bump?.args.at(-1)).toBe(3);
    expect(bump?.args).toContain(4);
    expect(statements.some((q) => q.sql.includes("INSERT INTO file_versions"))).toBe(true);
  });

  it("409s when a concurrent writer already advanced the entry", async () => {
    const env = createEnv({
      run: () => ({ success: true, meta: { changes: 0, last_row_id: 0 } }),
      bucket: { put: async () => ({}), get: async () => ({ arrayBuffer: async () => new ArrayBuffer(3) }) },
    });
    const err = await replace(env, entry(), input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
  });

  it("removes the staged object when the bump loses", async () => {
    const deleted: unknown[] = [];
    const env = createEnv({
      run: () => ({ success: true, meta: { changes: 0, last_row_id: 0 } }),
      bucket: { put: async () => ({}), delete: async (key: unknown) => void deleted.push(key) },
    });
    await replace(env, entry(), input).catch(() => {});
    expect(deleted).toHaveLength(1);
  });

  it("does not record a row for the version the entry never reached", async () => {
    // Archiving the *outgoing* version is expected and correct. What must not happen is a row
    // for version 4 while the entry is still at 3: that is wrong data in the version list.
    // The gap this leaves instead is filled by the next archive, which is why the version
    // bump and the row insert are not one transaction.
    const statements: QueryCall[] = [];
    const env = createEnv({
      run: (sql) => ({
        success: true,
        meta: { changes: sql.includes("UPDATE entries") ? 0 : 1, last_row_id: 0 },
      }),
      bucket: { put: async () => ({}), get: async () => ({ arrayBuffer: async () => new ArrayBuffer(3) }) },
      onQuery: (sql, args) => statements.push({ sql, args }),
    });
    await replace(env, entry(), input).catch(() => {});

    const versionRows = statements.filter((q) => q.sql.includes("INSERT INTO file_versions"));
    // The outgoing version was archived...
    expect(versionRows.some((q) => q.args[1] === 3)).toBe(true);
    // ...and the incoming one was not.
    expect(versionRows.some((q) => q.args[1] === 4)).toBe(false);
  });
});

describe("archive", () => {
  it("does not copy version 1 bytes that already live at the entry key", async () => {
    // Copying would leave the original object referenced by nothing and permanently double
    // the stored bytes for the life of the entry.
    const puts: string[] = [];
    const statements: QueryCall[] = [];
    const env = createEnv({
      bucket: { put: async (key: string) => void puts.push(key) },
      onQuery: (sql, args) => statements.push({ sql, args }),
    });

    await archive(env, entryRow({ version: 1, object_key: "abc123" }) as never);

    expect(puts).toEqual([]);
    expect(statements.some((q) => q.sql.includes("UPDATE file_versions"))).toBe(true);
    expect(statements.some((q) => q.sql.includes("INSERT INTO file_versions"))).toBe(false);
  });

  it("refreshes version 1 metadata so a rename is reflected", async () => {
    const binds: unknown[][] = [];
    const env = createEnv({
      onBind: (sql, args) => {
        if (sql.includes("UPDATE file_versions")) binds.push(args);
      },
    });

    await archive(
      env,
      entryRow({ version: 1, object_key: "abc123", filename: "renamed.png" }) as never,
    );

    expect(binds[0]?.[0]).toBe("renamed.png");
    expect(binds[0]?.at(-1)).toBe("abc123");
  });

  it("copies the bytes for later versions", async () => {
    const puts: string[] = [];
    const env = createEnv({
      bucket: {
        put: async (key: string) => void puts.push(key),
        get: async () => ({ arrayBuffer: async () => new ArrayBuffer(3) }),
      },
    });

    await archive(env, entryRow({ version: 2, object_key: "abc123/versions/2" }) as never);

    expect(puts).toEqual(["abc123/versions/2"]);
  });
});

describe("prune", () => {
  it("deletes events older than the cutoff", async () => {
    const statements: QueryCall[] = [];
    const env = createEnv({ onQuery: (sql, args) => statements.push({ sql, args }) });
    await prune(env, "2026-01-01T00:00:00.000Z");
    const cut = statements.find((q) => q.sql.includes("DELETE FROM download_events"));
    expect(cut?.args).toEqual(["2026-01-01T00:00:00.000Z"]);
  });

  it("defaults to the retention window rather than now", async () => {
    // A default of `nowIso()` meant the hourly maintenance wiped the entire download history
    // on every run. The test above passes an explicit cutoff, which is why it passed anyway.
    const statements: QueryCall[] = [];
    const env = createEnv({ onQuery: (sql, args) => statements.push({ sql, args }) });
    const before = Date.now();
    await prune(env);
    const cut = statements.find((q) => q.sql.includes("DELETE FROM download_events"));
    const days = (before - Date.parse(String(cut?.args[0]))) / 86_400_000;
    expect(days).toBeGreaterThan(RETENTION_DAYS - 0.01);
    expect(days).toBeLessThanOrEqual(RETENTION_DAYS);
  });
});

describe("history", () => {
  it("caps the number of returned rows", async () => {
    // The table is written by unauthenticated requests and reclaimed only by retention, so
    // an unbounded read here is an unbounded response built from an unbounded table.
    const statements: QueryCall[] = [];
    const env = createEnv({
      first: () => entryRow() as never,
      onQuery: (sql, args) => statements.push({ sql, args }),
    });
    await history(env, "abc123", false);
    expect(statements.find((q) => q.sql.includes("SELECT downloaded_at"))?.sql).toContain(
      "LIMIT ?",
    );
  });

  it("groups by address in the default view", async () => {
    const statements: QueryCall[] = [];
    const env = createEnv({
      first: () => entryRow() as never,
      onQuery: (sql, args) => statements.push({ sql, args }),
    });
    await history(env, "abc123", true);
    expect(statements.some((q) => q.sql.includes("GROUP BY ip"))).toBe(true);
  });
});
