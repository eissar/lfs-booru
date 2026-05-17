import type { Event, ImageState } from '../indexer.ts';

export type IndexCursor = {
    eventFile: string;
    line: number;
    byteOffset: number;
};

export interface DerivedIndexStore {
    getCursor(): Promise<IndexCursor | null>;

    getImage(id: string): Promise<ImageState | null>;
    getIdByOid(oid: string): Promise<string | null>;

    applyEvent(event: Event, nextCursor: IndexCursor): Promise<void>;

    listImages(options?: { limit?: number }): AsyncIterable<[string, ImageState]>;

    close(): Promise<void> | void;
}
