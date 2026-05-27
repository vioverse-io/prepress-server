/* ═════════════════════════════════════════════════════════════════
   UI TOGGLES — small collapse/expand behaviors for sidebar chrome.
   Kept out of app.js so chrome toggles don't mix with job-state logic.
   ═════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    const REVISIONS_KEY = 'wo-revisions-collapsed';

    // Global (called from onclick in index.html)
    window.toggleRevisionTimeline = function () {
        const footer = document.getElementById('sidebarFooter');
        if (!footer) return;
        const nowCollapsed = footer.classList.toggle('collapsed');
        try { localStorage.setItem(REVISIONS_KEY, nowCollapsed ? '1' : '0'); } catch (_) {}
    };

    // Restore collapse state on page load. Default = expanded (no class).
    document.addEventListener('DOMContentLoaded', () => {
        const footer = document.getElementById('sidebarFooter');
        if (!footer) return;
        try {
            if (localStorage.getItem(REVISIONS_KEY) === '1') {
                footer.classList.add('collapsed');
            }
        } catch (_) {}
    });
})();
