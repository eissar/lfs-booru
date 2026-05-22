> Snapshot commit: HASH:95496183dcd3ba4b319702e4600536e09cd776bd

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
        "@std/cli": "jsr:@std/cli@1.0.29",
        "@std/dotenv": "jsr:@std/dotenv@0.225.6",
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

CLI flags and environment variables configure runtime settings:

| Flag | Env var | Default |
|---|---|---|
| `--lfsserver` | `BOORU_LFS_SERVER` | `http://localhost:8080` |
| `--lfsauth` | `BOORU_LFS_AUTH` | `Basic ${btoa('user:pass')}` |
| `--port` | `BOORU_PORT` | `8000` |
| `--lib` | `BOORU_LIBRARY` | `$XDG_DOCUMENTS_DIR/Libraries/Default` |

The `.env` file and `$XDG_CONFIG_HOME` are loaded for environment variables via `@std/dotenv`.

## Source Structure

```
server.ts                          HTTP server setup and route dispatch (handlers inline)
src/
  cli.ts                           CLI flag parsing with env fallback and XDG paths
  event_log.ts                     EventLog interfaces and NDJSON append/read implementation
  git.ts                           Library initialization and add/commit helpers
  html.ts                          Tagged template helper for HTML string construction
  indexer.ts                       Event replay orchestration and event/index types
  index_store.ts                   DerivedIndexStore interface and JSON-file implementation
  ingest.ts                        Multipart ingest parsing, hashing, LFS upload, and pointer writing
  library.ts                       LibraryConnection type alias
  lfs/
    api.ts                         Thin Git LFS HTTP client (metadata, content, and HEAD helpers)
    openapi.json                   Git LFS server OpenAPI reference material
  logging.ts                       Debug logging helper and Error inspect customization
  pointer.ts                       Git LFS pointer-file writer
  renderer.ts                      HtmlRenderer interface with file-backed caching gallery page cache
  util.ts                          Panic helper and HTTP response utility object
  template/
    index.ts                       Exports template functions for gallery and image-card
    gallery.ts                     Full gallery page HTML template (escaped)
    image-card.ts                  Image card fragment HTML template (escaped)
static/
  gallery.css                      Gallery stylesheet served under `/static` for gallery pages
scripts/
  dump_types.ts                    Source type-surface dump utility
  read_json_sync_bench.ts          JSON index-shaped benchmark utility
```

## Key Modules

### HTTP server (`server.ts`)

Startup constructs `JsonFileIndexStore`, `NdjsonEventLog`, `CachingHtmlRenderer`, parses CLI flags, loads LFS connection details, and checks `store.isInitialized()`. If index artifacts are missing, it calls `initializeEmptyIndex()` then `processEvents(store, eventLog)` before serving. Routes:

| Pattern | Method | Behavior |
|---|---:|---|
| `/` | any | Redirects to `/gallery` (302) |
| `/gallery` | any | Renders gallery HTML via `HtmlRenderer` with optional `?tags=` filter |
| `/ingest` | POST | Parses multipart form, writes to LFS, appends event, commits, updates index |
| `/image/:oid` | any | Proxies raw object content from the LFS server |
| `/static/*` | any | Serves files from `./static` through `serveDir` |
| other paths | any | Returns 404 text |

Gallery tag filtering reads `tag_index.json` synchronously from disk, resolves matching image IDs, and passes them to `listImagesByIds`.

The `CachingHtmlRenderer` is wired into the handler. Image cards are rendered through `renderImageCard` (per-image, uncached), and the gallery page is rendered and cached through `renderGalleryPage`.

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

  Construction reads `index/next_image_id` synchronously during `allocateImageId` (the constructor does not read it). Writes use a temporary file plus `Deno.rename`. `applyEvent` loads both index files, applies the event reducer, writes image state and tag index, writes the cursor, and updates the in-memory cursor cache.
  `getCursor()` returns only the in-memory cache. It does not load `event_cursor` from disk. `allocateImageId()` increments the file and in-memory sequence under a dedicated mutex.

### Indexer (`src/indexer.ts`)

`processEvents(store, eventLog)` requires `eventLog instanceof NdjsonEventLog`. It replays events through `NdjsonEventLog.readEvents(store.getCursor())`, persists each event through `store.applyEvent`, prints aggregate counts, and returns `IndexResult`. Supported event operations: `add`, `tag_add`, `tag_remove`, `delete`.

