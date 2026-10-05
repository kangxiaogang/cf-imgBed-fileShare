import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/types";

// Resolved with string arithmetic rather than `new URL(..., import.meta.url)`: the `URL` in
// scope is the Workers/DOM one, which is a different type from the `node:url` overload.
const SCHEMA = fileURLToPath(import.meta.url).replace(/[\\/]tests[\\/][^\\/]*$/, "/../../schema.sql");

/**
 * A real SQLite database behind the D1 shape, built from the shipped `schema.sql`.
 *
 * The rest of the suite mocks D1, which cannot see a column-name mismatch: a query that
 * selects a column the type does not have still returns a `row`, so the test passes and
 * production gets `undefined`. Running the statements against the real schema is the only
 * way to catch a `schema.sql` rename drifting away from the row types.
 */
export type SqliteEnv = {
  env: Env;
  db: DatabaseSync;
  exec: (sql: string, ...args: unknown[]) => void;
  close: () => void;
};

// node:sqlite hands back null-prototype objects, so `toEqual` and object spread behave
// differently from a plain JSON response. Copying into a normal object keeps the rows
// indistinguishable from what the real Worker would deserialise.
const plain = (row: unknown): unknown => (row == null ? row : { ...(row as object) });

export function sqliteEnv(options: { secret?: string; origin?: string } = {}): SqliteEnv {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA, "utf8"));

  const prepare = (sql: string) => {
    const run = (args: unknown[]) => {
      const stmt = db.prepare(sql);
      return stmt.all(...(args as never[]));
    };
    const bound = (args: unknown[]) => ({
      first: async () => plain(run(args)[0]) ?? null,
      all: async () => ({ results: run(args).map(plain) }),
      run: async () => {
        const stmt = db.prepare(sql);
        // `all()` on a mutating statement returns []; node:sqlite reports affected rows via
        // `run()`, which is what D1 surfaces as `meta.changes`.
        const info = stmt.run(...(args as never[]));
        return { success: true, meta: { changes: Number(info.changes), last_row_id: 0 } };
      },
    });
    return {
      sql,
      args: [] as unknown[],
      bind: (...args: unknown[]) => bound(args),
      first: async () => plain(run([])[0]) ?? null,
      all: async () => ({ results: run([]).map(plain) }),
      run: async () => ({ success: true, meta: { changes: 0, last_row_id: 0 } }),
    };
  };

  const env = {
    PS_SHARED_SECRET: options.secret ?? "secret",
    PUBLIC_ORIGIN: options.origin,
    DB: {
      prepare,
      batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
        const out = [];
        for (const statement of statements) out.push(await statement.run());
        return out;
      },
    },
    BUCKET: {
      get: async () => null,
      put: async () => ({}),
      delete: async () => {},
      head: async () => null,
    },
    ASSETS: { fetch: async () => new Response("", { status: 404 }) },
  } as unknown as Env;

  return {
    env,
    db,
    exec: (sql, ...args) => {
      db.prepare(sql).run(...(args as never[]));
    },
    close: () => db.close(),
  };
}

export const responseBody = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

/** Sorts so the comparison does not depend on SQL column order. */
export const keysOf = (value: unknown): string[] => Object.keys(value as object).sort();
