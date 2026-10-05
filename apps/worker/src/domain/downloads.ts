import type { DownloadEvent, EntryDownloadsResponse } from "@picoshare/shared";
import { all, one } from "../platform/db";
import { nowIso } from "../platform/parse";
import type { Env } from "../types";

/*
 * The `download_events` table: how often a file is fetched, and from where.
 *
 * The table exists to answer "is this link being passed around?", so the write side is
 * deliberately narrow — only the two public file links record, and only on GET. A preview
 * is the owner looking at their own file, and a HEAD is a browser or player probing for the
 * size; counting either would make the number say nothing about propagation.
 */

const MAX_ROWS = 200;
export const RETENTION_DAYS = 90;

export async function record(env: Env, entryId: string, request: Request): Promise<void> {
  // The caller is the public link handler, which serves GET and HEAD from one function.
  if (request.method !== "GET") return;
  await env.DB.prepare(
    "INSERT INTO download_events(entry_id, ip, user_agent, downloaded_at) VALUES (?, ?, ?, ?)",
  )
    .bind(entryId, request.headers.get("cf-connecting-ip"), request.headers.get("user-agent"), nowIso())
    .run();
}

export async function count(env: Env, entryId: string): Promise<number> {
  const row = await one<{ count: number }>(
    env,
    "SELECT COUNT(*) AS count FROM download_events WHERE entry_id = ?",
    entryId,
  );
  return Number(row?.count || 0);
}

/**
 * Download history, bounded.
 *
 * The table is written by unauthenticated requests and reclaimed only by retention, so an
 * unbounded read here is an unbounded response built from an unbounded table. `uniqueIps` is
 * the default view because "how many distinct places fetched this" is the question the
 * feature exists for; the raw log is the secondary one.
 */
export async function history(env: Env, entryId: string, uniqueIps: boolean): Promise<EntryDownloadsResponse> {
  const total = await count(env, entryId);
  const sql = uniqueIps
    ? `SELECT MAX(downloaded_at) AS downloaded_at, ip, user_agent
       FROM download_events WHERE entry_id = ? GROUP BY ip ORDER BY downloaded_at DESC LIMIT ?`
    : `SELECT downloaded_at, ip, user_agent FROM download_events
       WHERE entry_id = ? ORDER BY downloaded_at DESC LIMIT ?`;
  return { total, events: await all<DownloadEvent>(env, sql, entryId, MAX_ROWS) };
}

/**
 * Drops events older than the retention window.
 *
 * The default is the window, not "now". A cutoff of `now` reads as harmless and is the
 * opposite: it would delete every event on every run.
 */
export async function prune(
  env: Env,
  before = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString(),
): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM download_events WHERE downloaded_at < ?")
    .bind(before)
    .run();
  return result.meta.changes ?? 0;
}
