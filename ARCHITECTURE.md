# Architecture

## System Overview

The booru is an append-only event-sourced image gallery where Git LFS stores
immutable image binaries and NDJSON event logs serve as the canonical source of
metadata truth. Derived indexes are disposable JSON files rebuilt from event
replay, and an HTTP server provides ingest, gallery browsing, and image serving.

The system separates three concerns:

- **Authoritative history** — Git commits store LFS pointer files and NDJSON
  event shards. The event log is canonical; everything else is derived.
- **Derived indexes** — `image_state.json` and `tag_index.json` are
  materialized views rebuilt incrementally from the event log.
- **Blob storage** — Image bytes live on a Git LFS server, addressed by
  content-hash OID.

## Source of Truth

The **NDJSON event log** under `events/` is the primary data model. Each line
is a JSON object with an `op` field (`add`, `tag_add`, `tag_remove`, `delete`)
and associated metadata. Shards are named `YYYY-MM.ndjson` for temporal
partitioning.

Every other persistent artifact is derived:

| Artifact | Derived from | Regeneration |
|----------|-------------|--------------|
| `index/image_state.json` | Event log replay | `processEvents` |
| `index/tag_index.json` | Event log replay | `processEvents` |
| `event_cursor` | Last processed byte offset | Written during replay |
| `images/{id}.png` (pointer) | OID from ingest | `internalIngest` |

This design means indexes can be deleted and rebuilt deterministically at any
time without data loss.

## Component Boundaries

### HTTP Layer (`server.ts`, `src/handlers.ts`)

The server is a Deno HTTP server with three routes. It does not manage LFS
storage or indexing directly — it delegates to the LFS API client for blob
operations and to the derived index store for metadata reads.

`server.ts` owns startup: it checks for the existence of derived indexes,
triggers a full rebuild if absent, then starts serving. The handler closure
captures hardcoded `conn` (LFS) and `lib` (library path) configuration.

### LFS Client (`src/lfs/api.ts`)

A thin HTTP client for a Git LFS server. It implements five operations (PUT
metadata, PUT content, GET metadata, GET content, HEAD metadata) using fetch
with correct Accept and Authorization headers. It does not implement the Batch
API, locking, or tus verify endpoints.

The client constructs URLs from a `Connection` record (`url`, `auth`, `user`,
`repo`). When `user` and `repo` are non-empty, the scoped `/{user}/{repo}`
prefix is used.

### Index Store (`src/index_store.ts`)

Defines the `DerivedIndexStore` interface as a contract for applying events
and reading derived state. `JsonFileIndexStore` is the sole implementation,
backed by three JSON files and a mutex for write serialization.

The store interface abstracts the storage backend, allowing replacement with
SQLite, Bbolt, or other backends without changing the indexer or handlers.

### Indexer (`indexer.ts`)

The event replay engine. It streams NDJSON shards, parses each line as an
event, applies it to in-memory state via the pure `applyEvent` function, then
persists through the store. It is incremental: a cursor tracks the last
processed byte offset within the last processed shard, allowing restarts
without full replays.

`applyEvent` is a pure function operating on `ImageStateIndex` and `TagIndex`
records. It does not touch disk — the store handles persistence separately.

### Git Operations (`src/git.ts`)

Library initialization is a one-time clone from `libraries/template` with
`GIT_LFS_SKIP_SMUDGE=1` (no blob hydration during clone). The function appends
`skipSmudge = true` to the local Git config and adds an `upstream` remote.

## Data Flow

### Ingest

```
Client
  → POST /ingest (multipart image bytes)
  → handleIngest: compute SHA-256 OID, dedupe, assign sequential ID
  → internalIngest:
      1. PutObjectMeta (LFS server)      — register blob
      2. PutObjectContent (LFS server)   — upload bytes
      3. Write LFS pointer file          — images/{id}.png
      4. Append NDJSON event             — events/2026-05.ndjson
      5. git add + git commit            — durability
  → 200 (dedupe) or 201 (new) with { id }
```

The ingest is synchronous: the client waits for LFS upload and Git commit to
complete. Both `git add` and `git commit` failures are caught and returned as
JSON error responses; the LFS upload is not rolled back on Git failure.

### Image Serving

```
Browser
  → GET /
  → handleRoot: read index/image_state.json
  → render HTML with <img src="/image/{oid}">
  → GET /image/{oid}
  → handleImage: GetObjectContent(conn, oid)
  → LFS server → raw image bytes
```

Images are served directly from the LFS server via the booru as a proxy. There
is no local blob cache.

### Index Rebuild

```
Startup or CLI invocation
  → processEvents(conn, store):
      1. Scan events/ for .ndjson shards, sort
      2. Load resume cursor from store
      3. For each shard (skipping fully-processed ones):
           Stream lines from byte offset
           Parse JSON → Event
           store.applyEvent(event, nextCursor)
      4. Log summary counts
```

The rebuild is incremental: `event_cursor` stores `{ eventFile, byteOffset }`
so only new events are replayed.

## Persistence Model

### Event Log (`events/YYYY-MM.ndjson`)

- Append-only NDJSON, one JSON object per line
- Ops: `add`, `tag_add`, `tag_remove`, `delete`
- Each `add` event carries full image metadata (oid, path, tags, dimensions, name, mtime)
- Sharding by month (`YYYY-MM.ndjson`) limits shard file growth

### Git Repository

