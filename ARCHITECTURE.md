# Architecture

## System Overview

The booru prototype is an event-sourced image gallery built around three persistent concerns:

- **Git LFS** stores immutable image bytes by SHA-256 OID.
- **Library Git repositories** store Git LFS pointer files and append-only NDJSON metadata events.
- **Derived JSON indexes** materialize the gallery state used by HTTP reads.

The HTTP server combines these concerns for a local prototype. Ingest uploads image bytes to the LFS server, writes repository files, appends an event, commits pointer and event changes, then applies the event to the derived JSON indexes. Reads render gallery HTML from the derived image-state index using HTMX lazy-loaded fragments and proxy image bytes from the LFS server by OID.

## Architectural Goals Implied by the Code

The implementation favors a Git-native, rebuildable data model over a mutable database service:

- Metadata history is append-only NDJSON.
- Derived indexes are JSON files produced by replay or by applying committed ingest events.
- Image content is content-addressed outside the repository through Git LFS.
- Library repositories remain ordinary Git repositories with `.gitattributes`, `.lfsconfig`, committed pointer files, and committed event shards.
- Runtime boundaries are simple TypeScript interfaces: `EventLog`, `EventLogReader`, `DerivedIndexStore`, `HtmlRenderer`, `LfsConnection`, and `LibraryConnection`.
- Server startup detects missing derived artifacts and rebuilds them from scratch, implying that the event log is the authoritative metadata source.

The code keeps most policies close to the operations they affect. Request handlers validate input, check LFS responses, write files, and convert recoverable request failures into HTTP responses. Replay treats malformed events and filesystem failures as fatal to the replay operation.

## Source of Truth

The authoritative metadata model is the event log under `events/`. Events support `add`, `tag_add`, `tag_remove`, and `delete` operations. Replaying those events produces two materialized views:

- `image_state.json`: image ID to image metadata.
- `tag_index.json`: tag to image ID list.

Image bytes are authoritative in the Git LFS object store. The repository stores pointer files that identify the LFS objects, not hydrated image content.

`event_cursor` is replay bookkeeping. It records the last processed event position but is not a source of truth — the JSON store loads it from disk when the in-memory cache is empty, and replay correctness depends on the event log, not the cursor.

`index/next_image_id` is a write-path allocation file for monotonically increasing, non-contiguous image IDs. It is initialized during `initializeEmptyIndex` and advanced before an ingest event is committed. `processEvents` reconciles `next_image_id` from committed add-event IDs via `applyEvent`, so ID allocation depends on both mutable local state and committed event IDs. Gaps from failed or abandoned ingest attempts are expected and are not a correctness problem.

## Git and Git LFS Responsibilities

Git is used for small-file history and library structure:

- pointer files under `images/`
- NDJSON event shards under `events/`
- repository configuration and placeholders

Git LFS is used for image bytes:

- `ingest` computes a SHA-256 OID from uploaded bytes.
- `PutObjectMeta` registers object metadata.
- `PutObjectContent` uploads bytes.
- `GetObjectContent` retrieves bytes for image serving.

The library `.gitattributes` routes image extensions through LFS filters. `.lfsconfig` points at the configured LFS server URL and sets `fetchexclude = *` so LFS objects are never fetched into the working tree. `Init` clones the template with `GIT_LFS_SKIP_SMUDGE=1`, appends local skip-smudge config, and adds a sample upstream remote.

## Component Boundaries

### HTTP boundary

`server.ts` owns process startup, CLI flag parsing, route dispatch, static-file serving, and the initial index rebuild check. It constructs the store, event log, and renderer and passes them into `createHandler`.

Route dispatch is split into two paths:

- `handleUiRoutes` handles gallery page and HTMX fragment routes (`/gallery`, `/fragment/items`). It uses `DerivedIndexStore.listItems()` for tag-filtered queries and `HtmlRenderer` for HTML rendering.
- The main handler closure handles ingest, image proxying, static files, root redirect, and 404 fallback.

The HTTP boundary returns raw `Response` objects. It does not use a framework router or domain-specific result wrapper.

### Ingest boundary

