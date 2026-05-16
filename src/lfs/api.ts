export const LFS_MEDIA_TYPE = 'application/vnd.git-lfs+json';
export const LFS_CONTENT_MEDIA_TYPE = 'application/octet-stream';

const LFS_SERVER = 'http://localhost:8080';

export type Connection = {
    url: string;
    auth: string;
    user: string;
    repo: string;
};

const conn: Connection = {
    url: LFS_SERVER,
    auth: `Basic ${btoa('user:pass')}`,
    user: '',
    repo: '',
};

// Headers:
// Accept header (required on most endpoints):
// - application/vnd.git-lfs+json - For JSON metadata responses
// - application/octet-stream - For binary object content
//
//  Range header (optional):
// - Any valid HTTP Range header string (e.g., bytes=1024-) - For resumable downloads
//
//  Authorization header:
// - HTTP Basic authentication credentials - Required on all authenticated endpoints except /verify/{oid}
//
// NOTE: We do not support the <baseURL>/objects/... endpoints (omit user/repo)

// possible todo:
// POST /objects/batch (or POST /{user}/{repo}/objects/batch)
//  - Most important for real Git LFS flows (upload/download planning in one request).
// POST /objects (or scoped variant)
//  - Register metadata before PUT content; useful for legacy/single-object flow.
// HEAD /objects/{oid} with Accept: application/octet-stream + Range
//  - Better resumable download/existence checks for content workflows.
// POST /verify/{oid} (if you plan to support tus resumable uploads)
//  - Finalization step.
// Locking APIs (/locks, /locks/verify, /locks/{id}/unlock)
//  - Useful for teams and file-lock workflows; optional if you don’t need locking.
// /{user}/{repo} variants
//  - Add if you need multi-repo/multi-tenant support.

type UploadBaseInput = {
    baseUrl: string;
    oid: string;
    user: string;
    repo: string;
    authorization: string;
    headers?: HeadersInit;
    signal?: AbortSignal;
};

export type UploadMetaInput = UploadBaseInput & {
    size: number;
};

export type UploadContentInput = UploadBaseInput & {
    body: BodyInit;
};

// function objectUrl(baseUrl: string, user: string, repo: string, oid: string): URL {
//     const prefix = `/${encodeURIComponent(user)}/${encodeURIComponent(repo)}`;
//     return new URL(`${prefix}/objects/${encodeURIComponent(oid)}`, baseUrl);
// }

export type UploadInput = UploadMetaInput & {
    body: BodyInit;
};

function objectUrl(conn: Connection, oid: string): URL {
    if (conn.user !== '' || conn.repo !== '') {
        const prefix = `/${encodeURIComponent(conn.user)}/${encodeURIComponent(conn.repo)}`;
        return new URL(`${prefix}/objects/${encodeURIComponent(oid)}`, conn.url);
    }
    return new URL(`objects/${encodeURIComponent(oid)}`, conn.url);
}
// - PUT
//     - Upload/store raw object bytes (application/octet-stream) for that OID
//     - Returns 200 on success, 404 if metadata for OID not found, 500 on store failure
export async function PutObjectContent(conn: Connection, oid: string, body: BodyInit, h: HeadersInit) {
    const url = objectUrl(conn, oid);

    const requestHeaders = new Headers(h);
    requestHeaders.set('Content-Type', LFS_CONTENT_MEDIA_TYPE);
    requestHeaders.set('Accept', LFS_CONTENT_MEDIA_TYPE);
    requestHeaders.set('Authorization', conn.auth);

    return fetch(url, {
        method: 'PUT',
        headers: requestHeaders,
        body,
        // signal,
    });
}

// TODO: validate this is true
// we can accept a user/repo, but they are *ignored*
// it isn't validated when requesting metadata,
// its' a simple lookup by the ID

// - GET
//     - Accept: application/vnd.git-lfs+json → return JSON metadata (Representation) with hypermedia links
export async function GetObjectMeta(conn: Connection, oid: string, h: HeadersInit) {
    const url = objectUrl(conn, oid);

    const requestHeaders = new Headers(h);
    requestHeaders.set('Accept', LFS_MEDIA_TYPE);
    requestHeaders.set('Authorization', conn.auth);

    return fetch(url, {
        method: 'GET',
        headers: requestHeaders,
        // signal,
    });
}
// - GET
//     - Accept: application/octet-stream → download raw object bytes (supports Range, can return 206)
export async function GetObjectContent(conn: Connection, oid: string, h: HeadersInit) {
    const url = objectUrl(conn, oid);

    const requestHeaders = new Headers(h);
    requestHeaders.set('Accept', LFS_CONTENT_MEDIA_TYPE);
    requestHeaders.set('Authorization', conn.auth);

    return fetch(url, {
        method: 'GET',
        headers: requestHeaders,
        // signal,
    });
}

// returns
// {"oid":"b8bb6fd3a1de6dfdb848bca774c3657c61986e47b6130d1f017808dbf05be77a","size":3574,"actions":{"download":{"href":"http://localhost:8080/objects/b8bb6fd3a1de6dfdb848bca774c3657c61986e47b6130d1f017808dbf05be77a","header":{"Accept":"application/vnd.git-lfs"},"expires_at":"0001-01-01T00:00:00Z"}}}
// useful for existence/range checks
export async function HeadObjectMeta(conn: Connection, oid: string, h: HeadersInit) {
    const url = objectUrl(conn, oid);

    const requestHeaders = new Headers(h);
    requestHeaders.set('Accept', LFS_MEDIA_TYPE);
    requestHeaders.set('Authorization', conn.auth);

    return fetch(url, {
        method: 'HEAD',
        headers: requestHeaders,
        // signal,
    });
}

const id = 'b8bb6fd3a1de6dfdb848bca774c3657c61986e47b6130d1f017808dbf05be77a';
const a = await GetObjectMeta(conn, id, []);

// const a = await PutObjectContent(
//     conn,
//     'b8bb6fd3a1de6dfdb848bca774c3657c61986e47b6130d1f017808dbf05be77a',
//     Deno.readFileSync('/home/eissar/example-images/1.png'),
//     [],
// );
console.log(await a.text());
