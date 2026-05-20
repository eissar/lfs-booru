> Snapshot commit: HASH:bc638de43715de9acf9faa875cc41096deaa4a3e

# Codebase Snapshot

## Purpose

This repository is a Deno-based booru prototype. It stores image bytes in a Git LFS server, stores Git LFS pointer files and metadata event shards in per-library Git repositories, and serves gallery HTML from JSON-derived image indexes.

## Runtime Entry Points

- `server.ts` starts the HTTP server used by `deno task run`.
- `src/indexer.ts` exports `processEvents`, the replay function used during server startup when derived index artifacts are incomplete.
- `scripts/dump_types.ts` prints the visible TypeScript declaration surface under `src/`.
- `scripts/read_json_sync_bench.ts` creates `scripts/big.internal.json` if absent and benchmarks synchronous read and parse behavior for a large JSON index-shaped file.
- `src/test_InitWith5Images.ts` is a five-image ingestion timing script, but it imports symbols that are not exported by the checked-out modules (`Connection` from `src/lfs/api.ts` and `internalIngest` from `src/handlers.ts`).

## Configuration

`deno.json` defines one task:

```text
deno task run -> deno run --allow-all ./server.ts
```

Imports and aliases:

- `@/` maps to `./src/`.
- `@std/http`, `@std/path@1.1.4`, `@std/streams`, `@std/async@1.3.0`, and `@std/html` are configured imports. The checked-out source uses the HTTP file server, path helpers, stream line splitting, and HTML escaping.
- `@core/asyncutil` provides the mutex used by the event log, handlers, and JSON index store.
- `simple-git@3.36.0` provides clone, add, commit, and remote setup operations.
- `npm:typescript@6.0.3` is loaded by `scripts/dump_types.ts`.

Formatter settings use 4-space indentation, single quotes, 120-column width, and exclude Markdown and JSON files. TypeScript strict mode is enabled.

`server.ts` hardcodes the LFS connection and library path:

```ts
const LFS_SERVER = 'http://localhost:8080';
const conn = {
    url: LFS_SERVER,
    auth: `Basic ${btoa('user:pass')}`,
    user: 'USER',
    repo: 'REPO',
};
const lib = { path: '/home/eissar/code/lfs-booru/libraries/new/' };
```

## Source Structure

```text
server.ts                       HTTP server setup and route dispatch
src/event_log.ts                EventLog interfaces and NDJSON append/read implementation
src/handlers.ts                 HTTP handlers for gallery, ingest, and image proxying
src/ingest.ts                   Multipart ingest parsing, hashing, LFS upload, and pointer writing
src/index_store.ts              DerivedIndexStore interface and JSON-file implementation
src/indexer.ts                  Event replay orchestration and event/index types
src/lfs/api.ts                  Thin Git LFS HTTP client
src/lfs/openapi.json            Git LFS server OpenAPI reference material
src/git.ts                      Library initialization and add/commit helpers
src/library.ts                  LibraryConnection type
src/logging.ts                  Debug logging helper and Error inspect customization
src/pointer.ts                  Git LFS pointer-file writer
src/renderer.ts                 Escaping HTML renderer with file-backed gallery page cache
src/util.ts                     Panic helper and response helper object
src/test_InitWith5Images.ts     Stale five-image ingestion measurement script
static/gallery.css              Gallery stylesheet served under `/static`
scripts/dump_types.ts           Source type-surface dump utility
scripts/read_json_sync_bench.ts JSON index-shaped benchmark utility
```

## Core Modules

### HTTP server (`server.ts`)

Startup constructs:

- `JsonFileIndexStore` for the hardcoded library path.
- `NdjsonEventLog` for the same library path.
- A hardcoded Git LFS `LfsConnection` for `http://localhost:8080`.

`JsonFileIndexStore` reads `index/next_image_id` synchronously during construction. After construction, `store.isInitialized()` checks for `index/image_state.json`, `index/tag_index.json`, and `index/next_image_id`. If that check returns false, startup calls `processEvents(store, eventLog)` before serving.

Routes:

| Pattern | Method | Behavior |
|---|---:|---|
| `/image/:oid` | any | `handleImage(req, conn)` proxies raw object content from the LFS server. |
| `/` | any | `handleRoot(store)` renders inline gallery HTML from `DerivedIndexStore.listImages()`. |
| `/ingest` | POST | `handleIngest(req, store, eventLog, lib, conn)` ingests multipart image uploads. |
| `/static/*` | any | Serves files from `./static` through `serveDir`. |
| other paths | any | Returns 404 text. |

### Event log (`src/event_log.ts`)

`EventLog` exposes append-only writes and `appendWithRollback`. `EventLogReader` exposes replay reads without adding read methods to the append-focused interface. `NdjsonEventLog` implements both interfaces for library-local `events/*.ndjson` files.

