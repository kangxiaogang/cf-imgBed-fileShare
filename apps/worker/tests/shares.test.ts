import { describe, expect, it } from "vitest";
import { expiryFromDays, mutationPayload } from "../src/domain/shares";
import { HttpError } from "../src/platform/http";
import { createEnv } from "./helpers";

const saved = { id: "abc", filename: "a.png", version: 1, sha256: null, deduped: false };

/**
 * `mutationPayload` used to live in `entries` and answer from the entry id alone. It moved here
 * because the URL it hands out now addresses a *share*, and the share is this module's to mint —
 * that is the whole difference between a link you can take back and one you cannot.
 */
describe("expiryFromDays", () => {
  it("reads a day count off the wire", () => {
    expect(expiryFromDays(null)).toBeNull();
    expect(expiryFromDays(1)).toMatch(/^\d{4}-/);
    expect(expiryFromDays(3650)).toMatch(/^\d{4}-/);
  });

  it("clamps rather than rejecting, to match the create path", () => {
    expect(expiryFromDays(999999)).toMatch(/^\d{4}-/);
  });

  it("rejects a value that is not a number, including a boolean", () => {
    // `Number(true)` is 1, so the lenient reader would have answered "expires tomorrow" to a body
    // that said nothing of the kind. This field decides when somebody loses access.
    for (const bad of ["7", true, false, {}, [], 0, -3, 0.5]) {
      expect(() => expiryFromDays(bad), `accepted ${JSON.stringify(bad)}`).toThrow(HttpError);
    }
  });

  it("names the field the way the form labels it", () => {
    // This message is what the browser shows in a toast, and the browser is the only thing that
    // ever sees it — nothing above the route checks it, and no test read it. It had drifted to
    // "分享有效期" while the input beside it says "链接有效天数", so the rejection talked about a
    // field the form does not have. Asserted rather than left to review, because the two strings
    // are in different packages and nothing else can hold them together.
    expect(() => expiryFromDays(0)).toThrow(/链接有效天数/);
    expect(() => expiryFromDays(0)).toThrow(/1-3650/);
    expect(() => expiryFromDays(0)).not.toThrow(/分享有效期/);
  });
});

