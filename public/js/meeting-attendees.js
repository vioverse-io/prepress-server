/* ═════════════════════════════════════════════════════════════════
   MEETING ATTENDEES — multi-select widget (Tech Services / Meeting Required)
   Merges CSR + Prepress + Tech Services rosters into one alphabetical list.
   Persists selected names via a hidden `.notes` input whose data-id lives in
   the TS PRINT_SECTIONS entry, so save/restore and print work unchanged.
   ═════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // Active assignee names for one department. app.js owns the roster and its
    // getAssigneeNames() already falls back to the built-in lists when the
    // roster table is unavailable, so calling it is always safe. The direct
    // read of ASSIGNEE_OPTIONS is only for the case where app.js has not
    // defined it, which would mean the app is broken anyway.
    function deptNames(deptId) {
        if (typeof window.getAssigneeNames === 'function') {
            return window.getAssigneeNames(deptId);
        }
        const dept = (window.DEPT_REGISTRY && window.DEPT_REGISTRY[deptId]) || {};
        return dept.ASSIGNEE_OPTIONS || [];
    }

    // Build the merged roster from three live sources so any roster change
    // propagates here: adding or turning off a name in "Manage CSRs &
    // Assignees" changes who can be picked as an attendee.
    function getCombinedRoster() {
        const byName = new Map(); // name → role

        function add(names, role) {
            (names || []).forEach(n => {
                const name = (n || '').trim();
                if (!name) return;
                // First role wins when a person appears in multiple rosters
                if (!byName.has(name)) byName.set(name, role);
            });
        }

        add(deptNames('prepress'), 'Prepress');
        add(deptNames('techservices'), 'TS');

        // CSRs live in the "New Work Order" form's quick-pick menu.
        const csrInput = document.getElementById('csrName');
        if (csrInput) {
            const wrapper = csrInput.closest('.quick-pick-wrapper');
            const menu = wrapper && wrapper.querySelector('.quick-pick-menu');
            if (menu) {
                try {
                    const csrs = JSON.parse(menu.dataset.options || '[]');
                    add(csrs, 'CSR');
                } catch (_) { /* malformed data-options — skip */ }
            }
        }

        // Alphabetical by first name
        return Array.from(byName.entries())
            .map(([name, role]) => ({ name, role }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    // Parse/serialize the hidden input value. Stored as a comma-separated
    // list so the print generator (which emits the raw `.notes` value into
    // the PDF) shows clean "Brandi, David, Jason" rather than JSON text.
    // Names in the rosters never contain commas, so CSV is safe.
    function parseValue(str) {
        if (!str) return [];
        // Back-compat: accept legacy JSON if it sneaks through
        if (str.trim().startsWith('[')) {
            try {
                const parsed = JSON.parse(str);
                if (Array.isArray(parsed)) return parsed.map(s => String(s).trim()).filter(Boolean);
            } catch (_) { /* fall through */ }
        }
        return str.split(',').map(s => s.trim()).filter(Boolean);
    }
    function serializeValue(names) {
        return (names || []).map(n => String(n).trim()).filter(Boolean).join(', ');
    }

    // Walk a `.meeting-attendees` widget and populate its checkbox list.
    function buildList(widget) {
        const listEl = widget.querySelector('.meeting-attendees-list');
        if (!listEl) return;
        const roster = getCombinedRoster();
        const selected = new Set(parseValue(getHidden(widget).value));

        listEl.innerHTML = roster.map(entry => {
            const checked = selected.has(entry.name) ? 'checked' : '';
            return (
                '<label class="meeting-attendee-item">' +
                  '<input type="checkbox" value="' + escapeAttr(entry.name) + '" ' + checked + '>' +
                  '<span class="meeting-attendee-name">' + escapeHtml(entry.name) + '</span>' +
                  '<span class="meeting-attendee-role">' + escapeHtml(entry.role) + '</span>' +
                '</label>'
            );
        }).join('');

        // When a box is toggled, push the new selection to the hidden input
        // and re-render chips immediately so the user sees feedback.
        listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => commitSelection(widget));
        });
    }

    function getHidden(widget) {
        return widget.querySelector('input.notes[data-id]');
    }

    function getChipsContainer(widget) {
        return widget.querySelector('.meeting-attendees-chips');
    }

    function getBtnText(widget) {
        return widget.querySelector('.meeting-attendees-btn-text');
    }

    function commitSelection(widget) {
        const checks = widget.querySelectorAll('.meeting-attendees-list input[type="checkbox"]:checked');
        const names = Array.from(checks).map(c => c.value);
        const hidden = getHidden(widget);
        if (!hidden) return;
        hidden.value = serializeValue(names);
        // Fire `input` so the app's debounced saveJobState picks this up
        hidden.dispatchEvent(new Event('input', { bubbles: true }));
        renderChips(widget);
        updateBtnText(widget, names);

        // Auto-check the "Meeting required" toggle when attendees are selected
        if (names.length > 0) {
            var meetingToggle = document.querySelector('input[data-id="ts_cb90"]');
            if (meetingToggle && !meetingToggle.checked) {
                meetingToggle.checked = true;
                meetingToggle.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    }

    function renderChips(widget) {
        const container = getChipsContainer(widget);
        if (!container) return;
        const names = parseValue(getHidden(widget).value);
        container.innerHTML = names.map(n => '<span class="meeting-chip">' + escapeHtml(n) + '</span>').join('');
    }

    function updateBtnText(widget, names) {
        const el = getBtnText(widget);
        if (!el) return;
        if (!names || names.length === 0) {
            el.textContent = 'Select attendees';
        } else if (names.length === 1) {
            el.textContent = '1 attendee';
        } else {
            el.textContent = names.length + ' attendees';
        }
    }

    // Sync UI (checkboxes + chips + button text) from whatever the hidden
    // input currently holds. Called after app.js restoreState / component
    // load / dept switch so the widget stays coherent with saved data.
    function syncFromValue(widget) {
        const selected = new Set(parseValue(getHidden(widget).value));
        widget.querySelectorAll('.meeting-attendees-list input[type="checkbox"]').forEach(cb => {
            cb.checked = selected.has(cb.value);
        });
        renderChips(widget);
        updateBtnText(widget, Array.from(selected));
    }

    // ── Global handlers (referenced via onclick="" in the HTML) ──────

    window.toggleMeetingAttendees = function (btnEl) {
        const widget = btnEl.closest('.meeting-attendees');
        if (!widget) return;
        const panel = widget.querySelector('.meeting-attendees-panel');
        if (!panel) return;
        const willOpen = panel.hasAttribute('hidden');
        // Close any other open pickers first
        document.querySelectorAll('.meeting-attendees').forEach(w => {
            if (w !== widget) closeWidget(w);
        });
        if (willOpen) {
            buildList(widget);       // rebuild so roster changes show up
            syncFromValue(widget);   // check the boxes that are persisted
            panel.removeAttribute('hidden');
            btnEl.classList.add('is-open');
            const search = widget.querySelector('.meeting-attendees-search');
            if (search) { search.value = ''; applyFilter(widget, ''); setTimeout(() => search.focus(), 0); }
        } else {
            closeWidget(widget);
        }
    };

    window.applyMeetingAttendees = function (btnEl) {
        const widget = btnEl.closest('.meeting-attendees');
        if (!widget) return;
        commitSelection(widget);
        closeWidget(widget);
    };

    window.clearMeetingAttendees = function (btnEl) {
        const widget = btnEl.closest('.meeting-attendees');
        if (!widget) return;
        widget.querySelectorAll('.meeting-attendees-list input[type="checkbox"]').forEach(cb => {
            cb.checked = false;
        });
        commitSelection(widget);
    };

    window.filterMeetingAttendees = function (inputEl) {
        const widget = inputEl.closest('.meeting-attendees');
        if (!widget) return;
        applyFilter(widget, inputEl.value);
    };

    function applyFilter(widget, query) {
        const q = (query || '').toLowerCase().trim();
        widget.querySelectorAll('.meeting-attendee-item').forEach(item => {
            const name = (item.querySelector('.meeting-attendee-name')?.textContent || '').toLowerCase();
            const role = (item.querySelector('.meeting-attendee-role')?.textContent || '').toLowerCase();
            const match = !q || name.includes(q) || role.includes(q);
            item.classList.toggle('is-hidden', !match);
        });
    }

    function closeWidget(widget) {
        const panel = widget.querySelector('.meeting-attendees-panel');
        const btn = widget.querySelector('.meeting-attendees-btn');
        if (panel) panel.setAttribute('hidden', '');
        if (btn) btn.classList.remove('is-open');
    }

    // ── Lifecycle: keep widget in sync with app.js save/restore ──────

    function syncAllWidgets() {
        document.querySelectorAll('.meeting-attendees').forEach(syncFromValue);
    }

    // Initial render + delegated close-on-outside-click
    document.addEventListener('DOMContentLoaded', () => {
        syncAllWidgets();

        // Close picker when clicking outside
        document.addEventListener('click', (e) => {
            if (e.target.closest('.meeting-attendees')) return;
            document.querySelectorAll('.meeting-attendees').forEach(closeWidget);
        });

        // Re-sync when the user switches departments or components, since
        // app.js sets `.notes` values by assignment (no `input` event fires).
        const resync = () => setTimeout(syncAllWidgets, 0);
        document.addEventListener('click', (e) => {
            if (e.target.closest('.dept-tab')) resync();
            if (e.target.closest('.component-tab')) resync();
        }, true);
    });

    // ── Tiny HTML-escape helpers (local to avoid leaking globals) ─────

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
    function escapeAttr(s) { return escapeHtml(s); }
})();
