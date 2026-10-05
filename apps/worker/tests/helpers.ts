import type { Env } from "../src/types";

export type QueryCall = { sql: string; args: unknown[] };
export type QueryHandler = (sql: string, args: unknown[]) => unknown;

export function createEnv(
  options: {
    first?: QueryHandler;
    all?: QueryHandler;
    run?: QueryHandler;
    batch?: (statements: unknown[]) => unknown;
    onBind?: (sql: string, args: unknown[]) => void;
    onQuery?: (sql: string, args: unknown[]) => void;
    bucket?: Record<string, unknown>;
    assets?: Record<string, unknown>;
    secret?: string;
  } = {},
): Env {
  const prepare = (sql: string) => {
    const record = (args: unknown[]) => options.onQuery?.(sql, args);
    // `sql`/`args` are carried on every bound statement so tests can assert on the exact
    // statement a code path builds, not just on the value it returns.
    const bound = (args: unknown[]) => ({
      sql,
      args,
      first: async () => {
        record(args);
        return options.first?.(sql, args) ?? null;
      },
      all: async () => {
        record(args);
        return options.all?.(sql, args) ?? { results: [] };
      },
      run: async () => {
        record(args);
        return options.run?.(sql, args) ?? { success: true, meta: { changes: 1, last_row_id: 0 } };
      },
    });
    const statement = {
      sql,
      args: [] as unknown[],
      bind: (...args: unknown[]) => {
        options.onBind?.(sql, args);
        return bound(args);
      },
      first: async () => {
        record([]);
        return options.first?.(sql, []) ?? null;
      },
      all: async () => {
        record([]);
        return options.all?.(sql, []) ?? { results: [] };
      },
      run: async () => {
        record([]);
        return options.run?.(sql, []) ?? { success: true, meta: { changes: 1, last_row_id: 0 } };
      },
    };
    return statement;
  };

  return {
    PS_SHARED_SECRET: options.secret ?? "secret",
    // Default to a successful single-row change so a missing stub fails on the assertion
    // under test rather than on `undefined.meta`.
    DB: {
      prepare,
      batch: async (statements: unknown[]) =>
        options.batch?.(statements) ??
        statements.map(() => ({ success: true, meta: { changes: 1, last_row_id: 0 } })),
    },
    BUCKET: {
      get: async () => null,
      put: async () => ({}),
      delete: async () => {},
      head: async () => null,
      ...options.bucket,
    },
    ASSETS: {
      fetch: async () => new Response("", { status: 404 }),
      ...options.assets,
    },
  } as unknown as Env;
}

export const entryRow = (overrides: Record<string, unknown> = {}) => ({
  id: "abc123",
  filename: "photo.png",
  content_type: "image/png",
  size: 3,
  sha256: "deadbeef",
  version: 1,
  object_key: "abc123",
  upload_time: "2026-09-26T00:00:00.000Z",
  updated_time: "2026-09-26T00:00:00.000Z",
  expiration_time: null,
  note: null,
  guest_link_id: null,
  ...overrides,
});

export const jsonRequest = (url: string, body: unknown, method = "POST"): Request =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const formRequest = (
  url: string,
  fields: Record<string, string | File>,
  method = "POST",
): Request => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return new Request(url, { method, body: fd });
};
