This document describes a **Git-native booru-style image gallery** architecture that treats the system as an append-only content archive with derived search/index artifacts and incremental static rendering. The core philosophy separates authoritative Git history from disposable materialized views.

Key architectural components:
- **Append-only NDJSON event logs** for metadata (add/tag/delete operations)
- **Git LFS** for immutable binary storage
- **Incremental indexer** that processes only new events via post-receive hooks
- **Incremental static renderer** that updates only affected pages
- **Git scaling optimizations**: partial clone, sparse checkout, lazy hydration

The system avoids traditional mutable database patterns and per-file metadata, instead using event sourcing semantics for deterministic rebuilds and minimal Git churn. The architecture supports scaling from small personal galleries (~10k images with JSON indexes) to large-scale deployments (~1M+ images with optimized indexes) while maintaining Git-native workflows and reproducibility.

The architecture supports a Git workflow with post-receive hooks that process new events, update indices from all metadata, and trigger incremental static site generation. The indexer uses `git diff` to find appended NDJSON segments and compute only the necessary updates to materialized views.

Core Philosophy

Treat the system as:

append-only content archive
+
derived search/index artifacts
+
incremental static renderer

—not as:

a traditional mutable database app
nor “millions of files in Git”

The key architectural insight is:

Git stores authoritative history.
Indexes are disposable materialized views.

That separation simplifies nearly everything.


the log is canonical
indexes are disposable caches


Repository Layout
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

Important points:

metadata is append-only NDJSON
binaries are immutable-ish
avoid per-image metadata files
avoid giant mutable manifests

This dramatically reduces:

Git tree churn
object count explosion
packfile fragmentation
Metadata Model

Use an append-only event log:

{"op":"add","id":123,"tags":["cat","night"]}
{"op":"tag_add","id":123,"tag":"outdoor"}
{"op":"tag_remove","id":123,"tag":"night"}
{"op":"delete","id":98}

Benefits:

incremental indexing becomes trivial
replayability
deterministic rebuilds
Git-friendly append patterns
temporal sharding
compact diffs
event sourcing semantics

The NDJSON log becomes:

the authoritative source of truth

Everything else becomes derived state.

Incremental Indexer

A post-receive hook or local watcher:

git diff previous_commit current_commit

finds:

appended NDJSON segments
changed thumbnails
new binaries

The indexer:

reads only new events
computes tag deltas
updates materialized indexes
rerenders affected pages only

No global rebuilds.

Index Storage:

Start with:
- tag_index.json
- image_state.json
- counts.json

simplest possible implementation
easy debugging, no external dependency
perfectly adequate for small/personal galleries

event log + disposable index means decoupling;
index storage layer is easily swappable for sqlite/bbolt, whatever

## Scaling
Recommended Scaling Path
Small Scale (~10k images)

Use:

JSON indexes
append-only NDJSON
static generation

No database needed.

Medium Scale (~100k images)

Move indexes to:

SQLite
or Bbolt

Add:

incremental materialized counts
cached implication closures
selective rerendering

Still very manageable.

Large Scale (~1M+ images)

Add:

roaring bitmap posting lists
compressed inverted indexes
parallel static generation
aggressive thumbnail caching

At this point:

query performance matters
index structure matters
Git object counts begin mattering more

But still feasible.


Git Scaling Strategy

The important optimization stack is:

1. Append-only metadata

Most important metadata optimization.

Avoid:

millions of mutable tiny files

Prefer:

segmented NDJSON logs
2. Partial clone
git clone --filter=blob:none

Downloads:

commits
trees
path metadata

but not blob contents initially.

Huge bandwidth savings.

3. Sparse checkout
git sparse-checkout set recent/

Reduces:

working tree size
hydration cost
editor load
local filesystem pressure

Important clarification:

Sparse checkout does NOT solve Git metadata scaling.
It only solves working-tree scaling.

Git still tracks:

trees
commits
path metadata

globally.

