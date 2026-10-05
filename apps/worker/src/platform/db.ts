import type { Env } from "../types";

/*
 * The three shapes of D1 access this app needs, plus the one primitive that makes
 * concurrency safe.
 */

export const one = async <T>(env: Env, sql: string, ...args: unknown[]): Promise<T | null> =>
  env.DB.prepare(sql).bind(...args).first<T>();

export const all = async <T>(env: Env, sql: string, ...args: unknown[]): Promise<T[]> =>
  (await env.DB.prepare(sql).bind(...args).all<T>()).results;

/**
 * Runs a single `UPDATE ... WHERE <precondition>` and reports whether this caller is the one
 * that satisfied it.
 *
 * D1 has no interactive transaction, but it does have a row-level write, and folding the
 * check into the statement's own `WHERE` turns a read-then-write race into a race with one
 * winner. Every mutual exclusion in this app is this call: the guest upload quota, the
 * version check on replacement, and the claim on a chunked upload session.
 *
 * `changes === 1` rather than `> 0`: a statement that matched nothing is the failure being
 * reported, and a bug that matched several rows should not read as success.
 */
export const claim = async (env: Env, sql: string, ...args: unknown[]): Promise<boolean> => {
  const result = await env.DB.prepare(sql).bind(...args).run();
  return result.meta.changes === 1;
};
