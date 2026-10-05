import { app } from "./app";
import { run as runMaintenance } from "./domain/maintenance";
import type { Env } from "./types";

export default {
  fetch: app.fetch,
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(runMaintenance(env).catch((err) => console.error("maintenance failed", err)));
  },
} satisfies ExportedHandler<Env>;