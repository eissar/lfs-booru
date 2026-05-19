> Snapshot commit: HASH:4b90caa163a750ed3b9c26d72e2e0d9910fe109d

# Codebase Snapshot

## Purpose

This repository is a Deno-based booru prototype. It stores image bytes in a Git LFS server, stores Git LFS pointer files in per-library Git repositories, records image metadata as append-only NDJSON events, and serves gallery HTML from derived JSON indexes.

## Runtime Entry Points

- `server.ts` starts the HTTP server used by `deno task run`.
- `src/indexer.ts` exports the event replay function used by server startup. It has no `import.meta.main` CLI block.
- `src/test_InitWith5Images.ts` is an integration and timing script. It removes `libraries/new`, clones `libraries/template`, ingests five PNG files from `$HOME/example-images`, and prints setup, per-image, and aggregate timings.
- `scripts/dump_types.ts` prints the visible type, function, interface, class, and type-alias surface under `src/` using the TypeScript compiler API.
- `scripts/read_json_sync_bench.ts` creates `scripts/big.internal.json` if absent and benchmarks synchronous read and parse behavior for a large JSON index-shaped file.

## Configuration

`deno.json` defines one task:

```text
deno task run -> deno run --allow-all ./server.ts
```

Imports and aliases:

- `@/` maps to `./src/`.
- `@std/path@1.1.4`, `@std/streams`, and `@std/async@1.3.0` provide path, stream, and async utilities.
- `@core/asyncutil` provides the mutex used by the event log and JSON index store.
- `simple-git@3.36.0` provides clone, add, commit, and remote setup operations.

Formatter settings use 4-space indentation, single quotes, 120-column width, and exclude Markdown and JSON files.

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
src/event_log.ts                EventLog interfaces and NDJSON-backed append/read implementation
src/handlers.ts                 HTTP handlers for gallery, ingest, and image proxying
src/index_store.ts              DerivedIndexStore interface and JSON-file implementation
src/indexer.ts                  Event application and replay orchestration
src/lfs/api.ts                  Thin Git LFS HTTP client
src/lfs/openapi.json            Git LFS server OpenAPI reference material
src/git.ts                      Library initialization from libraries/template
src/library.ts                  LibraryConnection type
src/logging.ts                  Debug logging helper and Error inspect customization
src/util.ts                     panic helper and response helper object
src/test_InitWith5Images.ts     Five-image ingestion measurement script
scripts/dump_types.ts           Source type-surface dump utility
scripts/read_json_sync_bench.ts JSON index-shaped benchmark utility
```

## Key Modules

### HTTP server (`server.ts`)

Startup constructs:

- `JsonFileIndexStore` for the hardcoded library path.
- `NdjsonEventLog` for the same library path.
- A hardcoded Git LFS `Connection` for `http://localhost:8080`.

`JsonFileIndexStore` reads `index/next_image_id` synchronously during construction. After construction, `store.isInitialized()` checks for `index/image_state.json`, `index/tag_index.json`, and `index/next_image_id`. If that check returns false, startup calls `processEvents(store, eventLog)` before serving.

Routes:

| Pattern | Method | Behavior |
|---|---:|---|
| `/image/:oid` | any | `handleImage(req, conn)` proxies raw object content from the LFS server. |
| `/` | any | `handleRoot(store)` renders gallery HTML from `DerivedIndexStore.listImages()`. |
| `/ingest` | POST | `handleIngest(req, store, eventLog, lib, conn)` ingests multipart image uploads. |
| other paths | any | Returns 404 text. |

### Event log (`src/event_log.ts`)

`EventLog` exposes append-only writes and `appendWithRollback`. `EventLogReader` exposes replay reads without adding read methods to the append-focused interface. `NdjsonEventLog` implements both interfaces for library-local `events/*.ndjson` files.

