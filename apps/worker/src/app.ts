import { Hono } from "hono";
import { handleError, json, type JsonResponse } from "./platform/http";
import * as entries from "./domain/entries";
import * as guest from "./domain/guest";
import * as settings from "./domain/settings";
import * as uploads from "./domain/uploads";
import * as routes from "./routes";
import type { Env } from "./types";
import type { EntryDownloadsResponse, Share, UpdateMetadataResponse } from "@picoshare/shared";
import type { CreateShareBody, UpdateShareBody } from "./domain/shares";

/**
 * The route table, as one chain.
 *
 * Three properties of Hono make this file the only place an endpoint's response shape is
 * written down, and all three are easy to break by accident:
 *
 * 1. Hono accumulates the route schema in the *type of the value each registration returns*.
 *    Registering routes as separate statements (`app.get(...)` on its own line, discarding
 *    the result) leaves `typeof app` as `BlankSchema`, and so does splitting the table with
 *    `app.route()` sub-apps. Only a single unbroken chain carries the schema forward. The
 *    typed client in `apps/web` then infers nothing — silently, with no error anywhere.
 *
 * 2. A JSON handler must return `json(...)`. It returns `Response & TypedResponse<T>`, and
 *    the brand is what the client reads. An explicit `: Promise<Response>` annotation widens
 *    it away, so those annotations live only on the handlers that genuinely return file
 *    bodies. `platform/serve.ts` is the one module allowed to.
 *
 * 3. A route whose input cannot be inferred — a handler reading a bare `Request` instead of
 *    `c.req.json()` — has to declare that input, and must declare the response alongside it.
 *    Declaring only the input silently drops the response generic to `any`.
 *
 * And the path is **always a runtime argument**, even when the type argument repeats it. A
 * registration written as `.get<"/x", In, Out>(handler)` type-checks perfectly and registers
 * nothing at that path: the string exists only in the type, and `addRoute` never sees it. Two
 * routes were written that way and `/api/entry/:id/downloads` answered 404 for as long as it
 * took someone to read the route table. `app.test.ts` now asserts the whole table.
 *
 * Registration order is load-bearing: the file routes and the `/api` 404s have to come
 * before the SPA catch-all, or every unmatched path serves the application shell.
 */
export const app = new Hono<{ Bindings: Env }>()
  .use("*", routes.corsPreflight)
  .use("*", routes.maintenance)
  .use("/api/*", routes.authorize)

  // Public: these two carry the access token in the URL by design.
  .on(["GET", "HEAD"], "/-*", routes.shortLinkRoute)
  .on(["GET", "HEAD"], "/img/:id/:filename{.+}", routes.imageLinkRoute)
  .get("/api/guest/:id/info", async (c) => json(await guest.info(c.env, c.req.param("id"))))
  .post("/api/guest/:id/upload", routes.guestUploadRoute)

  // List and bulk actions.
  .get("/api/entries", routes.listEntriesRoute)
  .post("/api/entries/delete", routes.bulkDeleteRoute)

  // The image-host upload endpoint. One route, two encodings — see `createEntryRoute`.
  .post("/api/entry", routes.createEntryRoute)

  // A single entry.
  .get("/api/entry/:id", async (c) => json(await entries.detail(c.env, c.req.param("id"))))
  .put<"/api/entry/:id", { in: { json: entries.UpdateMetadataBody } }, JsonResponse<UpdateMetadataResponse>>(
    "/api/entry/:id",
    routes.updateMetadataRoute,
  )
  .delete("/api/entry/:id", routes.deleteEntryRoute)
  .get("/api/entry/:id/preview", routes.previewRoute)
  .put("/api/entry/:id/content", routes.replaceContentRoute)

  // Shares. Listed under the entry they point at, acted on by their own id — which is the only
  // identifier a revoked link still has.
  .get("/api/entry/:id/shares", routes.entrySharesRoute)
  // Both write routes read a bare `Request`, so the body cannot be inferred and the response
  // has to be declared alongside it — declaring only the input silently widens the output to
  // `any`, which is exactly the failure this pairing exists to prevent.
  .post<
    "/api/entry/:id/shares",
    { in: { json: CreateShareBody } },
    JsonResponse<Share>
  >("/api/entry/:id/shares", routes.createShareRoute)
  .put<"/api/shares/:id", { in: { json: UpdateShareBody } }, JsonResponse<Share>>(
    "/api/shares/:id",
    routes.updateShareRoute,
  )
  .delete("/api/shares/:id", routes.revokeShareRoute)

  .get<"/api/entry/:id/downloads", { in: { query: { uniqueIps?: string } } }, JsonResponse<EntryDownloadsResponse>>(
    "/api/entry/:id/downloads",
    routes.entryDownloadsRoute,
  )

  // Versions.
  .get("/api/entry/:id/versions", routes.entryVersionsRoute)
  .delete("/api/entry/:id/versions/:version", routes.deleteVersionRoute)
  .get("/api/entry/:id/versions/:version/content", routes.versionContentRoute)

  // Chunked upload. Registered after `/api/entry/:id/...` on purpose: the literal segments
  // are more specific, and this ordering is the one the router has always resolved.
  .post("/api/entry/multipart/init", (c) => uploads.init(c.req.raw, c.env))
  .post("/api/entry/multipart/part/:uploadId/:part", routes.multipartPartRoute)
  .post("/api/entry/multipart/complete", (c) => uploads.complete(c.req.raw, c.env))
  .post("/api/entry/multipart/abort", (c) => uploads.abort(c.req.raw, c.env))

  // Guest links.
  .get("/api/guest-links", async (c) => json(await guest.list(c.env)))
  .post("/api/guest-links", (c) => guest.create(c.req.raw, c.env))
  .delete("/api/guest-links/:id", (c) => guest.remove(c.env, c.req.param("id")))

  // Settings and the dashboard counters.
  .get("/api/settings", async (c) => json(await settings.getSettings(c.env)))
  .put("/api/settings", (c) => settings.updateSettings(c.req.raw, c.env))
  .get("/api/system-info", async (c) => json(await settings.systemInfo(c.env)))

  .all("/api", routes.apiNotFound)
  .all("/api/*", routes.apiNotFound)
  .all("*", routes.spaFallback)
  .onError(handleError);

export type AppType = typeof app;
