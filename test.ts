// deno-lint-ignore-file no-import-prefix
import { assert } from 'https://deno.land/std@0.190.0/_util/asserts.ts';

for (const type of ['unhandledrejection', 'error']) {
    globalThis.addEventListener(type, (e) => {
        console.error('Exiting... Unhandled:', e);
        Deno.exit(1);
    });
}

const home = Deno.env.get('HOME');
assert(home, 'missing home env var');
const image = await Deno.realPath(`${home}/example-images/1.png`);

const bytes: Uint8Array = Deno.readFileSync(image);
assert(bytes.buffer instanceof ArrayBuffer); // coerce ArrayBuffer|SharedArrayBuffer to ArrayBuffer

const hashBuffer = await crypto.subtle.digest('SHA-256', bytes.buffer);
const hashArray = Array.from(new Uint8Array(hashBuffer));
const oid = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
console.log(oid);
//
//
//
//
//
// PushImageToLFS(testImage.
