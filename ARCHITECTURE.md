# Architecture

## System Overview

The repository implements a Git-backed media gallery with an event-sourced metadata model.

- Library repositories hold committed metadata event shards and Git LFS-tracked media paths.
- Git LFS stores original media files and generated JPEG thumbnails as large objects.
- JSON files under `index/` materialize the gallery read model.
- The HTTP server performs startup initialization and replay, synchronous ingest, gallery rendering, thumbnail regeneration, and image serving.

The implementation keeps the source model simple: committed NDJSON events describe metadata state, while media and thumbnail bytes live behind LFS-tracked paths. Derived JSON and HTML artifacts are disposable and rebuildable from committed source files and events.

## Source of Truth

### Metadata

`events/*.ndjson` is the authoritative metadata stream. Events include add, tag add, tag remove, delete, thumbnail-regeneration, and metadata-update operations. Replaying events produces image state and tag indexes.

`event_cursor` is replay bookkeeping. It records how far the derived index has processed the event log, but it is not authoritative metadata.

### Media bytes

Original media files are addressed by SHA-256 OID in add events and stored through Git LFS-tracked `images/{id}.{ext}` paths. Thumbnail bytes are generated as JPEG, addressed by SHA-256 OID, and stored through Git LFS-tracked `thumbnails/{thumbnailOid}.jpg` paths.

### IDs

`index/next_image_id` is the write-path allocator. Add events persist allocated IDs. Replay reconciles the allocator upward from committed add-event IDs, so gaps are allowed and committed events remain the durable record of assigned IDs.

The numeric ID serves as the catalog entry identity while the OID (SHA-256) is the content address. Routes that address a specific entry, such as the inspector and thumbnail regeneration, use the ID; routes that serve raw bytes use the OID because identical content is interchangeable at the byte level.

## Component Boundaries

### HTTP boundary

`server.ts` owns startup, route matching, request validation, request logging, and high-level write sequencing. It constructs the event log, derived store, and renderer, then passes them into a closure-based handler.

The HTTP boundary returns `Response` objects directly. There is no framework router, result wrapper, or centralized error hierarchy. The `c` utility in `src/util.ts` provides response constructors (`json`, `text`, `blob`, `html`, `error`, `redirect`).

### Ingest boundary

`ingest()` prepares an add event and the files it references. It reads bytes, hashes content, allocates an ID, detects media type, writes the original file, generates and writes a thumbnail, and returns an event together with the bytes to persist. It does not append the event or commit Git state.

The server handler owns the transactional sequence around that prepared event: append to the event log with rollback protection, commit source paths with Git, then apply the event to the derived index.

### Event-log boundary

`EventLog` is write-oriented and supports rollback-protected appends. `EventLogReader` is read-oriented and exposes cursor-based replay. `NdjsonEventLog` implements both with monthly shard files, process-local append locking, byte-offset cursors, and append rollback by truncation.

Prepared-file appends let Eagle import batch many events into one event-log append and one Git commit while preserving NDJSON line format.

### Derived-index boundary

`DerivedIndexStore` defines the read model and replay target. `JsonFileIndexStore` stores image state, tag index, cursor, and ID allocator files under the library root.

Replay and post-ingest application use the same `applyEvent` reducer path. Batch import uses `applyEventsFromFile` to apply a prepared NDJSON file and persist only the final cursor after the batch has been applied.

### Rendering boundary

`HtmlRenderer` separates request handling from templates. `CachingHtmlRenderer` caches gallery shell pages by content hash and renders uncached cards, photo-grid fragments, and inspector fragments. Template modules produce HTML strings through Preact JSX.

### Thumbnail boundary

`thumbnail.ts` isolates FFmpeg and mediaforge use. Callers provide bytes and a detected extension; the module returns a JPEG blob, OID, and size. The caller chooses where to persist the thumbnail and how to record the thumbnail OID.

### Import boundary

`eagle-import.ts` converts Eagle archive/library data into the same ingest and event-log paths used by HTTP upload. Import-specific concerns are extraction, metadata mapping, temporary prepared-event files, and batch commit.

## Data Flow

### Startup

```text
parse flags and .env
  -> initialize or reuse library Git repository
  -> optionally remove renderer artifacts
  -> create JSON store, NDJSON event log, and renderer
  -> initialize or rebuild derived index when requested or incomplete
  -> optionally import Eagle source through a batched event append
  -> serve HTTP
```

Startup treats missing derived artifacts as rebuildable state. Missing or invalid library initialization dependencies fail through Git or panic paths.

### Upload ingest

```text
multipart /ingest
  -> validate image and tags fields
  -> ingest() writes media and thumbnail files and returns add event
  -> append add event to NDJSON shard
  -> git add/commit event shard, media path, thumbnail path
  -> apply event to derived JSON indexes
  -> acknowledge success
```

The event append is protected by rollback around Git commit. The media and thumbnail writes happen before the event append, so failures later in the flow can leave uncommitted working-tree files or local LFS objects.

### Eagle import

```text
Eagle source
  -> iterate metadata and bytes
  -> ingest each item into media/thumbnail files
  -> write successful add events to a prepared NDJSON file
  -> append prepared file with rollback around one Git commit
  -> apply prepared events to derived JSON indexes
```

Import reuses the normal ingest and store application logic, but batches event-log append and Git commit work.

### Gallery reads

```text
/gallery
  -> cached gallery shell from renderer
  -> HTMX requests /fragment/items
  -> JSON store loads/sorts/filters image state
  -> renderer creates item-card fragments and photo-grid fragment

/fragment/inspect/{id}
  -> derived index looks up image by ID
  -> renderer creates inspector fragment
```

