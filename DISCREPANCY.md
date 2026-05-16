
Here are the differences between the new plan and the current implementation:

### Event-Log & Metadata System
- **Git commits are missing.** The plan says ingest should commit immediately (synchronous archival sink), but currently pointer files and events remain untracked — no `git add` or `git commit` runs.

### Git LFS & Binary Storage
- **No lazy hydration.** `GIT_LFS_SKIP_SMUDGE=1` is not configured anywhere.
- **No thumbnail generation.** `.gitattributes` excludes `*.thumbnail.png` from LFS, but no code generates thumbnails or writes to a thumbnails directory.
- **Data integrity bug:** image 2's pointer file is missing from `images/`.

### Incremental Indexer
- **Full rebuild vs. incremental.** Current indexer re-reads *every* NDJSON file and overwrites both index files each run. The plan requires a filesystem watcher that reads only new segments and computes deltas.
- **Subprocess vs. watcher.** Current approach spawns `indexer.ts` synchronously after ingest. The plan decouples this via an `events/` watcher so the trigger survives an async-git transition.
- **No pluggable backend.** Current code writes flat JSON only. The plan describes a progression (JSON → SQLite/bbolt → roaring bitmaps).

### Incremental Static Renderer
- **Not implemented at all.** Current server has only dynamic routes (`GET /`, `GET /image/:oid`). No static HTML generation, no rerendering of touched tag pages, no paginated sets, no image detail pages.

### Git Scaling & Client Optimization
- **Not implemented.** No partial clone (`--filter=blob:none`), no sparse checkout, no scheduled `git gc`, no background batch writer. Nothing in this area exists yet.

### Query Architecture
- **Primitive index only.** `tag_index.json` is a basic `Record<string, string[]>` (a flat posting list). The plan calls for intersection/exclusion/count operations, roaring bitmap compression, and backend selection — none of which exist.

---

**Summary:** The only parts of the plan that match current reality are the NDJSON append, temporal sharding path, LFS Batch API upload, and the basic posting-list shape of `tag_index.json`. Everything else — git commits, lazy hydration, thumbnails, watcher-driven incremental indexing, static rendering, git scaling, and advanced query ops — is unimplemented.

Would you like to start implementing one of these gaps, such as adding the filesystem-watcher-based incremental indexer?

