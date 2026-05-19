> Snapshot commit: HASH:539b1035c956fb364db9d5370c8dab067bda7f39

# Codebase Snapshot

## Purpose

This repository is a Deno-based booru prototype. It stores image bytes in a Git LFS server, writes Git LFS pointer files into per-library Git repositories, and records image metadata as append-only NDJSON events. JSON files under each library's `index/` directory are derived views built by replaying events.

## Runtime Entry Points

- `server.ts` starts a Deno HTTP server on port 8000 through `deno task run`.
- `src/indexer.ts` can run as a CLI with `deno run --allow-all src/indexer.ts [library-path]`. It replays NDJSON events into the JSON index store. Without an argument, its path expression resolves relative to `src/`.
- `src/test_InitWith5Images.ts` is an integration/measurement script. It removes `libraries/new`, clones a fresh library from `libraries/template`, ingests five PNG files from `$HOME/example-images`, and prints timing tables.
- `scripts/dump_types.ts` prints the visible type, function, interface, class, and type-alias surface under `src/` using the TypeScript compiler API.
- `scripts/read_json_sync_bench.ts` generates `scripts/big.internal.json` if absent and benchmarks synchronous read/parse behavior for a large JSON index-shaped file.

## Configuration

`deno.json` defines one task:

```text
deno task run -> deno run --allow-all ./server.ts
```

Imports and aliases:

- `@/` maps to `./src/`.
- `@std/path@1.1.4`, `@std/streams`, and `@std/async@1.3.0` are used for path, stream, and async utilities.
- `@core/asyncutil` provides the mutex used by the JSON index store.
- `simple-git@3.36.0` is used for Git clone, add, commit, and remote setup.

Formatter settings use 4-space indentation, single quotes, 120-column width, and exclude Markdown and JSON files.

`server.ts` hardcodes the runtime LFS connection and library path:

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
server.ts                      HTTP server setup and route dispatch
src/event_log.ts               EventLog interfaces and NDJSON-backed append/read implementation
src/handlers.ts                HTTP handlers for gallery, ingest, and image proxying
src/index_store.ts             DerivedIndexStore interface and JSON-file implementation
src/indexer.ts                 Event application and event replay engines
src/lfs/api.ts                 Thin Git LFS HTTP client
src/lfs/openapi.json           Git LFS server OpenAPI description used as reference material
src/git.ts                     Library initialization from libraries/template
src/library.ts                 LibraryConnection type
src/logging.ts                 Debug logging helper and Error inspect customization
src/util.ts                    panic helper and response helper object
src/test_InitWith5Images.ts    Five-image ingestion measurement script
scripts/dump_types.ts          Source type-surface dump utility
scripts/read_json_sync_bench.ts JSON index-shaped benchmark utility
```

## Key Modules

### HTTP server (`server.ts`)

Startup constructs:

- `JsonFileIndexStore` for the hardcoded library path.
- `NdjsonEventLog` for the same library path.
- A hardcoded Git LFS `Connection` for `http://localhost:8080`.

`store.isInitialized()` checks for both `index/image_state.json` and `index/tag_index.json`. If either file is missing, startup calls `processEventsNew(store, eventLog)` before serving.

Routes:

| Pattern | Method | Behavior |
|---|---:|---|
| `/image/:oid` | any | `handleImage(req, conn)` proxies raw object content from the LFS server. |
| `/` | any | `handleRootNew(store)` renders gallery HTML from `DerivedIndexStore.listImages()`. |
| `/ingest` | POST | `handleIngest(req, lib, conn)` ingests multipart image uploads. |
| other paths | any | Returns 404 text. |

The `EventLog` parameter passed into `createHandler` is not used by the route body.

### Event log (`src/event_log.ts`)

`EventLog` exposes append-only writes. `EventLogReader` exposes replay reads without adding read methods to the append-focused interface. `NdjsonEventLog` implements both interfaces for library-local `events/*.ndjson` files.

- `append(event)` writes one JSON line to `events/<yyyy-mm>.ndjson`, creating the directory when needed, and returns the changed relative path plus the cursor after the appended line.
- `readEvents(cursor?)` scans `.ndjson` shards under `events/`, sorts names, seeks to the supplied cursor in the matching shard, parses each line as an `Event`, and yields `{ event, cursor }` pairs.

`processEventsNew` requires an `NdjsonEventLog` instance and exits through `panic` for alternate `EventLog` implementations.

### Handlers (`src/handlers.ts`)

- `handleRootNew(store)` renders a simple HTML gallery from `store.listImages()`.
- `handleRoot(lib)` is a legacy gallery renderer that reads `index/image_state.json` directly.
- `handleIngest(req, lib, conn)` accepts multipart form data with an `image` file field, computes a SHA-256 OID, deduplicates by scanning `index/image_state.json`, assigns `max(id) + 1`, parses optional metadata fields, and delegates to `internalIngest`.
- `internalIngest(bytes, lib, conn, event, size)` registers metadata with the LFS server, uploads bytes, writes a Git LFS pointer file, appends an event line to `events/2026-05.ndjson`, then runs `git add` and `git commit` inside the library repository.
- `handleImage(req, conn)` extracts the OID from `/image/:oid` and returns `GetObjectContent(conn, oid)`.

The ingest path writes the event log directly instead of using `NdjsonEventLog.append`.

### LFS client (`src/lfs/api.ts`)

`Connection` contains `{ url, auth, user, repo }`. URL helpers use `/{user}/{repo}/objects` when either `user` or `repo` is non-empty; otherwise they use `/objects`.

