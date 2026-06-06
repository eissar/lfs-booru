# Architecture

## System Overview

The repository implements a Git-backed media gallery with an event-sourced metadata model.

- Library repositories hold committed metadata event shards and Git LFS-tracked media paths.
- Git LFS stores original media files and generated JPEG thumbnails as large objects.
- JSON files under `index/` materialize the gallery read model for serving.
- The HTTP server performs startup initialization and replay, synchronous ingest, gallery rendering, thumbnail regeneration, image serving, metadata updates, and deletion.

The implementation keeps the source model simple: committed NDJSON events describe metadata state, while media and thumbnail bytes live behind LFS-tracked paths. Derived JSON and HTML artifacts are disposable and rebuildable from committed source events.

## Source of Truth

### Metadata

`events/*.ndjson` is the authoritative metadata stream. Events include add, tag add, tag remove, delete, thumbnail-regeneration, and metadata-update (`name` field patch) operations. Replaying events produces image state and tag indexes.

`event_cursor` is replay bookkeeping. It records how far the derived index has processed the event log, but it is not authoritative metadata.

### Media bytes

Original media files are addressed by SHA-256 OID in add events and stored through Git LFS-tracked `images/{id}.{ext}` paths. Thumbnail bytes are generated as JPEG, addressed by SHA-256 OID, and stored through Git LFS-tracked `thumbnails/{thumbnailOid}.jpg` paths.

### IDs

`index/next_image_id` is the write-path allocator. Add events persist allocated IDs. Replay reconciles the allocator upward from committed add-event IDs, so gaps are allowed and committed events remain the durable record of assigned IDs.

The numeric ID serves as the catalog entry identity while the OID (SHA-256) is the content address. Routes that address a specific entry, such as the inspector, metadata update, thumbnail regeneration, and deletion, use the ID; routes that serve raw bytes use the OID because identical content is interchangeable at the byte level.

## Component Boundaries

### HTTP boundary

`server.ts` owns startup, route matching, request validation, request logging, and high-level write sequencing. It constructs the event log, derived store, and renderer, then passes them into a closure-based handler.

The HTTP boundary returns `Response` objects directly. There is no framework router, result wrapper, or centralized error hierarchy. The `c` utility in `src/util.ts` provides response constructors (`json`, `text`, `blob`, `html`, `error`, `redirect`). Request logging wraps the handler through `withLogging`, which measures request duration and logs method, path, status code, and elapsed time.

The handler closure owns an `AbortController` that triggers graceful shutdown when `POST /shutdown` is called.

### Ingest boundary

`ingest()` prepares an add event and the files it references. It reads bytes, hashes content, allocates an ID, detects media type by magic bytes, writes the original file, generates and writes a thumbnail, and returns an event together with the bytes to persist. It does not append the event or commit Git state.

The server handler owns the transactional sequence around that prepared event: append to the event log with rollback protection, write media and thumbnail files inside the rollback boundary, commit source paths with Git, then apply the event to the derived index.

### Event-log boundary

`EventLog` is write-oriented and supports rollback-protected appends. `EventLogReader` is read-oriented and exposes cursor-based replay. `NdjsonEventLog` implements both with monthly shard files, process-local append locking, byte-offset cursors, and append rollback by truncation.

Prepared-file appends let Eagle import batch many events into one event-log append and one Git commit while preserving NDJSON line format. The mutex is held through the entire rollback-protected operation, ensuring no later append can be accidentally truncated during rollback.

### Derived-index boundary

`DerivedIndexStore` defines the read model and replay target. `JsonFileIndexStore` stores image state, tag index, cursor, and ID allocator files under the library root. The store performs whole-file JSON reads and writes, with per-file atomicity from temp-file-and-rename, but no cross-file transactional guarantees.

Replay and post-ingest application use the same `applyEvent` reducer path. Batch import uses `applyEventsFromFile` to apply a prepared NDJSON file and persist only the final cursor after the batch has been applied. `applyEventsFromFile` avoids saving intermediate cursors after each event, reducing I/O for batch operations.

Tag index writes use per-tag ID arrays (`Record<string, string[]>`). The `listItems` method loads the full `image_state.json` into memory, applies in-process sorting and OR-tag filtering, applies offset, and yields up to `limit` records.

### Rendering boundary

`CachingHtmlRenderer` implements `HtmlRenderer` with Preact JSX templates under `src/template/`. All rendering methods produce output via `renderToString` without disk caching. The `artifactsPath` constructor parameter exists but no method reads it.

The renderer also produces toast notification HTML fragments used by the HTMX error-retargeting mechanism: fragment responses with error messages are targeted to `#toasts-log` instead of replacing the primary swap target.

### Thumbnail boundary

