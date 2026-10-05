# PicoShare

A lightweight file sharing service built on Cloudflare Workers + D1 + R2.

中文文档: [点我查看](docs/README.zh-CN.md)

## Features

- Password-protected management UI (shared secret login)
- File upload via select, drag-and-drop, paste text, and multipart upload (>= 100MB)
- Image hosting mode: paste screenshots (Ctrl+V), gallery with lightbox and search,
  copy direct link / Markdown / HTML / BBCode
- Image-host tooling support: JSON responses include absolute `url`, `markdown` and
  `bbcode`; the same endpoint also accepts a raw binary body when the request is not a form
  (works with PicGo custom web uploader, ShareX, uPic, shell one-liners, ...)
- SHA-256 de-duplication: identical images reuse the existing entry (instant upload);
  guest uploads only dedupe within the same guest link
- Server-side pagination and filename search for file/image lists, bulk delete
- Metadata editing, content replacement with version history, single version delete
- Guest link upload flow with per-link limits (atomic upload-count reservation)
- Download history tracking with optional per-IP de-duplication; HEAD requests and
  gallery previews are not counted
- Expiration cleanup, abandoned multipart cleanup (scheduled cron + lazy fallback)
- HTTP Range support for direct file/image links
- Hardened response headers (inline only for safe media/document types)
- Hono-based routing with Hono RPC, so each endpoint's response type is inferred from its
  route registration rather than written twice; single `schema.sql` for D1; Chinese-only web UI

## Tech Stack

- pnpm monorepo
- Cloudflare Worker API (`apps/worker/src`) with Hono
- Svelte 5 + TypeScript + Tailwind CSS 4 frontend (`apps/web`)
- Shared types, constants and URL builders (`packages/shared`)
- D1 (metadata + download events), R2 (file object storage)
- Vitest (`apps/worker/tests`) + Vitest/happy-dom/@testing-library/svelte (`apps/web/tests`)

## Quick Start

1. Install dependencies:

```bash
pnpm install
```

2. Configure the local secret. Create `.dev.vars` in the repository root — git ignores it —
with one line:

```
PS_SHARED_SECRET=<your own strong value>
```

The Worker has no default secret and no startup check, so skipping this line does not stop it
from starting — it just makes every protected route (and the login itself) answer `401`.

`wrangler.jsonc` is tracked and holds no secret, so there is nothing to copy. Edit it in
place: put your D1 `database_id` and R2 bucket name in the two places marked below, or the
deploy will fail on the placeholder id.

3. Initialize the local D1 database from `schema.sql`:

```bash
pnpm d1:init
```

4. Start local dev server:

```bash
pnpm dev
```

This builds the web app, starts the Worker on `http://127.0.0.1:8787` and the Vite
dev server on `http://127.0.0.1:5173` (API requests are proxied to the Worker).

5. Open `http://127.0.0.1:5173` and sign in with `PS_SHARED_SECRET`.

## Scripts

- `pnpm dev`: Worker + web dev servers
- `pnpm build`: build the frontend into `apps/web/dist`
- `pnpm typecheck`: TypeScript + svelte-check type checks
- `pnpm test`: run all unit tests (Worker + web), `pnpm test:watch` for worker watch mode
- `pnpm d1:init`: initialize the local D1 database from `schema.sql`
- `pnpm d1:init:remote`: initialize the remote D1 database from `schema.sql`
- `pnpm deploy`: build the frontend and deploy the Worker

## Deployment

1. Set production secrets:

```bash
npx wrangler secret put PS_SHARED_SECRET
```

> **This step is the only thing standing between a public deployment and an open one.** There is
> no default secret, and nothing at runtime checks for a missing or a placeholder value: a
> deployment that never set this answers `401` on every protected route and on the login itself,
> and a deployment that set an example value such as `replace-me` or `changeme` serves with that
> value as its real secret. Locally the same value goes in a git-ignored `.dev.vars` in the
> repository root, on a single line: `PS_SHARED_SECRET=<your own strong value>`

2. Initialize the remote database (fresh deployments only; the script is idempotent):

```bash
pnpm d1:init:remote
```

3. Build and deploy:

```bash
pnpm deploy
```

The Worker serves the built frontend from `apps/web/dist` through the `ASSETS`
binding, so unknown paths fall back to the SPA shell. One Worker answers both the API and the
frontend — the SPA fallback reads that binding and the browser client is hard-wired to its own
origin, so the two are not separable without code changes. `wrangler.jsonc` also configures an
hourly cron for expired-entry and abandoned-multipart cleanup.

Pushes to `main` deploy automatically once the repository has been given a
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. One `ci` job gates it: typecheck, the unit
tests, `schema.sql` applied twice to a scratch database, the frontend build, and a smoke run that
boots the real runtime with `wrangler dev` and walks it with `curl` — auth refused without the
secret, an upload, both public links, and the SPA fallback served from the `ASSETS` binding.
Nothing else reaches the Worker: those tests are mocks, so that smoke run is the only place the
bundler, the bindings and the route order are exercised together. The frontend is handed to the
deploy job as a build artifact rather than rebuilt, so what ships is the bytes that passed the
tests. The deploy applies `schema.sql` first, which is idempotent — but it only ever adds tables
and indexes, never a column to an existing table.

## Configuration

### The secret