`src/ingest.ts` performs the non-Git preparation work for an add event:

1. Read bytes from a `File` object.
2. Hash bytes to a SHA-256 OID.
3. Reserve a numeric image ID from the store.
4. Upload metadata and content to LFS.
5. Write the Git LFS pointer file.
6. Return the `add` event that describes the image.

The server's ingest handler then takes responsibility for source persistence and serving-state update. It serializes write-side Git/event/index work, appends the event with rollback protection around `stageAndCommit`, and applies the same event to the JSON indexes after Git commit succeeds.

LFS upload failures propagate via `cause: Response` and are caught at the handler level to return HTTP 502 or 400 as appropriate.

### Event-log boundary

`EventLog` is append-oriented. `EventLogReader` is separate so append consumers do not need file-reading semantics. `NdjsonEventLog` is the file-backed implementation and encodes shard selection, cursor seeking, line decoding, JSON parsing, and rollback-safe append behavior.

`appendWithRollback` is the event-log consistency boundary for ingest. It keeps the event-log mutex held until the protected Git operations complete. If the protected operation fails, it truncates the shard only when the file still ends at the appended event's cursor.

Replay uses `readEvents`, but `processEvents` still checks for the concrete `NdjsonEventLog` class. The public interface has not fully separated replay from the file-backed implementation.

### Derived-index boundary

`DerivedIndexStore` is the storage contract for replay, gallery reads, ID allocation, and post-ingest materialization. `JsonFileIndexStore` implements the contract with JSON files and process-local mutexes.

Replay calls `store.applyEvent` instead of writing files itself. `applyEvent` also reconciles `next_image_id` from committed add-event IDs, ensuring replay produces a consistent monotonic write-path allocator. Gallery rendering calls `store.listItems` with optional tag filtering. Ingest calls `store.allocateImageId`, then later calls `store.applyEvent` after the event has been appended and committed.

The store falls back to loading `event_cursor` from disk when the in-memory cursor cache is null. This means a fresh store instance reads the persisted cursor on first access, unlike the earlier design where the cursor was always null after construction.

### LFS boundary

`src/lfs/api.ts` is a thin fetch wrapper. It constructs URLs from `LfsConnection`, sets Git LFS media-type and authorization headers, and returns raw `Response` objects. It does not centralize retries, response parsing, or rollback policy.

### Git boundary

Git operations are localized to `Init` and `stageAndCommit`. `Init` handles clone and setup. `stageAndCommit` stages selected paths and creates a commit in the library repository. The server handler chooses the staged paths and commit message.

### Rendering boundary

There are two rendering layers:

- `CachingHtmlRenderer` implements `HtmlRenderer`. It renders individual item cards (uncached), inspector fragments (uncached), gallery pages (cached by content hash under `index/artifacts/gallery-pages`), and photo grid fragments (uncached).
- Template functions in `src/template/` (`gallery.ts`, `item-card.ts`, `inspector_fragment.ts`, `photo-grid_fragment.ts`) produce escaped HTML strings.

The server handler uses the renderer for all gallery and inspector fragment requests. Item cards include tag links pointing to `/gallery?tags=...` for filtered navigation and HTMX attributes that load `/fragment/inspect/{oid}` into the inspector panel. The gallery page renders an HTMX shell that lazy-loads items from `/fragment/items`.

## Data Flow

### Startup flow

```
server process
  -> parse CLI flags and env vars (cli.ts)
  -> construct JsonFileIndexStore
  -> construct NdjsonEventLog
  -> construct CachingHtmlRenderer
  -> check derived-index files via isInitialized()
  -> if incomplete: initializeEmptyIndex() then replay events via processEvents()
  -> serve HTTP requests on configured port
```

The startup rebuild check happens after constructing the JSON store. `isInitialized()` checks for `index/next_image_id` (validates its content as an integer >= 1), `index/image_state.json`, and `index/tag_index.json`.

### Ingest flow

