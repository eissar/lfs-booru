# Current Project State

This file inventories the current codebase as of 2026-05-17.

## Runtime Shape

The project is a Deno-based image booru prototype backed by:

- a local Git repository per library
- Git LFS pointer files for image paths under `images/`
- an external `lfs-test-server` on `http://localhost:8080`
- append-only NDJSON event logs under `events/`
- materialized JSON indexes under `index/`

The active hardcoded library is:

```ts
{ path: '/home/eissar/code/lfs-booru/libraries/new/' }
```

The active hardcoded LFS connection is:

```ts
{
  url: 'http://localhost:8080',
  auth: `Basic ${btoa('user:pass')}`,
  user: 'USER',
  repo: 'REPO',
}
```

## Deno Configuration

`deno.json` defines:

- task `run`: `deno run --allow-all ./index.ts`
- import alias `@/` -> `./src/`
- dependencies/imports:
  - `@std/path` from JSR
  - `simple-git` from npm
- formatting preferences: 4-space indent, single quotes, 120-column line width

## HTTP Server (`index.ts`)

`index.ts` starts a Deno server on port `8000` when run directly.

Routes:

- `GET /`
  - calls `Index(lib)` from `handlers.ts`
  - reads `lib.path/index/image_state.json`
  - renders a simple HTML gallery
- `GET /image/:oid`
  - proxies raw image content from LFS via `GetObjectContent(conn, oid)`
- `POST /ingest`
  - accepts multipart upload and calls `Ingest(req, lib, conn)`
- anything else returns `404 Not Found`

The server currently uses hardcoded `lib` and `conn` values.

## Library Connection (`src/library.ts`)

`LibraryConnection` is currently minimal:

```ts
type LibraryConnection = {
  path: string;
};
```

Most library-aware code now accepts this connection and resolves paths relative to `conn.path` / `lib.path` instead of assuming the process current working directory.

## Git Library Initialization (`src/git.ts`)

`Init(repoPath)` initializes a booru library by cloning `libraries/template`.

Behavior:

- resolves the static template at `../libraries/template`
- runs `git clone` with `GIT_LFS_SKIP_SMUDGE=1`
- appends local Git config:
  ```ini
  [lfs]
      skipSmudge = true
  ```
- adds an `upstream` remote pointing to `https://github.com/USER/REPO.git`
- returns `null` on success or an `Error` on clone failure

It intentionally does not run `git lfs` commands.

## Template Library (`libraries/template`)

The template contains Git/LFS config used for cloned libraries.

`.gitattributes` stores image files in LFS:

- `images/**/*.png`
- `images/**/*.jpg`
- `images/**/*.jpeg`
- `images/**/*.gif`
- `images/**/*.webp`

`.lfsconfig` currently points to:

```ini
[lfs]
    url = http://localhost:8080
    fetchexclude = *
```

Note: the application's direct LFS API calls use the repo-prefixed connection fields `USER/REPO`; `.lfsconfig` is still bare-root oriented.

## LFS API Wrapper (`src/lfs/api.ts`)

Exports `Connection`:

```ts
type Connection = {
  url: string;
  auth: string;
  user: string;
  repo: string;
};
```

Implemented helpers:

- `PutObjectMeta(conn, oid, size, headers?)`
  - `POST /{user}/{repo}/objects`
  - registers metadata before content upload
  - uses `Accept`/`Content-Type: application/vnd.git-lfs+json`
- `PutObjectContent(conn, oid, body, headers?)`
  - `PUT /{user}/{repo}/objects/{oid}`
  - uploads bytes
  - uses `Accept`/`Content-Type: application/vnd.git-lfs`
- `GetObjectMeta(conn, oid, headers?)`
  - `GET /{user}/{repo}/objects/{oid}` with metadata media type
- `GetObjectContent(conn, oid, headers?)`
  - `GET /{user}/{repo}/objects/{oid}` with content media type
- `HeadObjectMeta(conn, oid, headers?)`
  - `HEAD /{user}/{repo}/objects/{oid}` with metadata media type

The repo-prefixed URLs are important for `lfs-test-server` compatibility.

## Ingest Pipeline (`handlers.ts`)

### `internalIngest(bytes, lib, conn, event, size)`

The core ingest function now accepts both:

- `lib: LibraryConnection` for local repo/index/event paths
- `conn: LFS Connection` for remote LFS operations

Current flow:

1. Builds a Git LFS pointer file for `event.oid` and `size`.
2. Registers object metadata in LFS via `PutObjectMeta(conn, event.oid, size)`.
3. Uploads object bytes via `PutObjectContent(conn, event.oid, new Blob([bytes]))`.
4. Creates local directories as needed under `lib.path`.
5. Writes pointer file to `lib.path/event.path`, e.g. `images/1.png`.
6. Appends the add event to `lib.path/events/2026-05.ndjson`.
7. Runs `git add` for the pointer file and event log.
8. Runs `git commit -m "booru: add image {id}"`.

