> Last updated at HASH:5b7a8692e75edd5469e2d5b148aabf955d08331d

# Current Project State

## Runtime Shape

This is a Deno-based booru prototype with:

- one HTTP server entrypoint (`server.ts`)
- image ingest and gallery handlers (`src/handlers.ts`)
- a Git LFS HTTP wrapper (`src/lfs/api.ts`)
- append-only NDJSON event logs under `events/`
- derived indexes under `index/`
- one JSON-file index store backend (`JsonFileIndexStore`)
- one local library path hardcoded to `libraries/new/`

Hardcoded runtime config in `server.ts`:

```ts
const conn = {
  url: 'http://localhost:8080',
  auth: `Basic ${btoa('user:pass')}`,
  user: 'USER',
  repo: 'REPO',
};

const lib = {
  path: '/home/eissar/code/lfs-booru/libraries/new/',
};
```

## Deno Configuration (`deno.json`)

- task `run`: `deno run --allow-all ./server.ts`
- import alias `@/` -> `./src/`
- imports include `@std/path`, `@std/streams`, `@std/async`, `@core/asyncutil`, `simple-git`
- formatter: 4-space indent, single quotes, 120-column width

## HTTP Server (`server.ts`)

`server.ts` starts `Deno.serve({ port: 8000 }, handler)`.

Routes:

- `GET /` -> `handleRoot(lib)`
- `GET /image/:oid` -> `handleImage(req, conn)`
- `POST /ingest` -> `handleIngest(req, lib, conn)`
- all other routes -> `404 Not Found`

Startup behavior:

- creates `JsonFileIndexStore`
- computes `indexFlag`, but the current promise chain resolves to `true` even when `index/image_state.json` exists
- calls `processEvents(lib, store)` when `indexFlag` is true
- does not `await` `processEvents` before starting `Deno.serve`

## Ingest + Gallery Handlers (`src/handlers.ts`)

### `handleRoot(lib)`

- reads `lib.path/index/image_state.json`
- renders HTML cards with image metadata
- image bytes are fetched via `/image/{oid}`

### `handleIngest(req, lib, conn)`

- expects multipart field `image`
- computes SHA-256 OID for uploaded bytes
- deduplicates by scanning `index/image_state.json` OIDs
- optional form fields: `name`, `tags` (JSON array string), `width`, `height`, `mtime`
- creates an `add` event with path `images/{id}.png`
- calls `internalIngest`
- returns `{ id }` with:
  - `200` on dedupe
  - `201` on new ingest

### `internalIngest(bytes, lib, conn, event, size)`

Flow:

1. build Git LFS pointer text
2. `PutObjectMeta(conn, oid, size)`
3. `PutObjectContent(conn, oid, blob)`
4. write pointer file to `lib.path/event.path`
5. append event to `lib.path/events/2026-05.ndjson`
6. `git add [event.path, events/2026-05.ndjson]`
7. `git commit -m "booru: add image {id}"`

On failure it returns JSON `Response` errors; on success it returns `void`.

## LFS API Wrapper (`src/lfs/api.ts`)

`Connection`:

```ts
{ url: string; auth: string; user: string; repo: string }
```

Implemented functions:

- `PutObjectMeta` -> `POST /{user}/{repo}/objects` (or `/objects` when user/repo empty)
- `PutObjectContent` -> `PUT /{user}/{repo}/objects/{oid}`
- `GetObjectMeta` -> `GET /{user}/{repo}/objects/{oid}`
- `GetObjectContent` -> `GET /{user}/{repo}/objects/{oid}`
- `HeadObjectMeta` -> `HEAD /{user}/{repo}/objects/{oid}`

`src/lfs/openapi.json` is a 10-path OpenAPI spec titled `Git LFS Server` (version `1.0.0`).

## Indexer (`indexer.ts`)

Main function:

```ts
processEvents(conn: LibraryConnection, store: DerivedIndexStore): Promise<IndexResult>
```

Behavior:

- ensures `index/` exists
- scans `events/` for `.ndjson` files and sorts shard names
- replays events through `store.applyEvent(event, cursor)`
- updates cursor byte offsets per processed line
- reads final `image_state.json` and `tag_index.json` to produce counts
- logs summary: images, tags, event files, events

Supported event ops: `add`, `tag_add`, `tag_remove`, `delete`.

CLI mode:

```bash
deno run --allow-all indexer.ts [library-path]
```

Default path when omitted: `<project>/libraries/new`.

## Derived Index Store (`src/index_store.ts`)

`JsonFileIndexStore` implements `DerivedIndexStore` with:

- cursor file: `event_cursor`
- state file: `index/image_state.json`
- tag file: `index/tag_index.json`
- mutex-protected writes via `@core/asyncutil/mutex`
- atomic JSON writes using `tmp + rename`

Key behavior:

- `applyEvent` updates image state and tag index, then writes `event_cursor`
- `getCursor()` returns in-memory cache only
- `saveCursor()` writes cursor to disk and updates in-memory cache

## Git Library Initialization (`src/git.ts`)

`Init(repoPath)`:

- clones `libraries/template` with `GIT_LFS_SKIP_SMUDGE=1`
- appends to `.git/config`:

```ini
[lfs]
	skipSmudge = true
```

- adds remote `upstream` -> `https://github.com/USER/REPO.git`
- returns `null` on success or clone error on failure

## Script: `src/test_InitWith5Images.ts`

Purpose:

- deletes and recreates `libraries/new`
- runs `Init(lib.path)`
- reads first 5 PNGs from `$HOME/example-images`
- computes SHA-256 + PNG dimensions + file stats
- ingests each image via `internalIngest`
- prints setup, per-image, and aggregate timing tables

## Bench (`bench/read_json_sync_bench.ts`)

- creates `bench/big.internal.json` if missing (target size: 500 MiB)
- runs sync read/parse Deno benchmarks
- prints file size, entry count, read time, and parse time

## Library Directories (`libraries/`)

`libraries/` is ignored by root `.gitignore`, and currently contains:

- `template/`: baseline LFS-enabled repo skeleton (`images/`, `events/`, `index/` with `.gitkeep`)
- `new/`: local working library with:
  - pointer files `images/1.png`..`images/5.png`
  - `events/2026-05.ndjson`
  - `index/image_state.json`, `index/tag_index.json`
  - `event_cursor`
- `inspiration/`: local library containing a real image file at `images/1.png`

## Other Source Files

- `src/library.ts`: `LibraryConnection = { path: string }`
- `src/logging.ts`: debug logger with `DEBUG = true`
- `src/util.ts`: `panic(...)` and response helpers (`c.json`, `c.text`, `c.blob`, `c.error`)

## Repository Docs and Planning Files

- `readme.md`: architecture notes and ingest caveats
- `DESIGN.md`: error-handling and TypeScript API design principles
- `PLANNED.md` and `todo`: planned work items

## Verification Snapshot

Succeeded in this working tree:

```bash
deno check server.ts indexer.ts src/handlers.ts src/git.ts src/test_InitWith5Images.ts
deno run --allow-all indexer.ts
timeout 2s deno task run
```

`timeout 2s deno task run` starts the server and exits via timeout (code 124).

## Observed Constraints in Code

- Server, library path, and LFS connection are hardcoded.
- Ingest appends only to `events/2026-05.ndjson`.
- Ingest dedupe depends on `index/image_state.json`.
- Startup indexing is invoked without `await`.
- `indexFlag` logic in `server.ts` resolves to `true` with the current promise chain.
- `handleRoot` assumes `index/image_state.json` exists and does not provide a fallback.
- Gallery HTML is string-built and unescaped.