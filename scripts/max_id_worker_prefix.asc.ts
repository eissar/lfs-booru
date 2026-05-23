// Compile/update with:
// npx asc scripts/max_id_worker_prefix.asc.ts --outFile scripts/max_id_worker_prefix.wasm --optimize --runtime stub --noAssert

export function grow_to_fit(len: i32): void {
    const pages = (len + 65535) >>> 16;
    const current = memory.size();

    if (pages > current) {
        memory.grow(pages - current);
    }
}

export function max_id(ptr: i32, len: i32): i32 {
    const end = ptr + len;
    let cursor = ptr;
    let max = 0;

    while (cursor + 4 < end) {
        while (cursor + 4 < end && load<u8>(cursor) != 34) {
            cursor++;
        }

        if (cursor + 4 >= end) break;

        if (load<u32>(cursor) != 0x22646922 || load<u8>(cursor + 4) != 58) {
            cursor++;
            continue;
        }

        cursor += 5;
        let id = 0;

        while (cursor < end) {
            const byte = load<u8>(cursor);
            if (byte < 48 || byte > 57) break;

            id = id * 10 + byte - 48;
            cursor++;
        }

        if (id > max) max = id;

        while (cursor < end && load<u8>(cursor) != 10) {
            cursor++;
        }

        cursor++;
    }

    return max;
}
