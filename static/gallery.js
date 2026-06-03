(function () {
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
})();

(function () {
    var savedTheme = localStorage.getItem('theme');
    var isDarkMode = savedTheme ? savedTheme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
    document.addEventListener('DOMContentLoaded', function () {
        var toggle = document.getElementById('dark-mode-toggle');
        if (toggle) {
            toggle.addEventListener('click', function () {
                var currentTheme = document.documentElement.getAttribute('data-theme');
                var newTheme = currentTheme === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', newTheme);
                localStorage.setItem('theme', newTheme);
            });
        }
    });
})();

globalThis.booruToggleInspector = function (forceOpen) {
    var main = document.getElementById('gallery-main');
    if (!main) return;
    var state = main.classList.toggle('inspector-open', forceOpen);
    localStorage.setItem('inspector-open', String(state));
};

document.addEventListener('DOMContentLoaded', function () {
    if (localStorage.getItem('inspector-open') === 'true') {
        globalThis.booruToggleInspector('open');
    }
});

document.addEventListener('click', function (event) {
    var details = document.querySelectorAll('details');
    details.forEach(function (detail) {
        if (!detail.contains(event.target)) {
            detail.open = false;
        }
    });
});

document.addEventListener('DOMContentLoaded', function () {
    var viewInputs = document.querySelectorAll('input[name="gallery-view"]');
    var views = new Set(['masonry', 'grid', 'list']);
    var requestedView = new URLSearchParams(window.location.search).get('view');
    if (requestedView && views.has(requestedView)) {
        var selected = document.getElementById('gallery-view-' + requestedView);
        if (selected instanceof HTMLInputElement) selected.checked = true;
    }

    viewInputs.forEach(function (input) {
        input.addEventListener('change', function () {
            if (!(input instanceof HTMLInputElement) || !input.checked) return;
            var nextUrl = new URL(window.location.href);
            nextUrl.searchParams.set('view', input.value);
            window.history.replaceState(null, '', nextUrl);
            if (input.value === 'masonry') {
                globalThis.booruLayoutMasonry?.();
            } else {
                globalThis.booruClearMasonry?.();
            }
        });
    });

    globalThis.booruLayoutMasonry?.();
});