- `append(event)` writes one JSON line to `events/<yyyy-mm>.ndjson`, creating the directory when needed, and returns the changed relative path plus the cursor after the appended line.
- `appendWithRollback(event, fn)` appends an event, runs the callback while holding the event-log mutex, and truncates the shard back to the previous offset if the callback fails and no later append changed the file size.
- `readEvents(cursor?)` scans `.ndjson` shards under `events/`, sorts names, seeks to the supplied cursor in the matching shard, parses each line as an `Event`, and yields `{ event, cursor }` pairs.

`ReplayableEventLog` declares a `replayFrom` method, but `NdjsonEventLog` does not implement that interface.

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

### Handlers (`src/handlers.ts`)

- `handleRoot(store)` renders a simple HTML gallery from `store.listImages()`.
- `handleIngest(req, store, eventLog, lib, conn)` accepts multipart form data with an `image` file field, computes a SHA-256 OID, parses optional metadata fields, reserves an ID through `store.allocateImageId()`, builds an `add` event, and delegates to `internalIngest`.
- `internalIngest(bytes, lib, eventLog, conn, event, size)` registers metadata with the LFS server, uploads bytes, writes a Git LFS pointer file, appends the event with rollback protection, then runs `git add` and `git commit` inside the library repository.
- `handleImage(req, conn)` extracts the OID from `/image/:oid` and returns `GetObjectContent(conn, oid)`.

The ingest path allows duplicate OIDs. Content is content-addressed in LFS, while image records use sequential numeric IDs.

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

### Git initialization (`src/git.ts`)

`Init(repoPath)` resolves `libraries/template`, clones it with `GIT_LFS_SKIP_SMUDGE=1`, appends an `[lfs] skipSmudge = true` section to the cloned repository's `.git/config`, and adds an `upstream` remote pointing at `https://github.com/USER/REPO.git`. It returns `null` on success or the clone error on failure. It panics if the template path cannot be resolved.

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
  -> append add event to events/{yyyy-mm}.ndjson with rollback around git operations
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
  .gitignore             ignores /index/* except /index/.gitkeep
  .lfsconfig             lfs.url = http://localhost:8080 and fetchexclude = *
  events/                NDJSON metadata event shards
  images/                Git LFS pointer files
  index/                 derived JSON index files and next_image_id
  event_cursor           replay cursor written by JsonFileIndexStore
```

`libraries/template` is the clone source used by `Init`. It includes `.gitattributes`, `.gitignore`, `.lfsconfig`, and `.gitkeep` placeholders under `events/`, `images/`, and `index/`. `libraries/new` contains a sample library with `events/2026-05.ndjson`, pointer files, derived indexes, and `event_cursor`.

## Scripts and Utilities

- `scripts/dump_types.ts` walks `src/`, creates a TypeScript program, and prints declarations for interfaces, type aliases, enums, classes, and functions. The type dump is inspection output, not a generated repository artifact.
- `scripts/read_json_sync_bench.ts` creates or reuses `scripts/big.internal.json`; files matching `*.internal.*` are ignored by the root `.gitignore`.
- `src/test_InitWith5Images.ts` depends on a running LFS server at `localhost:8080` and at least five PNG files in `$HOME/example-images`.

## Implementation Constraints

- Server LFS connection details and library path are hardcoded.
- `JsonFileIndexStore` construction requires `index/next_image_id` to exist and contain a number.
- `store.isInitialized()` checks `index/next_image_id`, but server startup constructs the store before running that check.
- `handleIngest` reserves an ID before LFS upload, pointer write, event append, and Git commit. Failed ingest attempts can consume IDs.
- Ingest uploads LFS content before local pointer/event persistence and Git commit.
- Event append rollback covers the NDJSON append when Git add or commit fails; it does not remove the pointer file or LFS object.
- `JsonFileIndexStore.getCursor()` does not read `event_cursor` from disk.
- `processEvents` reports `eventFiles: 0`.
- Gallery HTML is string-built and does not escape image names or tags.
- JSON index writes are serialized within one store instance, but image state, tag index, and cursor writes are not committed as a single filesystem transaction.
- Mutexes are process-local and do not protect against other processes modifying the same library files.