The gallery read path depends on derived JSON freshness. It does not replay during ordinary reads.

### Image reads

```text
/image/{oid}
  -> serve local thumbnail file if it exists and is hydrated
  -> hydrate thumbnail pointer with git lfs pull if needed
  -> otherwise map original OID to image state
  -> hydrate original image path with git lfs pull
  -> read local LFS object bytes by OID path
```

The endpoint trusts the derived index for original OID lookup and trusts Git LFS to hydrate the requested path.

### Thumbnail regeneration

```text
/regen-thumbnail?id=...
  -> look up image state by ID
  -> read original media file
  -> generate new JPEG thumbnail
  -> append regen_thumbnail event with rollback around Git commit
  -> apply event to update thumbnailOid in image state
  -> return thumbnail OID and size JSON
```

The event records only the new thumbnail OID. The thumbnail file path is committed separately through Git.

## Persistence Model

The library repository separates canonical files from derived files.

Canonical committed files:

- `events/*.ndjson`
- LFS-tracked `images/**`
- LFS-tracked `thumbnails/**`
- repository configuration and placeholders from the template

Derived local files:

- `index/image_state.json`
- `index/tag_index.json`
- `index/next_image_id`
- `index/artifacts/**`
- `event_cursor`

The library `.gitignore` keeps derived files out of commits while allowing placeholders to preserve directories. JSON writes use temp files and rename per target file, but multi-file index updates are not a single transaction.

## Invariants and Assumptions

- Event replay order is lexicographic shard name order followed by line order
- Event cursors are byte offsets into shard files immediately after processed lines
- Event files are NDJSON with one serialized event per line
- Add events contain enough image metadata to rebuild `image_state.json`
- Tag indexes are derived from image state and tag events
- Thumbnail-regeneration events update only `thumbnailOid` in image state
- Original OIDs are SHA-256 hashes of original upload/import bytes
- Thumbnail OIDs are SHA-256 hashes of generated JPEG bytes
- Image IDs are numeric in events and strings in JSON index keys
- ID allocation is monotonic and non-contiguous
- `index/next_image_id` must contain an integer greater than or equal to 1 for the JSON store to be considered initialized
- `listItems` uses full-file loading, in-memory sorting, and OR tag matching
- Renderer gallery-page cache identity includes renderer version and input filter
- Process-local mutexes serialize operations only inside one process and one store/event-log instance

## Failure Boundaries

### Request input

The ingest handler requires a file field named `image` and parses `tags` as a JSON array of strings. Query parameters for limits, offsets, and sort values are normalized or rejected locally. HTML templates escape user-facing values through Preact's default escaping.

### Media detection and thumbnails

Media type detection uses magic-byte checks instead of trusting upload filenames. Unsupported inputs fail before events are appended. Thumbnail generation failures surface as request errors; missing FFmpeg is a known explicit error path.

### Git and Git LFS

Git failures inside protected event-log callbacks trigger event append rollback. Rollback is limited to NDJSON bytes and only succeeds if no later append changed the shard. Git LFS hydration errors during image serving fail the request through thrown command or filesystem errors.

### Derived-index consistency

The event log is safer than derived JSON files. A crash between writing `image_state.json`, `tag_index.json`, `event_cursor`, or `next_image_id` can leave derived state inconsistent. Rebuilding the index from committed events is the recovery path encoded by startup flags and initialization behavior.

If a Git commit succeeds and `store.applyEvent` fails, committed source state can be ahead of served JSON indexes. A rebuild reconciles derived state with events.

### Cross-process access

The file locks are process-local mutexes, not repository locks. Concurrent processes that modify the same library can interleave event, index, or Git operations outside these protections.

### Import failure

Eagle import skips individual items whose ingest step throws, writes events only for successful items, and commits a single batch when at least one event was produced. The temporary extraction and prepared-event directories are best-effort cleaned up in `finally` blocks.

## Design Tradeoffs

### Event log over mutable database records

Append-only events make history inspectable and allow derived indexes to be rebuilt. The cost is explicit replay logic, cursor management, and stale-index failure modes.

### JSON indexes over a database engine

JSON files keep the prototype easy to inspect and avoid a database dependency. The cost is whole-file reads and writes, coarse process-local locking, and memory-bound listing behavior.

### Git LFS-backed working tree over direct object-store API

Writing files into LFS-tracked paths lets normal Git LFS clean/filter behavior own pointer creation and local object storage. The cost is dependence on Git and Git LFS commands during ingest and serving.

### Synchronous persistence in request handlers

The upload path acknowledges only after file writes, event append, Git commit, and derived-index application. This keeps acknowledged uploads tied to committed source state, but request latency and availability depend on filesystem, FFmpeg, Git, and index writes.

### Generated thumbnails as committed LFS paths

Thumbnails are treated as persisted LFS-tracked artifacts and referenced by event metadata. This improves gallery serving and lets clones fetch thumbnails separately from originals, but it adds FFmpeg as an ingest dependency and requires regeneration events when thumbnails change.

### HTMX fragments with server-rendered HTML

The UI keeps client logic small by rendering gallery state on the server and updating fragments with HTMX. This makes filter, pagination, upload, and inspector interactions simple, while coupling UI behavior to server-rendered fragment shape.

### Partial abstractions

The code defines event-log and store interfaces, but replay still requires the concrete `NdjsonEventLog`. The abstraction seam supports local organization but does not provide backend substitution for replay without changing `processEvents`.