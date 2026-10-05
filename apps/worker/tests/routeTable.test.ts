import { describe, expect, it } from "vitest";
import { app } from "../src/app";

/**
 * The registered route table, asserted as a whole.
 *
 * Two registrations were written as `.get<Path, In, Out>(handler)` — the path only in the type
 * argument, which is erased before the code runs. Both type-checked, both compiled, and
 * `addRoute` never learned either path: `/api/entry/:id/downloads` answered 404, its panel
 * failed silently, and the detail page showed a count of eleven beside zero records from a
 * different query.
 *
 * Nothing caught it because every other test reached the domain functions directly or mocked
 * the client, so the one layer where a route either exists or does not was never inspected.
 */
/**
 * Only the endpoints. Hono also lists middleware and the fallbacks as ALL routes, and those
 * are asserted separately — mixing them in would let `ALL *` satisfy an endpoint assertion.
 */
const registered = () =>
  app.routes
    .filter((r) => r.method !== "ALL")
    .map((r) => `${r.method} ${r.path}`)
    .sort();

const EXPECTED = [
  // Public file links. The id is the credential, so these need no secret.
  "GET /-*",
  "HEAD /-*",
  "GET /img/:id/:filename{.+}",
  "HEAD /img/:id/:filename{.+}",

  // Guest upload. The only public /api routes.
  "GET /api/guest/:id/info",
  "POST /api/guest/:id/upload",

  // Entries.
  "GET /api/entries",
  "POST /api/entries/delete",
  "POST /api/entry",
  "GET /api/entry/:id",
  "PUT /api/entry/:id",
  "DELETE /api/entry/:id",
  "GET /api/entry/:id/preview",
  "PUT /api/entry/:id/content",
  "GET /api/entry/:id/downloads",

  // Shares. Listed under the entry they point at, acted on by their own id — which is the only
  // identifier a revoked link still has.
  "GET /api/entry/:id/shares",
  "POST /api/entry/:id/shares",
  "PUT /api/shares/:id",
  "DELETE /api/shares/:id",

  // Versions.
  "GET /api/entry/:id/versions",
  "DELETE /api/entry/:id/versions/:version",
  "GET /api/entry/:id/versions/:version/content",

  // Chunked upload.
  "POST /api/entry/multipart/init",
  "POST /api/entry/multipart/part/:uploadId/:part",
  "POST /api/entry/multipart/complete",
  "POST /api/entry/multipart/abort",

  // Guest links.
  "GET /api/guest-links",
  "POST /api/guest-links",
  "DELETE /api/guest-links/:id",

  // Settings and counters.
  "GET /api/settings",
  "PUT /api/settings",
  "GET /api/system-info",
];

describe("route table", () => {
  it("registers every endpoint the application calls", () => {
    // Asserted as a set rather than route by route: a registration that silently fails to
    // land shows up as a missing pair, and an extra one shows up as noise to delete on purpose.
    expect(registered()).toEqual([...EXPECTED].sort());
  });

  it("registers each path at runtime, not only in the type", () => {
    // The specific trap: a type argument naming a path the runtime never sees. Comparing
    // against `app.routes` is what sees it — the type system cannot, because the type argument
    // and the path argument are checked independently and either satisfies the signature.
    const paths = new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => r.path));
    for (const line of EXPECTED) {
      expect(paths, `${line} is not registered`).toContain(line.split(" ")[1]);
    }
  });

  it("keeps the middleware and the fallbacks", () => {
    const all = app.routes.filter((r) => r.method === "ALL").map((r) => r.path);
    // Hono normalises a bare `*` to `/*` on the way in.
    expect(all).toContain("/api");
    expect(all).toContain("/api/*");
    expect(all).toContain("/*");
    // The SPA catch-all has to come last, or an unmatched path answers with the shell and a
    // broken image looks like a slow one.
    // Registration order is load-bearing for the catch-all, and `use("*")` registers the
    // same method and path as `all("*")` does — so the pair cannot be told apart by search.
    // What matters is that the last registration is the shell: anything after it would be
    // unreachable, and anything matched by the shell before an endpoint would answer an
    // unmatched path with a page instead of a 404.
    const last = app.routes[app.routes.length - 1];
    expect([last.method, last.path]).toEqual(["ALL", "/*"]);
  });
});