describe("mutationPayload", () => {
  const env = () => createEnv({ first: () => null, all: () => ({ results: [] }) });

  it("uses PUBLIC_ORIGIN when configured", async () => {
    // The generated URL gets pasted into a README, so a spoofed Host must not reach it.
    const body = await mutationPayload(
      new Request("https://evil.example.com/api/entry"),
      { ...env(), PUBLIC_ORIGIN: "https://cdn.example.com/" } as never,
      saved,
      "image/png",
    );

    expect(body.url).toMatch(/^https:\/\/cdn\.example\.com\/img\/[A-Za-z0-9]{16}\/a\.png$/);
    expect(body.markdown).toContain(body.url);
  });

  it("falls back to the request origin", async () => {
    const body = await mutationPayload(
      new Request("https://real.example.com/api/entry"),
      env() as never,
      saved,
      "image/png",
    );

    expect(body.url).toMatch(/^https:\/\/real\.example\.com\/img\/[A-Za-z0-9]{16}\/a\.png$/);
  });

  it("gives an image a link and a file none", async () => {
    // The image host exists to hand back a link, so an uploaded image has to come with one. A file
    // does not: nothing about putting it in your library makes it public, and minting anyway is
    // how every upload ended up with a permanent URL nobody asked for — the thing shares were
    // introduced to undo.
    const image = await mutationPayload(
      new Request("https://x.example.com/api/entry"),
      env() as never,
      saved,
      "image/png",
    );
    const file = await mutationPayload(
      new Request("https://x.example.com/api/entry"),
      env() as never,
      saved,
      "text/plain",
    );

    expect(image.url).toMatch(/\/img\/[A-Za-z0-9]{16}\//);
    expect(file.url).toBeNull();
    expect(file.markdown).toBeNull();
    expect(file.bbcode).toBeNull();
  });

  it("mints nothing at all for a file", async () => {
    // The response being null is not enough on its own: a share row created and then not linked
    // would leave the file with a live token that nothing points at.
    const inserts: Array<{ sql: string; args: unknown[] }> = [];
    const local = createEnv({
      first: () => null,
      all: () => ({ results: [] }),
      onQuery: (sql) => {
        if (sql.includes("INSERT INTO shares")) inserts.push({ sql, args: [] });
      },
    });

    await mutationPayload(
      new Request("https://x.example.com/api/entry"),
      local as never,
      saved,
      "text/plain",
    );

    expect(inserts).toHaveLength(0);
  });

  it("still reports a link for a file that was already shared when its content is replaced", async () => {
    // A replace promises the public URL keeps working. A file the owner shared by hand therefore
    // still has one — and one they never shared still does not.
    const shared = createEnv({
      first: () => ({ share_id: "sharekeepme000000" }) as never,
      all: () => ({ results: [] }),
    });
    const bare = createEnv({ first: () => null, all: () => ({ results: [] }) });

    const kept = await mutationPayload(
      new Request("https://x.example.com/api/entry"),
      shared as never,
      saved,
      "text/plain",
      { reuseShare: true },
    );
    const none = await mutationPayload(
      new Request("https://x.example.com/api/entry"),
      bare as never,
      saved,
      "text/plain",
      { reuseShare: true },
    );

    expect(kept.url).toContain("/-sharekeepme000000");
    expect(none.url).toBeNull();
  });

  it("addresses a share rather than the entry", async () => {
    // The entry id used to be in the URL, which meant revoking access meant deleting the file.
    const body = await mutationPayload(new Request("https://x.example.com/api/entry"), env() as never, saved, "image/png");

    expect(body.url).not.toContain("/img/abc/");
    expect(body.id).toBe("abc");
  });

  it("gives every upload its own link, so a deduplicated paste is a separate share", async () => {
    // A repeat of bytes already stored returns the *existing* entry. Handing back that entry's
    // link would give the second recipient a token the first one may already have had revoked.
    const first = await mutationPayload(new Request("https://x.example.com/api/entry"), env() as never, saved, "image/png");
    const second = await mutationPayload(new Request("https://x.example.com/api/entry"), env() as never, saved, "image/png");

    expect(second.url).not.toBe(first.url);
  });

  it("mints a permanent link, because the upload contract returns one immediately", async () => {
    const body = await mutationPayload(new Request("https://x.example.com/api/entry"), env() as never, saved, "image/png");

    expect(body.url).toBeTruthy();
  });

  it("writes exactly one share, for the entry it was given", async () => {
    const inserts: Array<{ sql: string; args: unknown[] }> = [];
    const local = createEnv({
      first: () => null,
      all: () => ({ results: [] }),
      onQuery: (sql, args) => {
        if (sql.includes("INSERT INTO shares")) inserts.push({ sql, args });
      },
    });

    await mutationPayload(new Request("https://x.example.com/api/entry"), local as never, saved, "image/png");

    expect(inserts).toHaveLength(1);
    expect(inserts[0].args?.[1]).toBe("abc");
    // The upload-minted share never expires; expiry is something the owner opts into afterwards.
    expect(inserts[0].args?.[3]).toBeNull();
  });

  it("reuses the entry's live share when asked to, so a replace keeps the public URL", async () => {
    // Replacing content promises the link keeps working. Minting a fresh token here would hand
    // back a URL the recipient has never seen, which is the opposite of what a replace is for.
    const existing = createEnv({
      first: () => ({ share_id: "sharekeepme000000" }) as never,
      all: () => ({ results: [] }),
    });

    const body = await mutationPayload(
      new Request("https://x.example.com/api/entry"),
      existing as never,
      saved,
      "image/png",
      { reuseShare: true },
    );

    expect(body.url).toContain("/img/sharekeepme000000/");
  });

  it("mints when reuse is asked for and there is nothing to reuse", async () => {
    // An entry whose every share is revoked has no link left to keep.
    const empty = createEnv({ first: () => null, all: () => ({ results: [] }) });

    const body = await mutationPayload(
      new Request("https://x.example.com/api/entry"),
      empty as never,
      saved,
      "image/png",
      { reuseShare: true },
    );

    expect(body.url).toMatch(/\/img\/[A-Za-z0-9]{16}\//);
  });
});