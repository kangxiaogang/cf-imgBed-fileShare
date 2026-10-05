import { describe, expect, it } from "vitest";
import { create } from "../src/domain/entries";
import { createEnv } from "./helpers";

const existing = {
  id: "old-id",
  filename: "old.png",
  content_type: "image/png",
  size: 3,
  sha256: "same-hash",
  version: 2,
  object_key: "old-id",
  upload_time: "2026-09-26T00:00:00.000Z",
  updated_time: "2026-09-26T00:00:00.000Z",
  expiration_time: null,
  note: null,
  guest_link_id: null,
};

type Row = typeof existing;

/**
 * `scope` decides which of the two dedup queries the stub answers, so a test that claims
 * guest scoping is scoped also proves the statement carries the link id — the mock returns
 * null for the other shape rather than quietly matching it.
 */
function envWithHashMatch(match: Row | null, scope: "global" | "guest" = "global") {
  const puts: string[] = [];
  const batches: unknown[][] = [];
  const statements: string[] = [];
  const env = createEnv({
    first: (sql) => {
      if (!sql.includes("WHERE sha256 = ? AND size = ?")) return null;
      const wantsGuestScope = sql.includes("guest_link_id = ?");
      return wantsGuestScope === (scope === "guest") ? (match as never) : null;
    },
    onQuery: (sql) => statements.push(sql),
    bucket: {
      put: async (key: string) => void puts.push(key),
      get: async () => null,
      delete: async () => {},
    },
    batch: (list) => {
      batches.push(list as unknown[][]);
      return [];
    },
  });
  return { env, puts, batches, statements };
}

const bytes = () => new TextEncoder().encode("img");
const upload = (over: Record<string, unknown> = {}) => ({
  filename: "a.png",
  contentType: "image/png",
  bytes: bytes(),
  note: null,
  expiresAt: null,
  ...over,
});

describe("create dedup", () => {
  it("reuses an existing image instead of storing a copy", async () => {
    const { env, puts, batches } = envWithHashMatch(existing);
    const saved = await create(env, upload(), { mode: "global" });
    // The new name is reported, not the stored one: it becomes the alt text of the generated
    // Markdown, and a re-upload called shot-2.png should not inherit shot-1.png's caption.
    expect(saved).toMatchObject({ id: "old-id", filename: "a.png", version: 2, deduped: true });
    expect(puts).toEqual([]);
    expect(batches).toEqual([]);
  });

  it("stores an image with no hash match", async () => {
    const { env, puts, batches } = envWithHashMatch(null);
    const saved = await create(env, upload(), { mode: "global" });
    expect(saved.deduped).toBe(false);
    expect(puts).toHaveLength(1);
    expect(batches).toHaveLength(1);
  });

  it("never dedupes a non-image upload", async () => {
    // Same bytes, different type: stored twice, because the point of the feature is a link
    // that renders as an image.
    const { env, puts, batches } = envWithHashMatch(existing);
    const saved = await create(env, upload({ contentType: "text/plain" }), { mode: "global" });
    expect(saved.deduped).toBe(false);
    expect(puts).toHaveLength(1);
    expect(batches).toHaveLength(1);
  });

  it("does not look at all when dedup is off", async () => {
    const { env, puts, statements } = envWithHashMatch(existing);
    const saved = await create(env, upload(), { mode: "off" });
    expect(saved.deduped).toBe(false);
    expect(puts).toHaveLength(1);
    expect(statements.some((sql) => sql.includes("WHERE sha256 = ?"))).toBe(false);
  });

  it("scopes a guest's dedup to the link that is asking", async () => {
    // The public URL is the credential: handing a guest a link that came from another
    // guest's upload would hand them somebody else's file.
    const { env, statements } = envWithHashMatch(existing, "guest");
    const saved = await create(env, upload({ guestLinkId: "link-1" }), {
      mode: "guest",
      linkId: "link-1",
    });
    expect(saved.deduped).toBe(true);
    const query = statements.find((sql) => sql.includes("WHERE sha256 = ?")) || "";
    expect(query).toContain("guest_link_id = ?");
  });

  it("stores when the same bytes arrived under a different guest link", async () => {
    const { env, puts } = envWithHashMatch(null, "guest");
    const saved = await create(env, upload({ guestLinkId: "link-2" }), {
      mode: "guest",
      linkId: "link-2",
    });
    expect(saved.deduped).toBe(false);
    expect(puts).toHaveLength(1);
  });
});