4. Git LFS lazy hydration

Use: GIT_LFS_SKIP_SMUDGE=1
so binaries hydrate from lfs-server only when needed.



Rendering Model

Static pages are derived artifacts.

Incremental renderer updates only:

touched tag pages
affected pagination pages
image detail pages
derived feeds

Avoid:

full static rebuilds
What Actually Becomes Difficult

The indexing system is not the hardest part.

The hard parts at very large scale become:

- Git object counts
- filesystem inode pressure
- thumbnail generation
- deploy bandwidth
- repository maintenance
- LFS storage size

The NDJSON/event-log architecture largely solves:

metadata churn
incremental indexing complexity

which are the traditional booru pain points.

Final Architectural Summary

The recommended architecture is essentially:

Git:
  authoritative append-only event history

Git LFS:
  immutable binary storage

Indexer:
  incremental event consumer

Derived indexes:
  JSON initially
  SQLite/Bbolt later if needed

Renderer:
  incremental static site generator

Client:
  sparse checkout + partial clone + lazy hydration

That gives you:

git-native workflows
reproducibility
rebuildability
incremental updates
scalable indexing
optional backend sophistication
minimal operational complexity

while staying surprisingly lightweight for personal or archival-scale usage.


## HTTP Ingest Caveat

The `POST /ingest` endpoint uploads image bytes directly to the LFS server via the Batch API, writes the pointer file to `images/{id}.png`, appends an NDJSON event, and re-runs the indexer. It does **not** create a git commit.

This means:
- The binary exists on the LFS server at its OID
- The pointer file on disk is ready for `git add images/{id}.png && git commit`
- **Until committed**, the pointer file is untracked — committing it gives git ownership of the blob reference

## Image Filename & ID Convention

Images on disk use **sequential numeric IDs** as filenames:

```
images/1.png
images/2.png
images/3.png
```

The numeric ID serves as both the filename and the `id` field in NDJSON events. This was chosen over alternatives:

**OID-as-filename** (`images/907415...fea.png`):
- Content-addressed, no collisions, self-validating
- But: ugly long hex strings, filename changes if image is re-encoded

**UUID-as-filename** (`images/a1b2c3d4-...png`):
- Stable, no semantic meaning
- But: adds a generation step, opaque, no ordering

**Sequential numeric ID** (`images/1.png`):
- Clean, human-friendly, standard booru convention
- The ID in the event log IS the filename — no indirection
- Trivial to track: read max ID from the index, increment
- The OID remains a separate field used only for LFS blob retrieval

The philosophy: the event log is authoritative. The filename on disk is just a storage key — it carries no semantic weight. The simplest key is an integer.

The current design is pragmatic because the measurements show that ingestion cost is dominated by a stable, fixed overhead (~55-65ms per operation) coming primarily from process spawn and Git's index mutation, rather than any scaling factor related to repository size or NDJSON shard growth. This makes the system behavior predictable and operationally simple in the near term: throughput is bounded by a constant per-request cost rather than emergent complexity from large histories or large working trees. The benchmark results supporting this are documented here: https://github.com/eissar/git-performance-benchmarking/blob/main/bench.ts, where git add and update-index stabilize around ~63-64ms across varying repository sizes, with negligible file-read cost and no observed scaling degradation in the tested regime.

In the longer term, however, Git is intentionally being treated as a durability and history substrate rather than a synchronous ingestion dependency, and it will be decoupled from the ingest path once higher throughput or concurrency demands emerge. At that point, ingestion will shift to an asynchronous append-first pipeline while Git becomes a batched, background persistence layer, preserving the event-sourced model while removing Git from the critical request path.


Future considerations:

Query Architecture

Indexes become classic inverted indexes: tag -> posting list of image ids

Initially:
sorted integer arrays are fine

Later:
use roaring bitmaps
compressed posting lists

for fast:
intersection, exclusion, counts

This is where Bbolt/SQLite become useful.
