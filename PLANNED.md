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
