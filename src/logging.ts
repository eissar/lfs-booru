// deno-lint-ignore-file no-explicit-any

const DEBUG = true;

const TRACE = true; // Or loaded from process.env / config

export function trace(fn: (() => void) | (() => Promise<void>)) {
    if (TRACE) {
        fn();
    }
}

const originalLog = console.log;

const filePath = 'app.log';

const encoder = new TextEncoder();

// truncate to nil
Deno.writeFileSync(filePath, encoder.encode(''));

const file = await Deno.open(filePath, {
    write: true,
    create: true,
    append: true,
});

// Override console.log
console.log = (...args: unknown[]) => {
    const message = args.map((arg) => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');

    file.writeSync(encoder.encode(message + '\n'));
    originalLog(...args);
};

// --- Test it out ---

// Side effect, w/e
// Extend the global Error prototype with Deno's custom inspect symbol
Object.defineProperty(Error.prototype, Symbol.for('Deno.customInspect'), {
    value: function (this: Error) {
        return `${this.constructor.name}: ${this.message}`;
    },
    configurable: true,
    enumerable: false,
    writable: true,
});
type DebugInput =
    | any
    | (() => any)
    | (() => Promise<any>);

/**
 * Log a debug value to the console and the application log file.
 *
 * Accepts a plain value, a synchronous thunk, or an async thunk. Thunks are
 * resolved before inspection. When `DEBUG` is `false`, the call is a no-op.
 *
 * @param input Value or thunk to inspect and log.
 */
export const debug = (input: DebugInput): void => {
    if (!DEBUG) return;

    const run = async () => {
        let val;

        if (typeof input === 'function') {
            val = await input();
        } else {
            val = input;
        }

        const str = Deno.inspect(val, {
            showHidden: true,
            trailingComma: true,
        });

        if (!/^"+$/.test(str)) {
            console.log(str);
        }
    };

    void run();
};
