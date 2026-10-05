import { describe, expect, it } from "vitest";
import { list } from "../src/domain/entries";
import { createEnv, type QueryCall } from "./helpers";

function envWith(
  rows: unknown[],
  count: number,
  live: Array<{ entry_id: string; share_id: string | null }> = [],
) {
  const calls: QueryCall[] = [];
  const env = createEnv({
    onQuery: (sql, args) => calls.push({ sql, args }),
    all: (sql) => {
      if (sql.includes("LIMIT ?")) return { results: rows };
      if (sql.includes("FROM shares s")) return { results: live };
      return { results: [] };
    },
    first: () => ({ count }),
  });
  return { env, calls };
}

const pageSelect = (calls: QueryCall[]) => calls.find((c) => c.sql.includes("LIMIT ?"));
const shareSelect = (calls: QueryCall[]) => calls.find((c) => c.sql.includes("FROM shares s"));

describe("listEntries", () => {
  const rows = [{ id: "a", filename: "x.png" }];

  it("returns the page and its total", async () => {
    const { env, calls } = envWith(rows, 7);
    const page = await list(env);
    expect(page).toEqual({ items: [{ ...rows[0], share_id: null }], total: 7 });
    expect(pageSelect(calls)?.args).toEqual([50, 0]);
  });

  it("reports the share each entry would hand out", async () => {
    // The list is where a share is copied out of, so it has to be the one that still works. An
    // entry whose every share is revoked or expired gets null, and the UI offers to make another.
    const { env } = envWith(rows, 1, [{ entry_id: "a", share_id: "sh1" }]);
    const page = await list(env);
    expect(page.items[0].share_id).toBe("sh1");
  });

  it("asks about shares by id rather than reading the table", async () => {
    // A query shaped by the page rather than by the table: the id list is bounded by the same
    // limit the caller already agreed to, and nothing here scans `shares` on its own.
    const { env, calls } = envWith(rows, 1);
    await list(env);
    const share = shareSelect(calls);
    expect(share?.sql).toContain("WHERE e.id IN (");
    // One timestamp for the expiry cutoff, then one id per row on the page.
    expect(share?.args).toHaveLength(2);
    expect(share?.args?.[1]).toBe("a");
  });

  it("does not materialise download_events or window the page", async () => {
    // An aggregated derived table over download_events is uncorrelated, so SQLite
    // materialised every row; and COUNT(*) OVER() blocked idx_entries_upload_time from
    // satisfying ORDER BY, turning a 50-row page into a full scan of both tables.
    const { env, calls } = envWith(rows, 7);
    await list(env);
    const select = pageSelect(calls);
    expect(select?.sql).not.toContain("COUNT(*) OVER()");
    expect(select?.sql).not.toContain("GROUP BY entry_id");
    expect(select?.sql).toContain("ORDER BY e.upload_time DESC");
  });

  it("still reports the real total for an empty page", async () => {
    // An offset past the end is an empty page over a non-empty table. Returning `total: 0`
    // there made the caller's "is there more" answer wrong, so the COUNT always runs.
    const { env, calls } = envWith([], 3);
    const page = await list(env, { kind: "image", q: "zzz" });
    expect(page).toEqual({ items: [], total: 3 });
    expect(pageSelect(calls)).toBeDefined();
    expect(calls.some((c) => c.sql.includes("SELECT COUNT(*) AS count FROM entries"))).toBe(true);
  });

  it("clamps limit and honours offset", async () => {
    const { env, calls } = envWith(rows, 1);
    await list(env, { limit: 999, offset: 25 });
    expect(pageSelect(calls)?.args).toEqual([100, 25]);
  });

  it("clamps an absurd offset so D1 is not asked to walk the whole table", async () => {
    const { env, calls } = envWith(rows, 1);
    await list(env, { offset: 999_999_999 });
    expect(pageSelect(calls)?.args).toEqual([50, 100_000]);
  });

  it("filters images by content type", async () => {
    const { env, calls } = envWith(rows, 3);
    await list(env, { kind: "image" });
    const select = pageSelect(calls);
    expect(select?.sql).toContain("e.content_type LIKE 'image/%'");
  });

  it("escapes LIKE wildcards in the search query", async () => {
    const { env, calls } = envWith(rows, 2);
    await list(env, { q: "50%_off" });
    const select = pageSelect(calls);
    expect(select?.sql).toContain("ESCAPE '\\'");
    expect(select?.args).toEqual(["%50\\%\\_off%", 50, 0]);
  });

  it("binds the search term instead of interpolating it", async () => {
    const { env, calls } = envWith(rows, 1);
    await list(env, { q: "' OR 1=1 --" });
    const select = pageSelect(calls);
    expect(select?.sql).not.toContain("OR 1=1");
    expect(select?.args[0]).toBe("%' OR 1=1 --%");
  });

  it("caps the search term length", async () => {
    const { env, calls } = envWith(rows, 1);
    await list(env, { q: "x".repeat(5000) });
    const bound = pageSelect(calls)?.args[0] as string;
    expect(bound.length).toBeLessThanOrEqual(130);
  });
});