`thumbnail.ts` isolates `mediaforge` and FFmpeg use. Callers provide bytes and a detected extension; the module returns a JPEG blob, OID, and size. Video inputs extract a frame at one second; image inputs use FFmpeg resizing. The caller chooses where to persist the thumbnail and how to record the thumbnail OID.

### Import boundary

`eagle-import.ts` converts Eagle archive/library data into the same ingest and event-log paths used by HTTP upload. Import-specific concerns are zip extraction, metadata mapping, temporary prepared-event files, batch commit, and best-effort cleanup. Individual items whose ingest throws are skipped.

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
  -> append add event to NDJSON shard with rollback around Git commit
  -> git add/commit event shard, media path, thumbnail path
  -> apply event to derived JSON indexes
  -> acknowledge success with status 201
```

The event append is protected by rollback. If Git commit fails, the event-log shard is truncated and no event, media file, or thumbnail file remains committed. The media and thumbnail writes occur inside the rollback boundary to avoid orphaned files.

### Eagle import

```text
Eagle source
  -> iterate metadata and bytes
  -> ingest each item into media/thumbnail files
  -> write successful add events to a prepared NDJSON file
  -> append prepared file with rollback around one Git commit
  -> apply prepared events to derived JSON indexes
```

Import reuses the normal ingest and store application logic, but batches event-log append and Git commit work. Only the final cursor is persisted after all events are applied.

### Gallery reads

```text
/gallery
  -> render gallery shell
  -> HTMX requests /fragment/items or /fragment/gallery-content
  -> JSON store loads/sorts/filters image state
  -> renderer creates item-card fragments and photo-grid/gallery-content fragment

/fragment/inspect/{id}
  -> derived index looks up image by ID
  -> renderer creates inspector fragment

/fragment/gallery-content
  -> used by filter-chip tag clicks
  -> renders a full gallery content section rather than just a photo grid
```

The gallery read path depends on derived JSON freshness. It does not replay during ordinary reads.

`/fragment` URLs always respond with valid HTML. Fragment error responses render toast HTML and use HTMX error retargeting (`HX-Reswap: beforeend` + `hx-target-error`) to append the toast to `#toasts-log`.

### Image reads

```text
/image/{oid}
  -> serve local thumbnail file if it exists and is hydrated
  -> hydrate thumbnail pointer with git lfs pull if needed
  -> otherwise map original OID to image state via derived index
  -> hydrate original image path with git lfs pull
  -> read local LFS object bytes by OID path under .git/lfs/objects/
```

The endpoint trusts the derived index for original OID lookup and trusts Git LFS to hydrate the requested path. Thumbnails are checked first so gallery card images prefer thumbnail bytes over originals.

### Thumbnail regeneration

```text
/regen-thumbnail?id=...
  -> look up image state by ID
  -> read original media file from LFS-tracked path
  -> generate new JPEG thumbnail
  -> write thumbnail to thumbnails/{newOid}.jpg
  -> append regen_thumbnail event with rollback around Git commit
  -> apply event to update thumbnailOid in image state
  -> render and return updated image card HTML
```

The event records only the new thumbnail OID. The thumbnail file path is committed separately through Git.

### Metadata update and deletion

Both `/update-metadata` and `/delete` follow the same event-log transactional pattern: validate input, append event with rollback around a single-file Git commit, apply the event to the derived store, and return the updated fragment or acknowledgment.

## Persistence Model

The library repository separates canonical files from derived files.

Canonical committed files:

- `events/*.ndjson` — metadata event shards
- LFS-tracked `images/**` — original media files
- LFS-tracked `thumbnails/**` — generated JPEG thumbnails
- repository configuration and placeholders from the template

Derived local files (ignored by `.gitignore`):

- `index/image_state.json` — image metadata keyed by string numeric ID
- `index/tag_index.json` — tag-to-image-ID mapping
- `index/next_image_id` — monotonic ID allocator (text file)
- `event_cursor` — replay checkpoint as JSON `{ eventFile, byteOffset }`

The library `.gitignore` keeps derived files out of commits while allowing placeholders to preserve directories. JSON writes use temp files and rename per target file, but multi-file index updates are not a single transaction — a crash between writes can leave derived state inconsistent.

The template `.lfsconfig` configures LFS to fetch only `thumbnails/**` by default and exclude `images/**`, so git clones hydrate thumbnails without pulling originals.

## Invariants and Assumptions

