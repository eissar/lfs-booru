> Snapshot commit: HASH:62bdb56692e5e4720650618c2fe652470c5f6186

# Codebase Snapshot

## Purpose

A Deno-based booru prototype that stores image bytes in a Git LFS server, stores Git LFS pointer files and metadata event shards in per-library Git repositories, and serves gallery HTML from JSON-derived image indexes.

## Runtime Entry Points

- `server.ts` starts the HTTP server. Run with `deno task run`.
- `src/indexer.ts` exports `processEvents`, the replay function called during server startup when derived index artifacts are incomplete.
- `scripts/dump_types.ts` prints the visible TypeScript declaration surface under `src/`.
- `scripts/read_json_sync_bench.ts` creates `scripts/big.internal.json` if absent and benchmarks synchronous JSON read and parse behavior for a large index-shaped file.
- `src/test_InitWith5Images.ts` is a self-contained five-image ingestion measurement script that targets a running LFS server at `localhost:8080` and PNG files under `$HOME/example-images`.

## Configuration

`deno.json` defines one task and the following import map:

```json
{
    "tasks": { "run": "deno run --allow-all ./server.ts" },
    "imports": {
        "@std/http": "jsr:@std/http@^1.1.0",
        "@std/streams": "jsr:@std/streams",
        "@std/html": "jsr:@std/html",
        "@std/path": "jsr:@std/path@1.1.4",
        "@std/async": "jsr:@std/async@1.3.0",
        "@core/asyncutil": "jsr:@core/asyncutil",
        "simple-git": "npm:simple-git@3.36.0",
        "@/": "./src/"
    }
}
```

- `npm:typescript@6.0.3` is imported by `scripts/dump_types.ts` but is not listed in `deno.json` imports; it is resolved inline via `npm:` specifier.
- Formatter settings: 4-space indent, single quotes, 120-column width, excludes Markdown and JSON files.
- TypeScript strict mode is enabled.

The server hardcodes LFS connection and library path:

```ts
const LFS_SERVER = 'http://localhost:8080';
const conn = { url, auth, user: 'USER', repo: 'REPO' };
const lib = { path: '/home/eissar/code/lfs-booru/libraries/new/' };
```

## Source Structure

```
server.ts                          HTTP server setup and route dispatch
src/
  event_log.ts                     EventLog interfaces and NDJSON append/read implementation
  handlers.ts                      HTTP handlers for gallery, ingest, and image proxying
  index_store.ts                   DerivedIndexStore interface and JSON-file implementation
  indexer.ts                       Event replay orchestration and event/index types
  ingest.ts                        Multipart ingest parsing, hashing, LFS upload, and pointer writing
  git.ts                           Library initialization and add/commit helpers
  library.ts                       LibraryConnection type alias
  lfs/
    api.ts                         Thin Git LFS HTTP client (metadata, content, and HEAD helpers)
    openapi.json                   Git LFS server OpenAPI reference material
  logging.ts                       Debug logging helper and Error inspect customization
  pointer.ts                       Git LFS pointer-file writer
  renderer.ts                      Escaping HTML renderer with file-backed gallery page cache
  util.ts                          Panic helper and HTTP response utility object
  test_InitWith5Images.ts          Five-image ingestion timing and measurement script
static/
  gallery.css                      Gallery stylesheet served under `/static`
scripts/
  dump_types.ts                    Source type-surface dump utility
  read_json_sync_bench.ts          JSON index-shaped benchmark utility
```

## Key Modules

### HTTP server (`server.ts`)

Startup constructs `JsonFileIndexStore`, `NdjsonEventLog`, a hardcoded `LfsConnection`, and checks `store.isInitialized()`. If index artifacts are missing, it calls `processEvents(store, eventLog)` before serving. Routes:

| Pattern | Method | Behavior |
|---|---:|---|
| `/image/:oid` | any | `handleImage(req, conn)` proxies raw object content from the LFS server |
| `/` | any | `handleRoot(store)` renders inline gallery HTML from `DerivedIndexStore.listImages()` |
| `/ingest` | POST | `handleIngest(req, store, eventLog, lib, conn)` ingests multipart image uploads |
| `/static/*` | any | Serves files from `./static` through `serveDir` |
| other paths | any | Returns 404 text |

### Event log (`src/event_log.ts`)

