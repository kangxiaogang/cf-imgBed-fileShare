import { describe, expect, it } from "vitest";
import { HttpError } from "../src/platform/http";
import { getSettings, resolveExpiration, updateSettings } from "../src/domain/settings";
import { createEnv, jsonRequest, type QueryCall } from "./helpers";

function envWithSettings(rows: Array<{ key: string; value: string }> = []) {
  const statements: QueryCall[] = [];
  const env = createEnv({
    all: () => ({ results: rows }),
    onBind: (sql, args) => {
      if (sql.includes("REPLACE INTO settings")) statements.push({ sql, args });
    },
    batch: async (list) => list,
  });
  return { env, statements };
}

const put = (body: unknown) => jsonRequest("https://example.com/api/settings", body, "PUT");

describe("getSettings", () => {
  it("falls back to defaults for missing or invalid values", async () => {
    const { env } = envWithSettings([{ key: "default_expiration_days", value: "abc" }]);
    await expect(getSettings(env)).resolves.toEqual({ storeForever: true, defaultDays: 14 });
  });

  it("reads stored values", async () => {
    const { env } = envWithSettings([
      { key: "store_forever", value: "0" },
      { key: "default_expiration_days", value: "7" },
    ]);
    await expect(getSettings(env)).resolves.toEqual({ storeForever: false, defaultDays: 7 });
  });
});

describe("updateSettings", () => {
  it("updates only the provided fields", async () => {
    const { env, statements } = envWithSettings();
    const res = await updateSettings(put({ storeForever: true }), env);
    expect(res.status).toBe(200);
    expect(statements).toHaveLength(1);
    expect(statements[0].args).toEqual(["1"]);
  });

  it("rejects invalid day values instead of storing NaN", async () => {
    const { env, statements } = envWithSettings();
    const err = await updateSettings(put({ defaultDays: "abc" }), env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect(statements).toHaveLength(0);
  });

  it("rejects an empty update", async () => {
    const { env } = envWithSettings();
    const err = await updateSettings(put({}), env).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
  });

  it("rejects a boolean day value", async () => {
    // Number(true) === 1 would have stored "1" for {"defaultDays": true}.
    const { env, statements } = envWithSettings();
    const err = await updateSettings(put({ defaultDays: true }), env).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
    expect(statements).toHaveLength(0);
  });

  it("rejects a numeric string for a number field", async () => {
    const { env, statements } = envWithSettings();
    const err = await updateSettings(put({ defaultDays: "30" }), env).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(400);
    expect(statements).toHaveLength(0);
  });

  it("rejects out-of-range and non-finite day values", async () => {
    // 1.5 is deliberately absent: a fractional day count is floored, which is harmless and
    // existing behaviour.
    for (const value of [0, -1, 3651, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { env, statements } = envWithSettings();
      const err = await updateSettings(put({ defaultDays: value }), env).catch((e: unknown) => e);
      expect((err as HttpError).status, `accepted ${value}`).toBe(400);
      expect(statements).toHaveLength(0);
    }
  });

  it("rejects a non-boolean storeForever", async () => {
    for (const value of ["true", "1", 1, 0]) {
      const { env, statements } = envWithSettings();
      const err = await updateSettings(put({ storeForever: value }), env).catch((e: unknown) => e);
      expect((err as HttpError).status, `accepted ${JSON.stringify(value)}`).toBe(400);
      expect(statements).toHaveLength(0);
    }
  });
});

describe("resolveExpiration", () => {
  it("keeps files forever when store_forever is set and no value is requested", async () => {
    const { env } = envWithSettings([{ key: "store_forever", value: "1" }]);
    await expect(resolveExpiration(env, null)).resolves.toBeNull();
  });

  it("applies the default expiry when store_forever is off", async () => {
    // Previously every upload path hard-coded `expiration = null`, so these settings were
    // write-only and a configured "keep 7 days" silently stored files forever.
    const { env } = envWithSettings([
      { key: "store_forever", value: "0" },
      { key: "default_expiration_days", value: "7" },
    ]);
    const expiration = await resolveExpiration(env, null);
    expect(expiration).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const days = Math.round((Date.parse(expiration!) - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(6);
    expect(days).toBeLessThanOrEqual(7);
  });

  it("lets an explicit request win over the default", async () => {
    const { env } = envWithSettings([
      { key: "store_forever", value: "0" },
      { key: "default_expiration_days", value: "7" },
    ]);
    const expiration = await resolveExpiration(env, "1");
    const days = Math.round((Date.parse(expiration!) - Date.now()) / 86_400_000);
    expect(days).toBe(1);
  });

  it("falls back to the configured default when the value is present but unusable", async () => {
    // Every one of these reached `expirationToISO(null)`, which is no expiry: the branch was
    // taken on presence, so a value that could not be parsed produced "keep forever" instead of
    // the configured default. Forever is a decision, and only an empty field or the setting may
    // make it.
    for (const requested of ["abc", "0", "-8", "0.5", "  ", "NaN"]) {
      const { env } = envWithSettings([
        { key: "store_forever", value: "0" },
        { key: "default_expiration_days", value: "7" },
      ]);
      const expiration = await resolveExpiration(env, requested);
      expect(expiration, `${JSON.stringify(requested)} became no expiry`).not.toBeNull();
      const days = Math.round((Date.parse(expiration as string) - Date.now()) / 86_400_000);
      expect(days, `${JSON.stringify(requested)} gave ${days} days`).toBeGreaterThanOrEqual(6);
      expect(days).toBeLessThanOrEqual(7);
    }
  });

  it("still clamps a usable value rather than falling back", async () => {
    // The unusable case must not turn into "ignore the request": 9999 is understood, just too big.
    const { env } = envWithSettings([
      { key: "store_forever", value: "0" },
      { key: "default_expiration_days", value: "7" },
    ]);
    const expiration = await resolveExpiration(env, "9999");
    const days = Math.round((Date.parse(expiration as string) - Date.now()) / 86_400_000);
    expect(days).toBe(3650);
  });

  it("treats an explicit keep-forever as no expiry", async () => {
    const { env } = envWithSettings([{ key: "default_expiration_days", value: "7" }]);
    await expect(resolveExpiration(env, "")).resolves.toBeNull();
  });
});
