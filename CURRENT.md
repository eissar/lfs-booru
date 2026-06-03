> Snapshot commit: HASH:e566dc8a2f84a2cdf8841283012bc306aa55e5c2

# Codebase Snapshot

## Purpose

This repository is a Deno-based booru prototype. It stores media and generated thumbnails in Git LFS-backed library repositories, records metadata as append-only NDJSON event shards, materializes JSON indexes for reads, and renders the gallery UI with server-side HTML plus HTMX fragments.

The committed event log is the metadata source of truth. JSON index files, replay cursors, and rendered HTML artifacts are derived local state.

## Runtime Entry Points

- `server.ts` starts the application server and is the target of `deno task run`
- `src/indexer.ts` exports `processEvents`, which replays committed events into the derived store during startup when replay is needed
- `src/eagle-import.ts` imports an Eagle `.eaglepack` archive or `.library` directory when `--pack` is provided
- `scripts/dump_types.ts` prints the TypeScript declaration surface under `src/`
- `scripts/render_lint_artifacts.ts` generates representative HTML artifacts for CSS linting
- `scripts/find_unused_css.ts` scans CSS selectors against generated artifacts
- `scripts/read_json_sync_bench.ts` creates `scripts/big.internal.json` if absent and benchmarks large JSON read and parse behavior
- `scripts/smoke_thumbnail.ts` uses Playwright against a running server to check thumbnail error display behavior
- `src/test_InitWith5Images.ts` is a five-image ingestion timing script that reads files from `$HOME/example-images`

## Configuration

`deno.json` defines these tasks:

```json
{
    "run": "deno run --allow-all ./server.ts",
    "run:clean": "deno task run -A --clear-artifacts",
    "lint-artifacts": "deno run --allow-all scripts/render_lint_artifacts.ts && deno run --no-lock -A npm:stylelint 'static/**/*.css' '.lint-artifacts/**/*.css'"
}
```

Relevant import map entries include Deno standard modules, `@core/asyncutil`, `mediaforge`, `simple-git`, `zip-js`, Preact/JSX, and the `@/` alias for `./src/`. TypeScript strict mode is enabled with Preact JSX (`react-jsx`). Formatter settings use four-space indentation, single quotes, 120-column width, and exclude Markdown and JSON.

CLI flags and environment variables:

| Flag | Env var | Default |
|---|---|---|
| `--port` | `BOORU_PORT` | `8000` |
| `--lib` | `BOORU_LIBRARY` | `$XDG_DOCUMENTS_DIR/Libraries/Default` or `$HOME/Documents/Libraries/Default` |
| `--pack` | — | unset |
| `--clear-artifacts` | — | `false` |
| `--rebuild-index` | — | `false` |

`.env` is loaded by `src/cli.ts`. `--lib` and `--pack` support `~/` expansion and are resolved to absolute paths.

The checked-in `libraries/template/.lfsconfig` sets `lfs.url = http://localhost:8080`, includes `thumbnails/**` for LFS fetches, and excludes `images/**` from default fetches.

## Source Structure

```text
server.ts                         HTTP startup, route dispatch, ingest, image serving, thumbnail regeneration
src/
  cli.ts                          CLI/env parsing and path normalization
  cli.internal.ts                 LFS-oriented flag parser used by scripts and tooling
  eagle-import.ts                 Eagle archive/library import into batched event append
  event_log.ts                    EventLog interfaces and NDJSON append/read implementation
  git.ts                          Library initialization and Git stage/commit helpers
  html.ts                         Tagged template helper for HTML string construction
  indexer.ts                      Event types and event replay orchestration
  index_store.ts                  DerivedIndexStore interface and JSON-file implementation
  ingest.ts                       Media detection, hashing, file writes, thumbnail generation, add-event construction
  library.ts                      LibraryConnection type alias
  logging.ts                      console.log duplication to app.log and debug/trace helpers
  pointer.ts                      Git LFS pointer helper utilities
  renderer.tsx                    HtmlRenderer interface and file-backed gallery-page cache
  thumbnail.ts                    FFmpeg/mediaforge thumbnail generation
  template/                       Gallery page, item card, inspector, and photo-grid templates
  types/                          Preact JSX type augmentations
static/
  gallery.css                     Theme, masonry grid, inspector, and component styles
scripts/                          Type dump, CSS lint artifacts/scanner, benchmarks, smoke checks
libraries/template/               Clone source for user library repositories
```

## Key Modules

### HTTP server (`server.ts`)

Startup parses flags, initializes a library repository with `Init`, optionally clears renderer artifacts, creates `JsonFileIndexStore`, `NdjsonEventLog`, and `CachingHtmlRenderer`, initializes or rebuilds derived indexes when requested or incomplete, optionally imports an Eagle source, and serves requests with `Deno.serve`.

Routes:

| Pattern | Method | Behavior |
|---|---:|---|
| `/` | any | Redirects to `/gallery` with status 302 |
| `/gallery?q=...` | any | Parses search tokens; `#tag` tokens become repeated `tags` parameters, other tokens become `keyword` |
| `/gallery` | any | Renders the gallery shell with page size, sort, filter chips, upload form, and inspector shell |
| `/fragment/items` | any | Lists images from the derived store and returns a photo-grid fragment |
| `/fragment/inspect/:id` | any | Looks up an image by numeric ID and returns the inspector fragment |
| `/ingest` | POST | Parses multipart upload, writes media and thumbnail files, appends and commits an add event, applies the event |
| `/regen-thumbnail?id=...` | any | Regenerates a thumbnail, appends and commits a `regen_thumbnail` event, applies the event |
| `/image/:oid` | any | Serves a thumbnail file when present, otherwise resolves the image by OID and reads the local Git LFS object |
| `/static/*` | any | Serves files from `./static` |
| other paths | any | Returns 404 text |

Request logging is added by `withLogging`, and `logging.ts` duplicates `console.log` output to `app.log`.

### Event log (`src/event_log.ts`)

`EventLog` supports single-event appends, rollback-protected appends (`appendWithRollback`), and rollback-protected prepared NDJSON file appends (`appendPreparedFileWithRollback`). `EventLogReader` exposes cursor-based replay. `ReplayableEventLog` extends `EventLog` with `replayFrom`. `NdjsonEventLog` writes monthly shards at `events/<yyyy-mm>.ndjson`, uses a process-local mutex for appends, truncates appended bytes on protected-operation failure, and reads sorted `.ndjson` shards from an optional `{ eventFile, byteOffset }` cursor.

### Derived index store (`src/index_store.ts`)

`DerivedIndexStore` covers cursor persistence, readiness checks, empty-index creation, image and OID lookups, event application, batch-event application, ID allocation, item listing, stats, and close. `JsonFileIndexStore` stores derived state as JSON files and text files under the library root.

Key behavior:

- `isInitialized()` requires `index/image_state.json`, `index/tag_index.json`, and a valid integer `index/next_image_id`
- `initializeEmptyIndex()` creates `images/`, `events/`, and `index/`, writes empty JSON indexes, resets `next_image_id` to `1`, and removes `event_cursor`
- `applyEvent()` and `applyEventsFromFile()` update image state, tag index, and cursor
- add events reconcile `next_image_id` from committed IDs
- `listItems()` loads all image state, sorts by ID or `addedAt`, filters by tag membership, applies offset, and yields up to `limit` records
- JSON writes use a temporary file followed by `Deno.rename` per file

### Indexer (`src/indexer.ts`)

The event model includes `add`, `tag_add`, `tag_remove`, `delete`, `regen_thumbnail`, and `update_metadata`.

`processEvents(store, eventLog)` requires `eventLog instanceof NdjsonEventLog`, reads events from `store.getCursor()`, applies each event through the store, then returns image, tag, and event counts. The `eventFiles` counter exists in the result type but is not populated.

### Ingest (`src/ingest.ts`)

`ingest()` reads a `File`, computes a SHA-256 OID, reserves an image ID, detects the media extension from magic bytes, derives content type from extension, writes the original file to `images/{id}.{ext}`, generates a JPEG thumbnail, writes it to `thumbnails/{thumbnailOid}.jpg`, and returns an `add` event plus the raw bytes to persist.

Supported magic-byte detection covers PNG, JPEG, GIF, WebP, AVI, FLV, OGV, MPEG program/video streams, WMV/ASF, ISO base media variants (`mp4`, `mov`, `3gp`, `m4v`, `avif`), and EBML variants (`webm`, `mkv`).

### Thumbnailing (`src/thumbnail.ts`)

Thumbnails are generated through `mediaforge` and FFmpeg. Video inputs extract a frame at one second. Image inputs use FFmpeg resizing. Outputs are JPEG at `320x320` with quality `85`. The thumbnail OID is the SHA-256 digest of the JPEG bytes.

### Eagle import (`src/eagle-import.ts`)

`openEaglePack()` extracts a `.eaglepack` zip archive to a temp directory and yields `[metadata, bytes]` from `<id>.info/` directories. `ingestFromEagleSource()` reads either a `.library/images` directory or `.eaglepack` archive, ingests each item, writes events into a prepared NDJSON temp file, appends the prepared file to the source event log with rollback around one Git commit, and applies the prepared events as a batch via `applyEventsFromFile`.

### Git and library initialization (`src/git.ts`)

`Init(repoPath)` is idempotent when `.git` already exists. Otherwise it clones `libraries/template` with `GIT_LFS_SKIP_SMUDGE=1`, appends local `lfs.skipSmudge = true`, and adds an `upstream` remote placeholder. `stageAndCommit(paths, message, lib)` runs `git add` and `git commit` through `simple-git`.

### Rendering (`src/renderer.tsx`, `src/template/`)

