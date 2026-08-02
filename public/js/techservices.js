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
    DEDUP_METHODS: ["Individual (Full Name + Address)", "Household (Last Name + Address)", "Merge Households (Last Name + Address)", "Residential (Address only)"],
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
            { cbId: 'ts_cb50a', noteId: 'ts_cb50a_n', label: 'Match job' },
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

    // Build an operator-to-operator summary from checked fields.
    //
    // Wording follows documentation/TS_GENERATE_RESEARCH.md. The grouping does
    // not: that report calls for one paragraph, and a full panel produced a
    // 1000-character block operators called unreadable. Output is now one
    // labelled paragraph per section, blank-line separated, in the order the
    // panel is filled in: meeting warning, data conversion, hygiene,
    // deduplication, print.
    //
    // Two rules keep the voice consistent. Every entry is a sentence, never a
    // "Label: value" fragment, and no sentence carries more than one colon --
    // several field values are themselves comma-separated lists, so a colon
    // inside a sentence that already has one reads as two list items.
    //
    // Unchecked fields contribute nothing. A component with nothing checked
    // returns '' so the caller can show its "Nothing to generate" message; it
    // used to return "<name> instructions." and swallow that path.
    //
    // A ticked box whose note is blank only speaks when the tick alone means
    // something. "Multiple address fields" and "Variables beyond address" are
    // true on the tick, so they get a fallback sentence. "Addressing fields
    // used" and "File priorities" are the value, not a fact, so a blank note
    // stays silent rather than emitting an empty label.
    //
    // Reference output for every branch below lives in
    // dev/fixtures/ts-summary-baseline.txt. Run `node dev/ts-summary.js --check`
    // after touching this function.
    generateSummary: function(comp) {
        if (!comp) return '';
        const checks = comp.checkboxes || {};
        const notes  = comp.notes || {};
        const name   = comp.name || 'Component';

        function val(cbId, noteId) {
            return (checks[cbId] && (notes[noteId] || '').trim()) ? notes[noteId].trim() : '';
        }
        function chk(cbId) { return !!checks[cbId]; }
        function cap(text) { return text.charAt(0).toUpperCase() + text.slice(1); }

        // "a", "a and b", "a, b, and c"
        function list(items) {
            if (items.length < 2) return items[0] || '';
            if (items.length === 2) return items[0] + ' and ' + items[1];
            return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
        }

        // NCOA mover dropdowns read "Mail", "Drop", "Mail to Updated Address".
        // Turn the chosen value into a predicate. The inputs are not readonly,
        // so anything unrecognised falls back to naming the value outright.
        function moverClause(subject, raw) {
            const value = (raw || '').trim();
            const lower = value.toLowerCase();
            if (lower === 'drop') return subject + ' are dropped';
            if (lower === 'mail') return subject + ' are mailed';
            if (lower.indexOf('mail to ') === 0) {
                return subject + ' are mailed to the ' + lower.slice(8).replace(/ address$/, '') + ' address';
            }
            return subject + ' are handled as ' + value;
        }

        const blocks = [];
        function block(label, sentences) {
            const kept = sentences.filter(Boolean);
            if (kept.length) blocks.push((label ? label + ': ' : '') + kept.join(' '));
        }

        // ─── Meeting warning (leads, unlabelled) ─────────
        const meeting = [];
        if (chk('ts_cb90')) {
            const attendees = (notes['ts_cb90_attendees'] || '').trim();
            meeting.push('Meeting required before kickoff.');
            if (attendees) meeting.push('Attendees: ' + attendees + '.');
        }
        block('', meeting);

        // ─── Data Conversion ─────────────────────────────
        const data          = [];
        const filePath      = val('ts_fp10',  'ts_fp10n');
        const mailstreams   = val('ts_sp21',  'ts_sp21n');
        const splitCriteria = val('ts_sp22',  'ts_sp22n');
        const addrFields    = val('ts_sp23',  'ts_sp23n');
        const multiAddr     = val('ts_sp24',  'ts_sp24n');

        let lead = '';
        if (filePath)            lead = name + ' processes input files staged at ' + filePath;
        else if (chk('ts_fp10')) lead = name + ' processes the input data file';

        let split = '';
        if (mailstreams)         split = 'split into ' + mailstreams + (/^1\b/.test(mailstreams) ? ' mailstream' : ' mailstreams');
        else if (chk('ts_sp21')) split = 'split into multiple mailstreams';
        if (split && splitCriteria)  split += ' by ' + splitCriteria;
        else if (splitCriteria)      split = 'split by ' + splitCriteria;

        if (lead && split) data.push(lead + ', ' + split + '.');
        else if (lead)     data.push(lead + '.');
        else if (split)    data.push(name + ' is ' + split + '.');

        if (addrFields)          data.push('Addressing pulls from ' + addrFields + '.');
        if (multiAddr)           data.push('Multiple address fields are present, using ' + multiAddr + '.');
        else if (chk('ts_sp24')) data.push('Multiple address fields are present.');
        block('Data conversion', data);

        // ─── Hygiene (CASS, NCOA, deceased) ─────────────
        const hygiene = [];

        const cassDrops = [];
        if (chk('ts_cb30a')) cassDrops.push('USPS-flagged vacants');
        if (chk('ts_cb30b')) cassDrops.push('phantom carrier routes (R777, R778)');
        if (chk('ts_cb30c')) cassDrops.push('CASS errors over 90');
        if (chk('ts_cb30')) {
            hygiene.push('CASS-certified address standardization with DPV' +
                         (cassDrops.length ? ', dropping ' + list(cassDrops) : '') + '.');
        } else if (cassDrops.length) {
            hygiene.push('Address pass drops ' + list(cassDrops) + '.');
        }

        if (chk('ts_cb31')) hygiene.push('NCOALink move update against the 48-month database.');

        // Movers with an action chosen become a statement; movers left blank
        // become one instruction to go and choose, rather than a bare label.
        const moverStated  = [];
        const moverPending = [];
        [
            { cb: 'ts_cb31b_nna', note: 'ts_cb31b_nna_n', subject: 'movers with no new address' },
            { cb: 'ts_cb31b_new', note: 'ts_cb31b_new_n', subject: 'movers with a new address' }
        ].forEach(m => {
            if (!chk(m.cb)) return;
            const action = (notes[m.note] || '').trim();
            if (action) moverStated.push(moverClause(m.subject, action));
            else        moverPending.push(m.subject);
        });
        if (moverStated.length)  hygiene.push(cap(moverStated.join('; ')) + '.');
        if (moverPending.length) hygiene.push('Confirm handling for ' + list(moverPending) + '.');

        if (chk('ts_cb31a')) hygiene.push('Client review is required before the mail file is finalized.');

        if (chk('ts_cb31c')) {
            hygiene.push('Deceased suppression via DDNC; deceased records are ' +
                         (chk('ts_cb31c_drop') ? 'dropped' : 'flagged') + '.');
        } else if (chk('ts_cb31c_drop')) {
            hygiene.push('Deceased records are dropped.');
        }
        block('Hygiene', hygiene);

        // ─── Deduplication / Suppression / Matching ─────
        const dedup          = [];
        const dedupMethod    = val('ts_sp30', 'ts_sp30n');
        const filePriorities = val('ts_sp41', 'ts_sp41n');
        const prioritySuffix = filePriorities ? ', priority ' + filePriorities : '';
        if (dedupMethod)         dedup.push('Deduped at the ' + dedupMethod + ' level' + prioritySuffix + '.');
        else if (chk('ts_sp30')) dedup.push('Deduplication pass' + prioritySuffix + '.');
        else if (filePriorities) dedup.push('File priority is ' + filePriorities + '.');

        const suppressionMatch = val('ts_sp40', 'ts_sp40n');
        if (suppressionMatch)    dedup.push('Suppress against the client-supplied DNM list, matched by ' + suppressionMatch + '.');
        else if (chk('ts_sp40')) dedup.push('Suppress against the client-supplied DNM list.');

        // Checkbox-only row -- index.html gives ts_sp42 no note input, so the
        // ts_sp42n entry in PRINT_SECTIONS never holds a value.
        if (chk('ts_sp42')) dedup.push('Rollup and table relationships applied.');

        const matchVal = val('ts_cb50a', 'ts_cb50a_n');
        if (chk('ts_cb50a')) {
            dedup.push(cap(matchVal ? matchVal + ' match job' : 'match job') +
                       (chk('ts_cb50b') ? ' with match/append.' : '.'));
        } else if (chk('ts_cb50b')) {
            dedup.push('Match/append pass.');
        }

        // Casing values pair a case treatment with a punctuation treatment
        // ("Upper/Lower, No Punctuation"). Split them so the comma inside the
        // value does not read as a second list item.
        const casingVal = val('ts_sp51', 'ts_sp51n');
        if (casingVal) {
            const commaIdx = casingVal.indexOf(',');
            dedup.push(commaIdx === -1
                ? 'Casing is ' + casingVal + '.'
                : 'Casing is ' + casingVal.slice(0, commaIdx).trim() + ' with ' +
                  casingVal.slice(commaIdx + 1).trim().toLowerCase() + '.');
        } else if (chk('ts_sp51')) {
            dedup.push('Confirm the casing treatment.');
        }
        block('Deduplication', dedup);

        // ─── Print ──────────────────────────────────────
        const print          = [];
        const variableFields = val('ts_sp91', 'ts_sp91n');
        if (variableFields)      print.push('Variable fields beyond the address: ' + variableFields + '.');
        else if (chk('ts_sp91')) print.push('Variable fields beyond the address are in use.');

        // ts_sp93a is free text and holds either a count ("2") or the party who
        // signs off ("Acme HQ"), so the clause has to suit both.
        const numLetterVersions  = val('ts_sp92',  'ts_sp92n');
        const signoffsPerVersion = val('ts_sp93a', 'ts_sp93an');
        let signoffClause = '';
        if (signoffsPerVersion) {
            signoffClause = /^\d+$/.test(signoffsPerVersion)
                ? signoffsPerVersion + ' signoff' + (signoffsPerVersion === '1' ? '' : 's') + ' per version'
                : 'signed off by ' + signoffsPerVersion;
        }
        if (numLetterVersions) {
            const isOne = parseInt(numLetterVersions, 10) === 1;
            print.push(numLetterVersions + ' letter version' + (isOne ? '' : 's') +
                       (signoffClause ? ', ' + signoffClause : '') + '.');
        } else if (signoffClause) {
            print.push(cap(signoffClause) + '.');
        }

        const samplesCount = val('ts_sp95', 'ts_sp95n');
        const samplesAddr  = val('ts_sp94', 'ts_sp94n');
        if (samplesCount) {
            print.push(samplesCount + ' sample' + (/^1\b/.test(samplesCount) ? '' : 's') + ' per version' +
                       (samplesAddr ? ' addressed to ' + samplesAddr : '') + '.');
        } else if (samplesAddr) {
            print.push('Samples addressed to ' + samplesAddr + '.');
        }
        block('Print', print);

        return blocks.join('\n\n');
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
