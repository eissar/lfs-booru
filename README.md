# LFS Booru

This project is a Git-based booru-style image gallery. It stores metadata as append-only NDJSON event logs, stores image bytes with Git LFS, and builds search/index and static-rendering artifacts from those logs.

## Architecture overview

Core components:

- **Append-only NDJSON event logs** for metadata operations such as add, tag, and delete
- **Git LFS** for binary image storage
- **Incremental indexer** that processes new events from post-receive hooks or local watchers
- **Incremental static renderer** that updates affected pages
- **Git scaling options** such as partial clone, sparse checkout, and lazy LFS hydration

Git history is the source of truth. Indexes and rendered pages are derived artifacts that can be rebuilt from the event logs.

## Repository layout

```text
repo/
  events/
    2026-05.ndjson
    2026-06.ndjson

  images/
    2026/05/abc.webp
    2026/05/def.webp

  thumbs/
    ...

  generated/
    static html output (optional)
```

Notes:

- Metadata is stored as append-only NDJSON
- Image binaries are treated as immutable once written
- Per-image metadata files are avoided
- Large mutable manifests are avoided

This layout reduces Git tree churn, object count growth, and packfile fragmentation compared with per-image metadata files.

## Metadata model

Metadata is represented as an append-only event log:

```json
{"op":"add","id":123,"tags":["cat","night"]}
{"op":"tag_add","id":123,"tag":"outdoor"}
{"op":"tag_remove","id":123,"tag":"night"}
{"op":"delete","id":98}
```

The NDJSON log is the authoritative source of truth. Indexes, counts, rendered pages, and other materialized outputs are derived state.

This model supports:

- Incremental indexing
- Deterministic rebuilds
- Compact append-oriented diffs
- Temporal sharding

## Incremental indexer

A post-receive hook or local watcher compares commits:

```sh
git diff previous_commit current_commit
```

The indexer detects:

- Appended NDJSON segments
- Changed thumbnails
- New binaries

It then:

- Reads new events
- Computes tag deltas
- Updates materialized indexes
- Rerenders affected pages

Initial index files may include:

- `tag_index.json`
- `image_state.json`
- `counts.json`

The index storage layer can later be replaced with SQLite, Bbolt, or another storage engine.

## Scaling

### Small scale, around 10k images

Use:

- JSON indexes
- Append-only NDJSON logs
- Static generation

### Medium scale, around 100k images

Consider moving indexes to:

- SQLite
- Bbolt

Additional work may include:

- Incremental materialized counts
- Cached implication closures
- Selective rerendering

### Large scale, around 1M+ images

Possible additions:

- Roaring bitmap posting lists
- Compressed inverted indexes
- Parallel static generation
- Thumbnail caching

At this size, query performance, index structure, Git object counts, and repository maintenance need closer attention.

## Git scaling strategy

### 1. Append-only metadata

Segmented NDJSON logs avoid millions of mutable metadata files.

### 2. Partial clone

```sh
git clone --filter=blob:none
```

This downloads commits, trees, and path metadata without downloading blob contents immediately.

### 3. Sparse checkout

```sh
git sparse-checkout set recent/
```

Sparse checkout reduces working tree size, hydration cost, editor load, and local filesystem pressure.

Sparse checkout does not remove global Git metadata costs. Git still tracks trees, commits, and path metadata for the repository.

### 4. Git LFS lazy hydration

```sh
GIT_LFS_SKIP_SMUDGE=1
```

This avoids hydrating LFS objects during checkout. Binaries are fetched when needed.

## Rendering model

Static pages are derived artifacts. The renderer updates only affected outputs, such as:

- Touched tag pages
- Affected pagination pages
- Image detail pages
- Derived feeds

## Operational considerations

At larger repository sizes, the main operational concerns are:

- Git object counts
- Filesystem inode pressure
- Thumbnail generation
- Deploy bandwidth
- Repository maintenance
- LFS storage size

The event-log model is intended to reduce metadata churn and make incremental indexing explicit.

## HTTP ingest caveat

The `POST /ingest` endpoint uploads image bytes directly to the LFS server through the Batch API, writes the pointer file to `images/{id}.png`, appends an NDJSON event, and synchronously creates a Git commit containing both files.

This means:

- The binary exists on the LFS server at its OID
- The pointer file and NDJSON event are staged with `git add -- images/{id}.png events/2026-05.ndjson`
- A successful ingest returns only after `git commit` succeeds
- `git add` or `git commit` failures are returned as JSON HTTP errors

## Image filename and ID convention

Images on disk use sequential numeric IDs as filenames:

```text
images/1.png
images/2.png
images/3.png
```

The numeric ID is both the filename and the `id` field in NDJSON events.

Alternatives considered:

**OID as filename**: `images/907415...fea.png`

- Content-addressed
- Collision-resistant
- Changes if the image is re-encoded
- Produces long filenames

**UUID as filename**: `images/a1b2c3d4-...png`

- Stable
- Does not require sequential allocation
- Adds a generation step
- Does not provide ordering

**Sequential numeric ID**: `images/1.png`

- Matches common booru conventions
- Uses the same value in the filename and event log
- Can be allocated by reading the current maximum ID and incrementing
- Keeps the LFS OID as separate blob-retrieval metadata

The filename is a storage key. Semantic metadata belongs in the event log.

## Current ingest performance assumption

Current measurements indicate that ingestion cost is dominated by fixed overhead, mostly process spawning and Git index mutation. In the measured regime, `git add` and `update-index` stabilize around 63-64ms across varying repository sizes, with negligible file-read cost and no observed scaling degradation.

Benchmark reference: https://github.com/eissar/git-performance-benchmarking/blob/main/bench.ts

For higher throughput or concurrency requirements, Git can be moved out of the synchronous ingest path. In that model, ingestion would append first, and Git commits would be created by a batched background persistence process.

## Future query architecture

Indexes can use an inverted-index structure:

```text
tag -> posting list of image ids
```

Initial implementations can use sorted integer arrays. Later implementations may use roaring bitmaps or compressed posting lists for intersection, exclusion, and count queries.
