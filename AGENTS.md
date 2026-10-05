# Repository Guidelines

## Project Structure & Module Organization
This project is a pnpm monorepo: a Cloudflare Worker API plus a Svelte 5 frontend.

- `apps/worker/src/index.ts`: Worker entrypoint — `fetch` (straight to `app.fetch`) and the
  hourly `scheduled` sweep. No configuration checks live here; misconfiguration guidance is
  documentation, not runtime behaviour.
- `apps/worker/src/app.ts`: the route table, as **one unbroken chain** (see Type Safety).
- `apps/worker/src/routes.ts`: the HTTP layer. Every handler needing more than one line
  lives here; it may parse a body or read a path parameter, but it holds no rules.
- `apps/worker/src/platform/`: Cloudflare plumbing, swappable as a unit — `http.ts`
  (`json()`, auth, CORS, body limits, rate limiting), `serve.ts` (Range, ETag,
  `Content-Disposition`, inline-safety), `storage.ts` (the R2 key convention), `db.ts`
  (`one`/`all`/`claim`), plus `parse.ts`, `id.ts`, `hash.ts`.
- `apps/worker/src/domain/`: product rules, **one module per table** — `entries.ts`,
  `versions.ts`, `guest.ts`, `downloads.ts`, `uploads.ts`, `settings.ts`, and
  `maintenance.ts`, which orchestrates the sweep and contains no SQL.
- `apps/worker/src/types.ts`: `Env` and the D1 row shapes.
- `apps/web/src/App.svelte`: layout + path-based router; views live in `apps/web/src/views/`.
- `apps/web/src/lib/`: API client (`api.ts` — the typed Hono RPC client), reactive state
  (`*.svelte.ts`), upload/paging/selection helpers.
- `apps/web/src/components/`: shared UI (`FilePicker`, `Thumb`, `ImageViewer`,
  `CopyLinkButtons`, `EntryPreview`, `VersionTable`, `DownloadHistory`).
- `packages/shared/`: types, constants, media helpers and link URL builders shared by worker and web.
  It holds the **domain** shapes (`Entry`, `FileVersion`, `GuestInfo`, …); route shapes are
  not written here — they are inferred from `app.ts` (see Type Safety below).
- `schema.sql`: D1 schema initialization (single source of truth for the schema).
- `.github/workflows/ci.yml`: the only workflow, two jobs. `ci` runs typecheck, the tests,
  `schema.sql` applied twice to a scratch SQLite, the frontend build and a smoke run (`wrangler dev`
  on a throwaway `.dev.vars`, walked with `curl` — the only place the bundler, the bindings and the
  route order are exercised together), then uploads `web-dist`. `deploy` needs it and is limited to
  pushes on `main` plus manual dispatch, because the deploy has to ship the artifact the tests ran
  against.
- `wrangler.jsonc`: the Worker config, tracked and without secrets (`main`, `assets`, `DB`, `BUCKET`, cron triggers). One Worker serves the API and the frontend — `routes.ts`'s SPA fallback reads the `ASSETS` binding and the client is hard-wired to its own origin.
- `tsconfig.json`: strict TypeScript settings for worker + shared packages. It does **not**
  include `apps/web`; that app is type-checked by `svelte-check` via its own tsconfig, which
  **does** include `../worker/src` so the RPC client's types resolve (see Type Safety below).

Keep new runtime logic inside the matching app and split large features into focused modules.

## Domain rules: three invariants

Not style preferences. Each exists because the alternative has already produced a bug, and
each is cheap to keep only if it is written down.

1. **`entries.create` is the only way a new entry comes into existence.** Four upload shapes
   reach it — a form post, a raw body, a guest form post, a finished chunked upload — so
   dedup, expiry resolution and the version-1 bookkeeping cannot drift apart between them. A
   new intake path calls `create`; it never calls `insertRows`.
2. **`entries.require` is the only way an entry is read for use.** Expiry is enforced there
   rather than in the serving routes, because a route that reads `SELECT … FROM entries`
   directly can hand back a file already reported as gone, and a replacement will mint a
   fresh ETag for it. `entries.list` is the deliberate exception: the list has to show
   expired rows, or the owner cannot see what needs cleaning up.
3. **One module writes each table.** `entries.remove` is the single exception — it cascades
   into `download_events`, `file_versions` and `upload_sessions`, because a row outliving
   its referent is worse than the rule: an orphaned version row points at bytes nothing will
   ever delete. Even the guest-link teardown goes through `entries.detachGuestLink` rather
   than writing the column from `guest.ts`. Worth re-checking after any change that adds a
   `DELETE FROM` or `UPDATE`: `grep -E 'INSERT|UPDATE|DELETE' src/domain/*.ts` and confirm
   each table still has one owner.

## Type Safety: the response contract