```
client multipart POST /ingest
  -> request boundary validates image field and tags JSON
  -> content boundary computes SHA-256 OID
  -> derived-index boundary reserves next numeric ID
  -> LFS boundary registers metadata and uploads bytes
  -> filesystem writes pointer file
  -> event-log boundary appends add event with rollback protection
  -> Git boundary stages and commits pointer plus event shard
  -> derived-index boundary applies the committed event
  -> HTTP response returns text `ok`
```

This path is synchronous. The client waits for LFS, filesystem, Git, and JSON-index work before receiving a success response. ID allocation, LFS upload, and pointer writing happen before the event append and Git commit.

### Image-serving and gallery flow

```
gallery request (GET /gallery)
  -> renders gallery HTML shell with HTMX loader
  -> client-side HTMX requests GET /fragment/items (with optional ?tags= and ?limit=)
  -> store.listItems() loads full image state, filters by tag intersection
  -> CachingHtmlRenderer.renderImageCard() for each image (uncached)
  -> CachingHtmlRenderer.renderPhotoGrid() wraps cards in masonry fragment
  -> HTMX swaps the initial loading indicator with the photo grid

inspector request (GET /fragment/inspect/{oid})
  -> store.getIdByOid() maps OID to image ID
  -> store.listImagesByIds() loads the image state
  -> CachingHtmlRenderer.renderInspector() renders metadata fragment
  -> HTMX swaps #inspector-content

image request (GET /image/{oid})
  -> route extracts OID
  -> LFS client fetches object content
  -> upstream response is returned
```

The booru does not maintain a blob cache. Image bytes are fetched from the LFS server for each image request.

### Replay flow

```
startup replay
  -> choose JSON store and NDJSON event log
  -> read cursor from store (in-memory cache or from event_cursor file on disk)
  -> read sorted NDJSON shards from events/
  -> parse event lines
  -> apply each event to image and tag state
  -> write image_state.json, tag_index.json, and event_cursor
  -> reconcile next_image_id from committed add-event IDs
```

The event reducer mutates in-memory image and tag records. File persistence and cursor advancement belong to the store.

## Persistence Model

A library repository contains canonical small-file history and derived local state:

```
events/*.ndjson        canonical metadata events
images/*               Git LFS pointer files
index/next_image_id    local monotonic write-path ID allocator
index/image_state.json derived image state
index/tag_index.json   derived tag index
index/artifacts/*      cached rendered HTML artifacts (gallery pages)
event_cursor           replay checkpoint
```

The `index/` directory is ignored by the library repository except for `.gitkeep`, reflecting its role as local derived state. Event shards and pointer files are committed by ingest. `event_cursor` is ignored by the library repository and written beside the index files as replay bookkeeping.

JSON index writes use a temp-file-and-rename pattern per file. The store writes image state, tag index, and cursor in sequence, so the group of files is not atomic as a unit.

## Invariants and Assumptions

- Event replay order is shard-name sort order, then line order within each shard.
- Image IDs are strings in derived indexes, even when ingest events carry numeric IDs.
- `add` events carry the full image state needed to materialize the image index.
- Tag indexes are derived from image state and tag events; they are not canonical.
- OIDs are SHA-256 hashes of uploaded bytes.
- Pointer file content is derived from OID and byte size using the Git LFS pointer format.
- The ingest path uses monotonically increasing numeric IDs from `index/next_image_id`; IDs are intentionally allowed to be non-contiguous.
- Startup requires `index/next_image_id` to exist with a valid integer >= 1 for `isInitialized()` to return true.
- `listItems` loads the entire image state into memory; tag intersection is applied in-memory after loading.
- The gallery page shell is cached by SHA-1 content hash of renderer version and gallery input.
- `applyEvent` reconciles `next_image_id` from committed add-event IDs, ensuring replay produces a correct monotonic write-path allocator.
- `getCursor()` returns the persisted cursor from disk when the in-memory cache is empty.

## Trust, Error, and Failure Boundaries

### Request input

The server handler validates that the multipart request includes an `image` file and that `tags` parses as a JSON array of strings. Other metadata fields are accepted as strings or parsed integers with fallback values. Template functions escape names and tags via `@std/html/entities`.

### LFS server

The LFS client returns fetch responses directly. `ingest` checks `ok` for metadata registration and content upload before writing the pointer file, using `cause: Response` to propagate LFS error details. The server returns the upstream content response without additional validation.