`CachingHtmlRenderer` renders item cards, gallery pages, inspector fragments, and photo-grid fragments using Preact JSX templates. Gallery pages are cached under `index/artifacts/gallery-pages` keyed by a SHA-1 hash of renderer version and input filter. Item cards, inspector fragments, and photo-grid fragments are not cached by the renderer.

Templates use HTMX for upload, lazy item loading, pagination, filter chip updates, inspector loading, and thumbnail regeneration. `static/gallery.css` provides light and dark themes, masonry columns, component styles, and inspector layout.

### Utility (`src/util.ts`)

Exports `panic` for fatal termination, `isInt` as a safe-integer type guard, and `c` response helpers (`json`, `text`, `blob`, `html`, `error`, `redirect`). The `c` helpers form the HTTP response layer used throughout `server.ts`.

## Core Flows

### Server startup

```text
server.ts
  -> getFlags()
  -> Init(library path)
  -> optionally remove index/artifacts
  -> create JsonFileIndexStore
  -> create NdjsonEventLog
  -> create CachingHtmlRenderer
  -> if --rebuild-index or store.isInitialized() is false:
       initializeEmptyIndex()
       processEvents(store, eventLog)
  -> if --pack is set:
       ingestFromEagleSource(...)
  -> Deno.serve({ port }, withLogging(createHandler(...)))
```

### HTTP ingest

```text
POST /ingest multipart form
  -> require image file field and JSON tags array
  -> call ingest(): hash bytes, reserve ID, detect extension, write media, generate/write thumbnail
  -> append add event to events/{yyyy-mm}.ndjson with rollback around Git commit
  -> git add event shard, media file, thumbnail file
  -> git commit -m "booru: add image {id}"
  -> store.applyEvent(event, appendResult.cursor)
  -> return text "ok" with status 201
```

### Eagle import

```text
startup with --pack
  -> read .library/images or extract .eaglepack
  -> ingest each valid entry into images/ and thumbnails/
  -> write each add event to a prepared NDJSON temp file
  -> append the prepared file into the monthly event shard with rollback around Git commit
  -> git add event shard and all media/thumbnail paths
  -> store.applyEventsFromFile(...)
```

### Gallery and image serving

```text
GET /gallery
  -> render gallery shell and filter controls
  -> browser HTMX-loads /fragment/items
  -> store.listItems(limit, offset, tags, sort)
  -> render item cards and photo-grid fragment
  -> HTMX swaps grid content

GET /fragment/inspect/{id}
  -> store.getImage(id)
  -> render inspector fragment

GET /image/{oid}
  -> if thumbnails/{oid}.jpg exists and is not a pointer, return it
  -> if thumbnail path is a pointer, run git lfs pull for that path then return it
  -> otherwise map original OID to image state, git lfs pull for image, read .git/lfs/objects/{oid[0:2]}/{oid[2:4]}/{oid}
```

### Replay

```text
processEvents
  -> require NdjsonEventLog
  -> read cursor from JsonFileIndexStore
  -> read sorted NDJSON shards after the cursor
  -> JSON.parse each line
  -> store.applyEvent(event, nextCursor)
  -> stats()
```

## Persistence

A library repository created from `libraries/template` contains:

```text
{library}/
  .git/                         Git repository metadata and local LFS objects
  .gitattributes                LFS filters for images and thumbnails
  .gitignore                    Ignores derived index files and event_cursor
  .lfsconfig                    LFS URL and include/exclude defaults
  events/*.ndjson               Committed metadata event shards
  images/*                      Git LFS-tracked original media files
  thumbnails/*.jpg              Git LFS-tracked generated JPEG thumbnails
  index/next_image_id           Derived write-path ID allocator
  index/image_state.json        Derived image state
  index/tag_index.json          Derived tag index
  index/artifacts/gallery-pages  Cached gallery HTML
  event_cursor                  Derived replay checkpoint
```

`libraries/`, `.lint-artifacts/`, logs, environment files, and `*.internal.*` are ignored by the application repository's `.gitignore`.

## Scripts and Utilities

- `scripts/dump_types.ts` builds a TypeScript program over `src/` and prints public declarations plus internal signatures
- `scripts/render_lint_artifacts.ts` writes representative gallery, card, and photo-grid HTML under `.lint-artifacts/`
- `scripts/find_unused_css.ts` compares CSS selectors against generated content and can fail on possibly unused selectors
- `scripts/read_json_sync_bench.ts` measures large JSON index read behavior using `scripts/big.internal.json`
- `scripts/smoke_thumbnail.ts` checks that thumbnail-generation failure text reaches the upload result area in the browser
- `src/test_InitWith5Images.ts` measures Git and event ingest timing for five PNG files in a fresh local library
- `build.internal.sh` sends keystrokes to a tmux pane to restart the server with `--clear-artifacts` and a local library path

## Implementation Constraints

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