An endpoint's response shape is written down exactly **once**, in its route registration. The
browser reads it back through `hc<AppType>()` in `apps/web/src/lib/api.ts`, so renaming a field
on one side fails the build on the other. Three things make that work, and all three are easy
to break:

1. **`app.ts` must be a single fluent chain.** Hono carries its route schema in the *type* of
   the value each registration returns. Registering routes as separate statements
   (`app.get(...)` per line, discarding the result), or splitting the table with
   `app.route()` sub-apps, leaves `typeof app` as `BlankSchema` and the client infers nothing —
   silently, with no error. Put any handler with a multi-line body in `routes.ts` and
   register it by name. Registration order is load-bearing: the file routes and the `/api`
   404s must precede the SPA catch-all.
2. **A JSON handler must return `json(...)` — of an actual value, not a `Promise`.** `json()`
   infers its payload from the argument, so `json(someAsyncCall())` infers `Promise<T>` and
   `JSONParsed` of that is `never`. The failure surfaces in the browser's own type check,
   three files away. Always `json(await …)`. An explicit `: Promise<Response>` annotation
   widens the brand away the same way, so those annotations were removed — do not re-add
   them. `platform/serve.ts` legitimately returns bare `Response`s (file bodies, Range,
   ETag); those routes are not part of the JSON contract.
3. **`hc` returns the raw `Response`, never the body.** `api.ts` wraps it to run
   `parseResponse` and to map `DetailedError` back to `RequestError` with the server's Chinese
   message. Do not call `hc` directly elsewhere.
4. **All of the above is compile-time only. Nothing checks the bytes.** `hc` is typed from the
   route table, so the compiler guarantees the *declared* shape and knows nothing about what
   came back over the wire. A client that forgets to parse resolves to `Response` objects that
   satisfy every type in the app while having none of the fields — which is exactly what
   happened here: the settings page rendered its counters as `undefined` and its error toasts
   as `请求失败 (undefined)`, with `pnpm typecheck` and all 59 tests green throughout. Two
   things have to carry that weight: `tests/client.test.ts`, which drives the real client
   against a stubbed `fetch` and asserts on the bytes, and `contract.test.ts` on the server
   side. If you touch the client's plumbing, re-run the first; if you touch a response
   shape, the second.

When a route's input cannot be inferred — a handler reading a bare `Request` or the raw URL
instead of `c.req.json()` / `c.req.query()` — declare it in the registration's type arguments
and **declare the response type alongside it**, or the response generic falls back to `any`:

```ts
.put<"/api/entry/:id", { in: { json: UpdateMetadataBody }, out: JsonResponse<UpdateMetadataResponse> }>(…)
```

What this does **not** cover: the bytes are still cast to the declared type, so a server that
disagrees with its own types is caught by tests, not by the compiler. `contract.test.ts` runs
real SQL against the real `schema.sql` for that reason. Multipart chunk uploads use `fetch`
directly (see `upload.ts`) because a raw binary body is not something Hono can type.

## Build, Test, and Development Commands
- `pnpm install`: install workspace dependencies.
- `pnpm dev`: build the web app, then run Worker (`:8787`) and Vite (`:5173`) together.
- `pnpm dev:worker` / `pnpm dev:web`: run a single side.
- `pnpm build` / `pnpm deploy`: build `apps/web/dist`, optionally deploy.
- `pnpm typecheck`: `tsc --noEmit` + `svelte-check`.
- `pnpm test` / `pnpm test:watch`: run both suites once / run the **worker** suite in watch mode.
- `pnpm d1:init`: initialize the local D1 database from `schema.sql`.
- `pnpm d1:init:remote`: initialize the remote D1 database from `schema.sql`.

Example local workflow:
```bash
pnpm install
pnpm d1:init
pnpm typecheck && pnpm test
pnpm dev
```

## Coding Style & Naming Conventions
- Language: TypeScript with `strict: true`; Svelte 5 runes for state.
- Indentation: 2 spaces; keep semicolon usage consistent with existing files.
- Naming: `camelCase` for variables/functions, `UPPER_SNAKE_CASE` for constants, `PascalCase` for types/components.
- Keep route handlers thin; move reusable logic into `domain/`, and anything with a
  multi-line body into `routes.ts`.
- UI copy is Chinese only; do not add i18n tables.
- Validation lives in `parse.ts`. The lenient readers (`str`, `positiveInt`, `parseDate`) clamp
  and default on purpose; the strict ones (`bool`, `finiteNumber`, `boundedNumber`,
  `nonEmptyString`) return `null` for the wrong type so `=== null` is the invalid check. Use a
  strict reader for any flag whose value decides behaviour — a presence-only check accepted
  `{"deleteAfterExpiration": "false"}` and switched the expiry *on*.

## Testing Guidelines
- Always run `pnpm typecheck` and `pnpm test` before submitting changes.
- Worker unit tests live in `apps/worker/tests/*.test.ts`; use `tests/helpers.ts`
  (`createEnv`, `entryRow`, `jsonRequest`, `formRequest`) instead of re-writing mocks.
