// deno-lint-ignore-file no-explicit-any

const DEBUG = true;

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