- `append(event)` writes one JSON line to `events/<yyyy-mm>.ndjson`, creating the directory when needed, and returns the changed relative path plus the cursor after the appended line.
- `appendWithRollback(event, fn)` appends an event, runs the callback while holding the event-log mutex, and truncates the shard back to the previous offset if the callback fails and no later append changed the file size.
- `readEvents(cursor?)` scans `.ndjson` shards under `events/`, sorts names, seeks to the supplied cursor in the matching shard, parses each line as an `Event`, and yields `{ event, cursor }` pairs.

`ReplayableEventLog` declares a `replayFrom` method. `NdjsonEventLog` does not implement that interface.

### Derived index store (`src/index_store.ts`)

`DerivedIndexStore` defines cursor, initialization, image lookup, OID lookup, event application, ID allocation, image listing, stats, and close operations. `JsonFileIndexStore` is the only implementation.

Stored files under the library root:

- `index/image_state.json` stores `Record<string, ImageState>`.
- `index/tag_index.json` stores `Record<string, string[]>`.
- `index/next_image_id` stores the next numeric image ID as text.
- `event_cursor` stores `{ eventFile, byteOffset }`.

Writes are protected by per-instance mutexes. JSON writes use a temporary file plus `Deno.rename`. `applyEvent` loads both index files, applies the event through the reducer in `index_store.ts`, writes image state, writes tag index, writes the cursor, and updates the in-memory cursor cache. `allocateImageId` advances `index/next_image_id` before returning the reserved ID.

`getCursor()` returns only the in-memory cache. It does not load `event_cursor` from disk.

### Indexer (`src/indexer.ts`)

`processEvents(store, eventLog)` requires `eventLog instanceof NdjsonEventLog`. It replays events through `NdjsonEventLog.readEvents(store.getCursor())`, persists each event through `store.applyEvent`, prints aggregate counts, and returns an `IndexResult`.

Supported event operations are:

- `add`: inserts or replaces image metadata and rebuilds tag index entries for that ID.
- `tag_add`: adds a tag to an existing image and its posting list.
- `tag_remove`: removes a tag from an existing image and prunes empty posting lists.
- `delete`: removes image state and related tag index entries.

The returned `eventFiles` count is always `0` because `processEvents` delegates shard scanning to `NdjsonEventLog.readEvents()` and does not count shards itself.

### Ingest and handlers (`src/handlers.ts`, `src/ingest.ts`)

- `handleRoot(store)` renders a simple inline HTML gallery from `store.listImages()`.
- `ingestFile(lib, conn, req, store)` accepts multipart form data with an `image` file field, computes a SHA-256 OID, parses optional metadata fields, reserves an ID through `store.allocateImageId()`, registers and uploads the object to LFS, writes `images/{id}.png`, and returns an `add` event.
- `handleIngest(req, store, eventLog, lib, conn)` calls `ingestFile`, requires a non-null `store.getCursor()`, appends the event with rollback around `stageAndCommit`, applies the event to the derived index, and returns `ok` with HTTP status 201.
- `handleImage(req, conn)` extracts the OID from `/image/:oid` and returns `GetObjectContent(conn, oid)`.

The ingest path allows duplicate OIDs. Content is content-addressed in LFS, while image records use sequential numeric IDs.

### LFS client (`src/lfs/api.ts`)

`LfsConnection` contains `{ url, auth, user, repo }`. URL helpers use `/{user}/{repo}/objects` when either `user` or `repo` is non-empty; otherwise they use `/objects`.

Exported request helpers:

| Function | Method | Purpose |
|---|---:|---|
| `PutObjectMeta` | POST | Register object metadata with `application/vnd.git-lfs+json`. |
| `PutObjectContent` | PUT | Upload raw object content with `application/vnd.git-lfs`. |
| `GetObjectMeta` | GET | Fetch object metadata JSON. |
| `GetObjectContent` | GET | Fetch raw object content. |
| `HeadObjectMeta` | HEAD | Check object metadata headers. |

The OpenAPI file documents a broader Git LFS server surface. The client implements only the helpers listed above.

### Git and pointer files (`src/git.ts`, `src/pointer.ts`)

`Init(repoPath)` resolves `libraries/template`, clones it with `GIT_LFS_SKIP_SMUDGE=1`, appends an `[lfs] skipSmudge = true` section to the cloned repository's `.git/config`, and adds an `upstream` remote pointing at `https://github.com/USER/REPO.git`. It returns `null` on success or the clone error on failure. It panics if the template path cannot be resolved.

`stageAndCommit(paths, message, lib)` runs `git add` and `git commit` through `simple-git` inside the library repository.

