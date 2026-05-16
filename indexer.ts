type ImageState = {
    oid: string;
    path: string;
    tags: string[];
    width: number;
    height: number;
    name: string;
    mtime: string;
};

type TagIndex = Record<string, string[]>;

type ImageStateIndex = Record<string, ImageState>;

const eventsDir = 'events';
const indexDir = 'index';

const imageState: ImageStateIndex = {};
const tagIndex: TagIndex = {};

async function processEvents() {
    await Deno.mkdir(indexDir, { recursive: true });

    for await (const entry of Deno.readDir(eventsDir)) {
        if (!entry.name.endsWith('.ndjson')) continue;
        const content = await Deno.readTextFile(`${eventsDir}/${entry.name}`);
        for (const line of content.trim().split('\n')) {
            if (!line) continue;
            const event = JSON.parse(line);

            switch (event.op) {
                case 'add': {
                    const img: ImageState = {
                        oid: event.oid,
                        path: event.path,
                        tags: event.tags || [],
                        width: event.width,
                        height: event.height,
                        name: event.name,
                        mtime: event.mtime,
                    };
                    imageState[event.id] = img;
                    for (const tag of img.tags) {
                        tagIndex[tag] ??= [];
                        if (!tagIndex[tag].includes(event.id)) {
                            tagIndex[tag].push(event.id);
                        }
                    }
                    break;
                }
                case 'tag_add': {
                    const img = imageState[event.id];
                    if (!img) break;
                    if (!img.tags.includes(event.tag)) {
                        img.tags.push(event.tag);
                    }
                    tagIndex[event.tag] ??= [];
                    if (!tagIndex[event.tag].includes(event.id)) {
                        tagIndex[event.tag].push(event.id);
                    }
                    break;
                }
                case 'tag_remove': {
                    const img = imageState[event.id];
                    if (!img) break;
                    img.tags = img.tags.filter((t: string) => t !== event.tag);
                    if (tagIndex[event.tag]) {
                        tagIndex[event.tag] = tagIndex[event.tag].filter(
                            (id: string) => id !== event.id,
                        );
                    }
                    break;
                }
                case 'delete': {
                    const img = imageState[event.id];
                    if (img) {
                        for (const tag of img.tags) {
                            if (tagIndex[tag]) {
                                tagIndex[tag] = tagIndex[tag].filter(
                                    (id: string) => id !== event.id,
                                );
                            }
                        }
                    }
                    delete imageState[event.id];
                    break;
                }
            }
        }
    }

    await Deno.writeTextFile(
        `${indexDir}/image_state.json`,
        JSON.stringify(imageState),
    );
    await Deno.writeTextFile(
        `${indexDir}/tag_index.json`,
        JSON.stringify(tagIndex),
    );

    console.log(
        `Indexed ${Object.keys(imageState).length} images, ${Object.keys(tagIndex).length} tags`,
    );
}

await processEvents();
