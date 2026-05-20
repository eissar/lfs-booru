# Architecture

## System Overview

The booru prototype is an event-sourced image gallery built around three persistent concerns:

- Git LFS stores immutable image bytes by SHA-256 OID.
- A library Git repository stores Git LFS pointer files and append-only NDJSON metadata events.
- Derived JSON indexes materialize the gallery state used by HTTP reads.

The HTTP server combines these concerns for a local prototype. Ingest uploads image bytes to the LFS server, writes repository files, appends an event, commits pointer/event changes, then applies the event to the derived JSON indexes. Reads render gallery HTML from the derived image-state index and proxy image bytes from the LFS server by OID.

## Architectural Goals Implied by the Code

The implementation favors a Git-native, rebuildable data model over a mutable database service:

- Metadata history is append-only NDJSON.
- Derived indexes are JSON files produced by replay or by applying committed ingest events.
- Image content is content-addressed outside the repository through Git LFS.
- Library repositories remain ordinary Git repositories with `.gitattributes`, `.lfsconfig`, committed pointer files, and committed event shards.
- Runtime boundaries are simple TypeScript interfaces: `EventLog`, `EventLogReader`, `DerivedIndexStore`, `LfsConnection`, and `LibraryConnection`.

The code keeps most policies close to the operations they affect. Request handlers validate input, check LFS responses, write files, and convert recoverable request failures into HTTP responses. Replay treats malformed events and filesystem failures as fatal to the replay operation.

## Source of Truth

The authoritative metadata model is the event log under `events/`. Events support `add`, `tag_add`, `tag_remove`, and `delete` operations. Replaying those events produces two materialized views:

- `image_state.json`: image ID to image metadata.
- `tag_index.json`: tag to image ID list.

Image bytes are authoritative in the Git LFS object store. The repository stores pointer files that identify the LFS objects, not hydrated image content.

`event_cursor` is replay bookkeeping. It records the last processed event position after the store applies an event or saves a cursor, but the JSON store does not load it on construction. The durable metadata source remains the event log.

`index/next_image_id` is a write-path sequence file. It is initialized from the library template and advanced before an ingest event is committed. It is not rebuilt by `processEvents`, so ID allocation depends on mutable local state as well as committed add-event IDs.

## Git and Git LFS Responsibilities

Git is used for small-file history and library structure:

- pointer files under `images/`
- NDJSON event shards under `events/`
- repository configuration and placeholders

Git LFS is used for image bytes:

- `ingestFile` computes a SHA-256 OID from uploaded bytes.
- `PutObjectMeta` registers object metadata.
- `PutObjectContent` uploads bytes.
- `handleImage` retrieves bytes with `GetObjectContent`.

The library `.gitattributes` routes image extensions through LFS filters. `.lfsconfig` points at `http://localhost:8080` and excludes automatic fetches. `Init` clones the template with smudge skipped, appends local skip-smudge config, and adds a sample upstream remote.

## Component Boundaries

### HTTP boundary

`server.ts` owns process startup, hardcoded runtime configuration, route selection, static-file serving, and the initial index rebuild check. It constructs the store and event log and passes them into handlers.

`src/handlers.ts` owns request-specific behavior:

- Gallery rendering from `DerivedIndexStore`.
- Multipart ingest orchestration.
- Event append and Git commit sequencing.
- Derived-index update after a committed ingest.
- Image proxying to the LFS server.

The HTTP boundary returns raw `Response` objects. It does not use a framework router or domain-specific result wrapper.

### Ingest boundary

`src/ingest.ts` performs the non-Git preparation work for an add event:

1. Parse multipart form data.
2. Require an `image` file field.
3. Hash bytes to a SHA-256 OID.
4. Parse tags from JSON.
5. Reserve a numeric image ID.
6. Upload metadata and content to LFS.
7. Write the Git LFS pointer file.
8. Return the `add` event that describes the image.

`handleIngest` then takes responsibility for source persistence and serving-state update. It serializes write-side Git/event/index work with a module-level mutex, appends the event with rollback protection around `stageAndCommit`, and applies the same event to the JSON indexes after Git commit succeeds.