`writePointerFile(oid, size, path)` writes a Git LFS pointer with version, SHA-256 OID, and size fields.

### Renderer (`src/renderer.ts`)

`CachingHtmlRenderer` renders escaped image-card fragments and caches gallery pages under `index/artifacts/gallery-pages`. The cache key includes renderer version, title, and card fragments. `handleRoot` does not use this renderer.

## Core Flows

### Server startup

```text
server.ts
  -> create JsonFileIndexStore(libraries/new)
  -> create NdjsonEventLog(libraries/new)
  -> store.isInitialized()
  -> if index artifacts are incomplete: processEvents(store, eventLog)
  -> Deno.serve({ port: 8000 }, handler)
```

### Ingest

```text
POST /ingest multipart form
  -> require image field
  -> read bytes and compute SHA-256 OID
  -> parse tags as a JSON array of strings
  -> parse or default width, height, mtime, and name
  -> reserve ID by advancing index/next_image_id
  -> PUT LFS metadata
  -> PUT LFS content
  -> write images/{id}.png Git LFS pointer
  -> require in-memory derived-index cursor
  -> append add event to events/{yyyy-mm}.ndjson with rollback around Git operations
  -> git add pointer and event shard
  -> git commit -m "booru: add image {id}"
  -> apply event to image_state.json, tag_index.json, and event_cursor
  -> return text `ok`
```

### Gallery rendering and image serving

```text
GET /
  -> store.listImages()
  -> render HTML cards with /image/{oid}

GET /image/{oid}
  -> GetObjectContent(conn, oid)
  -> return upstream LFS response
```

### Event replay

```text
processEvents
  -> require NdjsonEventLog
  -> NdjsonEventLog.readEvents(store.getCursor())
  -> JSON.parse each NDJSON line
  -> store.applyEvent(event, nextCursor)
  -> store.stats()
```

## Persistence Layout

The project root ignores `libraries/`, but the checkout contains local library repositories used by the prototype.

A library repository uses this layout:

```text
{library}/
  .git/                  Git repository metadata
  .gitattributes         LFS filters for images/**/*.png, jpg, jpeg, gif, webp
  .gitignore             ignores /index/* except /index/.gitkeep and ignores /event_cursor
  .lfsconfig             lfs.url = http://localhost:8080 and fetchexclude = *
  events/                NDJSON metadata event shards
  images/                Git LFS pointer files
  index/                 derived JSON index files, next_image_id, and renderer artifacts
  event_cursor           replay cursor written by JsonFileIndexStore
```

`libraries/template` is the clone source used by `Init`. It includes `.gitattributes`, `.gitignore`, `.lfsconfig`, `index/next_image_id`, and `.gitkeep` placeholders under `events/`, `images/`, and `index/`. `libraries/new` contains a sample library with `events/2026-05.ndjson`, pointer files, derived indexes, and `event_cursor`.

## Scripts and Utilities

- `scripts/dump_types.ts` walks `src/`, creates a TypeScript program, and prints declarations for interfaces, type aliases, enums, classes, and functions. The type dump is inspection output, not a generated repository artifact.
- `scripts/read_json_sync_bench.ts` creates or reuses `scripts/big.internal.json`; files matching `*.internal.*` are ignored by the root `.gitignore`.
- `src/test_InitWith5Images.ts` targets a running LFS server at `localhost:8080` and at least five PNG files in `$HOME/example-images`, but its imports do not match the checked-out exported API.

## Implementation Constraints

- Server LFS connection details and library path are hardcoded.
- `JsonFileIndexStore` construction requires `index/next_image_id` to exist and contain a number.
- `store.isInitialized()` checks `index/next_image_id`, but server startup constructs the store before running that check.
- `JsonFileIndexStore.getCursor()` does not read `event_cursor` from disk. A constructed store has a null cursor until `applyEvent` or `saveCursor` runs.
- `handleIngest` performs LFS upload and pointer-file write before checking for a non-null in-memory cursor.
- `handleIngest` reserves an ID before LFS upload, pointer write, event append, Git commit, and derived-index application. Failed ingest attempts can consume IDs.
- Event append rollback covers the NDJSON append when Git add or commit fails. It does not remove the pointer file, LFS object, or any staged Git index state.
- If derived-index application fails after Git commit, source files are committed but the served index can remain stale.
- `processEvents` reports `eventFiles: 0`.
- `handleRoot` builds HTML strings without escaping image names or tags.
- `CachingHtmlRenderer` escapes HTML and caches pages, but no request path uses it.
- JSON index writes are serialized within one store instance, but image state, tag index, and cursor writes are not committed as a single filesystem transaction.
- Mutexes are process-local and do not protect against other processes modifying the same library files.