### Server handler and ingest flow (`server.ts`, `src/ingest.ts`)

- `ingest(lib, conn, store, file, tags, name?)` computes SHA-256 OID, reserves ID via `store.allocateImageId()`, uploads metadata and content to LFS, writes pointer file at `images/{id}.png`, and returns an `add` event.
- The server's ingest handler parses multipart form inline, calls `ingest`, appends the event with rollback around `stageAndCommit`, applies the event to the derived index, and returns `ok` with status 201.
- Image proxying extracts OID from `/image/:oid` and returns `GetObjectContent(conn, oid)`.

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

`CachingHtmlRenderer` implements `HtmlRenderer`. It escapes HTML via `@std/html/entities`, renders image cards via `templates.ImageCard`, and caches gallery pages under `index/artifacts/gallery-pages` by SHA-1 content hash of version, title, and card fragments. The server handler uses this renderer for all gallery requests.

### Templates (`src/template/`)

- `gallery.ts`: exports a `gallery(title, cards, version)` function that produces an escaped HTML document with masonry layout classes and a `data-renderer-version` attribute.
- `image-card.ts`: exports an `imageCard(image, tags)` function that produces an image card fragment with a linked thumbnail (`/image/{oid}`), escaped name, dimensions, and tag links pointing to `/gallery?tags=...`.

## Core Flows

### Server startup

```
server.ts
  -> getFlags() parses CLI flags and env vars
  -> create JsonFileIndexStore(lib)
  -> create NdjsonEventLog(lib.path)
  -> create CachingHtmlRenderer(lib.path)
  -> store.isInitialized() — checks index/image_state.json, tag_index.json, next_image_id
  -> if incomplete: initializeEmptyIndex() then processEvents(store, eventLog)
  -> Deno.serve({ port }, createHandler(store, eventLog, conn, lib, render))
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
GET / or GET /gallery
  -> optional ?tags= filter reads tag_index.json, resolves matching IDs
  -> store.listImages() or store.listImagesByIds(ids)
  -> render.renderImageCard() for each image
  -> render.renderGalleryPage() — cached by content hash
  -> return HTML

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

`libraries/template` is the clone source with `.gitattributes`, `.gitignore`, `.lfsconfig`, `index/next_image_id`, and `.gitkeep` files. The `libraries/` directory is gitignored in the booru project.

## Scripts and Utilities

- `scripts/dump_types.ts` walks `src/`, creates a TypeScript program, and prints declarations for interfaces, type aliases, classes, and function signatures.
- `scripts/read_json_sync_bench.ts` creates or reuses `scripts/big.internal.json` for benchmarking synchronous JSON reads. Files matching `*.internal.*` are gitignored.
- `src/test_InitWith5Images.ts` measures end-to-end ingest timing for 5 PNG images against a running LFS server. It creates a fresh library via `Init`, computes OIDs and PNG dimensions, uploads to LFS, writes pointers, appends events with Git commit, and prints per-image and aggregate timings.

## Implementation Constraints

- JSON index writes (image state, tag index, cursor) are not committed as a single filesystem transaction.
- `JsonFileIndexStore.getCursor()` does not load `event_cursor` from disk. A fresh store instance has a null cursor until `applyEvent` or `saveCursor` runs.
- The ingest handler performs LFS upload and pointer-file write before checking for a non-null in-memory cursor.
- The ingest handler reserves an ID before LFS upload and Git operations. Failed ingest attempts can consume IDs.
- Event append rollback covers the NDJSON append when Git operations fail. It does not remove the pointer file, LFS object, or staged Git index state.
- If derived-index application fails after Git commit, source files are committed but served indexes can be stale.
- Mutexes are process-local and do not protect against other processes modifying the same library files.
- The gallery page reads `tag_index.json` synchronously from disk for each request with tag filters, outside the store mutex.
- Image IDs are numeric values stored as string keys in `image_state.json`.
- The server calls `getCursor()` for the in-memory cursor check before event append during ingest, which can fail on a fresh store instance even when indexes exist.

## Planned Work

### Backlog

- **Event log compaction / log minification** — Prune deleted-image events and consolidate the NDJSON event log so replay is faster and deleted images are removed from storage. Needs a compaction marker scheme or a log rewrite pass. Not yet scoped or scheduled.