### Event-log boundary

`EventLog` is append-oriented. `EventLogReader` is separate so append consumers do not need file-reading semantics. `NdjsonEventLog` is the file-backed implementation and encodes shard selection, cursor seeking, line decoding, JSON parsing, and rollback-safe append behavior.

`appendWithRollback` is the event-log consistency boundary for ingest. It keeps the event-log mutex held until the protected Git operations complete. If the protected operation fails, it truncates the shard only when the file still ends at the appended event's cursor.

Replay uses `readEvents`, but `processEvents` still checks for the concrete `NdjsonEventLog` class. The public interface has not fully separated replay from the file-backed implementation.

### Derived-index boundary

`DerivedIndexStore` is the storage contract for replay, gallery reads, ID allocation, and post-ingest materialization. `JsonFileIndexStore` implements the contract with JSON files and process-local mutexes.

Replay calls `store.applyEvent` instead of writing files itself. Gallery rendering calls `store.listImages`. Ingest calls `store.allocateImageId`, then later calls `store.applyEvent` after the event has been appended and committed.

The store keeps the cursor in memory once written. A new store instance does not populate `cursorCache` from `event_cursor`, so persisted cursor state is not a startup source of truth in the implemented code.

### LFS boundary

`src/lfs/api.ts` is a thin fetch wrapper. It constructs URLs from `LfsConnection`, sets Git LFS media-type and authorization headers, and returns raw `Response` objects. It does not centralize retries, response parsing, or rollback policy.

### Git boundary

Git operations are localized to `Init` and `stageAndCommit`. `Init` handles clone/setup. `stageAndCommit` stages selected paths and creates a commit in the library repository. `handleIngest` chooses the staged paths and commit message.

### Rendering boundary

There are two rendering paths in the source tree:

- `handleRoot` builds inline HTML directly in the request handler.
- `CachingHtmlRenderer` escapes image data and caches rendered gallery pages below `index/artifacts/gallery-pages`.

The request path uses the inline renderer. The cached renderer is a separate module-level boundary that is not connected to server routing.

## Data Flow

### Startup flow

```text
server process
  -> construct JsonFileIndexStore
  -> read index/next_image_id synchronously
  -> construct NdjsonEventLog
  -> check derived-index files
  -> replay events only when required files are missing
  -> serve HTTP requests
```

The startup rebuild check happens after constructing the JSON store. This means `index/next_image_id` is a fatal precondition for startup even though `isInitialized()` also checks for it.

### Ingest flow

```text
client multipart POST /ingest
  -> request boundary validates image field and tags JSON
  -> content boundary computes SHA-256 OID
  -> derived-index boundary reserves next numeric ID
  -> LFS boundary registers metadata and uploads bytes
  -> filesystem writes pointer file
  -> handler requires an in-memory derived-index cursor
  -> event-log boundary appends add event with rollback protection
  -> Git boundary stages and commits pointer plus event shard
  -> derived-index boundary applies the committed event
  -> HTTP response returns text `ok`
```

This path is synchronous. The client waits for LFS, filesystem, Git, and JSON-index work before receiving a success response. ID allocation, LFS upload, and pointer writing happen before the event append and Git commit.

### Image-serving flow

```text
gallery request
  -> DerivedIndexStore.listImages()
  -> HTML includes /image/{oid}

image request
  -> route extracts OID
  -> LFS client fetches object content
  -> upstream response is returned
```

The booru does not maintain a blob cache. Image bytes are fetched from the LFS server for each image request.

### Replay flow

```text
startup replay
  -> choose JSON store and NDJSON event log
  -> read cursor from store memory
  -> read sorted NDJSON shards from events/
  -> parse event lines
  -> apply each event to image and tag state
  -> write image_state.json, tag_index.json, and event_cursor
```

The event reducer mutates in-memory image and tag records. File persistence and cursor advancement belong to the store.

## Persistence Model

A library repository contains canonical small-file history and derived local state:

```text
events/*.ndjson        canonical metadata events
images/*               Git LFS pointer files
index/next_image_id    local write-path ID sequence
index/image_state.json derived image state
index/tag_index.json   derived tag index
index/artifacts/*      cached rendered HTML artifacts
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
- The ingest path uses sequential numeric IDs from `index/next_image_id`.
- Startup requires the JSON store constructor to read `index/next_image_id` successfully.
- Startup treats missing derived index artifacts as a rebuild trigger after the store has been constructed.
- The hardcoded server configuration assumes an LFS server at `localhost:8080` and a local library at `libraries/new`.
- `handleIngest` assumes `store.getCursor()` returns a non-null cursor before event append. The JSON store does not satisfy that assumption after construction unless an event has been applied or a cursor has been saved in memory.

## Trust and Failure Boundaries

### Request input

`ingestFile` validates that the multipart request includes an `image` file and that `tags` parses as a JSON array of strings. Other metadata fields are accepted as strings or parsed integers with fallback values. `handleRoot` interpolates names and tags into HTML without escaping, so stored metadata is trusted by the inline renderer. `CachingHtmlRenderer` uses HTML escaping, but it is not used by the request handler.

### LFS server

The LFS client returns fetch responses directly. `ingestFile` checks `ok` for metadata registration and content upload before writing the pointer file. `handleImage` returns the upstream content response without additional validation.

### Filesystem and event parsing

Event replay parses each NDJSON line as JSON and lets unexpected parse or filesystem errors fail the replay. Missing `events/` is treated as an empty event set by `NdjsonEventLog.readEvents`.

### Derived index consistency

Mutexes serialize JSON-store operations within one process and one store instance. They do not provide cross-process locking. A crash or external mutation between writing `image_state.json`, `tag_index.json`, and `event_cursor` can leave the derived files inconsistent. Because metadata truth is the event log, safe recovery is to rebuild derived files from events.

`index/next_image_id` is not rebuilt by `processEvents`. Losing or corrupting that file affects write-path safety even when the event log remains intact.

If `store.applyEvent` fails after a successful Git commit in `handleIngest`, the event and pointer can be committed while the served JSON indexes remain stale.

### Cursor semantics

`JsonFileIndexStore` keeps the cursor in memory after a save or event application, but `getCursor()` does not load `event_cursor` from disk. A fresh store instance therefore starts with a null cursor. This makes the persisted cursor less authoritative than its file layout suggests and creates an ingest precondition that is not guaranteed by startup when indexes already exist.

### Git operations

Git add and commit errors are converted into text HTTP errors inside `handleIngest`. The LFS upload and pointer write happen before these Git operations. Event append rollback can remove the appended event line after Git failure, but it does not remove uploaded LFS objects, remove the pointer file, or reset any staged Git index state.

## Design Tradeoffs

### Event log over mutable records

Append-only events make metadata history auditable and derived indexes rebuildable. The tradeoff is that read-serving state depends on replay correctness and index freshness.

### JSON files over a database

JSON indexes are easy to inspect and require no service dependency. They also require whole-file read/modify/write cycles and coarse in-process locking, which limits write concurrency and large-index performance.

### Synchronous Git commit in ingest

Committing during the request path keeps repository history aligned with acknowledged ingests. It also couples request latency and availability to Git process execution and repository state.

### Content-addressed blobs with sequential image IDs

LFS OIDs provide immutable content addressing. Sequential IDs provide short booru-style storage keys and display identifiers. The cost is that ID allocation depends on a mutable local sequence file, and failed ingest attempts can leave gaps.

### Thin LFS client

Returning raw `Response` objects keeps the LFS boundary simple and transparent. Callers must inspect status codes and content themselves, and higher-level retry or rollback policy is not centralized.

### Partial abstraction adoption

The code contains `EventLog`, `EventLogReader`, and `DerivedIndexStore` boundaries, but replay still checks for `NdjsonEventLog`, and cursor persistence does not fully back the store abstraction. Safe changes need to account for these seams until the abstractions cover read and write paths consistently.
