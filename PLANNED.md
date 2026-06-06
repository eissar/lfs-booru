- Event-Log & Metadata System - Append-only NDJSON ingestion, sequential ID allocation, event replay
  for deterministic rebuilds, temporal sharding (events/2026-05.ndjson). POST /ingest writes the LFS
  blob, appends to the current shard, and commits immediately. Git is a synchronous archival sink;
  50-100ms write latency is acceptable at current write volume.

- Git LFS & Binary Storage - Immutable image storage via LFS, pointer-file management, lazy hydration
  (GIT_LFS_SKIP_SMUDGE=1), the Batch API upload path, and thumbnail generation/thumbnails directory.

- Incremental Indexer - Filesystem watcher on events/ that detects new NDJSON appends, reads only new
  segments, computes tag deltas, and updates materialized views (tag_index.json, image_state.json,
  counts.json). Watcher-driven rather than post-receive so index updates are decoupled from git commits
  and the trigger point survives a future async-git transition unchanged. Pluggable backend
  (JSON  SQLite/bbolt  roaring bitmaps as scale grows).

- Incremental Static Renderer - Derives HTML pages from indexes, rerenders only touched tag pages,
  paginated sets, and image detail pages; avoids full-site rebuilds.

- Git Scaling & Client Optimization - Partial clone (--filter=blob:none), sparse checkout,
  object-count management, packfile fragmentation mitigation (scheduled git gc). If sustained write
  rate or p95 ingest latency becomes a problem, git moves to a background batch writer; the ingest
  handler and watcher-based indexer require no structural changes for that transition.

- Query Architecture - Inverted indexes (tag  posting list), intersection/exclusion/count operations,
  roaring bitmap compression at scale, and index backend selection based on gallery size.

## Rollback, Transaction, and Event-System Shortcomings

The current write path should not be described as a true transaction. It is a best-effort persistence
sequence built from event-log append, filesystem writes, Git staging, Git commit, and derived-index
application. The rollback mechanism currently protects only the appended NDJSON bytes and does not
provide atomicity across the full source state.

- `appendWithRollback()` only truncates the event shard back to the previous byte offset.
- Rollback does not delete media files written to `images/{id}.{ext}`.
- Rollback does not delete thumbnail files written to `thumbnails/{thumbnailOid}.jpg`.
- Rollback does not clean up partially written or corrupted media files.
- Rollback does not clean up partially written or corrupted thumbnail files.
- Rollback does not unstage files after `git add` succeeds and `git commit` fails.
- Rollback does not restore the Git index to its previous state.
- Rollback does not restore the working tree to its previous state.
- Rollback does not distinguish files created by the failed operation from pre-existing files at the same path.
- Rollback does not protect against path collisions beyond the current ID allocation assumptions.
- Rollback does not remove Git LFS objects that may have been created by clean filters during staging.
- Rollback does not guarantee that event paths and media paths remain synchronized after failed writes.
- Rollback does not guarantee that a failed request leaves the repository clean.
- Rollback does not guarantee that a failed request leaves no orphaned media artifacts.
- Rollback does not guarantee that a failed request leaves no orphaned thumbnails.
- Rollback does not guarantee that a failed request leaves no staged event shard.
- Rollback does not guarantee that a failed request leaves no staged media path.
- Rollback does not guarantee that a failed request leaves no staged thumbnail path.
- Rollback does not handle crashes or process exits between event append and rollback.
- Rollback does not handle crashes or process exits between media write and Git commit.
- Rollback does not handle crashes or process exits after Git staging but before Git commit.
- Rollback does not handle crashes or process exits after Git commit but before derived-index application.
- Rollback is process-local and does not coordinate with another process modifying the same repository.
- The event-log mutex serializes only callers sharing the same `NdjsonEventLog` instance in one process.
- Rollback truncation only succeeds if the shard size still matches the appended cursor offset.
- Rollback can fail if another writer appends to the same shard outside the process-local mutex.
- Rollback can fail if an external editor, Git operation, import, or process mutates the event shard.
- `appendPreparedFileWithRollback()` has the same limitation: it rolls back only the appended event bytes,
  not all media files written for the batch.
- Eagle import can leave many orphaned media and thumbnail files if the batch Git commit fails after file writes.
- Eagle import can leave many staged paths if `git add` partially succeeds and `git commit` fails.
- Thumbnail regeneration writes the new thumbnail before appending and committing the regeneration event, so
  failure can leave an unreferenced thumbnail file.
- Metadata update and delete events have fewer filesystem side effects, but they can still leave staged
  event-shard changes after Git failure.
- Delete events are logical deletes only; they do not remove media or thumbnail artifacts, so storage reclamation
  is not part of the event model.
- Derived JSON indexes are applied after Git commit, so committed source state can advance while served indexes
  remain stale or inconsistent.
- Derived-index writes are per-file atomic but not transactionally grouped across `image_state.json`,
  `tag_index.json`, `event_cursor`, and `next_image_id`.
- A crash during derived-index application can leave event replay cursor and index contents out of sync.
- Startup replay can repair stale derived indexes only when a rebuild or replay path correctly detects and
  processes the committed events.
- There is no startup repair scan for orphaned files that exist on disk but are not referenced by committed events.
- There is no startup repair scan for committed events that reference missing media or thumbnail paths.
- There is no startup repair scan for staged but uncommitted event, image, or thumbnail paths.
- There is no startup repair scan for dirty worktree files under canonical source directories.
- There is no integrity check that every add event has a committed media path.
- There is no integrity check that every thumbnail OID referenced by events has a committed thumbnail path.
- There is no integrity check that media file content matches the OID recorded in the add event.
- There is no integrity check that thumbnail file content matches the thumbnail OID recorded in the event.
- There is no durable operation journal describing in-progress writes and cleanup actions.
- There is no two-phase commit, prepare/commit marker, or recovery protocol for interrupted writes.
- There is no temporary-file-and-atomic-rename discipline for canonical media and thumbnail writes.
- There is no explicit cleanup stack tracking paths created during a protected operation.
- There is no compensating action layer for failed Git staging or commit.
- There is no repository lock around event append, file writes, Git staging, Git commit, and index application.
- There is no clear distinction in naming between event-log rollback and full transaction rollback.
- Architecture comments currently overstate the guarantee by implying that no files are left on disk after Git failure.
- Documentation should describe the current model as best-effort event append rollback, not rollback-protected
  source transactions.
- The source-of-truth model depends on committed events and committed LFS paths, but the failed-write cleanup
  path does not yet enforce that relationship.
- The tagline and architecture should avoid implying sync-engine semantics such as multi-writer reconciliation,
  conflict resolution, or atomic replica convergence.
- Future work should decide whether to implement best-effort cleanup, full startup repair, a durable write journal,
  or a simpler documented operational caveat.
