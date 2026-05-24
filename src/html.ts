/**
 * Tagged template literal that concatenates strings and interpolated values.
 *
 * Interpolated values are coerced to strings via `String()`.
 *
 * @param strings Static template string parts.
 * @param values Interpolated expressions.
 * @returns The concatenated HTML string.
 *
 * @example Basic usage
 * ```ts ignore
 * const name = 'world';
 * const out = html`<p>Hello, ${name}</p>`;
 * assertEquals(out, '<p>Hello, world</p>');
 * ```
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
    return strings.reduce((result, string, index) => {
        const value = index < values.length ? String(values[index]) : '';
        return result + string + value;
    }, '');
}
