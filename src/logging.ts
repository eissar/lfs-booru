// deno-lint-ignore-file no-explicit-any

const DEBUG = true;

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
