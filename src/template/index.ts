import gallery from '@/template/gallery.ts';
import itemCard from '@/template/item-card.ts';
import photoGrid from '@/template/photo-grid_fragment.ts';
import inspector from '@/template/inspector_fragment.ts';

export const template = {
    page: {
        Gallery: gallery,
    },
    fragment: {
        ImageCard: itemCard,
        photoGrid: photoGrid,
        inspector: inspector,
    },
};
