import gallery from '@/template/GalleryPage.tsx';
import itemCard from '@/template/ItemCard.tsx';
import photoGrid from '@/template/PhotoGridFragment.tsx';
import inspector from '@/template/InspectorFragment.tsx';

export const template = {
    page: {
        Gallery: gallery,
    },
    fragment: {
        itemCard: itemCard,
        photoGrid: photoGrid,
        inspector: inspector,
    },
};
