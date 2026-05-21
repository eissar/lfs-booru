export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
    return strings.reduce((result, string, index) => {
        const value = index < values.length ? String(values[index]) : '';
        return result + string + value;
    }, '');
}
