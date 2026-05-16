This file inventories what exists in the codebase.

## Implemented Features

### HTTP Server (`test.ts`, 27 lines)
- Serves on port 8000 via Deno's std lib `serve`
- Provides three routes: GET / (gallery), GET /image/:oid (LFS proxy), POST /ingest (upload)
- Handles 404 catch-all for unknown paths
- Logs requests to console

### Ingest Pipeline (`handlers.ts`)
- POST /ingest accepts multipart/form-data with image, name, tags, width, height, mtime
- Computes SHA-256 of uploaded bytes as LFS OID
- Deduplicates: if OID already exists in index, returns existing ID (200)
- Performs two-step LFS upload via Batch API (POST /objects/batch then PUT to upload URL)
- Writes LFS pointer file to `images/{id}.png`
- Appends NDJSON event line to `events/2026-05.ndjson` (op:"add")
- Synchronously runs `git add -- images/{id}.png events/2026-05.ndjson`
- Synchronously runs `git commit -m "ingest: add image {id}" -- images/{id}.png events/2026-05.ndjson`
- Does **not** run `indexer.ts` during ingest (indexing remains a separate step)
- Surfaces LFS, `git add`, and `git commit` failures as JSON HTTP errors

### Indexer (`indexer.ts`, 106 lines)
- Runs as a standalone Deno script
- Reads every `.ndjson` file in `events/` from disk
- Rebuilds in-memory `imageState` (Record<string, ImageState>) and `tagIndex` (Record<string, string[]>)
- Handles 4 event operations: add, tag_add, tag_remove, delete
- Writes `index/image_state.json` and `index/tag_index.json` (full overwrite each run)
- Does not use `git` commands, cursor tracking, or incremental processing

### LFS Proxy (`handlers.ts`)
- FetchImageFromLFS(oid): proxies GET /objects/{oid} from LFS server
- PushImageToLFS(oid, bytes): performs two-step upload, handles already-exists case
- Configures LFS server at `http://localhost:8080` (`.lfsconfig`)
- Uses hardcoded `user:pass` basic auth

### Git Configuration
- `.gitattributes`: marks `.png`, `.jpg`, `.gif` for LFS; excludes `*.thumbnail.png`
- `.lfsconfig`: points to local LFS server

### Runtime Data (on disk)
- `events/2026-05.ndjson` — contains 3 events (add 1, add 2, add 3)
- `images/1.png`, `images/3.png` — contain LFS pointer files (image 2's pointer missing)
- `index/image_state.json` — holds 3 entries
- `index/tag_index.json` — maps 3 tags to IDs
