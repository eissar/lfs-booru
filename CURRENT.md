# Current Project State

This file inventories the current codebase as of 2026-05-17.

## Runtime Shape

The project is a Deno-based booru prototype with:

- one local Git repo per library (currently `libraries/new/`)
- Git LFS pointer files under `images/`
- an external `lfs-test-server` at `http://localhost:8080`
- append-only NDJSON event logs under `events/`
- materialized JSON indexes under `index/`

Hardcoded runtime config in `server.ts`:

```ts
const lib = { path: '/home/eissar/code/lfs-booru/libraries/new/' };
const conn = {
  url: 'http://localhost:8080',
  auth: `Basic ${btoa('user:pass')}`,
  user: 'USER',
  repo: 'REPO',
};
```

## Deno Configuration (`deno.json`)

- task `run`: `deno run --allow-all ./server.ts`
- import alias `@/` -> `./src/`
- imports:
  - `@std/path`
  - `simple-git`
- formatting: 4-space indent, single quotes, 120-column width

## HTTP Server (`server.ts`)

`server.ts` starts `Deno.serve({ port: 8000 }, handler)`.

Routes:

- `GET /`
  - calls `handleRoot(lib)`
  - renders gallery HTML from `index/image_state.json`
- `GET /image/:oid`
  - calls `handleImage(req, conn)`
  - fetches object bytes via LFS API
- `POST /ingest`
  - calls `handleIngest(req, lib, conn)`
- all other paths return `404 Not Found`

## Library Connection (`src/library.ts`)

```ts
type LibraryConnection = {
  path: string;
};
```

## Ingest + Gallery Handlers (`src/handlers.ts`)

### `handleRoot(lib)`

- reads `lib.path/index/image_state.json`
- renders simple unescaped HTML cards
- references image data by `/image/{oid}`

### `internalIngest(bytes, lib, conn, event, size)`

Flow:

1. build Git LFS pointer text for `event.oid`
2. `PutObjectMeta(conn, oid, size)`
3. `PutObjectContent(conn, oid, blob)`
4. write pointer file to `lib.path/event.path` (e.g. `images/1.png`)
5. append event JSON to `lib.path/events/2026-05.ndjson`
6. run `git add [event.path, events/2026-05.ndjson]`
7. run `git commit -m "booru: add image {id}"`

Returns JSON `Response` on error, `void` on success.

### `handleIngest(req, lib, conn)`

- expects multipart file field `image`
- computes SHA-256 OID
- reads `index/image_state.json` if present for dedupe + next ID
- optional fields: `name`, `tags` (JSON array string), `width`, `height`, `mtime`
- creates `op: 'add'` event with path `images/{id}.png`
- calls `internalIngest`
- returns `{ id }` with `201` on success, or existing ID with `200` on dedupe

## LFS API Wrapper (`src/lfs/api.ts`)

`Connection`:

```ts
{ url: string; auth: string; user: string; repo: string }
```

Implemented helpers:

- `PutObjectMeta` → `POST /{user}/{repo}/objects`
- `PutObjectContent` → `PUT /{user}/{repo}/objects/{oid}`
- `GetObjectMeta` → `GET /{user}/{repo}/objects/{oid}`
- `GetObjectContent` → `GET /{user}/{repo}/objects/{oid}`
- `HeadObjectMeta` → `HEAD /{user}/{repo}/objects/{oid}`

## Indexer (`indexer.ts`)

Main export:

```ts
processEvents(conn: LibraryConnection): Promise<IndexResult>
```

Behavior:

- ensures `conn.path/index/` exists
- reads all `.ndjson` files in `conn.path/events/`
- sorts file names, replays all events in order
- writes:
  - `index/image_state.json`
  - `index/tag_index.json`
- prints and returns counts (`images`, `tags`, `eventFiles`, `events`)

Supported ops: `add`, `tag_add`, `tag_remove`, `delete`.

Standalone usage:

```bash
deno run --allow-all indexer.ts [library-path]
```

Default path when omitted: `<project>/libraries/new`.

## Git Library Initialization (`src/git.ts`)

`Init(repoPath)`:

- clones `libraries/template` with `GIT_LFS_SKIP_SMUDGE=1`
- appends to `.git/config`:

```ini
[lfs]
	skipSmudge = true
```

- adds `upstream` remote: `https://github.com/USER/REPO.git`
- returns `null` on success or clone error on failure

## Template Library (`libraries/template`)

- `.gitattributes` sends common image extensions to LFS
- `.lfsconfig`:

```ini
[lfs]
	url = http://localhost:8080
	fetchexclude = *
```

## Other Source Files

- `src/index_store.ts`: JSON-backed `DerivedIndexStore` implementation (`JsonFileIndexStore(conn)`), with:
  - `IndexCursor = { eventFile, byteOffset }`
  - cursor path: `event_cursor` at the library root
  - methods: `getCursor`, `getImage`, `getIdByOid`, `applyEvent(event, nextCursor)`, `listImages`, `close`
  - constructor accepts `LibraryConnection` only
  - locking uses `using _lock = await mu.acquire()`
  - `applyEvent` updates `index/image_state.json`, rebuilds `index/tag_index.json`, then writes `event_cursor`
- `src/logging.ts`: debug logger (`DEBUG = true`)
- `src/util.ts`: panic + response helpers

## Script: `src/test_InitWith5Images.ts`

Purpose: remove/recreate `libraries/new`, ingest first 5 PNGs from `~/example-images`, print timing tables.

Import status: `internalIngest` is imported via `@/handlers.ts`.

## Runtime Data Layout (`libraries/new`)

Observed populated layout:

- `.git/`
- `.gitattributes`
- `.lfsconfig`
- `images/{id}.png` (LFS pointers)
- `events/2026-05.ndjson`
- `index/image_state.json`
- `index/tag_index.json`

Raw image bytes are stored in the external LFS server.

## Current Verification Snapshot

Succeeded:

```bash
deno check server.ts indexer.ts src/handlers.ts src/git.ts src/test_InitWith5Images.ts
deno run --allow-all indexer.ts
timeout 2s deno task run
# server starts and listens on :8000 (timeout exits intentionally)
```

## Important Current Limitations / TODOs

- Server/library/LFS config is hardcoded.
- Event log shard path is hardcoded: `events/2026-05.ndjson`.
- Ingest dedupe relies on up-to-date `index/image_state.json`.
- Server does not auto-run indexer after ingest.
- Gallery HTML is minimal and not escaped/sanitized.
- `indexer.ts` entrypoint performs full rebuild.
