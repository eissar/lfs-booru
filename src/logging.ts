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

/** monoid endofunctor or w/e */
// deno-lint-ignore no-explicit-any
export const debug = (val: any): any => {
    // Replace with your actual debug flag or environment check
    if (!DEBUG) return val;

    const str = Deno.inspect(val, {
        showHidden: true,
        trailingComma: true,
    });

    // TODO: better way to exclude empty strings?
    if (/^"+$/.test(str)) return val;

    console.log(str);

    return val;
};
