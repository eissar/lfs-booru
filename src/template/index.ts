import gallery from '@/template/gallery.tsx';
import itemCard from '@/template/item-card.tsx';
import photoGrid from '@/template/photo-grid_fragment.tsx';
import inspector from '@/template/inspector_fragment.tsx';

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
