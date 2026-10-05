import type { Env } from "../types";
import * as downloads from "./downloads";
import * as entries from "./entries";
import * as shares from "./shares";
import * as uploads from "./uploads";

/*
 * The hourly sweep, and the request-time fallback that runs it too.
 *
 * This module contains no SQL. It names the tasks and runs them; each one lives with the
 * module that owns its table, so a task cannot quietly grow a second implementation of a
 * rule that already exists.
 *
 * The task list is a single value rather than a `run()` body plus a parallel array of names
 * for the log. Those two lists drifted the moment a task was added, and the failure was a
 * maintenance error logged under the wrong name.
 */

const TASKS: ReadonlyArray<[string, (env: Env) => Promise<unknown>]> = [
  ["cleanupExpired", entries.cleanupExpired],
  ["cleanupAbandonedUploads", uploads.cleanupAbandoned],
  ["pruneDownloadEvents", downloads.prune],
  ["pruneShares", shares.prune],
];

export async function run(env: Env): Promise<void> {
  // Independent, and deliberately not a sequential chain: one failure must not skip the
  // rest for the remainder of the hour.
  const results = await Promise.allSettled(TASKS.map(([, task]) => task(env)));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error("maintenance task failed", TASKS[index][0], result.reason);
    }
  });
}