On LFS or Git failure it returns a JSON `Response` error. On success it returns `void`.

### `Ingest(req, lib, conn)`

HTTP multipart ingest handler:

- expects file field `image`
- computes SHA-256 OID locally
- reads `lib.path/index/image_state.json` if present for dedupe and next-ID selection
- returns existing ID with `200` if an indexed image has the same OID
- accepts optional fields:
  - `name`
  - `tags` as a JSON array string
  - `width`
  - `height`
  - `mtime`
- creates an `op: 'add'` event
- calls `internalIngest(...)`
- returns `{ id: nextId }` with status `201` on success

Important limitation: dedupe depends on the materialized index. If `index/image_state.json` is stale or missing, duplicate object detection may not work.

### `Index(lib)`

Simple gallery renderer:

- reads `lib.path/index/image_state.json`
- renders image cards with name, tags, dimensions, and `/image/:oid` source URLs

It does not rebuild indexes; `indexer.ts` must be run separately.

## Indexer (`indexer.ts`)

The indexer now accepts a `LibraryConnection`.

Main export:

```ts
processEvents(conn: LibraryConnection): Promise<IndexResult>
```

Behavior:

- creates `conn.path/index/` if needed
- reads all `.ndjson` files from `conn.path/events/`
- sorts event files for deterministic replay
- replays events into in-memory indexes
- writes full materialized views:
  - `conn.path/index/image_state.json`
  - `conn.path/index/tag_index.json`
- returns counts:
  - image count
  - tag count
  - event file count
  - event count

Supported event operations:

- `add`
- `tag_add`
- `tag_remove`
- `delete`

IDs are normalized to strings in the materialized indexes.

When run as a standalone script:

```bash
deno run --allow-all indexer.ts [library-path]
```

If no path is provided, it defaults to `libraries/new` relative to the project directory.

Current implementation is still full-rebuild, not incremental/watch-based.

## Test / Bootstrap Script (`src/test_InitWith5Images.ts`)

This script initializes a fresh library and ingests 5 PNG images from `~/example-images`.

Behavior:

1. Removes `/home/eissar/code/lfs-booru/libraries/new/` if it exists.
2. Calls `Init(lib.path)`.
3. Reads sorted PNG paths from `~/example-images`.
4. Requires at least 5 PNGs and uses the first 5 sorted paths.
5. For each image:
   - reads bytes
   - computes SHA-256 OID
   - extracts PNG width/height from the PNG header
   - reads file `mtime`
   - builds an `op: 'add'` event with IDs `1..5`
   - calls `internalIngest(bytes, lib, conn, event, bytes.byteLength)`
6. Prints detailed timing information:
   - setup timings: remove, init, image discovery
   - per-image timings: read, hash, dimensions, stat, ingest, total
   - aggregate totals and full script time

It requires `lfs-test-server` to be running on `localhost:8080`.

Known current selection behavior: lexicographic sort means names like `1.png`, `10.png`, `2.png` sort in that order.

## Legacy / Scratch Script (`test.ts`)

`test.ts` is no longer the main HTTP server. It currently reads `~/example-images/1.png`, computes its SHA-256 OID, and prints it. It appears to be scratch/debug code.

## Runtime Data Layout

A populated library such as `libraries/new/` contains:

- `.git/`
- `.gitattributes`
- `.lfsconfig`
- `images/{id}.png`
  - LFS pointer files, not raw image bytes
- `events/2026-05.ndjson`
  - append-only event log
- `index/image_state.json`
  - materialized image state generated by `indexer.ts`
- `index/tag_index.json`
  - materialized tag index generated by `indexer.ts`

Raw image bytes live in the external LFS server content store.

## Verified Commands Recently Used

These commands have type-checked successfully:

```bash
deno check indexer.ts index.ts src/test_InitWith5Images.ts
```

The 5-image bootstrap script has run successfully against a local `lfs-test-server`:

```bash
deno run --allow-all src/test_InitWith5Images.ts
```

The indexer has run successfully after bootstrapping:

```bash
deno run --allow-all indexer.ts
```

Example result:

```text
Indexed 5 images, 0 tags from 5 events in 1 files
```

## Important Current Limitations / TODOs

- `index.ts` still uses hardcoded library and LFS connection values.
- Event log path is hardcoded to `events/2026-05.ndjson`.
- The indexer is full-rebuild only; no filesystem watcher or incremental cursor yet.
- Ingest dedupe relies on an existing/current `index/image_state.json`.
- `Index(lib)` assumes `index/image_state.json` exists and will throw if it does not.
- The HTTP server does not automatically run the indexer after ingest.
- The gallery HTML is minimal and not escaped/sanitized.
- No thumbnail generation exists yet.
- No static renderer exists yet.
- No auth/config layer exists for choosing libraries or LFS remotes at runtime.
