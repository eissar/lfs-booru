export function panic(message: string, code = 1): never {
    console.error(`Panic: ${message}`);
    Deno.exit(code);
}
