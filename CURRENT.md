> Snapshot commit: HASH:6c4c6e36f8aac6296c0716c95bfce4289666a711

# Codebase Snapshot

## Purpose

A Deno-based booru (image gallery) prototype that stores images in Git LFS and tracks
metadata through append-only NDJSON event logs. Indexes are derived from event replay
and treated as disposable materialized views.

## Runtime Entry Points

- **`server.ts`** — HTTP server on port 8000. On startup, checks for
  `index/image_state.json`; if absent, runs `processEvents` to rebuild indexes from
  the event log before beginning to serve requests.
- **`indexer.ts`** — CLI indexer that replays event shards into derived indexes.
  Invoked programmatically by `server.ts` at startup, or standalone:
  `deno run --allow-all indexer.ts [library-path]`. Defaults to `libraries/new`.
- **`scripts/dump_types.ts`** — TypeScript type-dump utility that prints the public
  type and function surface of `src/` using the TypeScript compiler API.
- **`scripts/read_json_sync_bench.ts`** — Deno benchmark measuring sync JSON
  read/parse performance on a generated ~500 MiB file. Creates
  `scripts/big.internal.json` if absent.

## Configuration

### `deno.json`

| Key | Value |
|-----|-------|
| Task `run` | `deno run --allow-all ./server.ts` |
| Import alias `@/` | `./src/` |
| Imports | `@std/path@1.1.4`, `@std/streams`, `@std/async@1.3.0`, `@core/asyncutil`, `npm:simple-git@3.36.0` |
| Formatter | 4-space indent, single quotes, 120-column width |

### Hardcoded runtime config in `server.ts`

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

## HTTP Server (`server.ts`)

Routes:

| Pattern | Method | Handler |
|---------|--------|---------|
| `/image/:oid` | any | `handleImage(req, conn)` — proxies LFS blob download |
| `/` | GET | `handleRoot(lib)` — gallery HTML page |
| `/ingest` | POST | `handleIngest(req, lib, conn)` — multipart image upload |
| all other | any | 404 |

Startup:

- `Deno.stat(join(lib.path, 'index', 'image_state.json'))` determines whether indexes exist
- If not, `processEvents(lib, store)` rebuilds indexes before `Deno.serve` starts

## Source Structure

```
src/
  handlers.ts   — HTTP handlers: ingest, gallery root, image proxy
  lfs/
    api.ts      — Git LFS HTTP client (PUT/GET/HEAD for object metadata and content)
    openapi.json — 10-path OpenAPI 3.0 spec titled "Git LFS Server"
  index_store.ts — DerivedIndexStore interface and JsonFileIndexStore implementation
  indexer.ts    — Event replay engine (processEvents) + event application logic
  git.ts        — Library initialization via template clone
  library.ts    — LibraryConnection type { path: string }
  logging.ts    — Debug logger (DEBUG=true, custom Error inspect)
  util.ts       — panic(), response helpers (c.json, c.text, c.blob, c.error)
  test_InitWith5Images.ts — Integration script: init library, ingest 5 PNGs, print timing tables
```

## Core Modules

### Handlers (`src/handlers.ts`)

**`handleRoot(lib)`** — Reads `lib.path/index/image_state.json`, renders an HTML
gallery page with image cards (name, tags, dimensions, inline image via
`/image/{oid}`). Does not handle missing `image_state.json`.

**`handleIngest(req, lib, conn)`** — Accepts multipart form with field `image`.
Computes SHA-256 OID from uploaded bytes. Deduplicates by scanning
`index/image_state.json` OIDs (falls back to `{}` if the file is absent). Optional
form fields: `name`, `tags` (JSON array string), `width`, `height`, `mtime`.
Creates an `add` event and delegates to `internalIngest`. Returns `{ id }` with
200 on dedupe, 201 on new ingest.

**`internalIngest(bytes, lib, conn, event, size)`** — Six-step pipeline:

1. Build Git LFS pointer text
2. `PutObjectMeta(conn, oid, size)` — register blob metadata with LFS server
3. `PutObjectContent(conn, oid, blob)` — upload blob bytes
4. Write pointer file to `lib.path/images/{id}.png`
5. Append event line to `lib.path/events/2026-05.ndjson`
6. `git add` and `git commit` both files

Returns JSON error responses on failure; `void` on success.

**`handleImage(req, conn)`** — Extracts OID from `/image/:oid` path and proxies
to `GetObjectContent`.

The event log shard name is hardcoded to `events/2026-05.ndjson`; the `getCurrentYearMonth` helper exists but is unused.

### LFS API Client (`src/lfs/api.ts`)

`Connection` type: `{ url, auth, user, repo }`.

Five exported functions, each constructing URLs and setting Accept/Authorization headers:

| Function | Method | Path | Accept |
|----------|--------|------|--------|
| `PutObjectMeta` | POST | `/{user}/{repo}/objects` | `application/vnd.git-lfs+json` |
| `PutObjectContent` | PUT | `/{user}/{repo}/objects/{oid}` | `application/vnd.git-lfs` |
| `GetObjectMeta` | GET | `/{user}/{repo}/objects/{oid}` | `application/vnd.git-lfs+json` |
| `GetObjectContent` | GET | `/{user}/{repo}/objects/{oid}` | `application/vnd.git-lfs` |
| `HeadObjectMeta` | HEAD | `/{user}/{repo}/objects/{oid}` | `application/vnd.git-lfs+json` |