- `EventLog` interface: append-only writes with `append` and `appendWithRollback`.
- `EventLogReader` interface: read-only replay via `readEvents(cursor?)`.
- `ReplayableEventLog` interface: extends `EventLog` with `replayFrom(cursor)`. Not implemented by `NdjsonEventLog`.
- `NdjsonEventLog` implements both `EventLog` and `EventLogReader`. Writes to `events/<yyyy-mm>.ndjson` (monthly shards). Append holds a mutex. `appendWithRollback` truncates the shard on callback failure if no later append changed file size. `readEvents` scans `.ndjson` shards, sorts by name, seeks to cursor, parses each line via `JSON.parse`, and yields `{event, cursor}` pairs.

### Derived index store (`src/index_store.ts`)

- `DerivedIndexStore` interface: cursor, initialization check, image/oid lookup, event application, ID allocation, listing, stats, close.
- `JsonFileIndexStore` is the sole implementation. Stores under library root:
  - `index/image_state.json` — `Record<string, ImageState>`
  - `index/tag_index.json` — `Record<string, string[]>`
  - `index/next_image_id` — numeric sequence text
  - `event_cursor` — `{eventFile, byteOffset}` JSON

  Construction reads `index/next_image_id` synchronously. Writes use a temporary file plus `Deno.rename`. `applyEvent` loads both index files, applies the event reducer, writes image state and tag index, writes the cursor, and updates the in-memory cursor cache.
  `getCursor()` returns only the in-memory cache. It does not load `event_cursor` from disk. `allocateImageId()` increments the file and in-memory sequence under a dedicated mutex.

### Indexer (`src/indexer.ts`)

`processEvents(store, eventLog)` requires `eventLog instanceof NdjsonEventLog`. It replays events through `NdjsonEventLog.readEvents(store.getCursor())`, persists each event through `store.applyEvent`, prints aggregate counts, and returns `IndexResult`. Supported event operations: `add`, `tag_add`, `tag_remove`, `delete`.

### Handlers and ingest (`src/handlers.ts`, `src/ingest.ts`)

- `handleRoot(store)` renders inline gallery HTML from `store.listImages()`.
- `ingestFile(lib, conn, req, store)` parses multipart form, requires an `image` file field, computes SHA-256 OID, parses tags as JSON array, reserves ID via `store.allocateImageId()`, uploads metadata and content to LFS, writes pointer file at `images/{id}.png`, and returns an `add` event.
- `handleIngest` calls `ingestFile`, requires a non-null `store.getCursor()`, appends the event with rollback around `stageAndCommit`, applies the event to the derived index, and returns `ok` with status 201.
- `handleImage(req, conn)` extracts OID from `/image/:oid` and returns `GetObjectContent(conn, oid)`.

### LFS client (`src/lfs/api.ts`)

`LfsConnection` type: `{ url, auth, user, repo }`. Exported helpers:

| Function | Method | Purpose |
|---|---:|---|
| `PutObjectMeta` | POST | Register object metadata with `application/vnd.git-lfs+json` |
| `PutObjectContent` | PUT | Upload raw object content with `application/vnd.git-lfs` |
| `GetObjectMeta` | GET | Fetch object metadata JSON |
| `GetObjectContent` | GET | Fetch raw object content |
| `HeadObjectMeta` | HEAD | Check object metadata headers |

URL helpers use `/{user}/{repo}/objects` when either user or repo is non-empty, otherwise `/objects`.

### Git and pointer files (`src/git.ts`, `src/pointer.ts`)

- `Init(repoPath)` clones `libraries/template` with `GIT_LFS_SKIP_SMUDGE=1`, appends `[lfs] skipSmudge = true` to `.git/config`, and adds an `upstream` remote.
- `stageAndCommit(paths, message, lib)` runs `git add` and `git commit` through `simple-git`.
- `writePointerFile(oid, size, path)` writes a Git LFS pointer with version, `oid sha256:...`, and `size N` fields.

### Renderer (`src/renderer.ts`)

`CachingHtmlRenderer` implements `HtmlRenderer`. It escapes HTML via `@std/html/entities`, caches gallery pages under `index/artifacts/gallery-pages` by SHA-256 content hash of version, title, and card fragments. `handleRoot` does not use this renderer; only inline HTML is served for gallery requests.

## Core Flows

### Server startup

