/* ═════════════════════════════════════════════════════════════════
   PREPRESS DEPARTMENT — Field definitions & logic
   Loaded before app.js. Registers via DEPT_REGISTRY global.
   ═════════════════════════════════════════════════════════════════ */

// Global registry (created once, shared by all department files)
if (!window.DEPT_REGISTRY) window.DEPT_REGISTRY = {};

window.DEPT_REGISTRY.prepress = {
    id: 'prepress',
    label: 'Prepress',
    panelId: 'prepressChecklist',
    sidebarTitle: 'Prepress Instructions',
    printHeading: 'Prepress Instructions',

    // ── Assignee roster (alphabetical by first name) ──
    ASSIGNEE_OPTIONS: ["David Marra", "Don Marcotte", "Sue Foster"],

    // ── Dropdown options ──
    PIECE_FORMAT_OPTIONS: [
        "6x9.5\u2033 Envelope", "9x12 Envelope", "A7 Envelope", "Booklet", "Buckslip",
        "Label", "Letter", "No. 9 BRE Envelope", "No. 10 Envelope", "No. 10 Envelope Window",
        "Postcard", "Remit", "Self-Mailer", "Sticker"
    ],

    FLAT_SIZES_STANDARD: [
        "3.5\u2033 x 5\u2033", "4\u2033 x 6\u2033", "4.25\u2033 x 6\u2033", "5\u2033 x 7\u2033",
        "6\u2033 x 9\u2033", "6\u2033 x 11\u2033", "8.5\u2033 x 5.5\u2033", "8.5\u2033 x 11\u2033",
        "8.5\u2033 x 14\u2033", "11\u2033 x 17\u2033", "8.5\u2033 x 3.5\u2033",
        "1\u2033 x 2.625\u2033", "2\u2033 x 4\u2033", "4\u2033 x 6\u2033",
        "3.33\u2033 x 4\u2033", "2\u2033 x 2\u2033", "N/A"
    ],
    FLAT_SIZES_ENVELOPE: [
        "4.125\u2033 x 9.5\u2033 \u2003\u2003No. 10 Env",
        "3.875\u2033 x 8.875\u2033 \u2003\u2003No. 9 BRE Env",
        "5.25\u2033 x 7.25\u2033 \u2003\u2003A7 Env",
        "6\u2033 x 9.5\u2033 \u2003\u20036x9.5 Env",
        "9\u2033 x 12\u2033 \u2003\u20039x12 Flat Env",
        "N/A"
    ],

    PRESS_STANDARD: ["Canon (color)", "Titan (b&w)", "MCS", "Outside Print", "N/A"],
    PRESS_ENVELOPE: ["Kirk-Rudy", "Outside Print", "N/A"],

    ENVELOPE_KEYWORDS: ['envelope', 'no. 9', 'no. 10', 'a7', '6x9', '9x12'],

    // Field data-id for flat size input, press input
    flatSizeFieldId: 'ps3n',
    pressFieldId: 'sp3n',

    // Required fields
    REQUIRED_FIELDS: [
        { id: 'ps3n', label: 'Flat Size' },
        { id: 'sp2n', label: 'Presswork' },
        { id: 'ps1n', label: 'Press sheet' },
        { id: 'ps13n', label: 'Number Up' },
        { id: 'sp3n', label: 'Press' },
    ],
    REQUIRED_SKIP_ENVELOPE: ['ps1n', 'ps13n'],

    // Check if component is envelope-type
    isEnvelopeComponent: function(name) {
        const lower = (name || '').toLowerCase();
        return this.ENVELOPE_KEYWORDS.some(kw => lower.includes(kw));
    },

    // Get active required fields for this component
    getRequiredFields: function(comp) {
        if (comp && this.isEnvelopeComponent(comp.name)) {
            return this.REQUIRED_FIELDS.filter(rf => !this.REQUIRED_SKIP_ENVELOPE.includes(rf.id));
        }
        return this.REQUIRED_FIELDS;
    },

    // Update flat size dropdown options based on component type
    updateDropdowns: function(comp) {
        const isEnv = comp ? this.isEnvelopeComponent(comp.name) : false;

        // Flat size
        const fsInput = document.querySelector('[data-id="ps3n"]');
        if (fsInput) {
            const wrapper = fsInput.closest('.quick-pick-wrapper');
            if (wrapper) {
                const menu = wrapper.querySelector('.quick-pick-menu');
                if (menu) {
                    menu.dataset.options = JSON.stringify(isEnv ? this.FLAT_SIZES_ENVELOPE : this.FLAT_SIZES_STANDARD);
                    delete menu.dataset.populated;
                    menu.innerHTML = '';
                }
            }
        }

        // Press
        const prInput = document.querySelector('[data-id="sp3n"]');
        if (prInput) {
            const wrapper = prInput.closest('.quick-pick-wrapper');
            if (wrapper) {
                const menu = wrapper.querySelector('.quick-pick-menu');
                if (menu) {
                    menu.dataset.options = JSON.stringify(isEnv ? this.PRESS_ENVELOPE : this.PRESS_STANDARD);
                    delete menu.dataset.populated;
                    menu.innerHTML = '';
                }
            }
        }
    },

    // Auto-complete flat size dimension to full option string
    autoCompleteFlatSize: function() {
        const input = document.querySelector('[data-id="ps3n"]');
        if (!input) return;
        const raw = input.value.trim();
        if (!raw) return;
        const normalized = this._normalizeDim(raw);

        const wrapper = input.closest('.quick-pick-wrapper');
        if (!wrapper) return;
        const menu = wrapper.querySelector('.quick-pick-menu');
        if (!menu) return;
        const options = JSON.parse(menu.dataset.options || '[]');

        for (const opt of options) {
            const dimPart = opt.includes('\u2003') ? opt.slice(0, opt.indexOf('\u2003')) : opt;
            if (this._normalizeDim(dimPart) === normalized) {
                input.value = opt;
                break;
            }
        }
    },

    _normalizeDim: function(s) {
        return s.replace(/[\u2033\u201d"'\u2032]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    },

    // Print accent color
    printAccent: '#CB333B',

    // Print sections (field mapping for PDF output)
    PRINT_SECTIONS: [
        { title: 'Piece Specs', fields: [
            { cbId: 'sp1', noteId: 'sp1n', label: 'Previous Job#' },
            { cbId: 'ps3', noteId: 'ps3n', label: 'Flat Size' },
            { cbId: 'ps4', noteId: 'ps4n', label: 'Finished Size' },
            { cbId: 'sp2', noteId: 'sp2n', label: 'Presswork' },
            { cbId: 'sp3', noteId: 'sp3n', label: 'Press' },
            { cbId: 'ps1', noteId: 'ps1n', label: 'Press sheet' },
            { cbId: 'ps14', noteId: 'ps14n', label: 'Print marks' },
            { cbId: 'ps13', noteId: 'ps13n', label: 'Number Up' },
            { cbId: 'sp7', noteId: 'sp7n', label: 'Indicia' },
            { cbId: 'ps10', noteId: 'ps10n', label: 'Head info' },
            { cbId: 'sp6', noteId: 'sp6n', label: 'Binding info' },
            { cbId: 'sp4', noteId: 'sp4n', label: 'Special color' },
        ]},
        { title: 'File Path', fields: [
            { cbId: 'fp1', noteId: 'fp1n', label: 'Artwork path' },
            { cbId: 'fp3', noteId: 'fp3n', label: 'Mockup path' },
            { cbId: 'fp2', noteId: 'fp2n', label: 'SOF path' },
            { cbId: 'fp7', noteId: 'fp7n', label: 'Seeds & Samp' },
            { cbId: 'fp5', noteId: 'fp5n', label: 'Lives path' },
            { cbId: 'fp6', noteId: 'fp6n', label: 'Record Counts' },
            { cbId: 'fp4', noteId: 'fp4n', label: 'Other path' },
        ]},
        { title: 'Variable Print', fields: [
            { cbId: 'ps11', noteId: 'ps11n', label: 'Address Blk' },
            { cbId: 'vp1', noteId: 'vp1n', label: '2D (camera)' },
            { cbId: 'ps12', noteId: 'ps12n', label: '2D (inserter)' },
            { cbId: 'vp3', noteId: 'vp3n', label: 'Match job' },
        ]},
    ]
};
