export const LFS_MEDIA_TYPE = 'application/vnd.git-lfs+json';

export const LFS_CONTENT_MEDIA_TYPE = 'application/vnd.git-lfs';

export type LfsConnection = {
    url: string;
    auth: string;
    user: string;
    repo: string;
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

function objectsUrl(conn: LfsConnection): URL {
    if (conn.user !== '' || conn.repo !== '') {
        const prefix = `/${encodeURIComponent(conn.user)}/${encodeURIComponent(conn.repo)}`;
        return new URL(`${prefix}/objects`, conn.url);
    }
    return new URL('objects', conn.url);
}

function objectUrl(conn: LfsConnection, oid: string): URL {
    return new URL(`${objectsUrl(conn).pathname}/${encodeURIComponent(oid)}`, conn.url);
}
/**
 * Register object metadata with the LFS server (POST batch).
 *
 * @param conn LFS server connection.
 * @param oid SHA-256 hex digest of the object.
 * @param size Object size in bytes.
 * @param h Optional additional request headers.
 * @returns The LFS server response.
 */
export async function PutObjectMeta(conn: LfsConnection, oid: string, size: number, h?: HeadersInit) {
    const url = objectsUrl(conn);

    const requestHeaders = new Headers(h);
    requestHeaders.set('Content-Type', LFS_MEDIA_TYPE);
    requestHeaders.set('Accept', LFS_MEDIA_TYPE);
    requestHeaders.set('Authorization', conn.auth);

    return fetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ oid, size }),
    });
}

/**
 * Upload raw object bytes to the LFS server (PUT).
 *
 * Object metadata must already be registered via {@link PutObjectMeta}.
 *
 * @param conn LFS server connection.
 * @param oid SHA-256 hex digest of the object.
 * @param body Object content.
 * @param h Optional additional request headers.
 * @returns The LFS server response (200 on success, 404 if metadata not found).
 */
export async function PutObjectContent(conn: LfsConnection, oid: string, body: BodyInit, h?: HeadersInit) {
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

/**
 * Retrieve object metadata from the LFS server (GET JSON).
 *
 * @param conn LFS server connection.
 * @param oid SHA-256 hex digest of the object.
 * @param h Optional additional request headers.
 * @returns The LFS server response with hypermedia links.
 */
export async function GetObjectMeta(conn: LfsConnection, oid: string, h?: HeadersInit) {
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
/**
 * Download raw object bytes from the LFS server (GET binary).
 *
 * Supports `Range` headers for resumable downloads.
 *
 * @param conn LFS server connection.
 * @param oid SHA-256 hex digest of the object.
 * @param h Optional additional request headers.
 * @returns The LFS server response with the object body.
 */
export async function GetObjectContent(conn: LfsConnection, oid: string, h?: HeadersInit) {
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

/**
 * Check object existence and metadata via HEAD.
 *
 * @param conn LFS server connection.
 * @param oid SHA-256 hex digest of the object.
 * @param h Optional additional request headers.
 * @returns The LFS server response (status and headers only, no body).
 */
export async function HeadObjectMeta(conn: LfsConnection, oid: string, h?: HeadersInit) {
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