- LFS pointer files at `images/{id}.png` — small text files with OID reference
- Event shards are tracked in Git for history/durability
- `.lfsconfig` sets `lfs.url` and `lfs.fetchexclude = *` to prevent automatic
  blob checkout
- `.gitattributes` declares LFS filter rules for image extensions

### Derived Indexes (`index/`)

- `image_state.json` — `{ [id: string]: ImageState }` mapping ID to full
  metadata
- `tag_index.json` — `{ [tag: string]: string[] }` mapping tag to list of
  image IDs
- `event_cursor` — `{ eventFile: string, byteOffset: number }` at library root

All derived files are written atomically via `tmp + rename`.

## Invariants

- **Event log is append-only.** The indexer reads events; nothing mutates
  existing lines. Replay from cursor is always safe.
- **OIDs are content-addressed.** SHA-256 of image bytes. Two identical images
  produce the same OID; deduplication prevents double-ingest.
- **Sequential IDs are determined by the index.** The next image ID is
  `max(existing_ids) + 1`, read from `image_state.json` during ingest.
- **Cursor advances only after event application.** `applyEvent` writes the
  cursor as the last step, using the mutex to ensure atomicity with index
  writes.
- **Index files are disposable.** Any index can be deleted and rebuilt from
  the event log.
- **Pointer files are deterministic.** Given an OID and size, the pointer text
  is fixed by the Git LFS spec.

## Failure Boundaries

### Startup Integrity

`server.ts` checks for `index/image_state.json` at startup. If absent, it
rebuilds indexes before serving. This is a hard precondition: if the event log
is also absent or corrupt, the server will fail during replay.

### LFS Upload Failures

`internalIngest` checks `metaRes.ok` and `lfsRes.ok` after each LFS operation.
On failure, it returns a JSON error response (502) and does not proceed to
file writes or Git operations.

### Git Operation Failures

`git add` and `git commit` failures are caught via `.catch()` and returned as
500 JSON error responses. The pointer file and NDJSON append have already been
written to disk when these errors occur — there is no rollback.

### Index Consistency

The `JsonFileIndexStore` uses a mutex for all writes. `applyEvent` writes
`image_state.json`, then `tag_index.json`, then `event_cursor`. A crash between
the first two writes leaves the tag index inconsistent with the image state.
A crash after the cursor write but before the mutex release can cause the
cursor to advance past events that were only partially applied (the next
startup would skip those events).

### Deduplication Window

Deduplication scans `image_state.json` OIDs. Between reading the index and
writing the new event, another concurrent ingest could insert the same OID.
The mutex protects the store, but `handleIngest` reads the index file directly
(not through the store), so concurrent ingests are not serialized.

### Missing Index Files

`handleRoot` throws if `image_state.json` is missing. `handleIngest` falls back
to `{}` for deduplication when the file is absent, allowing ingest when
indexes have not been built.

## Design Tradeoffs

### Synchronous Git Commit During Ingest

Each ingest waits for `git add` and `git commit` to complete before responding.
This provides durable event history at the cost of latency (~50-100ms per
operation from Git process spawn and index mutation). The choice favors
simplicity and durability over throughput, appropriate for a prototype with
low write volume.

### JSON Files as Index Backend

Using flat JSON files for indexes keeps the system dependency-free and
debuggable (files are human-readable). The tradeoff is that the entire index
must be loaded into memory for each read or write, and serializing the full
object on every mutation limits scalability. The `DerivedIndexStore` interface
exists to allow replacement with SQLite or other backends when scale demands
it.

### Single Hardcoded Event Shard

The ingest handler hardcodes `events/2026-05.ndjson` rather than computing the
current month. The `getCurrentYearMonth` helper exists but is unused. This
avoids complexity in the prototype but means all events accumulate in one shard
until the name is manually changed.

### No Thumbnail Pipeline

Ingest stores only the full-resolution image. There is no thumbnail generation
or thumbnail-serving path. Gallery HTML embeds full images, leaving scaling to
the browser.

### Event Log as Canonical, Indexes as Disposable

The system treats the event log as the only durable metadata store. This means
index corruption is non-catastrophic (rebuild from events), but it also means
the event log must never be truncated or rewritten without rebuilding indexes.

## Module Dependency Graph

```
server.ts
  ├── src/handlers.ts
  │     ├── src/lfs/api.ts       (LFS HTTP client)
  │     ├── src/library.ts       (LibraryConnection type)
  │     ├── src/logging.ts       (debug)
  │     ├── npm:simple-git       (git add/commit)
  │     └── @std/path            (path joins)
  ├── src/index_store.ts
  │     ├── indexer.ts           (applyEvent, processEvents)
  │     ├── src/library.ts
  │     └── @core/asyncutil      (Mutex)
  └── indexer.ts
        ├── src/index_store.ts
        └── @std/streams         (TextLineStream)

src/git.ts
  ├── src/logging.ts
  ├── src/util.ts                (panic)
  ├── npm:simple-git             (clone)
  └── @std/path

scripts/dump_types.ts
  └── npm:typescript@6.0.3

scripts/read_json_sync_bench.ts
  (no project imports)

src/test_InitWith5Images.ts
  ├── src/handlers.ts            (internalIngest)
  ├── src/git.ts                 (Init)
  ├── src/lfs/api.ts
  ├── src/library.ts
  └── src/util.ts                (panic)
```