- `app.test.ts` exercises the Hono app via `app.request(path, init, env)`; no workerd needed.
- `contract.test.ts` runs the real read paths against a real SQLite database built from
  `schema.sql` (`tests/sqlite.ts`). The mocked `createEnv` cannot catch a column-name mismatch,
  because a query that selects a column the type lacks still returns a row. Use it when a change
  touches a `SELECT`, `schema.sql`, or a response shape.
- Frontend tests live in `apps/web/tests/*.test.ts` with `happy-dom` +
  `@testing-library/svelte` (config: `apps/web/vitest.config.ts`). Keep event-driven
  component tests; wait for async `onMount` data (e.g. `findByText`) before interacting.
- Frontend tests mock `../src/lib/api`, whose `api` is a nested proxy — a mock must reproduce the
  route path, e.g. `api.api.entry[":id"].$delete`, `api.api.entries.$get`. Chunk uploads use
  `fetch`, so stub `globalThis.fetch` instead.
- **`client.test.ts` is the one file that must not mock the client.** Mocking it everywhere else
  is right for a component test and is why the client's own plumbing went untested for so long.
  Its assertions are on parsed values and on request shape, not on rendered text.
- `pnpm test` runs worker tests first, then the web suite via `pnpm --filter @picoshare/web test`.
- Manually verify key flows in `pnpm dev`: login, upload (including >100MB), list,
  copy link, edit/replace, versions (including version delete), bulk delete, guest
  link create/upload, and `/-<id>` retrieval.
- Image hosting flows: image-mode paste (Ctrl+V) upload, gallery `/images` with
  lightbox + search, copy Markdown/HTML/BBCode, `/img/<id>/<filename>` headers
  (inline image vs `attachment` for HTML/SVG), Range/304 responses, SHA-256 dedup
  (`deduped: true`), and list pagination (`?kind=&q=&limit=&offset=` returning `{ items, total }`).
- Image-host tooling: `POST /api/entry` returns absolute `url`/`markdown`/`bbcode` and takes
  **two request encodings on one route** — `multipart/form-data` (form field `file`, what a
  browser and PicGo send) and a raw body (what `curl --data-binary` sends, filename in
  `?filename=`). The discriminator is the request's own `Content-Type`. Auth via
  `Authorization`, `X-Api-Key` or `?token=`.

## Commit & Pull Request Guidelines
Commit history is available, but most existing messages are non-descriptive (`fix`,
`add clips`, `add docker`), so use Conventional Commits for new work:
- `feat: add guest link expiration validation`
- `fix: reject upload when auth header is missing`

For PRs, include:
- clear summary and rationale,
- linked issue (if applicable),
- setup notes (for `schema.sql` or bindings),
- manual verification steps and expected results.

## Security & Configuration Tips
- Never put a secret in `wrangler.jsonc`; it is tracked, and a test fails if one appears.
  Use `wrangler secret put`. Nothing at runtime checks `PS_SHARED_SECRET`: an unset one
  fails closed in `platform/http.ts` (every protected route answers `401`), and a placeholder
  value is a working password, so the requirement has to be met in the README's Deployment
  section rather than in code. Do not reintroduce a startup guard for it.
- Treat `PS_SHARED_SECRET` as required in every protected `/api/*` route; only
  `/api/guest/:id/info` and `/api/guest/:id/upload` are public. `/-<id>` and
  `/img/<id>/<filename>` are public **by design** — the id is the access token, so
  `generateID` must stay on `crypto.getRandomValues` and must not be shortened.
- Rate limits key on `cf-connecting-ip` only; `x-forwarded-for` is client-controlled
  and must never be used for that (see `clientIp` in `http.ts`).
- Validate file metadata and size limits before persisting to R2/D1, and reject
  oversized bodies from `content-length` *before* `arrayBuffer()`/`formData()`
  (`assertBodyWithinLimit`): the isolate only has 128 MB.
- Query-token auth is accepted on **exactly one route**, `POST /api/entry` (the image-host
  endpoint), and only there; every other `/api/*` route requires the header form. The
  allowlist is `TOKEN_QUERY_ROUTES` in `platform/http.ts`. Adding a second entry needs a
  reason stronger than convenience, because each entry is a path where the secret can appear
  in a URL and land in access logs and `Referer`.
- Set `PUBLIC_ORIGIN` when the deployment is behind a proxy that forwards the
  original `Host`; generated share links otherwise take their origin from the request.
- Keep schema changes in `schema.sql`; never reintroduce runtime DDL. Note that
  `CREATE TABLE IF NOT EXISTS` applies new *indexes* to an existing database but
  never new *columns*.
- `apps/web` type-checks the worker's sources, so a type error in the worker surfaces twice
  (`tsc` and `svelte-check`). That coupling is what makes the RPC client's types resolve; it is
  intentional, not a misconfiguration.