### Filesystem and event parsing

Event replay parses each NDJSON line as JSON and lets unexpected parse or filesystem errors fail the replay. Missing `events/` is treated as an empty event set by `NdjsonEventLog.readEvents`.

### Derived index consistency

Mutexes serialize JSON-store operations within one process and one store instance. They do not provide cross-process locking. A crash or external mutation between writing `image_state.json`, `tag_index.json`, and `event_cursor` can leave the derived files inconsistent. Because metadata truth is the event log, safe recovery is to rebuild derived files from events.

`index/next_image_id` is reconciled by `applyEvent` during replay, so losing the sequence file can be recovered by rewriting from committed add-event IDs.

If `store.applyEvent` fails after a successful Git commit in the ingest handler, the event and pointer can be committed while the served JSON indexes remain stale.

### Cursor semantics

`JsonFileIndexStore.getCursor()` returns the in-memory cache when non-null, otherwise falls back to reading `event_cursor` from disk. After `initializeEmptyIndex()` removes the cursor file, `getCursor()` returns null, which signals `readEvents` to start from the beginning. Once events are applied, the cursor is persisted and becomes available on next process start.

### Git operations

Git add and commit errors are converted into text HTTP errors inside the server handler. The LFS upload and pointer write happen before these Git operations. Event append rollback can remove the appended event line after Git failure, but it does not remove uploaded LFS objects, remove the pointer file, or reset any staged Git index state.

### Gallery page caching

`CachingHtmlRenderer.renderGalleryPage` uses SHA-1 content hashing for cache identity and stores rendered pages on disk. Cache identity includes renderer version and gallery input. Cache misses render and persist; cache hits return the stored HTML.

## Design Tradeoffs

### Event log over mutable records

Append-only events make metadata history auditable and derived indexes rebuildable. The tradeoff is that read-serving state depends on replay correctness and index freshness.

### JSON files over a database

JSON indexes are easy to inspect and require no service dependency. They also require whole-file read/modify/write cycles and coarse in-process locking, which limits write concurrency and large-index performance. `listItems` loads the full image state into memory for tag intersection filtering, which does not scale.

### HTMX-driven gallery UI

The gallery uses HTMX for lazy-loaded fragment replacement rather than server-rendered full pages. This enables a responsive masonry grid and inspector-panel updates but means the initial page load makes a second request for items. Tag filtering loads and filters image state on the server and sends rendered HTML fragments, which keeps the client simple while tying interaction state to server-rendered fragments.

### Synchronous Git commit in ingest

Committing during the request path keeps repository history aligned with acknowledged ingests. It also couples request latency and availability to Git process execution and repository state.

### Content-addressed blobs with monotonic image IDs

LFS OIDs provide immutable content addressing. Monotonically increasing image IDs provide short booru-style storage keys and display identifiers. IDs are not required to be contiguous; gaps from failed or abandoned ingest attempts are expected. The cost is that ID allocation depends on a mutable local allocation file.

### Thin LFS client

Returning raw `Response` objects keeps the LFS boundary simple and transparent. Callers must inspect status codes and content themselves, and higher-level retry or rollback policy is not centralized.

### Template-based rendering with caching

The `CachingHtmlRenderer` uses SHA-1 content hashing for cache identity and stores rendered pages on disk. Item card, inspector, and photo grid fragments are not cached at the page level. Gallery page caches are invalidated by version bump or by clearing the artifacts directory.

### Inline handlers over separate module

Handler logic lives inside `server.ts` rather than a separate `handlers.ts` file. This keeps route dispatch, validation, and persistence sequencing in one place but bundles all request logic into the startup module. `handleUiRoutes` provides partial separation for gallery and fragment routes.

### Partial abstraction adoption

The code contains `EventLog`, `EventLogReader`, and `DerivedIndexStore` boundaries, but replay still checks for `NdjsonEventLog`, meaning alternate event log backends cannot be substituted for replay without changing `processEvents`. Safe changes need to account for these seams until the abstractions cover read and write paths consistently.