- Event replay order is lexicographic shard name order followed by line order within each shard
- Event cursors are byte offsets into shard files immediately after the last processed line
- Event files are NDJSON with one serialized event per line, terminated by newline
- Add events contain enough image metadata (OID, path, dimensions, content type, timestamps) to rebuild `image_state.json`
- Tag indexes are derived from image state and tag events by calling `addToTag` and `removeFromTag`
- Thumbnail-regeneration events update only `thumbnailOid` in image state
- Original OIDs are SHA-256 hashes of original upload or import bytes
- Thumbnail OIDs are SHA-256 hashes of generated JPEG bytes
- Image IDs are numeric in events and strings in JSON index keys
- ID allocation is monotonic and non-contiguous — deletion does not free IDs
- `index/next_image_id` must contain an integer >= 1 for the JSON store to be considered initialized
- `listItems` uses full-file loading, in-memory sorting, and OR tag matching across the tag index
- Process-local mutexes serialize operations only inside one process and one store/event-log instance
- Event replay (`processEvents`) accepts any `EventLogReader`, not requiring `NdjsonEventLog` specifically

## Failure Boundaries

### Request input

The ingest handler requires a file field named `image` and parses `tags` as a JSON array of strings. Query parameters for limits, offsets, and sort values are normalized or rejected locally with plain-text error responses. HTML templates escape user-facing values through Preact's default escaping.

### Media detection and thumbnails

Media type detection uses magic-byte checks instead of trusting upload filenames. Unsupported inputs fail before events are appended. Thumbnail generation failures surface as request errors; missing FFmpeg manifests as an explicit error from the `mediaforge` or `thumbnail.ts` layer.

### Git and Git LFS

Git failures inside protected event-log callbacks trigger event append rollback. Rollback is limited to NDJSON byte truncation and only succeeds if no later append changed the same shard. Git LFS hydration errors during image serving fail the request through thrown command or filesystem errors.

`stageAndCommit` distinguishes `TaskConfigurationError` and `GitConstructError` (fatal, rethrown) from `GitError` (operational, surfaces as request error).

### Derived-index consistency

The event log is safer than derived JSON files. A crash between writing `image_state.json`, `tag_index.json`, `event_cursor`, or `next_image_id` can leave derived state inconsistent. Rebuilding the index from committed events is the recovery path encoded by startup flags and initialization behavior.

If a Git commit succeeds and `store.applyEvent` fails, committed source state can be ahead of served JSON indexes. A rebuild reconciles derived state with events. The `--rebuild-index` flag explicitly triggers full replay from the beginning.

### Cross-process access

The file locks are process-local mutexes (`@core/asyncutil` Mutex), not repository locks. Concurrent processes that modify the same library can interleave event, index, or Git operations outside these protections.

### Import failure

Eagle import skips individual items whose ingest step throws, writes events only for successful items, and commits a single batch when at least one event was produced. The temporary extraction and prepared-event directories are best-effort cleaned up in `finally` blocks.

## Design Tradeoffs

### Event log over mutable database records

Append-only events make history inspectable and allow derived indexes to be rebuilt. The cost is explicit replay logic, cursor management, and stale-index failure modes.

### JSON indexes over a database engine

JSON files keep the prototype easy to inspect and avoid a database dependency. The cost is whole-file reads and writes, coarse process-local locking, and memory-bound listing behavior that loads all image state at once.

### Git LFS-backed working tree over direct object-store API

Writing files into LFS-tracked paths lets normal Git LFS clean/filter behavior own pointer creation and local object storage. The cost is dependence on Git and Git LFS commands during ingest and serving, plus the overhead of pointer-file indirection.

### Synchronous persistence in request handlers

The upload path acknowledges only after file writes, event append, Git commit, and derived-index application. This keeps acknowledged uploads tied to committed source state, but request latency and availability depend on filesystem, FFmpeg, Git, and index writes. Metadata update and delete paths follow the same synchronous pattern.

### Generated thumbnails as committed LFS paths

Thumbnails are treated as persisted LFS-tracked artifacts and referenced by event metadata. This improves gallery serving and lets clones fetch thumbnails separately from originals, but it adds FFmpeg as an ingest dependency and requires regeneration events when thumbnails change.

### HTMX fragments with server-rendered HTML

The UI keeps client logic small by rendering gallery state on the server and updating fragments with HTMX. This makes filter, pagination, upload, inspector, metadata update, and delete interactions simple, while coupling UI behavior to server-rendered fragment shape. The gallery shell, item grid, and inspector are separate HTMX targets.

### Partial abstractions

The code defines event-log and store interfaces that separate append, read, and replay concerns. `processEvents` accepts any `EventLogReader`, and the store is abstracted behind `DerivedIndexStore`. However, startup still constructs concrete `NdjsonEventLog` and `JsonFileIndexStore` instances, and `processEvents` reads batches through `applyEventsFromFile`, which is store-specific. The abstraction seams support local organization and testability but do not provide backend substitution through dependency injection without changing startup code.

### Append rollback coupled to the mutex

Rollback-protected appends hold the event-log mutex until the protected operation resolves or rollback completes. This ensures correct truncation but serializes append operations across concurrent callers within the same process.
