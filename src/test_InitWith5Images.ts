import { PutObjectContent } from '@/lfs/api.ts';
import { panic } from '@/util.ts';
import { LibraryConnection } from '@/library.ts';
import { Init } from '@/git.ts';
import { GitConstructError } from 'simple-git';
import { debug } from './logging.ts';

for (const type of ['unhandledrejection', 'error']) {
    globalThis.addEventListener(type, (e) => {
        console.error('Exiting... Unhandled:', e);
        Deno.exit(1);
    });
}

if (!import.meta.dirname) panic('ran wrong');

const lib: LibraryConnection = {
    path: '/home/eissar/code/lfs-booru/libraries/new/',
};

if (import.meta.main) {
    // we create from scratch every time.
    // also this is run from cli
    // if (!confirm(`you are going to delete the path at ${lib.path}. continue?`)) Deno.exit(0);

    await Deno.remove(lib.path, { recursive: true })
        .catch((e) => {
            // debug(e);
            if (!(e instanceof Deno.errors.NotFound)) throw e;
        });

    await Init(lib.path)
        .catch((e) => {
            if (e instanceof GitConstructError) panic(`attention: invalid application state or git not on PATH`);
        });
}

// Debug(Deno.readDirSync(`${lib}/images`));
// console.log('Server running on http://localhost:8000');
// await serve(handler, { port: 8000 });

// const id = 'b8bb6fd3a1de6dfdb848bca774c3657c61986e47b6130d1f017808dbf05be77a';
// const a = await GetObjectMeta(conn, id, []);

// const a = await PutObjectContent(
//     conn,
//     'b8bb6fd3a1de6dfdb848bca774c3657c61986e47b6130d1f017808dbf05be77a',
//     Deno.readFileSync('/home/eissar/example-images/1.png'),
//     [],
// );
// console.log(await a.text());