Exported request helpers:

| Function | Method | Purpose |
|---|---:|---|
| `PutObjectMeta` | POST | Register object metadata with `application/vnd.git-lfs+json`. |
| `PutObjectContent` | PUT | Upload raw object content with `application/vnd.git-lfs`. |
| `GetObjectMeta` | GET | Fetch object metadata JSON. |
| `GetObjectContent` | GET | Fetch raw object content. |
| `HeadObjectMeta` | HEAD | Check object metadata headers. |

The OpenAPI file documents a broader Git LFS server surface, including batch, locks, and tus-related routes. The client implements only the helpers listed above.

### Derived index store (`src/index_store.ts`)

`DerivedIndexStore` defines cursor, initialization, image lookup, OID lookup, event application, image listing, stats, and close operations. `JsonFileIndexStore` is the only implementation.

Stored files under the library root:

- `index/image_state.json` stores `Record<string, ImageState>`.
- `index/tag_index.json` stores `Record<string, string[]>`.
- `event_cursor` stores `{ eventFile, byteOffset }`.

Writes are protected by a module-level mutex. JSON writes use a temporary file plus `Deno.rename`. `applyEvent` loads both index files, applies the event through `indexer.ts`, writes image state, writes tag index, writes the cursor, and updates the in-memory cursor cache.

`getCursor()` returns only the in-memory cache. It does not load `event_cursor` from disk.

### Indexer (`src/indexer.ts`)

`applyEvent(imageState, tagIndex, event)` mutates in-memory records for four event ops:

- `add` inserts or replaces image metadata and rebuilds tag index entries for that ID.
- `tag_add` adds a tag to an existing image and its posting list.
- `tag_remove` removes a tag from an existing image and prunes empty posting lists.
- `delete` removes image state and related tag index entries.

`processEventsNew(store, eventLog)` replays events through `NdjsonEventLog.readEvents(store.getCursor())`, persists each event through `store.applyEvent`, then returns aggregate counts from `store.stats()`.

`processEvents(conn, store)` is the older replay implementation. It scans `events/` itself, sorts `.ndjson` shards, seeks from `store.getCursor()`, and persists each event through the store.

### Git initialization (`src/git.ts`)

`Init(repoPath)` resolves `libraries/template`, clones it with `GIT_LFS_SKIP_SMUDGE=1`, appends an `[lfs] skipSmudge = true` section to the cloned repository's `.git/config`, and adds an `upstream` remote pointing at `https://github.com/USER/REPO.git`. It returns `null` on success or the clone error on failure. It panics if the template path cannot be resolved.

## Core Flows

### Server startup

```text
server.ts
  -> create JsonFileIndexStore(libraries/new)
  -> create NdjsonEventLog(libraries/new)
  -> store.isInitialized()
  -> if missing image_state.json or tag_index.json: processEventsNew(store, eventLog)
  -> Deno.serve({ port: 8000 }, handler)
```

### Ingest

```text
POST /ingest multipart form
  -> require image field
  -> read bytes and compute SHA-256 OID
  -> scan index/image_state.json for duplicate OID
  -> assign next sequential numeric ID
  -> parse name, tags, width, height, mtime
  -> PUT LFS metadata
  -> PUT LFS content
  -> write images/{id}.png Git LFS pointer
  -> append add event to events/2026-05.ndjson
  -> git add pointer and event shard
  -> git commit -m "booru: add image {id}"
  -> return JSON { id }
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
processEventsNew
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
  .git/                 Git repository metadata
  .gitattributes        LFS filters for images/**/*.png, jpg, jpeg, gif, webp
  .gitignore            ignores /index/* except /index/.gitkeep
  .lfsconfig            lfs.url = http://localhost:8080 and fetchexclude = *
  events/               NDJSON metadata event shards
  images/               Git LFS pointer files
  index/                derived JSON index files
  event_cursor          replay cursor written by JsonFileIndexStore
```

`libraries/template` is the clone source used by `Init`. `libraries/new` contains a five-image sample library with `events/2026-05.ndjson`, pointer files, derived indexes, and `event_cursor`. `libraries/inspiration` contains a separate local library with an image file.

## Scripts and Utilities

- `scripts/dump_types.ts` walks `src/`, creates a TypeScript program, and prints declarations for interfaces, type aliases, enums, classes, and functions. The type dump is inspection output, not a generated repository artifact.
- `scripts/read_json_sync_bench.ts` creates or reuses `scripts/big.internal.json`; files matching `*.internal.*` are ignored by the root `.gitignore`.
- `src/test_InitWith5Images.ts` depends on a running LFS server at `localhost:8080` and at least five PNG files in `$HOME/example-images`.

## Implementation Constraints

- Server LFS connection details and library path are hardcoded.
- `handleIngest` appends only to `events/2026-05.ndjson`.
- `handleIngest` deduplicates and assigns IDs by reading `index/image_state.json` directly, not through `DerivedIndexStore`.
- The server uses `handleRootNew`, but ingest does not update the in-memory store after writing an event. A newly ingested image is reflected in derived reads only after event replay updates the index.
- `JsonFileIndexStore.getCursor()` does not read `event_cursor` from disk.
- `processEventsNew` reports `eventFiles: 0` because shard counting is delegated to `NdjsonEventLog.readEvents()` and not tracked.
- Gallery HTML is string-built and does not escape image names or tags.
- JSON index writes are serialized by a mutex, but image state, tag index, and cursor writes are not committed as a single filesystem transaction.
