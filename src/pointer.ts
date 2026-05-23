import { dirname } from '@std/path';

const GIT_LFS_POINTER_SPEC_VERSION = 'version https://git-lfs.github.com/spec/v1';

/**
 * Writes a Git LFS pointer file to the given path, creating parent directories as needed.
 *
 * @param oid - The SHA-256 object identifier.
 * @param size - The byte size of the object.
 * @param path - Absolute path to write the pointer file to.
 * @returns The path that was written.
 */
export async function writePointerFile(oid: string, size: number, path: string): Promise<string> {
    const pointer = [
        GIT_LFS_POINTER_SPEC_VERSION,
        `oid sha256:${oid}`,
        `size ${size}`,
    ].join('\n');
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, pointer);
    return path;
}
