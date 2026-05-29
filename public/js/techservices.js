/* ═════════════════════════════════════════════════════════════════
   TECH SERVICES DEPARTMENT — Field definitions & logic
   Spec: documentation/TS_SECTIONS_SPEC.md (approved 2026-04-20)
   Sections: Data Conversion, NCOA/CASS, Deduplication, Print
   (Presort — Data Processing is a placeholder note in the UI, no fields yet — pending Jason's spec.)
   Every field ID uses ts_ prefix (app.js scoping requirement).
   ═════════════════════════════════════════════════════════════════ */

if (!window.DEPT_REGISTRY) window.DEPT_REGISTRY = {};

window.DEPT_REGISTRY.techservices = {
    id: 'techservices',
    label: 'Tech Services',
    panelId: 'techservicesChecklist',
    sidebarTitle: 'TS Instructions',
    printHeading: 'Tech Services Instructions',

    // Assignee roster (alphabetical by first name)
    ASSIGNEE_OPTIONS: [
        "Adarsh Singh", "Bill Bohneberg", "Jason Strope", "Joseph Caldwell",
        "Leslie Moffatt", "Michael Cook", "Ruth Mooney", "Zach Victor"
    ],

    // Dropdown option sets.
    DEDUP_METHODS: ["Individual (Full Name + Address)", "Household (Last Name + Address)", "Residential (Address only)"],
    CASING_OPTIONS: ["Upper/Lower, Punctuation", "Upper/Lower, No Punctuation", "All Upper, Punctuation", "All Upper, No Punctuation"],

    // Required fields (first pass — Jason may add more; see TBD T1)
    REQUIRED_FIELDS: [
        { id: 'ts_fp10n', label: 'Data file locations' }
    ],
    // No envelope-specific skip list yet (TBD T2)
    REQUIRED_SKIP_ENVELOPE: [],

    // Print accent (existing TS color — do not change)
    printAccent: '#1e3a5f',

    // PRINT_SECTIONS — consumed by app.js:2415 for PDF output.
    // Each entry: { cbId, noteId, label }. Checkbox-only rows use a noteId that never holds a value.
    // Print logic: filepath (ts_fp*) prints only when toggled ON; others print when checked OR value present.
    PRINT_SECTIONS: [
        { title: 'Data Conversion', fields: [
            { cbId: 'ts_fp10', noteId: 'ts_fp10n', label: 'Data file locations' },
            { cbId: 'ts_sp21', noteId: 'ts_sp21n', label: 'Number of mailstreams' },
            { cbId: 'ts_sp22', noteId: 'ts_sp22n', label: 'Splitting criteria' },
            { cbId: 'ts_sp23', noteId: 'ts_sp23n', label: 'Addressing fields used' },
            { cbId: 'ts_sp24', noteId: 'ts_sp24n', label: 'Multiple address fields' }
        ]},
        { title: 'NCOA / CASS', fields: [
            { cbId: 'ts_cb31a', noteId: 'ts_cb31a_n', label: 'Client review required' },
            { cbId: 'ts_cb30', noteId: 'ts_cb30_n', label: 'CASS' },
            { cbId: 'ts_cb30a', noteId: 'ts_cb30a_n', label: 'Drop vacants' },
            { cbId: 'ts_cb30b', noteId: 'ts_cb30b_n', label: 'Drop phantom carrier routes (R777, R778)' },
            { cbId: 'ts_cb30c', noteId: 'ts_cb30c_n', label: 'Drop CASS errors over 90' },
            { cbId: 'ts_cb31', noteId: 'ts_cb31_n', label: 'NCOA' },
            { cbId: 'ts_cb31b_nna', noteId: 'ts_cb31b_nna_n', label: 'Movers w/ No New Address' },
            { cbId: 'ts_cb31b_new', noteId: 'ts_cb31b_new_n', label: 'Movers w/ New Address' }
        ]},
        { title: 'Deceased', fields: [
            { cbId: 'ts_cb31c', noteId: 'ts_cb31c_n', label: 'Deceased' },
            { cbId: 'ts_cb31c_drop', noteId: 'ts_cb31c_drop_n', label: 'Drop deceased' }
        ]},
        { title: 'Deduplication', fields: [
            { cbId: 'ts_sp30', noteId: 'ts_sp30n', label: 'Deduplication method' },
            { cbId: 'ts_sp41', noteId: 'ts_sp41n', label: 'File priorities' },
            { cbId: 'ts_sp40', noteId: 'ts_sp40n', label: 'Suppression file match' },
            { cbId: 'ts_sp42', noteId: 'ts_sp42n', label: 'Rollup/Table' },
            { cbId: 'ts_cb50a', noteId: 'ts_cb50a_n', label: 'Matching - #-Way' },
            { cbId: 'ts_cb50b', noteId: 'ts_cb50b_n', label: 'Match/Append' },
            { cbId: 'ts_sp51', noteId: 'ts_sp51n', label: 'Casing' }
        ]},
        { title: 'Print', fields: [
            { cbId: 'ts_cb90', noteId: 'ts_cb90_attendees', label: '\u26A0 Meeting required' },
            { cbId: 'ts_sp91', noteId: 'ts_sp91n', label: 'Variables beyond address' },
            { cbId: 'ts_sp92', noteId: 'ts_sp92n', label: 'Number of letter versions' },
            { cbId: 'ts_sp93a', noteId: 'ts_sp93an', label: '\u00A0\u00A0Signoffs per letter version' },
            { cbId: 'ts_sp95', noteId: 'ts_sp95n', label: 'Samples per letter version' },
            { cbId: 'ts_sp94', noteId: 'ts_sp94n', label: '  Samples — address info' }
        ]}
    ],

    // ─── Generate-summary surfaces (parallels DEPT_REGISTRY.prepress) ──────────────
    // Distinct marker strings prevent any marker-search bleed across departments
    // even though the active-dept Quill content swap already isolates by storage.
    summaryMarkerStart: '── TS Summary ────────────────────────',
    summaryMarkerEnd:   '── End TS Summary ────────────────────',
    summaryFingerprintField: 'tsFingerprint',

    summaryFingerprint: function(comp) {
        if (!comp) return '';
        const checks = comp.checkboxes || {};
        const notes  = comp.notes || {};
        const pairs = [];
        (this.PRINT_SECTIONS || []).forEach(sec => {
            (sec.fields || []).forEach(f => pairs.push({ cb: f.cbId, note: f.noteId }));
        });
        return pairs.map(p => (checks[p.cb] ? '1' : '0') + ':' + (notes[p.note] || '')).join('|');
    },

    // No QC validation rules for TS yet. Returns empty array so the dispatcher's
    // inline-warning strip stays hidden until rules are written.
    validateSummary: function(comp) {
        return [];
    },

    // Build a single-paragraph operator-to-operator summary from checked fields.
    // Voice and structure follow documentation/TS_GENERATE_RESEARCH.md.
    // Section order: meeting-required lead, data conversion, CASS, NCOA, deceased,
    // dedup/suppression, presort/DP, print. Unchecked fields contribute nothing.
    generateSummary: function(comp) {
        if (!comp) return '';
        const checks = comp.checkboxes || {};
        const notes  = comp.notes || {};
        const name   = comp.name || 'Component';

        function val(cbId, noteId) {
            return (checks[cbId] && (notes[noteId] || '').trim()) ? notes[noteId].trim() : '';
        }
        function chk(cbId) { return !!checks[cbId]; }

        const parts = [];

        // Meeting-required leads the paragraph when checked.
        if (chk('ts_cb90')) {
            const attendees = (notes['ts_cb90_attendees'] || '').trim();
            parts.push('Meeting required before kickoff' + (attendees ? ' (attendees: ' + attendees + ')' : '') + '.');
        }

        // ─── Data Conversion ─────────────────────────────
        const filePath      = val('ts_fp10',  'ts_fp10n');
        const mailstreams   = val('ts_sp21',  'ts_sp21n');
        const splitCriteria = val('ts_sp22',  'ts_sp22n');
        const addrFields    = val('ts_sp23',  'ts_sp23n');
        const multiAddr     = val('ts_sp24',  'ts_sp24n');

        let opener = name;
        if (filePath) {
            opener += ' processes input files staged at ' + filePath;
        } else if (chk('ts_fp10')) {
            opener += ' processes the input data file';
        } else {
            opener += ' instructions';
        }
        if (mailstreams) {
            const isPlural = !/^1\b/.test(mailstreams);
            opener += ', split into ' + mailstreams + (isPlural ? ' mailstreams' : ' mailstream');
            if (splitCriteria) opener += ' by ' + splitCriteria;
        } else if (chk('ts_sp21')) {
            opener += ', split into multiple mailstreams';
            if (splitCriteria) opener += ' by ' + splitCriteria;
        }
        parts.push(opener + '.');

        if (addrFields) parts.push('Addressing pulls from ' + addrFields + '.');
        if (multiAddr)  parts.push('Multiple address fields present, using ' + multiAddr + '.');

        // ─── CASS ───────────────────────────────────────
        if (chk('ts_cb30')) {
            const cassClauses = [];
            if (chk('ts_cb30a')) cassClauses.push('drop USPS-flagged vacants');
            if (chk('ts_cb30b')) cassClauses.push('drop phantom carrier routes (R777, R778)');
            if (chk('ts_cb30c')) cassClauses.push('drop CASS errors over 90');
            parts.push('CASS-certified address standardization with DPV' +
                       (cassClauses.length ? ', ' + cassClauses.join(', ') : '') + '.');
        }

        // ─── NCOA ───────────────────────────────────────
        if (chk('ts_cb31')) {
            const ncoaClauses = [];
            if (chk('ts_cb31a'))      ncoaClauses.push('client review required before mail file is finalized');
            if (chk('ts_cb31b_nna')) {
                const nnaAction = (notes['ts_cb31b_nna_n'] || '').trim().toLowerCase();
                ncoaClauses.push('movers w/ no new address' + (nnaAction ? ': ' + nnaAction : ''));
            }
            if (chk('ts_cb31b_new')) {
                const newAction = (notes['ts_cb31b_new_n'] || '').trim().toLowerCase();
                ncoaClauses.push('movers w/ new address' + (newAction ? ': ' + newAction : ''));
            }
            let ncoaText = 'NCOALink move update against the 48-month database';
            if (ncoaClauses.length) ncoaText += '; ' + ncoaClauses.join(', ');
            parts.push(ncoaText + '.');
        }

        // ─── Deceased ───────────────────────────────────
        if (chk('ts_cb31c')) {
            let deceasedText = 'Deceased suppression via DDNC';
            deceasedText += chk('ts_cb31c_drop') ? '; deceased records dropped' : '; deceased records flagged';
            parts.push(deceasedText + '.');
        }

        // ─── Deduplication / Suppression ─────────────────
        const dedupMethod      = val('ts_sp30', 'ts_sp30n');
        if (dedupMethod)              parts.push('Deduped at the ' + dedupMethod + ' level.');
        else if (chk('ts_sp30'))      parts.push('Deduplication pass.');

        const filePriorities   = val('ts_sp41', 'ts_sp41n');
        if (filePriorities)           parts.push('File priority: ' + filePriorities + '.');

        const suppressionMatch = val('ts_sp40', 'ts_sp40n');
        if (suppressionMatch)         parts.push('Suppress against client-supplied DNM list, matched by ' + suppressionMatch + '.');
        else if (chk('ts_sp40'))      parts.push('Suppress against client-supplied DNM list.');

        // ─── Other (Matching / Casing) ──────────────────
        const otherClauses = [];
        if (chk('ts_cb50a')) otherClauses.push('matching (#-way)');
        if (chk('ts_cb50b')) otherClauses.push('match/append');
        const casingVal = val('ts_sp51', 'ts_sp51n');
        if (casingVal) otherClauses.push('casing: ' + casingVal);
        else if (chk('ts_sp51')) otherClauses.push('casing');
        if (otherClauses.length) parts.push('Other processing: ' + otherClauses.join(', ') + '.');

        // ─── Print ──────────────────────────────────────
        const variableFields = val('ts_sp91', 'ts_sp91n');
        if (variableFields) parts.push('Variable fields beyond address: ' + variableFields + '.');

        const numLetterVersions  = val('ts_sp92',  'ts_sp92n');
        const signoffsPerVersion = val('ts_sp93a', 'ts_sp93an');
        if (numLetterVersions) {
            const isOne = parseInt(numLetterVersions, 10) === 1;
            let lvText = numLetterVersions + ' letter version' + (isOne ? '' : 's');
            if (signoffsPerVersion) lvText += ', ' + signoffsPerVersion + ' signoffs per version';
            parts.push(lvText + '.');
        } else if (signoffsPerVersion) {
            parts.push('Signoffs per version: ' + signoffsPerVersion + '.');
        }

        const samplesCount = val('ts_sp95', 'ts_sp95n');
        const samplesAddr  = val('ts_sp94', 'ts_sp94n');
        if (samplesCount && samplesAddr) parts.push(samplesCount + ' samples per version addressed to ' + samplesAddr + '.');
        else if (samplesCount)           parts.push(samplesCount + ' samples per version.');
        else if (samplesAddr)            parts.push('Samples addressed to ' + samplesAddr + '.');

        return parts.join(' ');
    },

    // No envelope-only logic yet (TBD T2). First pass: always return false.
    isEnvelopeComponent: function(name) {
        return false;
    },

    getRequiredFields: function(comp) {
        // No envelope-skip yet (TBD T2 pending Jason)
        return this.REQUIRED_FIELDS;
    },

    // Populate dropdown options on component load. Dedup gets the fixed list; Presort fields get empty arrays (free-text) until Jason supplies.
    updateDropdowns: function(comp) {
        const setOptions = (fieldId, options) => {
            const input = document.querySelector('[data-id="' + fieldId + '"]');
            if (!input) return;
            const wrapper = input.closest('.quick-pick-wrapper');
            if (!wrapper) return;
            const menu = wrapper.querySelector('.quick-pick-menu');
            if (!menu) return;
            menu.dataset.options = JSON.stringify(options);
            delete menu.dataset.populated;
            menu.innerHTML = '';
        };

        setOptions('ts_sp30n', this.DEDUP_METHODS);
        setOptions('ts_sp51n', this.CASING_OPTIONS);
    },

    // No-op: TS has no flat-size field. Kept for registry-shape parity with Prepress.
    autoCompleteFlatSize: function() {}
};
