import { describe, expect, it } from "vitest";
import { authorized, clientIp, rateLimit } from "../src/platform/http";
import { ENTRY_ID_LENGTH, generateID } from "../src/platform/id";
import { createEnv } from "./helpers";

const env = (secret = "secret") => createEnv({ secret });
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

describe("generateID", () => {
  it("uses the default length for entry ids", () => {
    expect(generateID()).toHaveLength(ENTRY_ID_LENGTH);
  });

  it("honours an explicit length", () => {
    expect(generateID(6)).toHaveLength(6);
  });

  it("only emits characters from the alphabet", () => {
    expect(generateID(200)).toMatch(/^[0-9A-Za-z]+$/);
  });

  it("does not repeat itself across calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateID()));
    expect(ids.size).toBe(500);
  });
});

describe("authorized", () => {
  it("accepts the secret via Authorization", () => {
    expect(authorized(req("https://x/api/entries", { Authorization: "secret" }), env())).toBe(true);
  });

  it("accepts the secret via X-Api-Key", () => {
    expect(authorized(req("https://x/api/entries", { "X-Api-Key": "secret" }), env())).toBe(true);
  });

  it("fails closed when PS_SHARED_SECRET is unset", () => {
    expect(authorized(req("https://x/api/entries", { Authorization: "secret" }), env(""))).toBe(false);
  });

  it("rejects a near-miss secret", () => {
    expect(authorized(req("https://x/api/entries", { Authorization: "secreT" }), env())).toBe(false);
  });

  it("rejects a truncated secret", () => {
    expect(authorized(req("https://x/api/entries", { Authorization: "secre" }), env())).toBe(false);
  });

  it("accepts ?token= on the image-host upload route", () => {
    // The one route whose callers are upload tools, some of whose config screens have no
    // field for a request header.
    expect(authorized(req("https://x/api/entry?token=secret"), env())).toBe(true);
  });

  it("rejects ?token= on every other route", () => {
    for (const path of [
      "/api/settings",
      "/api/entries",
      "/api/entries/delete",
      "/api/entry/abc123",
      "/api/guest-links",
      "/api/entry/multipart/init",
      "/api/upload",
    ]) {
      expect(authorized(req(`https://x${path}?token=secret`), env())).toBe(false);
    }
  });

  it("rejects a wrong ?token=", () => {
    expect(authorized(req("https://x/api/entry?token=nope"), env())).toBe(false);
  });
});

describe("clientIp", () => {
  it("uses the edge-provided address", () => {
    expect(clientIp(req("https://x/", { "CF-Connecting-IP": "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("ignores a spoofed X-Forwarded-For", () => {
    expect(clientIp(req("https://x/", { "X-Forwarded-For": "9.9.9.9" }))).toBe("unknown");
  });

  it("prefers the edge address over X-Forwarded-For", () => {
    const request = req("https://x/", { "CF-Connecting-IP": "1.2.3.4", "X-Forwarded-For": "9.9.9.9" });
    expect(clientIp(request)).toBe("1.2.3.4");
  });
});

describe("rateLimit", () => {
  it("admits up to the limit, then rejects", () => {
    const key = `test-limit-${Date.now()}-${Math.random()}`;
    expect(Array.from({ length: 3 }, () => rateLimit(key, 3, 60_000))).toEqual([true, true, true]);
    expect(rateLimit(key, 3, 60_000)).toBe(false);
  });

  it("does not let a spoofed header create a new bucket", () => {
    const base = `test-xff-${Date.now()}`;
    for (let i = 0; i < 3; i += 1) {
      const request = req("https://x/", { "X-Forwarded-For": `9.9.9.${i}` });
      expect(rateLimit(clientIp(request), 3, 60_000)).toBe(true);
    }
    const spoofed = req("https://x/", { "X-Forwarded-For": "8.8.8.8" });
    expect(rateLimit(clientIp(spoofed), 3, 60_000)).toBe(false);
  });
});
