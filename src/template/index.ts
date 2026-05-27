import gallery from '@/template/gallery.ts';
import imageCard from '@/template/image-card.ts';
import photoGrid from '@/template/photo-grid_fragment.ts';
import inspector from '@/template/inspector_fragment.ts';

export const template = {
    page: {
        Gallery: gallery,
    },
    fragment: {
        ImageCard: imageCard,
        photoGrid: photoGrid,
        inspector: inspector,
    },
};