```
server.ts
  -> create JsonFileIndexStore(libraries/new)
  -> read index/next_image_id synchronously
  -> create NdjsonEventLog(libraries/new)
  -> store.isInitialized() — checks index/image_state.json, tag_index.json, next_image_id
  -> if incomplete: processEvents(store, eventLog)
  -> Deno.serve({ port: 8000 }, handler)
```

### Ingest

```
POST /ingest multipart form
  -> require image file field
  -> read bytes, compute SHA-256 OID
  -> parse tags as JSON array of strings
  -> parse or default width, height, mtime, name
  -> reserve ID (advance index/next_image_id)
  -> PUT LFS metadata, PUT LFS content
  -> write images/{id}.png Git LFS pointer
  -> require in-memory derived-index cursor
  -> append add event to events/{yyyy-mm}.ndjson with rollback around Git operations
  -> git add pointer + event shard, git commit -m "booru: add image {id}"
  -> apply event to image_state.json, tag_index.json, event_cursor
  -> return text `ok`
```

### Gallery rendering and image serving

```
GET /
  -> store.listImages()
  -> render HTML cards with /image/{oid}

GET /image/{oid}
  -> GetObjectContent(conn, oid)
  -> return upstream LFS response
```

### Event replay

```
processEvents
  -> require NdjsonEventLog
  -> NdjsonEventLog.readEvents(store.getCursor())
  -> JSON.parse each NDJSON line
  -> store.applyEvent(event, nextCursor)
  -> log stats
```

## Persistence Layout

A library repository:

```
{library}/
  .git/                        Git repository metadata
  .gitattributes               LFS filters for image extensions
  .gitignore                   Ignores /index/* except .gitkeep, ignores /event_cursor
  .lfsconfig                   lfs.url = http://localhost:8080, fetchexclude = *
  events/*.ndjson              NDJSON metadata event shards (monthly)
  images/*                     Git LFS pointer files
  index/
    image_state.json           Derived image state (Record<string, ImageState>)
    tag_index.json             Derived tag index (Record<string, string[]>)
    next_image_id              Write-path ID sequence
    artifacts/gallery-pages/   Cached HTML renderer output
  event_cursor                 Replay checkpoint JSON
```

`libraries/template` is the clone source with `.gitattributes`, `.gitignore`, `.lfsconfig`, `index/next_image_id`, and `.gitkeep` files. `libraries/new` contains a sample library with 5 ingested images, event shards, and derived indexes.

## Scripts and Utilities

- `scripts/dump_types.ts` walks `src/`, creates a TypeScript program, and prints declarations for interfaces, type aliases, classes, and function signatures.
- `scripts/read_json_sync_bench.ts` creates or reuses `scripts/big.internal.json` for benchmarking synchronous JSON reads. Files matching `*.internal.*` are gitignored.
- `src/test_InitWith5Images.ts` measures end-to-end ingest timing for 5 PNG images against a running LFS server. It creates a fresh library via `Init`, computes OIDs and PNG dimensions, uploads to LFS, writes pointers, appends events with Git commit, and prints per-image and aggregate timings.

## Implementation Constraints

- Server LFS connection details and library path are hardcoded in `server.ts`.
- `JsonFileIndexStore` construction requires `index/next_image_id` to exist and contain a parseable number.
- `store.isInitialized()` checks `index/next_image_id`, but server startup constructs the store before running that check, making `next_image_id` a fatal precondition regardless of the initialization flag.
- `JsonFileIndexStore.getCursor()` does not load `event_cursor` from disk. A fresh store instance has a null cursor until `applyEvent` or `saveCursor` runs.
- `handleIngest` performs LFS upload and pointer-file write before checking for a non-null in-memory cursor.
- `handleIngest` reserves an ID before LFS upload and Git operations. Failed ingest attempts can consume IDs.
- Event append rollback covers the NDJSON append when Git operations fail. It does not remove the pointer file, LFS object, or staged Git index state.
- If derived-index application fails after Git commit, source files are committed but served indexes can be stale.
- `handleRoot` builds HTML strings without escaping image names or tags.
- `CachingHtmlRenderer` escapes HTML and caches pages, but no request path connects to it.
- JSON index writes (image state, tag index, cursor) are not committed as a single filesystem transaction.
- Mutexes are process-local and do not protect against other processes modifying the same library files.