The local secret goes in `.dev.vars` at the repository root — git-ignored, one line, no
template to copy:

```
PS_SHARED_SECRET=<your own strong value>
```

In production it is a Worker secret:

```bash
npx wrangler secret put PS_SHARED_SECRET
```

It is deliberately **not** in `wrangler.jsonc`, which is tracked — a test fails if a secret
assignment appears there — and not in the deploy workflow, because a secret in GitHub
Actions is a secret in the run log.

Nothing at runtime checks the value: an unset secret means every protected route answers `401`
(`platform/http.ts` fails closed), and a placeholder value is a working password. The
Deployment section above is where that has to be caught.

### Worker configuration

`wrangler.jsonc` is tracked. There is no template and no copy step: a deploy cannot be
reproduced from a file that is not in the repository, and this one holds nothing private.

| Key | What it is |
|---|---|
| `name` | worker name, and with it the `workers.dev` subdomain |
| `main` | `apps/worker/src/index.ts` |
| `assets` | `apps/web/dist` with the `ASSETS` binding — the SPA fallback reads it |
| `d1_databases` | the `DB` binding |
| `r2_buckets` | the `BUCKET` binding |
| `triggers.crons` | the hourly maintenance sweep |
| `compatibility_date` | pinned runtime behaviour; see the note in the file |
| `vars` | `PUBLIC_ORIGIN` only, and only behind a proxy that forwards the original `Host` |

Two values are per-deployment and must be replaced before the first deploy:
`d1_databases[].database_id` (printed by `npx wrangler d1 create picoshare_db`) and
`r2_buckets[].bucket_name`. Neither is a credential, which is why they can live in the
repository at all.

R2 bucket names may contain only lowercase letters, numbers and hyphens. `picoshare_files`
is rejected by name validation and `wrangler dev` refuses to start rather than warning. D1
has no such rule, which is what makes the underscore look plausible.

One Worker answers both the API and the frontend, so the frontend redeploys whenever the API
does and the site is unavailable whenever the API is. Splitting them would need a route
table and a configurable client base URL, and the SPA fallback reads that binding.

### Database schema

The schema is `schema.sql`, and it is idempotent: `pnpm d1:init` (local) and
`pnpm d1:init:remote` can both be re-run, and CI applies it twice against a scratch
database to keep it that way.

Idempotent is not the same as migratory. `schema.sql` only ever says
`CREATE TABLE IF NOT EXISTS`, which adds *indexes* to an existing database and never a column
or a renamed one. So re-running it against a database built from an older schema reports
success and changes nothing, and the code then fails on every read that touches the renamed
column. **There is no migration path** — the intended deployment is a fresh database built
from the current `schema.sql`, so there is no upgrade path to owe anyone.

That failure is recognised rather than reported as a bare `500`: if a response says
`数据库结构与代码不匹配`, it is this, and the fix is to rebuild.

```bash
rm -rf .wrangler/state && pnpm d1:init
```

`.wrangler/state` is the local database *and* bucket in one directory, so a backup of it is
a backup of everything before you do that. Two things worth knowing about it: changing
`database_id` moves the local database too, because Miniflare keys the file by it, and the
old file is simply left behind rather than deleted.

### Security checklist

The rest is under [Notes](#notes) — the public routes, the content policy and the id
generator are all covered there.

- Never commit `.dev.vars`, `.env*`, private keys or cert files. `wrangler.jsonc` is tracked
  and a test fails if a secret assignment appears in it.
- Rotate `PS_SHARED_SECRET` if it leaks, and use a different one per environment.

## Notes

- The Worker API lives under `/api/*` and requires `PS_SHARED_SECRET` (except
  `/api/guest/:id/info` and `/api/guest/:id/upload`, which are public by design);
  share links use `/-<id>` and image links
   use `/img/<id>/<filename>` (served by the Worker before the SPA fallback).
  Those two are **unauthenticated by design** — the id *is* the access token — so ids
  are generated with a CSPRNG at 16 characters (~93 bits of entropy).
- Auth accepts `Authorization: <secret>`, `X-Api-Key: <secret>` or `?token=<secret>`. The
  query form is accepted on **exactly one route**, `POST /api/entry`, because it exists for
  image-host tooling that cannot set headers — every other `/api/*` route requires the
  header form. A secret in a URL lands in access logs and `Referer` headers.
- `POST /api/entry` takes **two request encodings on one route**, told apart by the
  request's own `Content-Type`: a `multipart/form-data` form (field `file`, what a browser
  and PicGo send) and a raw binary body (what `curl --data-binary` sends, filename in
  `?filename=`). Both answer with the same object —
  `{ id, filename, version, sha256, deduped, url, markdown, bbcode }` — where `url`,
  `markdown` and `bbcode` are `null` for a non-image, since only images are given a link.
- `GET /api/entries` accepts `kind` (`all`/`image`), `q`, `limit`, `offset` and
  returns `{ items, total }` in a single query.
- Response headers are hardened: only image/video/audio/PDF/plain-text are served
  inline; HTML/XML/JS are forced to `attachment`, SVG gets `attachment` + CSP
  `sandbox`, and every content response sends `X-Content-Type-Options: nosniff`.
- Direct links support `Range` and `If-None-Match` and only count GET requests as downloads.
- The previous cloud clipboard (clips), MD5 checksums, Docker runtime, and
  English UI have been removed.
