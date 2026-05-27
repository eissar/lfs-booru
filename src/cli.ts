import { load } from '@std/dotenv';
import { parseArgs } from '@std/cli/parse-args';
import { resolve } from '@std/path';
import { panic } from './util.ts';

// constants
const DEFAULT_PORT = '8000';
const DEFAULT_LFS_SERVER = 'http://localhost:8080';
const DEFAULT_LFS_AUTH = `Basic ${btoa('user:pass')}`;
// load env
await load({ envPath: '.env', export: true });
const HOME = Deno.env.get('HOME') || Deno.env.get('USERPROFILE');

// load xdg dirs
// https://wiki.archlinux.org/title/XDG_user_directories
//
// we won't be able to do this by parsing
// the file since we would need to implement
// sourcing / expanding any env var somehow
//
// $XDG_CONFIG_HOME  $HOME/.config.
// $XDG_DATA_HOME    $HOME/.local/share.
// $XDG_STATE_HOME   $HOME/.local/state.
// $XDG_CACHE_HOME   $HOME/.cache.
// const XDG_CONFIG_HOME = Deno.env.get('XDG_CONFIG_HOME') || `${HOME}/.config`;
// await load({ envPath: resolve(XDG_CONFIG_HOME, 'user-dirs.dirs'), export: true });

const DOCS = Deno.env.get('XDG_DOCUMENTS_DIR') || `${HOME}/Documents`;
const DEFAULT_BOORU_LIBRARY_PATH = `${DOCS}/Libraries/Default`;

/**
 * Read an environment variable or throw if it is unset or empty.
 *
 * @param name Environment variable name.
 * @returns The environment variable value.
 * @throws Error when the variable is missing or empty.
 */
export function mustGetEnv(name: string): string {
    const v = Deno.env.get(name);
    if (!v) throw new Error(`Missing env var: ${name}`);
    return v;
}

/**
 * Parsed command-line flags for the application.
 */
export interface CliFlags {
    /** @default http://localhost:8080 */
    lfsserver: string;
    /** @default `Basic ${btoa('user:pass')}` */
    lfsauth: string;
    /** @default 8000 */
    port: number;
    /** path to the library */
    lib: string;
    /** optional path to an .eaglepack archive to import on startup */
    pack?: string;
    /** remove cached renderer artifacts before startup */
    clearArtifacts: boolean;
    /** reset derived index artifacts and replay committed events from the beginning */
    rebuildIndex: boolean;
}

function parsePort(port: string): number {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new TypeError(`Cannot parse port "${port}": expected an integer from 1 to 65535`);
    }
    return parsed;
}

const flagDefaults = {
    'lfsserver': DEFAULT_LFS_SERVER,
    'lfsauth': DEFAULT_LFS_AUTH,
    'port': DEFAULT_PORT,
    'lib': DEFAULT_BOORU_LIBRARY_PATH,
    'pack': undefined as string | undefined,
} as const;

type PrefArr = keyof typeof flagDefaults;

/**
 * Parses process command-line flags.
 * Does not yet do complete validation
 *
 * preference hierarchy: config file (TODO) -> env -> explicitly passed as flag
 *
 * @returns Parsed command-line flags.
 */
export function getFlags(): CliFlags {
    const flags = parseArgs(Deno.args, {
        string: Object.keys(flagDefaults) as PrefArr[],
        boolean: ['clear-artifacts', 'rebuild-index'],
        default: { 'clear-artifacts': false, 'rebuild-index': false },
    });

    // fallback values if a flag is unset
    const lfsserver = Deno.env.get('BOORU_LFS_SERVER') ?? flagDefaults.lfsserver;
    const lfsauth = Deno.env.get('BOORU_LFS_AUTH') ?? flagDefaults.lfsauth;
    const port = Deno.env.get('BOORU_PORT') ?? flagDefaults.port;
    let lib = Deno.env.get('BOORU_LIBRARY') ?? flagDefaults.lib;
    // optional ,no fallback
    let pack = flags.pack;

    if (Deno.env.has('BOORU_LIBRARY')) flags.lib = Deno.env.get('BOORU_LIBRARY') as string;

    lib = flags.lib ?? lib;

    // normalize input here
    if (lib.startsWith('~/')) {
        if (!HOME) panic('cannot substitute ~ in library path when HOME is unset');
        lib = lib.replace('~', HOME);
    }
    lib = resolve(lib);

    if (pack) {
        if (pack.startsWith('~/')) {
            if (!HOME) panic('Cannot substitute ~ in pack path when HOME is unset');
            pack = pack.replace('~', HOME);
        }
        pack = resolve(pack);
    }

    return {
        lfsserver: flags.lfsserver ?? lfsserver,
        lfsauth: flags.lfsauth ?? lfsauth,
        port: parsePort(flags.port ?? port),
        lib,
        pack: pack || undefined,
        clearArtifacts: flags['clear-artifacts'],
        rebuildIndex: flags['rebuild-index'],
    };
}
