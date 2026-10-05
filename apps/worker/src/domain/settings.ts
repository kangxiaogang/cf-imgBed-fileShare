import type { OkResponse, Settings, SystemInfo } from "@picoshare/shared";
import { DEFAULT_EXPIRATION_DAYS, MAX_EXPIRATION_DAYS } from "@picoshare/shared";
import { HttpError, json, readJson } from "../platform/http";
import { all, one } from "../platform/db";
import { boundedNumber, bool, expirationToISO, parseExpirationDays } from "../platform/parse";
import type { Env } from "../types";

/*
 * The `settings` table, plus the two read-only aggregates the settings page shows.
 *
 * The one thing worth finding here is `resolveExpiration`. It is the reason this module
 * exists rather than living inside the upload paths: expiry resolution reached four separate
 * call sites, and when the global setting was only consulted by one of them a configured
 * "keep 7 days" silently stored everything forever. One function, one behaviour.
 */

export async function getSettings(env: Env): Promise<Settings> {
  const rows = await all<{ key: string; value: string }>(
    env,
    "SELECT key, value FROM settings WHERE key IN ('store_forever', 'default_expiration_days')",
  );
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const days = Number(map.get("default_expiration_days"));
  return {
    storeForever: (map.get("store_forever") ?? "1") !== "0",
    defaultDays:
      Number.isFinite(days) && days >= 1
        ? Math.min(MAX_EXPIRATION_DAYS, Math.floor(days))
        : DEFAULT_EXPIRATION_DAYS,
  };
}

/**
 * The expiry for a new upload, as an absolute instant.
 *
 * A caller-supplied value always wins; otherwise the stored default applies. Returning an ISO
 * string rather than "should it expire" keeps every caller from re-deriving the same thing.
 */
export async function resolveExpiration(
  env: Env,
  requested: string | number | null | undefined,
): Promise<string | null> {
  // An empty string is how a client asks for forever, and that is worth keeping distinct from
  // an absent field. Anything else that is present, though, has to be *usable* — deciding on
  // presence alone sent `expirationDays=abc` (and `0`, `-8`, `0.5`) straight through
  // `expirationToISO(null)`, which is no expiry at all. So one unparseable field on a form post
  // silently overrode a configured "keep 7 days" and stored the file forever, which is the exact
  // failure this function was written to end.
  if (requested === "") return null;
  if (requested !== null && requested !== undefined) {
    const days = parseExpirationDays(String(requested));
    if (days !== null) return expirationToISO(days);
  }
  const settings = await getSettings(env);
  return settings.storeForever ? null : expirationToISO(settings.defaultDays);
}

export async function updateSettings(request: Request, env: Env) {
  const body = await readJson<{ storeForever?: unknown; defaultDays?: unknown }>(request);
  const statements: D1PreparedStatement[] = [];

  if (body.storeForever !== undefined) {
    // `typeof` check rather than truthiness: `{"storeForever": "false"}` would otherwise be
    // stored as "permanent" while looking like a valid request.
    const storeForever = bool(body.storeForever);
    if (storeForever === null) throw new HttpError(400, "storeForever 必须为布尔值");
    statements.push(
      env.DB.prepare("REPLACE INTO settings(key, value) VALUES ('store_forever', ?)").bind(
        storeForever ? "1" : "0",
      ),
    );
  }

  if (body.defaultDays !== undefined) {
    // A type check alone was not enough: Number(true) === 1 would have stored "1" for a
    // boolean body, and the bounds were a separate condition.
    const days = boundedNumber(body.defaultDays, 1, MAX_EXPIRATION_DAYS);
    if (days === null) throw new HttpError(400, `defaultDays 必须在 1-${MAX_EXPIRATION_DAYS} 之间的数字`);
    statements.push(
      env.DB.prepare("REPLACE INTO settings(key, value) VALUES ('default_expiration_days', ?)").bind(
        String(Math.floor(days)),
      ),
    );
  }

  if (!statements.length) throw new HttpError(400, "没有需要更新的设置");
  await env.DB.batch(statements);
  return json({ ok: true } satisfies OkResponse);
}

/** Read-only counters. No write path touches these tables. */
export async function systemInfo(env: Env): Promise<SystemInfo> {
  const [storage, entries, guests, downloads] = await Promise.all([
    // Summed over `file_versions`, not `entries`: retained versions are stored bytes and the
    // settings page is reporting disk use, not file count.
    one<{ total: number }>(env, "SELECT COALESCE(SUM(size), 0) AS total FROM file_versions"),
    one<{ count: number }>(env, "SELECT COUNT(*) AS count FROM entries"),
    one<{ count: number }>(env, "SELECT COUNT(*) AS count FROM guest_links"),
    one<{ count: number }>(env, "SELECT COUNT(*) AS count FROM download_events"),
  ]);
  return {
    upload_data_bytes: Number(storage?.total || 0),
    entry_count: Number(entries?.count || 0),
    guest_link_count: Number(guests?.count || 0),
    download_count: Number(downloads?.count || 0),
  };
}