The batch API (`POST /objects/batch`), locking APIs, and tus verify endpoints are
documented in the OpenAPI spec but not implemented in the client.

### Derived Index Store (`src/index_store.ts`)

**`DerivedIndexStore` interface** — `getCursor`, `saveCursor`, `getImage`,
`getIdByOid`, `applyEvent`, `listImages`, `close`.

**`JsonFileIndexStore`** — The sole implementation. Persists three JSON files under
the library root:

- `event_cursor` — resume position `{ eventFile, byteOffset }`
- `index/image_state.json` — `Record<string, ImageState>`
- `index/tag_index.json` — `Record<string, string[]>`

Uses `@core/asyncutil/mutex` for write serialization. Atomic writes via
`tmp + rename` pattern. `getCursor()` returns in-memory cache only;
`saveCursor()` writes to disk. `applyEvent` loads both index files, calls
`applyEvent` from `indexer.ts`, writes both files, then writes the cursor.

### Indexer (`indexer.ts`)

**`processEvents(conn, store)`** — The event replay engine:

1. Ensures `index/` directory exists
2. Scans `events/` for `.ndjson` files, sorts shard names
3. Resumes from `store.getCursor()` if available (skips prior shards, seeks to byte offset within current shard)
4. Streams lines via `TextLineStream`, parses each as JSON, calls `store.applyEvent(event, cursor)`
5. Reports final counts from `image_state.json` and `tag_index.json`

**`applyEvent(imageState, tagIndex, event)`** — Pure function applying event ops:

- `add` — inserts/updates image state, rebuilds tag index entries
- `tag_add` — appends tag to image, adds to tag index
- `tag_remove` — removes tag from image and tag index, prunes empty tag entries
- `delete` — removes image and its tag entries

Returns `IndexResult { images, tags, eventFiles, events }`.

### Library Initialization (`src/git.ts`)

**`Init(repoPath)`** — Clones `libraries/template` with `GIT_LFS_SKIP_SMUDGE=1`,
appends `[lfs] skipSmudge = true` to `.git/config`, and adds `upstream` remote
pointing to `https://github.com/USER/REPO.git`. The template must resolve to a
real path (panics if not). Returns `null` on success or the `Error` from clone.

## Core Flows

### Ingest Flow

```
POST /ingest (multipart image)
  → compute SHA-256 OID
  → dedupe scan: index/image_state.json OIDs
  → assign next sequential ID
  → PUT LFS blob metadata → PUT LFS blob content
  → write pointer file (images/{id}.png)
  → append NDJSON event line (events/2026-05.ndjson)
  → git add + git commit
  → 201 { id }
```

### Gallery Serving Flow

```
GET /
  → read index/image_state.json
  → render HTML with inline <img src="/image/{oid}">
  → GET /image/{oid} → GetObjectContent(conn, oid) → LFS server
```

### Index Rebuild Flow

```
Startup or CLI
  → scan events/ for .ndjson shards, sort
  → resume from event_cursor if present
  → stream lines, parse JSON events
  → applyEvent to in-memory image state + tag index
  → atomic write to index/image_state.json, index/tag_index.json, event_cursor
```

## Persistence Layout

Each library directory (`libraries/new`, `libraries/template`, `libraries/inspiration`) is a Git repository with:

```
{library}/
  .git/                          — Git metadata
  .gitattributes                 — LFS filter rules for image/*.png, *.jpg, etc.
  .gitignore                     — ignores index/* except .gitkeep
  .lfsconfig                     — lfs.url and lfs.fetchexclude
  images/                        — Git LFS pointer files (e.g., 1.png, 2.png)
  events/                        — NDJSON event shards (e.g., 2026-05.ndjson)
  index/                         — derived index files
    image_state.json             — { [id]: ImageState }
    tag_index.json               — { [tag]: id[] }
  event_cursor                   — { eventFile, byteOffset }
```

`libraries/template/` is the baseline skeleton with `.gitkeep` placeholders.
`libraries/new/` contains ingested pointer files and event data.
`libraries/inspiration/` contains a real image file at `images/1.png`.

`libraries/` is gitignored at the project root.

## Scripts and Utilities

### `scripts/dump_types.ts`

Uses `npm:typescript@6.0.3` to create a program from all `.ts` files under `src/`
and prints exported function signatures, interfaces, type aliases, enums, and
classes (with bodies stripped).

### `scripts/read_json_sync_bench.ts`

Generates a ~500 MiB JSON file (`scripts/big.internal.json`) containing
`{ "1": { oid, path, tags, ... }, ... }` entries. Runs three Deno benchmarks:
read+parse, read-only, and parse-only.

### `src/test_InitWith5Images.ts`

Integration test script:

1. Removes `libraries/new`
2. Calls `Init(lib.path)` to clone fresh from template
3. Reads first 5 PNGs from `$HOME/example-images`
4. Computes SHA-256, PNG dimensions, and file stats per image
5. Ingests each via `internalIngest`
6. Prints per-image and aggregate timing tables (read, hash, dimensions, stat, ingest)

## Implementation Constraints

- Server config, library path, and LFS connection are hardcoded in `server.ts`
- Ingest appends only to `events/2026-05.ndjson` (shard name is hardcoded)
- Ingest deduplication depends on `index/image_state.json` being present
- `handleRoot` expects `index/image_state.json` and throws if absent
- Gallery HTML is string-built and unescaped
- Resource cleanup is not implemented (no `close()` calls on `DerivedIndexStore`)
