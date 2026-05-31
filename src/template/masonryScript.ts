function javascript(strings: TemplateStringsArray): string {
    return strings.join('');
}
export const MASONRY_LAYOUT_SCRIPT = javascript`(function () {
    var galleryColHeights = [];

    function clearMasonryLayout() {
        var grid = document.getElementById('photo-grid');
        if (!grid) return;
        var pagination = grid.querySelector('#pagination-controls');
        var columns = grid.querySelectorAll('.masonry-column');
        for (var i = 0; i < columns.length; i++) {
            var col = columns[i];
            while (col.firstChild) {
                if (pagination) {
                    grid.insertBefore(col.firstChild, pagination);
                } else {
                    grid.appendChild(col.firstChild);
                }
            }
            col.remove();
        }
        galleryColHeights = [];
    }

    function layoutMasonry() {
        var grid = document.getElementById('photo-grid');
        if (!grid) return;

        var styles = getComputedStyle(grid);
        var parsedColumns = Number.parseInt(styles.getPropertyValue('--masonry-columns'), 10);
        var columns = Number.isFinite(parsedColumns) && parsedColumns > 0 ? parsedColumns : 1;
        var cols = [];
        var pagination = grid.querySelector('#pagination-controls');

        for (var i = 0; i < columns; i++) {
            var col = grid.querySelector(':scope > .masonry-column:nth-of-type(' + (i + 1) + ')');
            if (!col) {
                col = document.createElement('div');
                col.className = 'masonry-column';
                if (pagination) grid.insertBefore(col, pagination);
                else grid.appendChild(col);
            }
            cols.push(col);
        }

        for (var i = 0; i < columns; i++) {
            if (galleryColHeights[i] == null) galleryColHeights[i] = 0;
        }

        var newArticles = Array.from(grid.querySelectorAll(':scope > article.masonry-item'));

        newArticles.forEach(function (article) {
            var img = article.querySelector('img[width][height]');
            var ratio = 1;
            if (img) {
                var w = Number(img.getAttribute('width'));
                var h = Number(img.getAttribute('height'));
                ratio = w > 0 && h > 0 ? h / w : 1;
            }

            var shortest = 0;
            for (var i = 1; i < columns; i++) {
                if (galleryColHeights[i] < galleryColHeights[shortest]) shortest = i;
            }

            cols[shortest].appendChild(article);
            galleryColHeights[shortest] += ratio;
        });
    }

    globalThis.booruLayoutMasonry = layoutMasonry;
    globalThis.booruClearMasonry = clearMasonryLayout;

    [
        '(min-width: 768px)',
        '(min-width: 1024px)',
        '(min-width: 1280px)',
    ].forEach(function (query) {
        matchMedia(query).addEventListener('change', function () {
            requestAnimationFrame(function () {
                globalThis.booruClearMasonry?.();
                globalThis.booruLayoutMasonry?.();
            });
        });
    });

    document.addEventListener('htmx:afterSettle', layoutMasonry);
})();`;
