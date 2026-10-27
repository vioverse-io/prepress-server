
    // ── Theme toggle (light ↔ dark), persisted in localStorage ──
    function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        if (next === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        try { localStorage.setItem('wo-theme', next); } catch (e) {}
    }

    let currentJobId = null;
    let currentComponentId = null;
    let activeDepartment = 'prepress';
    // An archived job opened with View, read only (DECISIONS item 8,
    // ARCHIVE_VIEW_PLAN). Held here and never in jobsCache: every function
    // that changes a work order finds the open job in the active list, so for
    // this one they find nothing and write nothing. Only the functions that
    // draw the work order and print it ask shownJob() for it.
    let viewedJob = null;
    const MAX_ACTIVE_JOBS = 10000;
    const MAX_UNDO_HISTORY = 15;
    const MAX_COMPONENTS = 10;

    // Tab in the instructions box moves on to the next box, and Shift+Tab goes
    // back, as in any other box (KEYBOARD_PLAN.md 2.1). Quill merges these into
    // its own bindings by name, and a handler that answers true hands the key on;
    // when nothing stops it, Chrome moves the focus. A bullet (or any indented
    // line) is pushed in or out only with words selected: Tab arriving in the box
    // puts the caret at its start, so on a box that begins with a bullet a plain
    // Tab pushed it in again and again and saved that under a reader's name.
    const passKey = () => ({ handler() { return true; } });
    const quillTabBindings = {
        tab: passKey(),
        'remove tab': passKey(),
        'indent code-block': passKey(),
        'outdent code-block': passKey(),
        indent: { handler(range, context) {
            if (context.collapsed) return true;
            this.quill.format('indent', '+1', 'user');
            return false;
        } },
        outdent: { handler(range, context) {
            if (context.collapsed) return true;
            this.quill.format('indent', '-1', 'user');
            return false;
        } }
    };

    // Initialize Quill editor (history disabled — app-level undo/redo handles full form state)
    const quill = new Quill('#csrInstructions', {
        theme: 'snow',
        modules: {
            toolbar: '#quill-toolbar',
            history: { maxStack: 0 },
            keyboard: { bindings: quillTabBindings }
        },
        placeholder: 'Type instructions here...'
    });

    // Strip Word/HTML tables on paste. Quill Snow does not support table-cell
    // editing, so pasted tables leave undeletable cell borders. Convert each
    // row to a plain-text line with pipe separators between cells. Both
    // editors get it, this one and the hidden one that rebuilds a summary
    // block (summaryScratch): each converts stored words through its own
    // clipboard, and a stored table must come out the same in both.
    function stripTablesOnPaste(q) {
    q.clipboard.addMatcher('TABLE', function(node) {
        const Delta = Quill.import('delta');
        const out = new Delta();
        const rows = node.querySelectorAll('tr');
        rows.forEach(function(row) {
            const cells = row.querySelectorAll('td, th');
            const rowText = Array.from(cells)
                .map(function(c) { return (c.innerText || c.textContent || '').trim(); })
                .join('  |  ');
            if (rowText) out.insert(rowText + '\n');
        });
        return out;
    });
    }
    stripTablesOnPaste(quill);

    // Quill rewrites what it loads: two spaces become one, a space at the
    // start or end of a line and a Tab go, old plain text and <b> become its
    // own HTML, and a style with a colour and a background swaps the two on
    // every load. So the editor's HTML differs from the stored words although
    // nobody touched the box, and writing it back put the reader's name on the
    // work order (seen 2026-09-26: a Tech Services tab click on 50355 saved its
    // words again under David's name). Each load is therefore remembered, per
    // job, piece and department: the stored value exactly as it was and what
    // the editor held right after. While the editor still holds that and the
    // stored value has not moved, the stored words are kept (editorUntouched).
    // The content is compared, not the HTML: a toolbar button pressed with
    // nothing selected adds a hidden cursor span to the HTML and no content.
    // Undo and Redo are real changes and are never remembered as a load.
    const editorLoads = new Map();

    // Old plain text (no tags at all) kept its line breaks as newlines.
    function instructionsAsHtml(stored) {
        return (stored && !stored.includes('<')) ? stored.replace(/\n/g, '<br>') : (stored || '');
    }

    // Stored instructions and revisions are HTML. The editor only ever writes
    // Quill's own formats, but a hand-made request or an import file can put
    // anything in them, and they are drawn for every reader (R25, the
    // after-rollout batch, item 12). So what the page draws of them is cleaned
    // first: DOMPurify (lib/purify.min.js) keeps bold, lists, colours, links,
    // pictures and the revision markup, and drops scripts, event attributes,
    // javascript: links, <style> and form controls; ids and names go too, so
    // stored words can never stand in for one of the page's own elements.
    // The print frame needs none of this: it is sandboxed and runs nothing
    // (printViaIframe), so a print is the stored record as it is. review.js
    // cleans the signed sheet on screen the same way (sheetHtml).
    const CLEAN_HTML = { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option'], FORBID_ATTR: ['id', 'name'] };
    function cleanHtml(html) {
        if (!html) return '';
        if (window.DOMPurify && window.DOMPurify.isSupported) return window.DOMPurify.sanitize(html, CLEAN_HTML);
        // lib/purify.min.js did not load (a file missing from an install):
        // the words as plain text, never the stored HTML as it is.
        const text = inertBody(String(html).replace(/<(br|\/p|\/li|\/div|\/h[1-6])\b[^>]*>/gi, '$&\n')).textContent;
        return escHtml(text).replace(/\n/g, '<br>');
    }
    // Stored HTML parsed where nothing in it can run or load: a document of
    // its own, never an element of this page, whose pictures load (and fire
    // their onerror) even off screen.
    function inertBody(html) {
        return new DOMParser().parseFromString(html || '', 'text/html').body;
    }

    // A piece's stored words for one department, into the editor. Not
    // dangerouslyPasteHTML, which also puts the caret at the top of the box and
    // focuses it, so a reader's next Space, Tab or Enter after a tab click typed
    // into the instructions; this is the same content without the focus.
    function loadEditor(comp, dept) {
        const stored = comp['instructions_' + dept];
        const html = instructionsAsHtml(stored);
        if (html) quill.setContents(quill.clipboard.convert({ html, text: '' }), 'api');
        else quill.setContents([], 'api');
        editorLoads.set(currentJobId + '|' + comp.id + '|' + dept, { stored, content: quill.getContents() });
    }

    // The editor's words as HTML, without Quill's cursor: a toolbar button
    // pressed with nothing selected (Bold, Ctrl+B) puts a hidden cursor span
    // into the HTML and nothing into the content, so reading innerHTML then
    // saved that span and read as a change nobody made (build review A-2).
    function editorHtml() {
        const root = quill.root;
        if (!root.querySelector('.ql-cursor')) return root.innerHTML;
        const copy = root.cloneNode(true);
        copy.querySelectorAll('.ql-cursor').forEach(cursor => {
            let node = cursor;
            let parent = node.parentNode;
            node.remove();
            // The empty bold or italic it sat in goes with it.
            while (parent && parent !== copy && !parent.childNodes.length && /^(STRONG|EM|U|S|SPAN|B|I|SUB|SUP|A)$/.test(parent.nodeName)) {
                node = parent;
                parent = node.parentNode;
                node.remove();
            }
            // A blank line that held only the cursor keeps the <br> Quill
            // would have (an empty <p> draws at no height outside the editor).
            if (parent && parent !== copy && /^(P|LI|H[1-6]|BLOCKQUOTE|PRE)$/.test(parent.nodeName) &&
                !Array.from(parent.childNodes).some(n => !(n.nodeType === 1 && n.classList.contains('ql-ui')))) {
                parent.appendChild(document.createElement('br'));
            }
        });
        return copy.innerHTML;
    }

    function editorUntouched(comp, dept) {
        const load = editorLoads.get(currentJobId + '|' + comp.id + '|' + dept);
        return !!load && comp['instructions_' + dept] === load.stored
            && quill.getContents().diff(load.content).ops.length === 0;
    }
    const PIECE_FORMAT_OPTIONS = ["6x9.5\u2033 Envelope", "9x12 Envelope", "A7 Envelope", "Booklet", "Buckslip", "Label", "Letter", "No. 9 BRE Envelope", "No. 10 Envelope", "No. 10 Envelope Window", "Postcard", "Remit", "Self-Mailer", "Sticker"];
    const CSR_NAMES = ["Brandilee Czajkowski", "Charlene Fitzpatrick", "Claudine Hauret", "Courtney Coyle", "Doug Jowsey", "Gina Burton", "Jamie Coyle", "Lucy Ballester", "Marc Maio", "Rosette Jowsey", "Stef Tarpy"];

    // ── Roster: CSR and assignee lists, editable in the app ──────────────
    //
    // These lists used to live only in the constants above and in each dept's
    // ASSIGNEE_OPTIONS, so hiring or losing a CSR meant editing this file and
    // having IT swap it. They come from the roster table now.
    //
    // The constants stay put on purpose. They are the fallback and the seed:
    // if the table is missing, the account cannot create it, or the fetch
    // fails, every picker shows exactly what it showed before the roster
    // existed. A roster problem must never stop anyone working on a job.
    let _roster = null;   // null means unavailable -- use the built-ins

    function builtInRoster() {
        const dr = window.DEPT_REGISTRY || {};
        return {
            csr:          CSR_NAMES.slice(),
            prepress:     ((dr.prepress     && dr.prepress.ASSIGNEE_OPTIONS)     || []).slice(),
            techservices: ((dr.techservices && dr.techservices.ASSIGNEE_OPTIONS) || []).slice()
        };
    }

    async function loadRoster() {
        try {
            const res = await fetch('/api/roster', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ seed: builtInRoster() })
            });
            if (!res.ok) { _roster = null; return; }
            const data = await res.json();
            _roster = (data && data.available && Array.isArray(data.people)) ? data.people : null;
        } catch (e) {
            _roster = null;   // offline or old server: fall back silently
        }
    }

    // Active names for one list. Falls back to the built-in list if the roster
    // is unavailable, and also if it somehow came back empty -- an empty picker
    // would be worse than a stale one.
    function rosterNames(kind) {
        const builtIn = builtInRoster()[kind] || [];
        if (!_roster) return builtIn;
        const names = _roster.filter(p => p.kind === kind && p.active).map(p => p.name);
        return names.length ? names.sort((a, b) => a.localeCompare(b)) : builtIn;
    }

    // Every entry, active or not, for the management screen.
    function rosterAll(kind) {
        if (!_roster) return [];
        return _roster.filter(p => p.kind === kind)
                      .slice().sort((a, b) => a.name.localeCompare(b.name));
    }

    function rosterEditable() { return _roster !== null; }

    function getCsrNames() { return rosterNames('csr'); }
    function getAssigneeNames(deptId) { return rosterNames(deptId); }
    // Flat Size dropdown options — standard vs envelope
    const FLAT_SIZES_STANDARD = [
        "3.5\u2033 x 5\u2033",
        "4\u2033 x 6\u2033",
        "4.25\u2033 x 6\u2033",
        "5\u2033 x 7\u2033",
        "6\u2033 x 9\u2033",
        "6\u2033 x 11\u2033",
        "8.5\u2033 x 5.5\u2033",
        "8.5\u2033 x 11\u2033",
        "8.5\u2033 x 14\u2033",
        "11\u2033 x 17\u2033",
        "8.5\u2033 x 3.5\u2033",
        "1\u2033 x 2.625\u2033",
        "2\u2033 x 4\u2033",
        "4\u2033 x 6\u2033",
        "3.33\u2033 x 4\u2033",
        "2\u2033 x 2\u2033",
        "N/A"
    ];
    const FLAT_SIZES_ENVELOPE = [
        "4.125\u2033 x 9.5\u2033 \u2003\u2003No. 10 Env",
        "3.875\u2033 x 8.875\u2033 \u2003\u2003No. 9 BRE Env",
        "5.25\u2033 x 7.25\u2033 \u2003\u2003A7 Env",
        "6\u2033 x 9.5\u2033 \u2003\u20036x9.5 Env",
        "9\u2033 x 12\u2033 \u2003\u20039x12 Flat Env",
        "N/A"
    ];
    const ENVELOPE_KEYWORDS = ['envelope', 'no. 9', 'no. 10', 'a7', 'bre'];

    function isEnvelopeComponent(name) {
        const lower = (name || '').toLowerCase();
        return ENVELOPE_KEYWORDS.some(kw => lower.includes(kw));
    }

    // Press dropdown options — standard vs envelope
    const PRESS_STANDARD = ["Canon (color)", "Titan (b&w)", "MCS", "Outside Print", "N/A"];
    const PRESS_ENVELOPE = ["Kirk-Rudy", "Outside Print", "N/A"];

    function autoCompleteFlatSize() {
        // A viewed archived job is read only: this rewrites the box by code.
        if (isViewed(currentJobId)) return;
        // Delegate to active department
        const dept = window.DEPT_REGISTRY[activeDepartment];
        if (dept && dept.autoCompleteFlatSize) dept.autoCompleteFlatSize();
        if (currentJobId) debouncedSaveJobState();
    }

    // Attach auto-complete on blur and Enter for flat size (both departments).
    // On blur only when something was typed in the box since it got focus:
    // clicking in and away, or pressing Home, must not rewrite a value nobody
    // touched (an old "8.5 x 11") and put that person's name on the job.
    document.addEventListener('focus', (e) => {
        if (e.target.matches && e.target.matches('[data-id="ps3n"]')) e.target._typedSinceFocus = false;
    }, true);
    document.addEventListener('input', (e) => {
        if (e.target.matches && e.target.matches('[data-id="ps3n"]')) e.target._typedSinceFocus = true;
    }, true);
    document.addEventListener('blur', (e) => {
        if (e.target.matches('[data-id="ps3n"]') && e.target._typedSinceFocus) autoCompleteFlatSize();
    }, true);
    document.addEventListener('keydown', (e) => {
        // Not behind a box: the key is the box's (KEYBOARD_PLAN.md 2).
        if (e.defaultPrevented) return;
        if (e.target.matches('[data-id="ps3n"]') && e.key === 'Enter') {
            e.preventDefault();
            autoCompleteFlatSize();
            e.target.blur();
        }
    });

    // Required fields — notes data-ids that must be filled before a job is production-ready
    const REQUIRED_FIELDS_BASE = [
        { id: 'ps3n', label: 'Flat Size' },
        { id: 'sp2n', label: 'Presswork' },
        { id: 'ps1n', label: 'Sheet size' },
        { id: 'ps13n', label: 'Number Up' },
        { id: 'sp3n', label: 'Press' },
    ];
    const REQUIRED_SKIP_ENVELOPE = ['ps1n', 'ps13n']; // Sheet size, Number Up

    function getActiveRequiredFields() {
        // Delegate to department registry
        return getDeptRequiredFields();
    }

    // Per-department undo/redo stacks. Each tab is its own "document" — Ctrl+Z
    // on Prepress can never touch Tech Services (matches InDesign/Word/VS Code
    // tabbed document convention).
    let undoStacks = { prepress: [], techservices: [] };
    let redoStacks = { prepress: [], techservices: [] };
    let isUndoRedo = false;
    let undoRedoCooldown = false;
    let saveDebounceTimer = null;   // set only while typing is waiting to be saved
    // The open Signoff due editor's commit, so leaving the work order can run
    // it first (sendWaitingSaves). Null when that editor is not open.
    let _signoffCommit = null;
    let fieldDirty = false;
    function getActiveUndoStack() { return undoStacks[activeDepartment] || (undoStacks[activeDepartment] = []); }
    function getActiveRedoStack() { return redoStacks[activeDepartment] || (redoStacks[activeDepartment] = []); }
    function clearAllUndoStacks() {
        undoStacks = { prepress: [], techservices: [] };
        redoStacks = { prepress: [], techservices: [] };
    }
    // Pre-edit snapshot captured on focusin. Pushed to the undo stack on the
    // first input/text-change in a focus session so undo restores the state
    // *before* the first keystroke (not after it).
    let focusSnapshot = null;

    function toggleTextSize() {
        document.body.classList.toggle('text-lg');
        localStorage.setItem('prepressTextLg', document.body.classList.contains('text-lg') ? '1' : '');
    }
    // Restore on load
    if (localStorage.getItem('prepressTextLg') === '1') document.body.classList.add('text-lg');

    // ========== SERVER BACKUP (no IndexedDB needed) ==========

    function showToast(msg) {
        const el = document.getElementById('backupToast');
        el.textContent = msg;
        el.classList.add('visible');
        setTimeout(() => el.classList.remove('visible'), 4000);
    }

    async function restoreFromBackupUI() { }

    function autoResizeTextarea(el) {
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
    }
    function autoResizeAllTextareas() {
        document.querySelectorAll('.notes-multi').forEach(autoResizeTextarea);
    }

    /* ════════════════════════════════════════════════════════════════
       PROFILE / PHOTO SYSTEM
       ════════════════════════════════════════════════════════════════ */
    // ── Generic greetings (fallback) ──
    const GREETINGS_GENERIC = [
        name => `Welcome back, ${name}!`,
        name => `Hey ${name}, what are we working on?`,
        name => `${name}'s on it.`,
        name => `Ready when you are, ${name}.`,
        name => `Let's get to work, ${name}.`,
        name => `${name} returns!`,
        name => `Good to see you, ${name}.`,
        name => `Back at it, ${name}.`,
        name => `What's on deck, ${name}?`,
        name => `Another day, another job, ${name}.`,
        name => `${name} has entered the building.`,
        name => `The press waits for no one, ${name}.`,
        name => `Stay classy, ${name}.`,
        name => `As you wish, ${name}.`,
        name => `Who you gonna call? ${name}, apparently.`,
        name => `The Dude abides, ${name}.`,
        name => `${name}, I'm kind of a big deal around here.`,
        name => `Don't call me Shirley, ${name}.`,
        name => `Bueller? Bueller? ... ${name}?`,
        name => `But ya are, ${name}! Ya are in that chair!`,
        name => `${name}! ... ${name}!`,
        name => `Eee-vah! ... I mean, ${name}!`
    ];

    // ── Time-of-day greetings ──
    const GREETINGS_TIME = {
        earlyBird: [ // before 6am
            name => `Burning the midnight oil, ${name}?`,
            name => `Up before the sun, ${name}. Respect.`,
            name => `${name}, the early bird catches the deadline.`
        ],
        morning: [ // 6am-12pm
            name => `Good morning, ${name}!`,
            name => `Morning, ${name}. Coffee first, prepress second.`,
            name => `Rise and grind, ${name}.`
        ],
        afternoon: [ // 12pm-5pm
            name => `Good afternoon, ${name}!`,
            name => `Afternoon, ${name}. Let's knock this out.`
        ],
        evening: [ // 5pm-10pm
            name => `Good evening, ${name}!`,
            name => `Still at it, ${name}? Let's finish strong.`,
            name => `Evening shift, ${name}. Let's go.`
        ],
        nightOwl: [ // after 10pm
            name => `Burning the midnight oil, ${name}?`,
            name => `Night owl mode, ${name}.`,
            name => `${name}, the presses never sleep.`
        ]
    };

    // ── Day-of-week greetings ──
    const GREETINGS_DAY = {
        1: [ // Monday
            name => `Monday morning, ${name}. Let's ease into it.`,
            name => `Happy Monday, ${name}. Deep breath.`,
            name => `New week, fresh start, ${name}.`,
            name => `Monday again, ${name}. We've got this.`,
            name => `Sounds like somebody's got a case of the Mondays, ${name}.`,
            name => `${name}, I believe you have my stapler.`,
            name => `Monday, ${name}. Did you get the memo about the TPS reports?`,
            name => `${name}, we're gonna need you to come in on Saturday. That'd be great.`,
            name => `What would you say... you DO here, ${name}?`
        ],
        2: [ // Tuesday
            name => `Tuesday, ${name}. The day nobody writes songs about.`,
            name => `Taco Tuesday, ${name}. That's all the motivation you need.`,
            name => `${name}, Tuesday called. It wants more effort than Monday got.`,
            name => `Tuesday, ${name}. Yesterday's excuses have expired.`,
            name => `${name}, it's Tuesday. We're warmed up now.`
        ],
        3: [ // Wednesday
            name => `Hump day, ${name}! Downhill from here.`,
            name => `Happy Wednesday, ${name}. Halfway there.`,
            name => `It's Wednesday, ${name}. Coast is in sight.`
        ],
        4: [ // Thursday
            name => `Thursday, ${name}. Friday's opening act.`,
            name => `Almost Friday, ${name}. Hang in there.`,
            name => `Thursday, ${name}. Close enough to smell the weekend.`,
            name => `${name}, it's basically Friday. Basically.`
        ],
        5: [ // Friday
            name => `Happy Friday, ${name}!`,
            name => `Friday, ${name}! Let's wrap it up.`,
            name => `TGIF, ${name}. Finish line is close.`,
            name => `Friday vibes, ${name}. Almost there.`,
            name => `It's Fri-yay, ${name}. You made it.`,
            name => `One more push, ${name}. Weekend's calling.`,
            name => `${name}, the weekend is within striking distance.`
        ],
        0: [ // Sunday
            name => `Weekend warrior, ${name}?`,
            name => `Sunday session, ${name}. Dedication.`,
            name => `${name}, working on a Sunday? Above and beyond.`,
            name => `Sunday, ${name}. Even God rested, but here you are.`,
            name => `${name} doesn't take days off. Noted.`
        ],
        6: [ // Saturday
            name => `Working the weekend, ${name}?`,
            name => `Saturday grind, ${name}. Respect.`
        ]
    };

    // ── Holiday greetings ──
    // Returns null if no holiday, or an array of greeting functions
    function getHolidayGreetings(month, day, year) {
        // Fixed-date holidays
        if (month === 1 && day === 1) return [
            name => `Happy New Year, ${name}!`,
            name => `New year, new jobs, ${name}!`,
            name => `${name} kicks off the new year!`
        ];
        if (month === 12 && day === 31) return [
            name => `Happy New Year's Eve, ${name}!`,
            name => `Last job of the year, ${name}?`,
            name => `Closing out the year, ${name}. Cheers!`
        ];
        if (month === 2 && day === 14) return [
            name => `Happy Valentine's Day, ${name}!`,
            name => `Roses are red, proofs are due, ${name}.`,
            name => `Love is in the air, ${name}. And ink.`
        ];
        if (month === 3 && day === 17) return [
            name => `Happy St. Patrick's Day, ${name}!`,
            name => `Feeling lucky, ${name}?`,
            name => `May your traps be clean, ${name}.`
        ];
        if (month === 7 && day === 4) return [
            name => `Happy 4th of July, ${name}!`,
            name => `Happy Independence Day, ${name}!`,
            name => `Red, white, blue, and CMYK, ${name}.`
        ];
        if (month === 10 && day === 31) return [
            name => `Happy Halloween, ${name}!`,
            name => `Spooky season, ${name}. Watch for ghost images.`,
            name => `Trick or treat, ${name}. Mostly deadlines though.`
        ];
        if (month === 12 && day === 24) return [
            name => `Happy Christmas Eve, ${name}!`,
            name => `Almost Christmas, ${name}. Last push!`
        ];
        if (month === 12 && day === 25) return [
            name => `Merry Christmas, ${name}!`,
            name => `${name}, working on Christmas? That's dedication.`
        ];

        // Floating holidays — computed
        // Memorial Day: last Monday of May
        if (month === 5) {
            const lastDay = new Date(year, 4, 31);
            const memDay = 31 - ((lastDay.getDay() + 6) % 7);
            if (day === memDay) return [
                name => `Happy Memorial Day, ${name}.`,
                name => `Honoring those who served. Happy Memorial Day, ${name}.`
            ];
        }
        // Labor Day: first Monday of September
        if (month === 9) {
            const first = new Date(year, 8, 1);
            const labDay = 1 + ((8 - first.getDay()) % 7);
            if (day === labDay) return [
                name => `Happy Labor Day, ${name}!`,
                name => `Labor Day, ${name}. The irony of working today.`
            ];
        }
        // Thanksgiving: 4th Thursday of November
        if (month === 11) {
            const first = new Date(year, 10, 1);
            const firstThurs = 1 + ((11 - first.getDay()) % 7);
            const tDay = firstThurs + 21;
            if (day === tDay) return [
                name => `Happy Thanksgiving, ${name}!`,
                name => `Grateful for good prepress, ${name}.`,
                name => `Turkey day, ${name}. Save room for pie.`
            ];
        }

        return null;
    }

    // Friday the 13th check
    function isFridayThe13th(date) {
        return date.getDay() === 5 && date.getDate() === 13;
    }

    function pickGreeting(name) {
        const now = new Date();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        const year = now.getFullYear();
        const hour = now.getHours();
        const dow = now.getDay();
        const pick = arr => arr[Math.floor(Math.random() * arr.length)];

        // 1. Holidays (always win)
        const holiday = getHolidayGreetings(month, day, year);
        if (holiday) return pick(holiday)(name);

        // 2. Friday the 13th (rare, fun)
        if (isFridayThe13th(now)) {
            return pick([
                name => `Friday the 13th, ${name}. Check your files twice.`,
                name => `Careful out there, ${name}. It's Friday the 13th.`
            ])(name);
        }

        // 3. Day-of-week (50% chance, so it's not always day-themed)
        if (GREETINGS_DAY[dow] && Math.random() < 0.5) {
            return pick(GREETINGS_DAY[dow])(name);
        }

        // 4. Time-of-day (40% chance)
        if (Math.random() < 0.4) {
            let bucket;
            if (hour < 6) bucket = GREETINGS_TIME.earlyBird;
            else if (hour < 12) bucket = GREETINGS_TIME.morning;
            else if (hour < 17) bucket = GREETINGS_TIME.afternoon;
            else if (hour < 22) bucket = GREETINGS_TIME.evening;
            else bucket = GREETINGS_TIME.nightOwl;
            return pick(bucket)(name);
        }

        // 5. Generic fallback
        return pick(GREETINGS_GENERIC)(name);
    }

    // The user picked from the user list for this page (js/user-picker.js), for
    // example "David.Marra". An honor-system user picker, not a sign-in.
    function getUserName() { return window.userPicker ? window.userPicker.user() : ''; }
    function byLabel(name) { return name ? ' by ' + name : ''; }

    // A person as a key that compares reliably: no DOMAIN\ in front, nothing
    // from an @ on, small letters (userKey in user-list.js on the server).
    function userKeyOf(raw) {
        return String(raw || '').split('\\').pop().split('@')[0].trim().toLowerCase();
    }

    // Change user, from the profile popover. A work order open now belongs to
    // the person who opened it, so it is closed the app's own way first.
    function changeUserFromProfile() {
        document.getElementById('profilePopover').classList.remove('open');
        if (!window.userPicker) return;
        if (currentJobId) {
            const job = shownJob();
            if (!confirm('Close ' + (job ? job.jobNumber : 'this job') + ' and change user?')) return;
            // A save still owed asks Stay or Leave first: Stay cancels the
            // change of user (SAVE_FAILURE_PLAN.md).
            closeJobWithWarning(true, () => window.userPicker.change());
            return;
        }
        window.userPicker.change();
    }

    // Before the page reloads as someone else: the saves already on their way
    // (closing a work order files its instructions), and any held while the
    // server was away, get up to 5 seconds to finish. Only read here: the
    // save code is not changed.
    window.appSavesSettled = async function () {
        const until = Date.now() + 5000;
        await savesSettled(5000);
        while (_retryQueue.length && Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    };

    // ── Photo crop state ──
    let _cropState = { img: null, scale: 1, baseScale: 1, ox: 0, oy: 0, dragging: false, sx: 0, sy: 0 };

    function triggerPhotoUpload() {
        document.getElementById('profilePhotoInput').click();
    }

    function handlePhotoSelect(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            // Store original for re-cropping on popover reopen
            localStorage.setItem('prepressUserPhotoSrc', reader.result);
            loadCropImage(reader.result);
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    }

    function loadCropImage(src) {
        const img = document.getElementById('profileCropImg');
        const circle = document.getElementById('profileCropCircle');
        img.onload = () => {
            const size = circle.offsetWidth;
            const baseScale = size / Math.min(img.naturalWidth, img.naturalHeight);
            _cropState = { img: img, scale: 1, baseScale: baseScale, ox: 0, oy: 0, dragging: false, sx: 0, sy: 0 };
            const zoom = document.getElementById('profileZoom');
            zoom.value = 1;
            zoom.style.display = '';
            img.style.display = '';
            document.getElementById('profileCropPlaceholder').style.display = 'none';
            document.getElementById('profileCropInitial').style.display = 'none';
            document.getElementById('profileRemoveBtn').style.display = '';
            applyCropTransform();
        };
        img.src = src;
    }

    function applyCropTransform() {
        const img = _cropState.img;
        if (!img) return;
        const s = _cropState.baseScale * _cropState.scale;
        const w = img.naturalWidth * s;
        const h = img.naturalHeight * s;
        const circle = document.getElementById('profileCropCircle');
        const size = circle.offsetWidth;
        // Clamp offset so image always covers the circle
        const maxOx = Math.max(0, (w - size) / 2);
        const maxOy = Math.max(0, (h - size) / 2);
        _cropState.ox = Math.min(maxOx, Math.max(-maxOx, _cropState.ox));
        _cropState.oy = Math.min(maxOy, Math.max(-maxOy, _cropState.oy));
        img.style.width = w + 'px';
        img.style.height = h + 'px';
        img.style.left = ((size - w) / 2 + _cropState.ox) + 'px';
        img.style.top = ((size - h) / 2 + _cropState.oy) + 'px';
    }

    function removePhoto() {
        _cropState = { img: null, scale: 1, baseScale: 1, ox: 0, oy: 0, dragging: false, sx: 0, sy: 0 };
        const img = document.getElementById('profileCropImg');
        img.style.display = 'none';
        img.src = '';
        document.getElementById('profileZoom').style.display = 'none';
        document.getElementById('profileRemoveBtn').style.display = 'none';
        const name = profileDisplayName();
        if (name) {
            showCropInitial(name);
        } else {
            document.getElementById('profileCropPlaceholder').style.display = '';
            document.getElementById('profileCropInitial').style.display = 'none';
        }
        localStorage.removeItem('prepressUserPhoto');
        localStorage.removeItem('prepressUserPhotoSrc');
        updateProfileBtn();
    }

    function showCropInitial(name) {
        const el = document.getElementById('profileCropInitial');
        el.textContent = name.charAt(0).toUpperCase();
        el.style.display = '';
        document.getElementById('profileCropPlaceholder').style.display = 'none';
    }

    function cropToDataURL() {
        const img = _cropState.img;
        if (!img || !img.src) return null;
        const canvas = document.createElement('canvas');
        const outSize = 96;
        canvas.width = outSize;
        canvas.height = outSize;
        const ctx = canvas.getContext('2d');
        const circle = document.getElementById('profileCropCircle');
        const size = circle.offsetWidth;
        const s = _cropState.baseScale * _cropState.scale;
        const w = img.naturalWidth * s;
        const h = img.naturalHeight * s;
        const imgLeft = (size - w) / 2 + _cropState.ox;
        const imgTop = (size - h) / 2 + _cropState.oy;
        const ratio = outSize / size;
        ctx.drawImage(img, imgLeft * ratio, imgTop * ratio, w * ratio, h * ratio);
        return canvas.toDataURL('image/jpeg', 0.8);
    }

    // Crop drag + zoom handlers (attached once on DOMContentLoaded)
    function initCropHandlers() {
        const circle = document.getElementById('profileCropCircle');
        const zoom = document.getElementById('profileZoom');

        function onPointerDown(x, y) {
            if (!_cropState.img || !_cropState.img.src) return;
            _cropState.dragging = true;
            _cropState.sx = x - _cropState.ox;
            _cropState.sy = y - _cropState.oy;
        }
        function onPointerMove(x, y) {
            if (!_cropState.dragging) return;
            _cropState.ox = x - _cropState.sx;
            _cropState.oy = y - _cropState.sy;
            applyCropTransform();
        }
        function onPointerUp() { _cropState.dragging = false; }

        circle.addEventListener('mousedown', (e) => { e.preventDefault(); onPointerDown(e.clientX, e.clientY); });
        document.addEventListener('mousemove', (e) => onPointerMove(e.clientX, e.clientY));
        document.addEventListener('mouseup', onPointerUp);
        circle.addEventListener('touchstart', (e) => { onPointerDown(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
        document.addEventListener('touchmove', (e) => { if (_cropState.dragging) onPointerMove(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
        document.addEventListener('touchend', onPointerUp);

        zoom.addEventListener('input', () => {
            _cropState.scale = parseFloat(zoom.value);
            applyCropTransform();
        });
    }

    let _profileJustOpened = false;

    function toggleProfilePopover(e) {
        if (e) e.stopPropagation();
        const pop = document.getElementById('profilePopover');
        const isOpen = pop.classList.contains('open');
        document.querySelectorAll('.more-dropdown-content.open, .print-dropdown-content.open').forEach(d => d.classList.remove('open'));
        if (isOpen) {
            pop.classList.remove('open');
        } else {
            const saved = profileDisplayName();
            const savedPhotoSrc = localStorage.getItem('prepressUserPhotoSrc');
            document.getElementById('profileUserName').textContent = saved;
            document.getElementById('profileUserKey').textContent = getUserName();
            document.getElementById('profileNicknameInput').value = localStorage.getItem('prepressNickname') || '';

            // Reset crop area to saved state (use original source for re-cropping)
            const img = document.getElementById('profileCropImg');
            if (savedPhotoSrc) {
                loadCropImage(savedPhotoSrc);
            } else {
                img.style.display = 'none';
                img.src = '';
                document.getElementById('profileZoom').style.display = 'none';
                document.getElementById('profileRemoveBtn').style.display = 'none';
                if (saved) {
                    showCropInitial(saved);
                } else {
                    document.getElementById('profileCropPlaceholder').style.display = '';
                    document.getElementById('profileCropInitial').style.display = 'none';
                }
            }
            pop.classList.add('open');
            _profileJustOpened = true;
            requestAnimationFrame(() => { _profileJustOpened = false; });
        }
    }

    // The picked user as a name to show: "David.Marra" is "David Marra".
    function profileDisplayName() {
        return window.userPicker ? window.userPicker.display() : '';
    }

    function saveProfile() {
        const name = getUserName();
        // Save nickname (greeting display name)
        var nickInput = document.getElementById('profileNicknameInput');
        if (nickInput) {
            var nick = nickInput.value.trim();
            if (nick) {
                localStorage.setItem('prepressNickname', nick);
            } else {
                localStorage.removeItem('prepressNickname');
            }
        }
        // Save cropped photo
        const cropped = cropToDataURL();
        if (cropped) {
            localStorage.setItem('prepressUserPhoto', cropped);
        }
        updateProfileBtn();
        updateLandingGreeting();
        document.getElementById('profilePopover').classList.remove('open');
        var greeting = getGreetingName();
        if (name) showToast('Profile saved. Hey, ' + greeting + '!');
    }

    function updateProfileBtn() {
        const btn = document.getElementById('profileBtn');
        const iconEl = document.getElementById('profileBtnIcon');
        const photo = localStorage.getItem('prepressUserPhoto');
        const name = profileDisplayName();

        btn.classList.remove('has-profile', 'has-initial');
        if (photo) {
            iconEl.style.display = 'none';
            btn.style.backgroundImage = `url(${photo})`;
            btn.style.backgroundSize = 'cover';
            btn.style.backgroundPosition = 'center';
            btn.classList.add('has-profile');
        } else if (name) {
            iconEl.style.display = '';
            btn.style.backgroundImage = '';
            const initial = name.charAt(0).toUpperCase();
            iconEl.setAttribute('fill', 'none');
            iconEl.removeAttribute('stroke');
            iconEl.removeAttribute('stroke-width');
            iconEl.innerHTML = '<text x="12" y="17.5" text-anchor="middle" fill="white" font-family="DM Sans, system-ui, sans-serif" font-size="18" font-weight="600">' + initial + '</text>';
            btn.classList.add('has-initial');
        } else {
            iconEl.style.display = '';
            btn.style.backgroundImage = '';
            iconEl.setAttribute('fill', 'none');
            iconEl.setAttribute('stroke', 'rgba(255,255,255,0.7)');
            iconEl.setAttribute('stroke-width', '1.5');
            iconEl.setAttribute('stroke-linecap', 'round');
            iconEl.setAttribute('stroke-linejoin', 'round');
            iconEl.innerHTML = '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 12 0v1"/>';
        }
    }

    function displayFirstName(raw) {
        var first = raw.indexOf('.') > 0 ? raw.substring(0, raw.indexOf('.')) : raw;
        return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    }

    function getGreetingName() {
        var nick = localStorage.getItem('prepressNickname');
        if (nick) return nick;
        var name = getUserName();
        if (name) return displayFirstName(name);
        return '';
    }

    function updateLandingGreeting() {
        const el = document.getElementById('landingGreeting');
        if (!el) return;
        const name = getGreetingName();
        if (name) {
            el.textContent = pickGreeting(name);
        } else {
            el.textContent = 'Select or Create a Work Order';
        }
        const countEl = document.getElementById('landingJobCount');
        if (countEl) {
            const jobs = getActiveJobs();
            const connMsg = 'Connected to SQL Server';
            countEl.textContent = connMsg + ' -- ' + jobs.length + ' active job' + (jobs.length !== 1 ? 's' : '');
        }
    }

    // Close profile popover on outside click
    document.addEventListener('click', (e) => {
        if (_profileJustOpened) return;
        const pop = document.getElementById('profilePopover');
        if (pop && pop.classList.contains('open') && !e.target.closest('.profile-btn') && !e.target.closest('.profile-popover')) {
            pop.classList.remove('open');
        }
    });

    // Keep `--billboard-height` and `--component-tabs-height` in sync with the
    // actual rendered heights of those elements so each downstream sticky
    // element can dock flush against its upstream neighbor. Without syncing,
    // each sticky sibling hits its threshold at a different scroll moment,
    // producing gaps that expand and contract with wheel direction.
    function initBillboardHeightSync() {
        const observe = (el, cssVar) => {
            if (!el) return;
            const update = () => {
                const h = el.offsetHeight;
                if (h > 0) document.documentElement.style.setProperty(cssVar, h + 'px');
            };
            update();
            if (window.ResizeObserver) {
                new ResizeObserver(update).observe(el);
            } else {
                window.addEventListener('resize', update);
            }
        };
        observe(document.getElementById('printHeader'), '--billboard-height');
        observe(document.querySelector('.component-tabs-wrapper'), '--component-tabs-height');
        observe(document.querySelector('.dept-tabs'), '--dept-tabs-height');
        // The save bar: its words can wrap on a narrow window.
        const bar = document.getElementById('saveBar');
        if (bar && window.ResizeObserver) new ResizeObserver(saveBarHeight).observe(bar);
        else window.addEventListener('resize', saveBarHeight);
    }

    document.addEventListener('DOMContentLoaded', async () => {
        // Nothing loads until the user picker knows whose page this is. Without
        // it nobody could be named, so the app does not start at all.
        if (!window.userPicker) {
            showErrorModal('The app could not start: js/user-picker.js did not load. Reload the page; if it keeps happening, tell IT.', 'Close');
            return;
        }
        await window.userPicker.ready();

        // Roster before anything renders a picker. Never throws: on failure
        // the accessors fall back to the built-in lists.
        await loadRoster();

        // Init profile
        updateProfileBtn();
        updateLandingGreeting();
        initCropHandlers();

        // Load jobs from server
        await refreshJobs();

        loadJobs(); setupListeners(); updateUndoRedoButtons(); setupAutoActivateToggles(); setupPastedPaths(); populateCSRDropdowns();
        initBillboardHeightSync();
        // Suppress browser autocomplete on all quick-pick inputs
        document.querySelectorAll('.quick-pick-wrapper input, .quick-pick-wrapper textarea').forEach(el => el.setAttribute('autocomplete', 'off'));
        // Skip dropdown arrow buttons in tab order — users tab field-to-field only
        document.querySelectorAll('.quick-pick-btn').forEach(el => el.setAttribute('tabindex', '-1'));

        // Tab key skips toggle switches — land in text inputs and dropdowns only
        document.querySelectorAll('.toggle-switch input[type="checkbox"]').forEach(el => el.tabIndex = -1);
        document.querySelectorAll('.group-check').forEach(el => el.tabIndex = -1);
        // ...except a row with no box, where nothing else reaches it by key.
        setSwitchStops();

        // A link from a QC Review email (PHASE5_PLAN section d). It opens the
        // job list with the QC Review window on top, never a work order, so it
        // takes no edit lock and files no "Updated by" line. review.js reads
        // the address; when its own file could not load, openReview is not
        // there and the link just shows the job list.
        const reviewLink = typeof window.reviewLinkFromAddress === 'function' ? window.reviewLinkFromAddress() : null;

        // Takes ?job= out of the address bar, the same as review.js does for
        // ?review=, so a reload or Change user does not open it again.
        function cleanLinkFromAddress() {
            try {
                window.history.replaceState(null, '', window.location.pathname + window.location.hash);
            } catch (e) {
                // Nothing to do: the link simply opens again on a reload.
            }
        }

        // ?job=<id>, the second link in a sign back in email. Unlike the QC
        // Review link above this one does open the work order, so it takes the
        // ordinary edit lock, exactly as clicking the job on the list does. The
        // round's real instructions live there (SIGN_BACK_IN_PLAN section h).
        const jobLink = (() => {
            if (reviewLink) return '';
            try { return String(new URLSearchParams(window.location.search).get('job') || '').trim(); }
            catch (e) { return ''; }
        })();

        // Restore last active job if session is still fresh (under 30 min):
        // this tab's own when it had one open as it went (item 6), else the
        // last job any tab opened.
        let tabJobId = null;
        try { tabJobId = sessionStorage.getItem('prepressTabJob'); sessionStorage.removeItem('prepressTabJob'); } catch (e) { tabJobId = null; }
        const lastJobId = tabJobId || localStorage.getItem('prepressActiveJob');
        const lastActiveTime = parseInt(localStorage.getItem('prepressActiveJobTime') || '0', 10);
        const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
        const sessionFresh = (Date.now() - lastActiveTime) < SESSION_TIMEOUT;
        if (reviewLink) {
            showNoJobState();
            if (typeof window.openReview === 'function') {
                window.openReview(reviewLink.jobId, reviewLink.tab, { link: reviewLink });
            }
        } else if (jobLink && getActiveJobs().some(j => j.id === jobLink)) {
            cleanLinkFromAddress();
            loadJob(jobLink);
        } else if (jobLink) {
            // Not on the active list: an archived job opens read only in View
            // (David, 2026-09-27); one that is gone lands quietly on the list.
            // showNoJobState first, so a job remembered before is forgotten
            // and every refusal has the list under it.
            cleanLinkFromAddress();
            showNoJobState();
            viewArchivedJob(jobLink, { quietIfGone: true });
        } else if (lastJobId && sessionFresh && !currentJobId && getActiveJobs().some(j => j.id === lastJobId)) {
            // Only when nothing opened a job while the list was loading (the
            // dev checks call loadJob as soon as the list is there; a second
            // open of the same job redrew over what was typed).
            loadJob(lastJobId);
        } else {
            showNoJobState();
        }
    });

    // ── Closing the tab (item 6) ──
    //
    // As the page goes (Ctrl+W, the X, F5, the browser closing, a link
    // followed in the same tab) it sends everything on its screen the server
    // does not have yet as ONE request, which the server writes in one batch
    // before letting this page's hold go (POST /api/jobs/:id/last-save;
    // docs/design_handoff_qc_review/CLOSE_TAB_PLAN.md). It used to send the
    // typed piece and the job row at the same moment with the same version, so
    // the server kept one and refused the other: since item 3 the typing was
    // the one lost (measured 0 of 10), before it an Edit Job change made with
    // it. It also never saw a save still waiting in the queue, an open header
    // box, the Signoff due editor, or the job just left with Home.
    //
    // It does NOT file the instructions into the revisions. Closing the
    // browser is not a deliberate "I have finished with this job" (David,
    // 2026-09-20): it is a misclick, a crash, a Windows update or the end of
    // the day, and filing cannot be taken back. Only the work order's own X
    // (closeJobWithWarning) files.
    //
    // beforeunload only asks: when what would be sent is too big for Chrome to
    // send from a closing page (a pasted picture in the words just typed),
    // Chrome's own "Leave site?" box comes up (David, 2026-09-29), and Cancel
    // leaves the page exactly as it was, so the ordinary save goes. It changes
    // nothing, because the page may stay.
    // It also asks while the open job owes a save the server failed
    // (SAVE_FAILURE_PLAN.md): the last save sends it, but the server may fail
    // that one too.
    window.addEventListener('beforeunload', e => {
        let big = false;
        try { big = lastSavesTooBig() || (!pageLeaving && !!currentJobId && !isViewed(currentJobId) && owedNow(currentJobId)); } catch (err) { big = false; }
        if (!big) return;
        e.preventDefault();
        e.returnValue = '';   // Chrome asks only with this set as well
    });
    window.addEventListener('pagehide', () => { sendLastSaves(); });
    // Back into a page Chrome kept (its back/forward cache): its hold went as
    // it left, and nothing would take it again. A work order that was open for
    // editing reloads, which opens it through the front door (the lock, a
    // fresh copy, or the view when somebody else has it now). pageLeaving
    // stays set for that, so the reload neither asks nor sends it again.
    window.addEventListener('pageshow', e => {
        if (!e.persisted || !pageLeaving) return;
        if (currentJobId && !isViewed(currentJobId)) { location.reload(); return; }
        pageLeaving = false;
    });

    function setupListeners() {
        document.getElementById('newJobForm').addEventListener('submit', e => { e.preventDefault(); createNewJob(); });
        document.getElementById('addComponentForm').addEventListener('submit', e => { e.preventDefault(); addComponent(document.getElementById('newComponentName').value.trim(), document.getElementById('addComponentTemplate').value); closeAddComponentModal(); });
        quill.on('text-change', (delta, oldDelta, source) => { if (source === 'user' && currentJobId) debouncedSaveJobState(); });
        document.getElementById('masterCheckbox').addEventListener('change', toggleAllCheckboxes);
        document.getElementById('jobSelectorButton').addEventListener('click', toggleJobDropdown);
        document.getElementById('selectAllJobsCheckbox').addEventListener('change', toggleSelectAllJobs);

        let dropdownCloseTimer;
        document.querySelector('.job-selector-custom').addEventListener('mouseleave', () => {
            const dd = document.getElementById('jobSelectorDropdown');
            if (!dd.classList.contains('open')) return;
            dropdownCloseTimer = setTimeout(() => {
                closeJobDropdown();
            }, 800);
        });
        document.querySelector('.job-selector-custom').addEventListener('mouseenter', () => {
            clearTimeout(dropdownCloseTimer);
        });
        // Capture state BEFORE checkbox changes (don't clear redo yet - wait for actual change).
        // Users click the visible .toggle-track span, not the hidden <input type="checkbox"> —
        // so we resolve the checkbox via the enclosing .toggle-switch label, not e.target.type.
        document.addEventListener('mousedown', e => {
            if (!currentJobId || isUndoRedo) return;
            const toggleLabel = e.target.closest('.toggle-switch');
            const checkbox = toggleLabel
                ? toggleLabel.querySelector('input[type="checkbox"]')
                : (e.target.type === 'checkbox' ? e.target : null);
            if (!checkbox) return;
            const isGroupCheck = checkbox.classList.contains('group-check');
            const isMasterCheck = checkbox.id === 'masterCheckbox';
            // Only capture for individual checklist item checkboxes (group and master handle their own)
            if (!isGroupCheck && !isMasterCheck && checkbox.closest('.field-row')) {
                pushToUndo(false);
            }
        });

        // Reset dirty flag on focus AND capture a pre-edit snapshot. The snapshot
        // (not the post-edit state) is what gets pushed to the undo stack on the
        // first keystroke — so undo restores what the field looked like *before*
        // the user started editing, not after the first character already landed.
        document.addEventListener('focusin', e => {
            if ((e.target.classList.contains('notes') || quill.root.contains(e.target)) && currentJobId) {
                fieldDirty = false;
                focusSnapshot = captureState();
            }
        });

        // Capture undo state on first keystroke after focus (not on focus itself).
        // We push the focusSnapshot (pre-change state), not the current state.
        document.addEventListener('input', e => {
            if (e.target.classList.contains('notes') && currentJobId && !isUndoRedo && !fieldDirty) {
                fieldDirty = true;
                pushToUndo(true, focusSnapshot);
            }
        });
        quill.on('text-change', (delta, oldDelta, source) => {
            if (source === 'user' && currentJobId && !isUndoRedo && !fieldDirty) {
                fieldDirty = true;
                pushToUndo(true, focusSnapshot);
            }
        });

        document.addEventListener('change', e => {
            if (!currentJobId) return;
            if (e.target.type === 'checkbox') {
                // Clear non-file-path note when individual toggle is turned off.
                // Not for a name unchecked in the attendee picker, which sits
                // inside Meeting required's row: its first note is the
                // attendee list, which the picker has just written (the
                // after-rollout batch, item 6). Only the row's own switch
                // clears it.
                if (!e.target.checked && e.target.closest('.field-row') && !e.target.closest('.meeting-attendees-list')) {
                    const noteInput = e.target.closest('.field-row').querySelector('.notes');
                    if (noteInput) {
                        const noteId = noteInput.getAttribute('data-id') || '';
                        if (!noteId.startsWith('fp')) noteInput.value = '';
                    }
                }
                // Checkboxes save immediately
                saveJobState();
                updateMasterCheckbox();
                updateGroupCheckboxes();
            } else if (e.target.classList.contains('notes')) {
                // Notes debounce (also fires on blur, so this catches final value)
                debouncedSaveJobState();
            }
        });

        // Debounce notes input so we don't save on every keystroke
        document.addEventListener('input', e => {
            if (e.target.classList.contains('notes') && currentJobId) {
                debouncedSaveJobState();
            }
        });
        document.addEventListener('click', e => {
            const dropdown = document.getElementById('jobSelectorDropdown');
            const button = document.getElementById('jobSelectorButton');
            if (!dropdown.contains(e.target) && !button.contains(e.target)) {
                closeJobDropdown();
            }
        });
    }

    function loadJobs() {
        const jobs = getActiveJobs();
        // Sort by most recently modified first
        jobs.sort((a, b) => new Date(b.lastAccessed || b.lastModified || b.dateCreated) - new Date(a.lastAccessed || a.lastModified || a.dateCreated));

        const container = document.getElementById('jobListContainer');
        container.innerHTML = '';

        // Reset select all checkbox
        document.getElementById('selectAllJobsCheckbox').checked = false;
        updateDeleteSelectedButton();

        // Render landing page table, archive, and templates
        applyLandingFilters();
        renderArchivedJobs();
        renderTemplatesCol();

        if (jobs.length === 0) {
            container.innerHTML = '<div class="no-jobs-message">No jobs available</div>';
            showNoJobState();
            return;
        }

        jobs.forEach(j => {
            const jobItem = document.createElement('div');
            jobItem.className = 'job-item';
            jobItem.setAttribute('data-job-id', j.id);

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'job-checkbox';
            checkbox.setAttribute('data-job-id', j.id);
            checkbox.onclick = (e) => {
                e.stopPropagation();
                updateDeleteSelectedButton();
                updateSelectAllCheckbox();
            };

            const text = document.createElement('span');
            text.className = 'job-item-text';
            const description = j.jobDescription ? ` - ${j.jobDescription}` : '';
            text.textContent = `${j.jobNumber} - ${j.clientName}${description}`;
            text.onclick = () => {
                loadJob(j.id);
                closeJobDropdown();
            };

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'job-item-delete';
            deleteBtn.innerHTML = '\u00d7';
            deleteBtn.title = 'Delete this job';
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                deleteSingleJob(j.id);
            };

            jobItem.appendChild(checkbox);
            jobItem.appendChild(text);
            jobItem.appendChild(deleteBtn);
            container.appendChild(jobItem);
        });
    }

    let jobsCache = null;

    // ── Landing page state (v2 -- list view) ──
    let landingViewTab = 'all'; // 'my' or 'all'
    let landingCurrentPage = 1;
    let landingPageSize = 10;
    let landingSortColumn = 'due';
    let landingSortDir = 'asc';
    let landingDeptFilter = 'all';
    let landingTimeFilter = 'all';
    let landingStatusFilter = 'all';
    let landingQuickFilter = 'all';
    let landingGroupBy = 'none';
    let landingSelectedCSRs = [];
    let landingSelectedAssignees = [];
    let landingSelectedClients = [];
    let landingSearchQuery = '';

    function setLandingViewTab(tab) {
        landingViewTab = tab;
        landingCurrentPage = 1;
        applyLandingFilters();
    }

    // Compared by key, so a job stamped "david.marra@compu-mail.com" or
    // "DAVID.MARRA" is David.Marra's. Typed names ("Stef") still do not match.
    function isMyJob(job) {
        const me = userKeyOf(getUserName());
        if (!me) return false;
        return userKeyOf(job.createdBy) === me;
    }

    function setDeptFilter(dept) {
        landingDeptFilter = dept;
        landingCurrentPage = 1;
        applyLandingFilters();
    }

    function setTimeFilter(time) {
        landingTimeFilter = time;
        landingCurrentPage = 1;
        // Close the Updated dropdown
        document.querySelectorAll('.filter-dropdown.open').forEach(d => d.classList.remove('open'));
        applyLandingFilters();
    }

    function setStatusFilter(status) {
        landingStatusFilter = status;
        landingCurrentPage = 1;
        applyLandingFilters();
    }

    function setQuickFilter(q) {
        landingQuickFilter = (landingQuickFilter === q && q !== 'all') ? 'all' : q;
        landingCurrentPage = 1;
        applyLandingFilters();
    }

    function setGroupBy(g) {
        landingGroupBy = g;
        landingCurrentPage = 1;
        applyLandingFilters();
    }

    function setSortColumn(col) {
        if (landingSortColumn === col) {
            landingSortDir = landingSortDir === 'asc' ? 'desc' : 'asc';
        } else {
            landingSortColumn = col;
            // Date columns are almost always wanted newest-first.
            landingSortDir = (col === 'lastModified' || col === 'dateCreated') ? 'desc' : 'asc';
        }
        applyLandingFilters();
    }

    function setLandingPage(page) {
        landingCurrentPage = page;
        applyLandingFilters();
    }

    function setLandingPageSize(size) {
        landingPageSize = size;
        landingCurrentPage = 1;
        applyLandingFilters();
    }

    async function refreshLanding() {
        await refreshJobs();
        loadJobs();
    }

    // ── Multi-select filter dropdowns ──
    function toggleFilterDropdown(event, dropdownId) {
        event.stopPropagation();
        const dd = document.getElementById(dropdownId);
        const wasOpen = dd.classList.contains('open');
        document.querySelectorAll('.filter-dropdown.open').forEach(d => d.classList.remove('open'));
        if (!wasOpen) {
            dd.classList.add('open');
            populateFilterDropdown(dropdownId);
            const searchInput = dd.querySelector('.filter-dropdown-search');
            if (searchInput) { searchInput.value = ''; setTimeout(() => searchInput.focus(), 50); }
        }
    }

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.inline-trigger')) {
            document.querySelectorAll('.filter-dropdown.open').forEach(d => d.classList.remove('open'));
        }
    });

    function populateFilterDropdown(dropdownId) {
        const jobs = getActiveJobs();
        let listId, values, selectedArr;
        if (dropdownId === 'filterCSRDropdown') {
            listId = 'filterCSRList';
            const fromJobs = jobs.map(j => (j.csrName || '').trim()).filter(Boolean);
            values = [...new Set([...getCsrNames(), ...fromJobs])].sort();
            selectedArr = landingSelectedCSRs;
        } else if (dropdownId === 'filterAssigneeDropdown') {
            listId = 'filterAssigneeList';
            const knownAssignees = [];
            Object.values(window.DEPT_REGISTRY || {}).forEach(dept => {
                if (dept.id) knownAssignees.push(...getAssigneeNames(dept.id));
            });
            const fromJobs = new Set();
            jobs.forEach(j => {
                if (j.assignedToPrepress) fromJobs.add(j.assignedToPrepress.trim());
                if (j.assignedToTechservices) fromJobs.add(j.assignedToTechservices.trim());
            });
            values = [...new Set([...knownAssignees, ...fromJobs])].filter(Boolean).sort();
            selectedArr = landingSelectedAssignees;
        } else {
            listId = 'filterClientList';
            let knownClients = [];
            const wrapper = document.getElementById('clientName');
            if (wrapper) {
                const wp = wrapper.closest('.quick-pick-wrapper');
                if (wp) {
                    const qp = wp.querySelector('.quick-pick-menu');
                    if (qp && qp.dataset.options) {
                        try { knownClients = JSON.parse(qp.dataset.options); } catch(e) {}
                    }
                }
            }
            const fromJobs = jobs.map(j => (j.clientName || '').trim()).filter(Boolean);
            values = [...new Set([...knownClients, ...fromJobs])].sort();
            selectedArr = landingSelectedClients;
        }
        const list = document.getElementById(listId);
        if (!list) return;
        list.innerHTML = values.map(v => {
            const checked = selectedArr.includes(v) ? ' checked' : '';
            return '<label class="filter-dropdown-item"><input type="checkbox"' + checked + ' value="' + escHtml(v) + '"> ' + escHtml(v) + '</label>';
        }).join('');
    }

    function filterDropdownList(searchInput) {
        const q = searchInput.value.toLowerCase();
        const items = searchInput.closest('.filter-dropdown').querySelectorAll('.filter-dropdown-item');
        items.forEach(item => {
            const text = item.textContent.toLowerCase();
            item.style.display = text.includes(q) ? '' : 'none';
        });
    }

    function applyFilterDropdown(type) {
        const listId = 'filter' + type + 'List';
        const list = document.getElementById(listId);
        if (!list) return;
        const selected = [...list.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
        if (type === 'CSR') landingSelectedCSRs = selected;
        else if (type === 'Assignee') landingSelectedAssignees = selected;
        else landingSelectedClients = selected;

        const btn = document.getElementById('filter' + type + 'Btn');
        if (selected.length > 0) {
            if (btn) btn.classList.add('has-selection');
        } else {
            if (btn) btn.classList.remove('has-selection');
        }
        document.querySelectorAll('.filter-dropdown.open').forEach(d => d.classList.remove('open'));
        landingCurrentPage = 1;
        applyLandingFilters();
    }

    function clearFilterDropdown(type) {
        const listId = 'filter' + type + 'List';
        const list = document.getElementById(listId);
        if (list) list.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        applyFilterDropdown(type);
    }

    // ── View tabs rendering ──
    function renderViewTabs(allJobs) {
        const container = document.getElementById('viewTabs');
        if (!container) return;
        const me = getUserName();
        const myCount = me ? allJobs.filter(j => isMyJob(j)).length : 0;
        const allCount = allJobs.length;
        const myActive = landingViewTab === 'my' ? ' active' : '';
        const allActive = landingViewTab === 'all' ? ' active' : '';
        container.innerHTML =
            '<button class="view-tab' + myActive + '" onclick="setLandingViewTab(\'my\')">My Jobs <span class="tab-count">' + myCount + '</span></button>' +
            '<button class="view-tab' + allActive + '" onclick="setLandingViewTab(\'all\')">All Jobs <span class="tab-count">' + allCount + '</span></button>';
    }

    // ── Job status helper ──
    const STATUS_MAP = {
        'new':         { label: 'New',         cls: 'new' },
        'in-progress': { label: 'In Progress', cls: 'in-progress' },
        'on-hold':     { label: 'On Hold',     cls: 'on-hold' },
        'complete':    { label: 'Complete',     cls: 'complete' },
        'cancelled':   { label: 'Cancelled',   cls: 'cancelled' }
    };
    const STATUS_KEYS = Object.keys(STATUS_MAP);

    function getJobStatusLabel(job) {
        // Stored status takes priority (explicit CSR-set)
        if (job.status && STATUS_MAP[job.status]) {
            return STATUS_MAP[job.status];
        }
        // Derived fallback for legacy jobs without a stored status column
        if (!job.components || !job.components.length) return STATUS_MAP['new'];
        const reqStatus = getRequiredStatusForJob(job);
        if (reqStatus.allComplete) return STATUS_MAP['complete'];
        const hasContent = job.components.some(c => {
            return (c.instructions_prepress && c.instructions_prepress !== '<p><br></p>') ||
                   (c.instructions_techservices && c.instructions_techservices !== '<p><br></p>') ||
                   (c.checkboxes && Object.values(c.checkboxes).some(v => v === true));
        });
        if (hasContent) return STATUS_MAP['in-progress'];
        return STATUS_MAP['new'];
    }

    // ── Due-date helpers (landing v2) ──
    function parseDueDateTime(dateStr, timeStr) {
        if (!dateStr) return null;
        const p = dateStr.split('-').map(Number);
        let hh = 17, mm = 0;
        if (timeStr) {
            const m = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
            if (m) { hh = Number(m[1]) % 12 + (/PM/i.test(m[3]) ? 12 : 0); mm = Number(m[2]); }
        }
        return new Date(p[0], (p[1] || 1) - 1, p[2] || 1, hh, mm);
    }

    function getJobDue(job) {
        const a = parseDueDateTime(job.signoffDueDatePrepress, job.signoffDueTimePrepress);
        const b = parseDueDateTime(job.signoffDueDateTechservices, job.signoffDueTimeTechservices);
        const ds = [a, b].filter(Boolean);
        if (!ds.length) return null;
        return new Date(Math.min.apply(null, ds.map(d => d.getTime())));
    }

    function isTerminalStatus(cls) {
        return cls === 'complete' || cls === 'cancelled';
    }

    function isJobOverdue(job) {
        const due = getJobDue(job);
        return !!due && due < new Date() && !isTerminalStatus(getJobStatusLabel(job).cls);
    }

    // Due soon: later today or any time tomorrow, so at 11 PM a job due 9 AM
    // tomorrow already shows (David, 2026-10-15). It used to be today only,
    // and the DUE SOON word only within 12 hours, so the evening before showed
    // nothing for the next morning.
    function isJobDueSoon(job) {
        const due = getJobDue(job);
        if (!due || isTerminalStatus(getJobStatusLabel(job).cls)) return false;
        const now = new Date();
        const endOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
        return due >= now && due < endOfTomorrow;
    }

    function formatDueParts(due) {
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        let h = due.getHours();
        const ap = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        const t = h + ':' + String(due.getMinutes()).padStart(2, '0') + ' ' + ap;
        return { date: months[due.getMonth()] + ' ' + due.getDate(), time: t };
    }

    // Date over time, matching the Signoff Due cell's two-line shape. Muted, so
    // it reads as reference information rather than competing with the deadline.
    function renderCreatedCell(job) {
        if (!job.dateCreated) return '<span class="created-date">--</span>';
        const d = new Date(job.dateCreated);
        if (isNaN(d.getTime())) return '<span class="created-date">--</span>';
        const p = formatDueParts(d);
        return '<span class="created-date">' + escHtml(p.date) + '</span>' +
               '<span class="created-time">' + escHtml(p.time) + '</span>';
    }

    function renderDueCell(job) {
        const due = getJobDue(job);
        if (!due) return '<span class="due-time">--</span>';
        const status = getJobStatusLabel(job);
        const p = formatDueParts(due);
        let modifier = '';
        let tag = '';
        if (isTerminalStatus(status.cls)) {
            modifier = ' complete';
        } else if (isJobOverdue(job)) {
            modifier = ' overdue';
            tag = '<span class="due-tag due-tag-overdue">OVERDUE</span>';
        } else if (isJobDueSoon(job)) {
            modifier = ' due-soon';
            tag = '<span class="due-tag due-tag-soon">DUE SOON</span>';
        }
        return '<span class="due-date' + modifier + '">' + escHtml(p.date) + '</span>' +
            '<span class="due-time' + modifier + '">' + escHtml(p.time) + tag + '</span>';
    }

    // ── Group-by helper ──
    function groupKeyFor(job) {
        if (landingGroupBy === 'status') return getJobStatusLabel(job).label;
        if (landingGroupBy === 'csr') return job.csrName || '(no CSR)';
        return '';
    }

    // ── Which departments a job uses (decision 6, David 2026-09-23 and 2026-09-25) ──
    // A department is on a job once it has anything there: words in its
    // instructions on any piece, still in the box or locked into the Revisions;
    // any of its own switches on; someone assigned to it; or any QC record the
    // QC column counts for it (a hand-over from Send to Prepress / Send to Tech
    // Services not taken back, a sign back in, or QC it has started), so only
    // while QC Review is on. The Depts dots and the Dept filter both ask
    // deptOnJob, so they always agree. A sign-off due date does not count: it
    // can only be set in the first place on the New Job form, where both
    // departments' boxes sit side by side.
    const deptSwitchIds = {};

    // A department's switches: the boxes on its own tab, read with the
    // selector saveComponentState stores them from.
    function deptSwitches(deptId) {
        if (!deptSwitchIds[deptId]) {
            // A department file that failed to load leaves only its switches out.
            const dept = (window.DEPT_REGISTRY || {})[deptId];
            const panel = dept && document.getElementById(dept.panelId);
            if (!panel) return [];
            deptSwitchIds[deptId] = Array.from(panel.querySelectorAll('.field-row .toggle-switch input[type="checkbox"]'))
                .map(cb => cb.getAttribute('data-id')).filter(Boolean);
        }
        return deptSwitchIds[deptId];
    }

    // Words in instructions: the same answer as the test Lock instructions
    // files by (the text with the tags taken out is not blank), stopping at the
    // first letter instead of copying a long revision history to find out. A
    // '<' with no '>' after it is not a tag, so it counts as a letter there too.
    function hasWords(html) {
        const s = String(html || '');
        for (let i = 0; i < s.length; i++) {
            if (s[i] === '<') {
                const end = s.indexOf('>', i);
                if (end < 0) return true;
                i = end;
            } else if (!/\s/.test(s[i])) {
                return true;
            }
        }
        return false;
    }

    function deptOnJob(job, deptId) {
        if (deptId !== 'prepress' && deptId !== 'techservices') return false;
        const assigned = deptId === 'prepress' ? job.assignedToPrepress : job.assignedToTechservices;
        if (String(assigned || '').trim()) return true;
        // Only while the QC column shows, as the column itself does.
        if (boardOn) {
            const qc = boardStates().get(job.id);
            if (qc && qc.depts[deptId] && qc.depts[deptId].counts) return true;
        }
        // A switch is on when the work order would draw it on (loadComponentData
        // sets checked from the stored value, whatever it is).
        const switches = deptSwitches(deptId);
        return (job.components || []).some(c => {
            const boxes = c.checkboxes || {};
            return switches.some(id => !!boxes[id]) ||
                hasWords(c['instructions_' + deptId]) || hasWords(c['instructionsHistory_' + deptId]);
        });
    }

    function getJobDeptDots(job) {
        return '<div class="dept-dots">' +
            '<div class="dept-dot' + (deptOnJob(job, 'prepress') ? ' filled-prepress' : '') + '"></div>' +
            '<div class="dept-dot' + (deptOnJob(job, 'techservices') ? ' filled-ts' : '') + '"></div>' +
            '</div>';
    }

    // ── QC Review board: the QC column (BOARD_PLAN.md, David 2026-09-18) ──
    // Where every active job's QC stands, one chip a job, from GET
    // /api/reviews/states and the rules in review-board.js. The Assigned column
    // came off to make room (David, Aug 14 and Sep 12); the Assignee filter and
    // the search still find either department's assignee.
    let boardReply = null;   // the route's last good reply
    let boardText = '';      // the same reply as it arrived, to tell whether it changed
    let boardOn = false;     // false hides the column: no reply yet, or QC Review is off
    let boardFor = { reply: null, jobs: null, states: new Map() };
    let boardSeq = 0;        // the newest request sent; an older answer arriving late is dropped
    let boardAsked = 0;      // when the board was last asked for, to pace the tab-return refresh

    // Whether a name is picked now. The states route answers 401 without one,
    // which the browser logs as an error; /api/me never does, and while nobody
    // is picked the user picker covers the page anyway.
    async function boardUserPicked() {
        try {
            const res = await fetch('/api/me', { cache: 'no-store' });
            const me = res.ok ? await res.json() : null;
            return !!(me && me.user);
        } catch (e) {
            return false;
        }
    }

    // Asks where every active job's QC stands. Never throws; answers whether
    // the column changed. No name picked, an unreachable server or a busy
    // database keep the last good copy; only QC Review being off on this
    // server (503 with available: false: its tables are missing, or its
    // checklist file is broken) hides the column.
    async function refreshBoard() {
        if (!window.REVIEW_BOARD) { boardOn = false; return false; }
        const seq = ++boardSeq;
        boardAsked = Date.now();
        try {
            if (!(await boardUserPicked())) return false;
            const res = await fetch('/api/reviews/states', { cache: 'no-store' });
            if (seq !== boardSeq) return false;
            if (res.status === 503) {
                const body = await res.json().catch(() => null);
                if (!body || body.available !== false || !boardOn) return false;
                boardReply = null;
                boardText = '';
                boardOn = false;
                return true;
            }
            if (!res.ok) return false;
            const text = await res.text();
            if (seq !== boardSeq) return false;
            const data = JSON.parse(text);
            if (!data || !data.available) return false;
            if (boardOn && text === boardText) return false;
            boardText = text;
            boardReply = data;
            boardOn = true;
            return true;
        } catch (e) {
            return false;   // keep what the column showed
        }
    }

    // Each job's chip, worked out once per reply and jobs list, never per
    // render: the Corrections count and the QC sort read every active job.
    function boardStates() {
        const jobs = getActiveJobs();
        if (boardFor.reply !== boardReply || boardFor.jobs !== jobs) {
            const states = new Map();
            if (boardReply && window.REVIEW_BOARD) {
                const index = REVIEW_BOARD.buildIndex(boardReply);
                jobs.forEach(j => states.set(j.id, REVIEW_BOARD.jobState(index, j.id, j.components || [])));
            }
            boardFor = { reply: boardReply, jobs, states };
        }
        return boardFor.states;
    }

    // The QC warning before a job is archived or deleted (David, 2026-09-20).
    // Archiving takes the job off the QC board and shuts its reviewers out
    // ("This job is archived. Restore it before reviewing."), and a delete
    // ends it for good: the QC record is kept, read only, under Deleted jobs
    // (item 7), but nobody can review the job again. So both say what is
    // running first.
    //
    // Setting a job Complete is deliberately NOT warned about on its own: it
    // changes nothing about QC, the chip stays and the reviews stay writable.
    // Only the "Archive this job?" it raises is, and that is the same press.
    //
    // A job at CSR PASSED is left alone: it is the one step where nobody is
    // waiting on anybody. Everything else means somebody is. Nothing here
    // blocks anything: it is advisory, as the whole feature is. Deleting a
    // job that is already archived is the one press it cannot cover, because
    // /api/reviews/states leaves archived jobs out.
    async function qcWarningLines(ids) {
        if (!window.REVIEW_BOARD) return [];
        // The board is only kept up to date while the job list is showing, so
        // it is asked again here. Bounded, because a press must never sit there
        // with no box at all: after a second and a half it goes with the last
        // good copy, which is what an unreachable server already does anyway.
        // A reply that changed the column is drawn, or the table behind this
        // box would stay as it was until the next QC change.
        let changed = false;
        try {
            changed = await Promise.race([refreshBoard(), new Promise(done => setTimeout(() => done(false), 1500))]);
        } catch (e) { /* keep the last good copy */ }
        if (changed) redrawLandingKeepingTicks();
        if (!boardOn) return [];
        const states = boardStates();
        const jobs = getActiveJobs();
        const many = ids.length > 1;
        const lines = [];
        ids.forEach(id => {
            const state = states.get(id);
            if (!state || !state.chip || state.chip === 'csr-passed') return;
            const job = jobs.find(j => j.id === id);
            const prefix = many && job && job.jobNumber ? job.jobNumber + ': ' : '';
            // The hover's own words, so this warning and the job list can never
            // say two different things about the same job.
            String(state.hover || state.word || '').split('\n')
                .filter(line => line.trim())
                .forEach(line => lines.push(prefix + line));
        });
        return lines;
    }

    // The question, with what QC is doing under it when there is any. With no
    // QC on the job it is the plain box it has always been, so nothing changes
    // for a job nobody has reviewed.
    async function confirmWithQc(question, ids, lead, okLabel) {
        const lines = await qcWarningLines(ids);
        if (!lines.length) return confirm(question);
        return await showWarningModal(question, [lead].concat(lines), {
            type: 'qc', okLabel: okLabel, cancelLabel: 'Cancel', showCancel: true
        });
    }

    const QC_ARCHIVE_LEAD = 'Archiving takes it off the QC list and locks its reviewers out until it is restored.';
    const QC_DELETE_LEAD = 'Its QC record is kept, and opens from Deleted jobs at the bottom of the job list.';
    const QC_IMPORT_LEAD = 'These checklists are filled in against a piece the file does not bring back. Importing leaves them stranded.';
    const QC_PIECE_DELETE_LEAD = 'This piece has a QC checklist started. Deleting the piece leaves the checklist stranded, and QC then counts only the pieces left.';

    // Deleting a piece says what QC is doing first when the piece has a
    // checklist (the after-rollout batch, item 2): the checklist is left as "a
    // part no longer on this job", and a department's pass is then counted on
    // the pieces left. The board is asked again first (qcWarningLines), as the
    // job's own delete does; the lines under the lead are the job's, in the
    // hover's own words. A piece with no checklist keeps the plain box.
    async function confirmPieceDelete(job, comp) {
        const question = `Delete component "${comp.name}"? This cannot be undone.`;
        const lines = await qcWarningLines([job.id]);
        const hasSheet = boardOn && !!boardReply && Array.isArray(boardReply.units) &&
            boardReply.units.some(u => String(u.jobId) === String(job.id) && String(u.unitId) === String(comp.id));
        if (!hasSheet) return confirm(question);
        // The box's title is HTML: the name goes in escaped, as the other
        // titles carry a name, so a name with markup in it is shown as typed.
        return await showWarningModal(`Delete component "${escHtml(comp.name)}"? This cannot be undone.`, [QC_PIECE_DELETE_LEAD].concat(lines), {
            type: 'qc', okLabel: 'Delete', cancelLabel: 'Cancel', showCancel: true
        });
    }

    // Which checklists an import would really strand (David, 2026-09-20, after
    // round-tripping 481204's own export and finding nothing was lost).
    //
    // A job keeps its id through an import, so its gate rows and its whole
    // history always survive. Its pieces come from the file, and a checklist is
    // keyed by the piece's id: a piece that comes back with the same id keeps
    // its checklist, whatever its name. So re-importing a job's own export
    // strands nothing at all, and warning about it would be crying wolf. Only
    // a file from somewhere else, whose pieces carry different ids, loses
    // anything. `/api/reviews/states` leaves out units whose piece is already
    // gone, so every one it names is a piece on the job right now.
    function strandedByImport(existingId, importedJob) {
        if (!boardOn || !boardReply || !Array.isArray(boardReply.units)) return [];
        const coming = new Set((importedJob.components || []).map(c => String(c.id)));
        const job = getActiveJobs().find(j => j.id === existingId);
        const names = {};
        ((job && job.components) || []).forEach(c => { names[String(c.id)] = c.name || 'a piece'; });
        const lost = [];
        boardReply.units.forEach(u => {
            if (String(u.jobId) !== String(existingId)) return;
            const unit = String(u.unitId);
            // 'job' is the Whole Job block, not a piece, so it always survives.
            if (unit === 'job' || coming.has(unit)) return;
            const name = names[unit] || 'a piece';
            if (lost.indexOf(name) < 0) lost.push(name);
        });
        return lost;
    }

    function boardChipOf(job) {
        const s = boardOn ? boardStates().get(job.id) : null;
        return s ? s.chip : '';
    }

    // The QC cell: the step the job is at, PRODUCTION under it while her newest
    // sign back in was a production round, and each checklist in the hover.
    //
    // A click anywhere in the cell opens the QC Review window, never the work
    // order, so it takes no edit lock. **With or without a chip** (David,
    // 2026-09-20): the column used to do two different things, because an
    // empty cell had no click of its own and fell through to the row, which
    // opened the work order and took its lock. Same column, two behaviours,
    // and nothing on screen said so. One rule now: that column is QC, the
    // rest of the row is the work order.
    function renderQcCell(job) {
        const s = boardOn ? boardStates().get(job.id) : null;
        const open = ' onclick="event.stopPropagation(); openBoardReview(' + jsArg(job.id) + ')"';
        if (!s || !s.chip) return '<td class="col-qc" title="Nobody has done any QC on this job yet."' + open + '></td>';
        return '<td class="col-qc" title="' + escHtml(s.hover) + '"' + open + '>' +
            '<span class="review-board-chip is-' + s.chip + '">' + escHtml(s.word) + '</span>' +
            (s.production ? '<span class="review-board-sub">PRODUCTION</span>' : '') + '</td>';
    }

    function openBoardReview(jobId) {
        const s = boardStates().get(jobId);
        // On a part-swapped build with review-board.js but no review.js the
        // cell would otherwise be a click that does nothing at all, so it
        // falls back to what the rest of the row does.
        if (typeof window.openReview !== 'function') return loadJob(jobId);
        window.openReview(jobId, (s && s.gate) || 'csr');
    }

    function landingShowing() {
        const el = document.getElementById('noJobState');
        return !!el && el.style.display === 'block';
    }

    // The window was closed, or the page came back into view: somebody may have
    // moved a job on. Only the board is asked again, and the list is redrawn
    // only when the answer changed, only while the job list is showing (a work
    // order open behind the window is never touched), and with any rows ticked
    // for Archive or Delete still ticked.
    function refreshBoardOnLanding() {
        refreshBoard().then(changed => {
            if (changed) redrawLandingKeepingTicks();
        });
    }

    // Redraw the table from the board reply just fetched, with any rows ticked
    // for Archive or Delete still ticked. Its own function because the QC
    // warning asks the board too, and a reply it did not draw would leave the
    // column behind the box as it was until the next QC change.
    function redrawLandingKeepingTicks() {
        if (!landingShowing()) return;
        const ticked = new Set(Array.from(document.querySelectorAll('#jobTableBody .table-row-check:checked')).map(cb => cb.getAttribute('data-job-id')));
        applyLandingFilters();
        if (!ticked.size) return;
        document.querySelectorAll('#jobTableBody .table-row-check').forEach(cb => { if (ticked.has(cb.getAttribute('data-job-id'))) cb.checked = true; });
        updateBulkBar();
    }
    document.addEventListener('sts-review-closed', refreshBoardOnLanding);
    // A piece was just added on the work order. Once a department's files have
    // gone to the CSR, the server names such a piece on the job list's hover
    // ("Buckslip added, not reviewed yet", ADDED_PIECE_PLAN), and going back to
    // the list draws from the last reply rather than asking again. So the ask
    // is made now, as for a new job sent to a department: usually the answer
    // is in hand when the list is drawn, and if Home was quicker, the list is
    // drawn again when it lands.
    function pieceAddedAskBoard() {
        refreshBoardOnLanding();
    }
    // The CSR sent a new job to a department from the work order: its chip has
    // to read NEW JOB the moment she goes back to the list, and closing a work
    // order redraws the table from the last reply rather than asking again.
    // The ask is made now, while the work order is still open, so the answer is
    // in hand by the time it is drawn (START_NEW_JOB_PLAN, David decision 1).
    document.addEventListener('sts-new-job-sent', refreshBoardOnLanding);
    // Coming back to the tab asks at most once every 15 seconds: each ask reads
    // every active job's review rows.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && landingShowing() && Date.now() - boardAsked > 15000) refreshBoardOnLanding();
    });

    // ── Format modified date ──
    function formatModifiedDate(dateStr) {
        if (!dateStr) return '--';
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return '--';
        const now = new Date();
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        let hours = d.getHours();
        const ampm = hours >= 12 ? 'p' : 'a';
        hours = hours % 12 || 12;
        const mins = d.getMinutes().toString().padStart(2, '0');
        const timeStr = hours + ':' + mins + ampm;
        if (d.toDateString() === now.toDateString()) return 'Today, ' + timeStr;
        const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) return 'Yesterday, ' + timeStr;
        return months[d.getMonth()] + ' ' + d.getDate() + ', ' + timeStr;
    }

    // ── Sort comparator ──
    function getSortValue(job, col) {
        switch (col) {
            case 'jobNumber': return job.jobNumber || '';
            case 'clientName': return (job.clientName || '').toLowerCase();
            case 'jobDescription': return (job.jobDescription || '').toLowerCase();
            case 'csrName': return (job.csrName || '').toLowerCase();
            case 'lastModified': return new Date(job.lastModified || job.dateCreated || 0).getTime();
            case 'dateCreated': return new Date(job.dateCreated || 0).getTime();
            case 'status': return getJobStatusLabel(job).label;
            case 'due': {
                if (isTerminalStatus(getJobStatusLabel(job).cls)) return 9e15;
                const due = getJobDue(job);
                return due ? due.getTime() : 8e15;
            }
            default: return '';
        }
    }

    // ── Render the job table ──
    function renderJobTable(jobs) {
        const tbody = document.getElementById('jobTableBody');
        if (!tbody) return;
        // A row, its checkbox or its status with the cursor gets it back after
        // the rows are drawn again (KEYBOARD_PLAN.md 2.4).
        const cursor = listCursor();

        // Update sort arrows
        document.querySelectorAll('.sort-arrow').forEach(el => {
            el.classList.remove('active');
            el.innerHTML = '';
        });
        const activeArrow = document.getElementById('sort-' + landingSortColumn);
        if (activeArrow) {
            activeArrow.classList.add('active');
            activeArrow.innerHTML = landingSortDir === 'asc' ? '&#9652;' : '&#9662;';
        }

        // The QC column is there only while the board has an answer.
        const table = document.getElementById('jobTable');
        if (table) table.classList.toggle('board-off', !boardOn);

        // The grouping banner and the "no matching jobs" line stretch across the
        // first nine columns only, so the channel before QC stays open on them
        // too (David, 2026-09-20): a band running through the gap would break
        // the one thing the gap is there to do. With the board off there is no
        // QC column at all and no spare cell to add.
        const columns = 9;
        if (jobs.length === 0) {
            const spare = boardOn ? '<td class="col-qc"></td>' : '';
            tbody.innerHTML = '<tr><td colspan="' + columns + '" class="no-jobs-table-message">' +
                (landingViewTab === 'my'
                    ? 'No jobs created by you yet.<br><span class="no-jobs-subline">Jobs you create are filed here automatically. Switch to All Jobs to see everything on the board.</span>'
                    : 'No matching jobs') +
                '</td>' + spare + '</tr>';
            document.getElementById('paginationControls').innerHTML = '';
            giveBackListCursor(cursor);
            return;
        }

        const me = getUserName().toLowerCase();
        let lastGroupKey = null;
        const rowsHtml = [];
        jobs.forEach(j => {
            // Insert group header row if grouping is active
            if (landingGroupBy !== 'none') {
                const gk = groupKeyFor(j);
                if (gk !== lastGroupKey) {
                    lastGroupKey = gk;
                    rowsHtml.push('<tr class="group-header-row"><td colspan="' + columns + '"><span class="group-header-label">' + escHtml(gk) + '</span></td>' +
                        (boardOn ? '<td class="col-qc"></td>' : '') + '</tr>');
                }
            }

            const mine = me && isMyJob(j) ? ' mine' : '';
            const status = getJobStatusLabel(j);
            const version = j.version ? ' <span class="version-badge">' + escHtml(j.version) + '</span>' : '';
            const desc = j.jobDescription ? escHtml(j.jobDescription) : '';
            const deptDots = getJobDeptDots(j);
            const dueHtml = renderDueCell(j);

            // A Tab stop: Enter opens the job (jobRowKey).
            rowsHtml.push('<tr class="' + mine.trim() + '" tabindex="0" data-job-id="' + escHtml(j.id) + '" onclick="loadJob(' + jsArg(j.id) + ')"' +
                ' onkeydown="jobRowKey(event, ' + jsArg(j.id) + ')">' +
                '<td class="col-select" onclick="event.stopPropagation()"><input type="checkbox" class="table-row-check" data-job-id="' + escHtml(j.id) + '" onchange="updateBulkBar()"></td>' +
                '<td class="col-job">' + escHtml(j.jobNumber || '') + version + '</td>' +
                '<td class="col-client">' + escHtml(j.clientName || '') + '</td>' +
                '<td class="col-desc">' + desc + '</td>' +
                '<td class="col-csr">' + escHtml(j.csrName || '') + '</td>' +
                '<td class="col-due">' + dueHtml + '</td>' +
                '<td class="col-status" onclick="event.stopPropagation(); openStatusPopover(this.querySelector(\'.status-badge\'), ' + jsArg(j.id) + ')">' +
                    '<span class="status-badge ' + status.cls + '" tabindex="0" data-status-job="' + escHtml(j.id) + '"' +
                    ' onkeydown="statusPillKey(event, ' + jsArg(j.id) + ')">' + status.label + '</span></td>' +
                '<td>' + deptDots + '</td>' +
                '<td class="col-created">' + renderCreatedCell(j) + '</td>' +
                renderQcCell(j) +
                '</tr>');
        });

        tbody.innerHTML = rowsHtml.join('');
        giveBackListCursor(cursor);
    }

    // ── Pagination rendering ──
    function renderPagination(totalItems) {
        const container = document.getElementById('paginationControls');
        if (!container) return;
        if (totalItems === 0) { container.innerHTML = ''; return; }

        const totalPages = Math.ceil(totalItems / landingPageSize);
        if (landingCurrentPage > totalPages) landingCurrentPage = totalPages;
        const start = (landingCurrentPage - 1) * landingPageSize + 1;
        const end = Math.min(landingCurrentPage * landingPageSize, totalItems);

        let pageButtons = '';
        const prevDisabled = landingCurrentPage <= 1 ? ' disabled' : '';
        const nextDisabled = landingCurrentPage >= totalPages ? ' disabled' : '';
        pageButtons += '<button class="page-btn nav-arrow' + prevDisabled + '" onclick="setLandingPage(' + (landingCurrentPage - 1) + ')">&#8249;</button>';

        let startPage = Math.max(1, landingCurrentPage - 3);
        let endPage = Math.min(totalPages, startPage + 6);
        if (endPage - startPage < 6) startPage = Math.max(1, endPage - 6);

        for (let p = startPage; p <= endPage; p++) {
            const active = p === landingCurrentPage ? ' active' : '';
            pageButtons += '<button class="page-btn' + active + '" onclick="setLandingPage(' + p + ')">' + p + '</button>';
        }
        pageButtons += '<button class="page-btn nav-arrow' + nextDisabled + '" onclick="setLandingPage(' + (landingCurrentPage + 1) + ')">&#8250;</button>';

        container.innerHTML =
            '<span class="pagination-info">Showing <strong>' + start + '-' + end + '</strong> of <strong>' + totalItems + '</strong> jobs</span>' +
            '<div class="pagination-controls">' + pageButtons + '</div>' +
            '<div class="per-page"><span>Show</span>' +
            '<select onchange="setLandingPageSize(Number(this.value))">' +
            '<option value="10"' + (landingPageSize === 10 ? ' selected' : '') + '>10</option>' +
            '<option value="25"' + (landingPageSize === 25 ? ' selected' : '') + '>25</option>' +
            '<option value="50"' + (landingPageSize === 50 ? ' selected' : '') + '>50</option>' +
            '</select><span>per page</span></div>';
    }

    // ========== LANDING SEARCH (filters the job table) ==========
    (function() {
        const input = document.getElementById('landingSearchInput');
        if (!input) return;
        let debounceTimer;
        input.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                landingSearchQuery = input.value.trim().toLowerCase();
                landingCurrentPage = 1;
                applyLandingFilters();
            }, 150);
        });
    })();

    // ── Server-backed data layer ──
    // jobsCache holds active jobs in memory; refreshed from server on key actions.
    // rowVersions tracks the optimistic lock version per job id.
    // _saveQueue serializes all server writes so rowVersion never races.
    let rowVersions = {};
    let _saveQueue = Promise.resolve();
    // How many saves are queued or in flight, and a number that moves with
    // every save queued: the catch-up with one's own other window waits for
    // none and gives up when one was queued while it asked (EDIT_LOCK_PLAN 11.5).
    let savesPending = 0;
    let saveSerial = 0;
    // The page is going (pagehide, item 6): its last save has sent everything
    // the server does not have, so nothing new goes on the queue. A save put
    // on it now would never run, or run as an ordinary request the closing
    // page cancels.
    let pageLeaving = false;
    // The one save on its way now (the queue sends one at a time), as sent:
    // { jobId, row } or { jobId, piece }. The server may take it after the
    // page's last save or before, so the last save also sends any field the
    // page has put back to what the server had before it (item 6's review:
    // a switch turned on, then off while the "on" was on its way).
    let savingNow = null;

    function queueSave(fn) {
        if (pageLeaving) return Promise.resolve(false);
        savesPending++;
        saveSerial++;
        const run = () => {
            let p;
            try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
            // Every answered save asks whether a failed one is still owed
            // (A SAVE THAT FAILS SAYS SO, below): once the queue is empty.
            return p.finally(() => { savesPending--; saveStateCheck(); });
        };
        _saveQueue = _saveQueue.then(run, run);
        return _saveQueue;
    }

    // Resolves once the saves already on the queue have finished, or after ms,
    // whichever comes first. Never rejects: the queue stays rejected after a
    // save that failed with a server error, until the next save runs.
    function savesSettled(ms) {
        return Promise.race([_saveQueue.catch(() => {}), new Promise(resolve => setTimeout(resolve, ms))]);
    }

    // ── Server-down retry queue ──
    // When a save fails because the server is unreachable, the request
    // is held in _retryQueue. A poller checks every few seconds and
    // replays the queue once the server responds to /api/health.

    var _retryQueue = [];
    var retryDropped = 0;   // queued changes a box named as not saved since the last outage
    var _retryTimer = null;
    var _serverDown = false;
    var RETRY_INTERVAL_MS = 5000;

    function isNetworkError(err) {
        return err instanceof TypeError && err.message === 'Failed to fetch';
    }

    function showServerBanner(down) {
        var banner = document.getElementById('serverBanner');
        if (!banner) return;
        if (down) {
            var count = _retryQueue.length;
            banner.className = 'server-banner server-down';
            banner.innerHTML = 'Server unreachable -- your changes are saved locally and will sync when it returns.' +
                (count ? '<span class="banner-detail">(' + count + ' pending save' + (count > 1 ? 's' : '') + ')</span>' : '');
        } else {
            banner.className = 'server-banner server-restored';
            // Changes a box has just named as not saved (the job was taken
            // over or archived meanwhile) were not synced (item 5's review),
            // nor a replay the server failed: the save bar says so.
            const owed = !!currentJobId && !isViewed(currentJobId) && owedNow(currentJobId);
            banner.innerHTML = (retryDropped || owed) ? 'Server connection restored.' : 'Server connection restored -- all changes synced.';
            retryDropped = 0;
            setTimeout(function() { banner.className = 'server-banner'; banner.innerHTML = ''; }, 4000);
        }
    }

    function startRetryPoller() {
        if (_retryTimer) return;
        _retryTimer = setInterval(async function() {
            try {
                var res = await fetch('/api/health');
                if (!res.ok) return;
            } catch (e) {
                return; // still down
            }
            // Server is back -- flush the queue
            _serverDown = false;
            clearInterval(_retryTimer);
            _retryTimer = null;
            await flushRetryQueue();
            showServerBanner(false);
            saveStateCheck();
        }, RETRY_INTERVAL_MS);
    }

    async function flushRetryQueue() {
        // The open job's lock first: an outage let it lapse, so it is taken
        // back before the first replayed write (a free job stays this page's),
        // and a job somebody else opened meanwhile is found now, by name,
        // with its queued changes counted in the box rather than refused one
        // by one.
        if (currentJobId && holdsLock && !isViewed(currentJobId)) {
            const openId = currentJobId;
            const r = await checkJobLock(openId);
            if (r && r.ok && r.archived && openId === currentJobId && !isViewed(openId)) {
                // Archived meanwhile: refused anyway, so counted in the box
                // and not replayed (item 5).
                await lockGone(openId, { archived: true });
            } else if (r && r.ok && r.locked && openId === currentJobId && !isViewed(openId)) {
                await lockLost(openId, r, {});
            }
        }
        while (_retryQueue.length > 0) {
            var entry = _retryQueue[0];
            try {
                await entry.fn();
                // By identity, not the head: a refusal by the lock (423) inside
                // entry.fn takes that job's entries off the queue itself.
                _retryQueue = _retryQueue.filter(function(e) { return e !== entry; });
            } catch (e) {
                if (isNetworkError(e)) {
                    // Server went down again mid-flush
                    _serverDown = true;
                    showServerBanner(true);
                    startRetryPoller();
                    return;
                }
                // Non-network error (e.g. 409 conflict) -- drop this entry, it was handled
                _retryQueue = _retryQueue.filter(function(e) { return e !== entry; });
            }
        }
    }

    function getActiveJobs() {
        return jobsCache || [];
    }

    let _persistJobTimer = null;
    // A change to the open job: its row is saved 600 ms after the last call,
    // stamped with this user's name. Only real changes come here. Which tab
    // or piece somebody is looking at used to be saved here too, keeping the
    // author, but every such save still raised the job's version: someone
    // reading a job another person was editing made that person's next save
    // be refused ("Job updated on the server.") and lost, and a page cannot
    // tell reliably whether it holds the edit lock (one person's two tabs
    // both do). So the tab and piece stay in the page's copy
    // (setJobsCacheOnly) and go with the next real change.
    function saveActiveJobs(jobs) {
        jobsCache = jobs;
        boardFor.jobs = null;   // a piece added or deleted changes the job's QC chip
        // Debounced persist: save current job to server 600ms after last call
        if (currentJobId) {
            clearTimeout(_persistJobTimer);
            _persistJobTimer = setTimeout(() => {
                // Cleared, so the unload flush below can tell a save that is
                // still waiting from one that has already gone.
                _persistJobTimer = null;
                const j = (jobsCache || []).find(x => x.id === currentJobId);
                if (j) persistJob(j);
            }, 600);
        }
    }

    // This page's copy changes and nothing is saved: the job list (a job
    // created, archived or deleted), or which tab and piece the open job
    // shows, which goes with its next real change. saveActiveJobs would start
    // a save of whichever job is open, stamped with this user's name although
    // nothing on it changed.
    function setJobsCacheOnly(jobs) {
        jobsCache = jobs;
        boardFor.jobs = null;
    }

    // Leaving a work order: sends now what is still waiting for it on the two
    // timers above, typing (400 ms) and a job-row change (600 ms). Every way out of
    // a work order calls this while the job is still the open one. Once
    // currentJobId has moved on, both timers either find no job and drop the
    // change, or find the next job opened and write that one instead
    // (measured 2026-09-26: a note typed then Home within 0.38 s never reached
    // the server; Edit Job's Save, Home, then another job opened within 0.6 s
    // stamped the other job; HOME_FIX_PLAN.md). With no job open it only
    // cancels them.
    //
    // Ordinary queued saves, not keepalive: the page stays, each save carries
    // the row version the one before it came back with, and a piece can pass
    // keepalive's 64 KB limit.
    // options.keepSignoff: the tab is only being hidden (the catch-up with
    // her other window), so an open Signoff due editor stays open.
    function sendWaitingSaves(options) {
        // Signoff due commits a moment after it loses focus, so a quick tap on
        // Home would otherwise run before it.
        if (_signoffCommit && !(options && options.keepSignoff)) _signoffCommit();
        if (!currentJobId) { dropWaitingSaves(); return; }
        // Typing first: saveComponentState starts the job-row timer itself.
        if (saveDebounceTimer) {
            clearTimeout(saveDebounceTimer);
            saveDebounceTimer = null;
            // The page stays (a tab hidden, a window left): the screen is
            // refreshed as the typing timer would (required marks, the print
            // copy). Leaving the job, the screen is about to go anyway.
            if (currentComponentId) { if (options && options.stay) saveJobState(); else saveComponentState(); }
        }
        if (_persistJobTimer) {
            clearTimeout(_persistJobTimer);
            _persistJobTimer = null;
            // Only a real change ever waits here: which tab or piece somebody
            // was on is never sent (saveActiveJobs).
            const j = (jobsCache || []).find(x => x.id === currentJobId);
            if (j) persistJob(j);
        }
    }

    // Forgets what is waiting without sending it: the page is about to be
    // redrawn from the server, so the screen it would read is the old one.
    function dropWaitingSaves() {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
        clearTimeout(_persistJobTimer);
        _persistJobTimer = null;
    }

    function invalidateJobsCache() {
        jobsCache = null;
    }

    async function refreshJobs() {
        const board = refreshBoard();   // beside the jobs; never throws
        // Saves already on their way land first, so the list read back holds
        // them. Refresh is often the next click after Home, which sends what
        // was waiting; read before those saves land, the list shows the old
        // values. At most 5 s, as for Change user.
        await savesSettled(5000);
        try {
            const res = await fetch('/api/jobs');
            if (!res.ok) throw new Error('Failed to load jobs');
            const jobs = await res.json();
            // The job open for editing while it owes a save the server
            // failed keeps the page's copy and version: the server's would
            // drop what the bar says is still to be sent (SAVE_FAILURE_PLAN.md).
            const owing = troubleJob && troubleJob === currentJobId && !isViewed(currentJobId) ? getActiveJobs().find(j => j.id === currentJobId) : null;
            const owingVersion = owing ? rowVersions[owing.id] : null;
            jobs.forEach(j => { rowVersions[j.id] = j.rowVersion; });
            if (owing) {
                const i = jobs.findIndex(j => j.id === owing.id);
                if (i >= 0) { jobs[i] = owing; rowVersions[owing.id] = owingVersion; }
            }
            jobsCache = jobs;
            forgetLeftCopy();
        } catch (e) {
            console.error('refreshJobs failed:', e);
            if (!jobsCache) jobsCache = [];
        }
        await board;
        return jobsCache;
    }

    // ── What the server has of the open job (EDIT_LOCK_PLAN 11.5 A) ──
    // A copy of the open job as the server holds it: taken from the fresh
    // copy the job was drawn from, and moved on by exactly the body of every
    // save the server took. The page's own copy runs ahead of it by whatever
    // is waiting, on its way or refused, so the two together say what was not
    // saved when the job stops being this page's (lockLost), and whether the
    // page may be redrawn with its own other window's saves (catch-up). The
    // job just left is kept too (leftCopy), for a save refused after Home.
    let savedCopy = null;   // { jobId, row, pieces: { id: piece } }
    let leftCopy = null;
    let refusedRequests = null;   // { jobId, items }: an add or a delete the lock refused
    function deepCopy(value) { return JSON.parse(JSON.stringify(value)); }
    function rememberSavedJob(job) {
        if (!job || !job.id || !Array.isArray(job.components)) { savedCopy = null; return; }
        const row = deepCopy(job);
        delete row.components;
        const pieces = {};
        job.components.forEach(c => { pieces[c.id] = deepCopy(c); });
        savedCopy = { jobId: job.id, row, pieces };
    }
    function copyFor(jobId) {
        if (savedCopy && savedCopy.jobId === jobId) return savedCopy;
        if (leftCopy && leftCopy.jobId === jobId) return leftCopy;
        return null;
    }
    function savedRowSent(jobId, body) {
        const copy = copyFor(jobId);
        if (!copy) return;
        try { const row = JSON.parse(body); delete row.components; copy.row = row; } catch (e) { /* kept as it was */ }
    }
    function savedPieceSent(jobId, body) {
        const copy = copyFor(jobId);
        if (!copy) return;
        try { const piece = JSON.parse(body); if (piece && piece.id) copy.pieces[piece.id] = piece; } catch (e) { /* kept as it was */ }
    }
    function savedPieceGone(jobId, pieceId) {
        const copy = copyFor(jobId);
        if (copy) delete copy.pieces[pieceId];
    }
    function recordRefused(jobId, text) {
        if (!refusedRequests || refusedRequests.jobId !== jobId) refusedRequests = { jobId, items: [] };
        refusedRequests.items.push({ text, kind: 'request' });
    }
    function takeRefused(jobId) {
        if (!refusedRequests || refusedRequests.jobId !== jobId) return [];
        const items = refusedRequests.items;
        refusedRequests = null;
        return items;
    }

    // ── The last save, as the tab closes (item 6; the listeners are with
    // the startup code) ──
    // Chrome sends at most 64 KiB from a closing page, everything together,
    // and the QC Review window sends its own last clicks after this (review.js,
    // pagehide), so the work order keeps to about half.
    const LAST_SAVE_BYTES = 32000;
    const LAST_SAVE_PIECE_FIELDS = ['name', 'version', 'instructions_prepress', 'instructions_techservices',
        'instructionsHistory_prepress', 'instructionsHistory_techservices'];
    // The job row's columns a person changes: not the stamp, and not which tab
    // or piece was showing, which only ever go with a real change.
    const LAST_SAVE_ROW_FIELDS = ['jobDescription', 'clientName', 'csrName', 'assignedToPrepress', 'assignedToTechservices',
        'signoffDueDatePrepress', 'signoffDueTimePrepress', 'signoffDueDateTechservices', 'signoffDueTimeTechservices',
        'version', 'status', 'duplicatedFrom', 'headerModified', 'headerModifiedBy'];
    // Switches and notes as componentSignature compares them: a box nobody
    // ticked and a note nobody typed are not changes.
    function keptValues(map) {
        const kept = {};
        Object.keys(map || {}).sort().forEach(id => {
            const v = map[id];
            if (v === true || (typeof v === 'string' && v.trim() !== '')) kept[id] = v;
        });
        return JSON.stringify(kept);
    }
    const textOf = v => String(v == null ? '' : v);
    // What the job has that the server does not (copyFor): only the fields of
    // each piece that differ, and the whole row when a column of it does.
    // null when nothing differs, so a page that only looked sends nothing.
    // A field goes when it differs from what the server has, or from what the
    // save on its way carries (which may land after this one).
    function lastSaveBody(job, saved) {
        if (!job || !Array.isArray(job.components) || !saved) return null;
        const flying = savingNow && savingNow.jobId === job.id ? savingNow : null;
        const pieces = [];
        job.components.forEach(p => {
            const was = saved.pieces[p.id];
            if (!was) return;   // a piece whose add has not been answered: the add carries it
            const sent = flying && flying.piece && flying.piece.id === p.id ? flying.piece : null;
            const moved = (a, b) => a !== b;
            const out = { id: p.id };
            LAST_SAVE_PIECE_FIELDS.forEach(f => {
                if (moved(textOf(p[f]), textOf(was[f])) || (sent && moved(textOf(p[f]), textOf(sent[f])))) out[f] = textOf(p[f]);
            });
            ['checkboxes', 'notes'].forEach(f => {
                const now = keptValues(p[f]);
                if (moved(now, keptValues(was[f])) || (sent && moved(now, keptValues(sent[f])))) out[f] = p[f] || {};
            });
            if (Object.keys(out).length > 1) pieces.push(out);
        });
        const rowDiffers = base => LAST_SAVE_ROW_FIELDS.some(f => textOf(job[f]) !== textOf(base[f]))
            || JSON.stringify(job.deletionLog || []) !== JSON.stringify(base.deletionLog || []);
        const rowMoved = rowDiffers(saved.row || {}) || !!(flying && flying.row && rowDiffers(flying.row));
        if (!pieces.length && !rowMoved) return null;
        let row = null;
        if (rowMoved) { row = Object.assign({}, job); delete row.components; }
        return { user: getUserName(), page: LOCK_PAGE_ID, rowVersion: rowVersions[job.id] || 1,
            lastModified: new Date().toISOString(), lastModifiedBy: getUserName(), row, pieces };
    }
    function utf8Size(text) { return new Blob([text]).size; }
    // Over the room left: whole pieces are left out, largest first, until it
    // fits (the row always goes). Only after Chrome asked and she chose Leave.
    // Never single fields: a piece's fields belong together (Lock
    // instructions empties the box and fills the Revisions; Generate writes
    // the words and their fingerprint in the notes), so half of one would
    // write a piece that never existed (item 6's build review: the box sent
    // empty without the Revisions that held its words).
    function fitLastSave(body, room) {
        let text = JSON.stringify(body);
        while (utf8Size(text) > room && body.pieces.length) {
            let biggest = 0;
            body.pieces.forEach((p, i) => { if (JSON.stringify(p).length > JSON.stringify(body.pieces[biggest]).length) biggest = i; });
            body.pieces.splice(biggest, 1);
            text = JSON.stringify(body);
        }
        return text;
    }
    // The job open for editing, and the job just left while the saves sent
    // on the way out are unanswered (leftCopy lives exactly that long).
    function lastSaveJobs() {
        const ids = [];
        if (currentJobId && !isViewed(currentJobId)) ids.push(currentJobId);
        if (leftCopy && !ids.includes(leftCopy.jobId)) ids.push(leftCopy.jobId);
        return ids;
    }
    // beforeunload's question, changing nothing: the open job read from the
    // screen into a copy (pageSnapshot), the job just left as it is.
    function lastSavesTooBig() {
        if (pageLeaving) return false;
        let total = 0;
        lastSaveJobs().forEach(id => {
            const job = id === currentJobId ? (pageSnapshot(id, true) || {}).job : getActiveJobs().find(j => j.id === id);
            const body = lastSaveBody(job, copyFor(id));
            if (body) total += utf8Size(JSON.stringify(body));
        });
        // A little room for what pagehide adds and this cannot see without
        // changing the page (an open header box, committed there).
        return total > LAST_SAVE_BYTES - 1000;
    }
    // pagehide: the page is going. Once.
    function sendLastSaves() {
        if (pageLeaving) return;
        const ids = lastSaveJobs();
        const openId = ids[0] === currentJobId ? currentJobId : null;
        // An open header box and the Signoff due editor count as done, the
        // way a click away does them, and then the screen is read into the
        // piece. Their own saves go nowhere now (pageLeaving).
        pageLeaving = true;
        if (openId) {
            try { commitOpenBoxes(); } catch (e) { /* send what the copy holds */ }
            try { if (currentComponentId) saveComponentState(); } catch (e) { /* the same */ }
        }
        let room = LAST_SAVE_BYTES;
        ids.forEach(id => {
            let body = null;
            try { body = lastSaveBody(getActiveJobs().find(j => j.id === id), copyFor(id)); } catch (e) { body = null; }
            if (!body) {
                // Nothing to send: only the hold goes, as before.
                lockRequest('DELETE', id, null, { keepalive: true });
                return;
            }
            const text = fitLastSave(body, room);
            room -= utf8Size(text);
            try {
                fetch('/api/jobs/' + encodeURIComponent(id) + '/last-save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-STS-User': encodeURIComponent(getUserName() || ''), 'X-STS-Writer': LOCK_PAGE_ID },
                    body: text,
                    keepalive: true
                }).catch(() => {
                    // Refused by Chrome (no room left): at least the hold
                    // goes, a small request that still runs after the page.
                    lockRequest('DELETE', id, null, { keepalive: true });
                });
            } catch (e) { lockRequest('DELETE', id, null, { keepalive: true }); }
        });
        // Remembered for a reload (F5 opens it again), as before, and for this
        // tab alone: the shared key names whichever job any tab opened last,
        // so with two tabs a reload used to come back on the other tab's job
        // (item 6's build review; sessionStorage is per tab and survives a
        // reload).
        if (openId) {
            localStorage.setItem('prepressActiveJobTime', Date.now().toString());
            try { sessionStorage.setItem('prepressTabJob', openId); } catch (e) { /* the shared key serves */ }
        }
        dropWaitingSaves();
        stopLockHeartbeat();
        holdsLock = false;
    }

    // The four writes below refuse a viewed archived job, tested at the call
    // on the job each save carries, so a save of the job left a moment before
    // still goes. The job is never in the active list, so nothing should get
    // here; this is the last fence if something does (ARCHIVE_VIEW_PLAN D).
    // opts.quiet: the caller says it itself when the server fails the save
    // (the job list's status change); nothing is marked owed.
    function persistJob(job, opts) {
        if (isViewed(job.id)) return Promise.resolve(false);
        return queueSave(async () => {
            job.lastModified = new Date().toISOString();
            job.lastModifiedBy = getUserName();
            const payload = { ...job, rowVersion: rowVersions[job.id] || 1 };
            delete payload.components;
            const body = JSON.stringify(payload);
            try {
                savingNow = { jobId: job.id, row: JSON.parse(body) };   // a copy: the page's own objects change under it
                const res = await fetch('/api/jobs/' + job.id, {
                    method: 'PUT',
                    headers: apiHeaders(job.id),
                    body
                });
                // A 404 cannot come from this route today (a deleted job is a
                // 409); taken as the conflict it would be. A save owed is not
                // sent again under the reload box.
                if (res.status === 409 || res.status === 404) {
                    conflictMark = { jobId: job.id, at: Date.now() };
                    if (troubleJob === job.id) clearSaveTrouble();
                    showReloadModal();
                    return false;
                }
                if (await refusedByLock(res, job.id)) return false;
                if (await refusedByArchive(res, job.id)) return false;
                // Any other refusal (a server error, a reply that cannot be
                // read) used to be thrown and caught by nobody: nothing on
                // screen, nothing sent again.
                if (!res.ok) { saveFailed(job.id, res.status, null, opts); return false; }
                let data;
                try { data = await res.json(); } catch (e) { saveFailed(job.id, 0, null, opts); return false; }
                rowVersions[job.id] = data.rowVersion;
                job.rowVersion = data.rowVersion;
                savedRowSent(job.id, body);
                return true;
            } catch (e) {
                if (isNetworkError(e)) {
                    _serverDown = true;
                    _retryQueue.push({ jobId: job.id, fn: function() { return persistJob(job, opts && opts.quiet ? { quiet: true, replay: true } : opts); } });
                    showServerBanner(true);
                    startRetryPoller();
                    return false;
                }
                throw e;
            } finally {
                savingNow = null;   // answered: the copy of what the server has has moved, or it was refused
            }
        });
    }

    // Create a component on the server (add and duplicate). Runs through the save
    // queue so it waits for the save of the component being left and sends the
    // rowVersion that save returned. Sent outside the queue, both requests carried
    // the same version and the server refused whichever arrived second.
    // Resolves true when created, false on a version conflict (reload modal shown).
    function createComponentOnServer(job, newComp) {
        if (isViewed(job.id)) return Promise.resolve(false);
        return queueSave(async () => {
            const body = JSON.stringify({ ...newComp, rowVersion: rowVersions[job.id], lastModifiedBy: getUserName() });
            const res = await fetch('/api/jobs/' + job.id + '/components', {
                method: 'POST',
                headers: apiHeaders(job.id),
                body
            });
            if (res.status === 409) {
                conflictMark = { jobId: job.id, at: Date.now() };
                showReloadModal();
                return false;
            }
            if (res.status === 423) recordRefused(job.id, 'new piece ' + quoteWords(newComp.name || ''));
            if (await refusedByLock(res, job.id)) return false;
            if (await refusedByArchive(res, job.id, 'new piece ' + quoteWords(newComp.name || ''))) return false;
            if (!res.ok) throw new Error('Failed to create component');
            const data = await res.json();
            rowVersions[job.id] = data.rowVersion;
            job.rowVersion = data.rowVersion;
            savedPieceSent(job.id, body);
            return true;
        });
    }

    // Delete a component on the server, through the save queue for the same reason:
    // the delete bumps the job's rowVersion, so a save still in flight would be refused.
    function deleteComponentOnServer(job, componentId) {
        // Refused, not skipped: the caller takes the piece off the screen only
        // once this has succeeded.
        if (isViewed(job.id)) return Promise.reject(new Error('This job is read only.'));
        return queueSave(async () => {
            // With the version this page has, as every save sends it: a delete
            // made from a copy older than the job is refused (409) rather than
            // handing this page a version that covers changes it never saw
            // (STAMPS_AND_VERSION_PLAN.md).
            const res = await fetch('/api/components/' + componentId, {
                method: 'DELETE',
                headers: apiHeaders(job.id),
                body: JSON.stringify({ rowVersion: rowVersions[job.id] || 1 })
            });
            if (res.status === 409) {
                // The reload box, as the piece add shows it; the caller keeps
                // the piece on screen and shows no box of its own. A save owed
                // is not sent again under the box, as on a save's 409.
                conflictMark = { jobId: job.id, at: Date.now() };
                if (troubleJob === job.id) clearSaveTrouble();
                showReloadModal();
                const e = new Error('This job was updated by someone else.');
                e.locked = true;
                throw e;
            }
            if (res.status === 423) {
                const gone = (job.components || []).find(c => c.id === componentId);
                recordRefused(job.id, 'deleting the ' + ((gone && gone.name) || 'piece'));
            }
            if (await refusedByLock(res, job.id)) {
                // Refused by the lock: the caller keeps the piece on screen and
                // shows no box of its own (the lost path has said who).
                const e = new Error('Somebody else is editing this job.');
                e.locked = true;
                throw e;
            }
            const kept = res.status === 410 ? (job.components || []).find(c => c.id === componentId) : null;
            if (await refusedByArchive(res, job.id, 'deleting the ' + ((kept && kept.name) || 'piece'))) {
                // Archived: the same, and lockGone's box names the delete.
                const e = new Error('This job is archived.');
                e.locked = true;
                throw e;
            }
            if (!res.ok) throw new Error('Failed to delete component');
            const data = await res.json();
            if (data.rowVersion) {
                rowVersions[job.id] = data.rowVersion;
                job.rowVersion = data.rowVersion;
            }
            savedPieceGone(job.id, componentId);
        });
    }

    function componentPayload(comp, job) {
        return {
            ...comp,
            checkboxes: comp.checkboxes || {},
            notes: comp.notes || {},
            rowVersion: rowVersions[job.id] || 1,
            lastModified: new Date().toISOString(),
            lastModifiedBy: getUserName()
        };
    }

    // A closing page sends none of these: its last save carries everything
    // (sendLastSaves, item 6).
    function persistComponent(comp, job) {
        if (isViewed(job.id)) return Promise.resolve(false);
        return queueSave(async () => {
            // Built here, not before the queue: each save must carry the
            // rowVersion the save in front of it came back with.
            const payload = componentPayload(comp, job);
            const body = JSON.stringify(payload);
            try {
                savingNow = { jobId: job.id, piece: JSON.parse(body) };
                const res = await fetch('/api/components/' + comp.id, {
                    method: 'PUT',
                    headers: apiHeaders(job.id),
                    body
                });
                if (res.status === 409) {
                    conflictMark = { jobId: job.id, at: Date.now() };
                    if (troubleJob === job.id) clearSaveTrouble();
                    showReloadModal();
                    return false;
                }
                // Gone from the server: deleted in her other window (a
                // conflict, as a 409), or by this page's own delete queued in
                // front of this save (nothing to say).
                if (res.status === 404) {
                    const listed = getActiveJobs().find(j => j.id === job.id);
                    if (listed && (listed.components || []).some(c => c.id === comp.id)) {
                        conflictMark = { jobId: job.id, at: Date.now() };
                        if (troubleJob === job.id) clearSaveTrouble();
                        showReloadModal();
                    }
                    return false;
                }
                if (await refusedByLock(res, job.id)) return false;
                if (await refusedByArchive(res, job.id)) return false;
                if (!res.ok) { saveFailed(job.id, res.status, comp.id); return false; }
                let data;
                try { data = await res.json(); } catch (e) { saveFailed(job.id, 0, comp.id); return false; }
                rowVersions[job.id] = data.rowVersion;
                job.rowVersion = data.rowVersion;
                savedPieceSent(job.id, body);
                tooBigPieces.delete(comp.id);
                return true;
            } catch (e) {
                if (isNetworkError(e)) {
                    _serverDown = true;
                    _retryQueue.push({ jobId: job.id, fn: function() { return persistComponent(comp, job); } });
                    showServerBanner(true);
                    startRetryPoller();
                    return false;
                }
                throw e;
            } finally {
                savingNow = null;
            }
        });
    }

    // ── A SAVE THAT FAILS SAYS SO (SAVE_FAILURE_PLAN.md) ──
    // A work order save the server refuses with anything but a conflict
    // (409), the lock (423) or the archive (410), and not for want of the
    // network (the retry queue above), used to be thrown and caught by
    // nobody: nothing on screen, and nothing sent again, because the page's
    // copy already held the change. Now:
    // - the open job is marked (troubleJob). What is owed is not a list of
    //   failures but the difference between the page's copy and what the
    //   server has (lastSaveBody, the last save's own test), so a failed save
    //   that changed nothing a person made (the job row's stamp after every
    //   component save) owes nothing;
    // - while owed, the bar under the nav says so and the page sends the
    //   difference again every 10 seconds (David, 2026-10-07); green "Saved."
    //   when it lands;
    // - every way out of the job waits for its saves and, when something is
    //   still owed, asks Stay on this job or Leave without saving (leaveJob);
    // - a job that is not open: the caller says it (the job list's status
    //   change), or one box for the job just left.
    const SAVE_RETRY_MS = 10000;
    const SAVE_BAR_WORDS = {
        failed: 'Your last change was not saved. The app tries again every 10 seconds.',
        big: 'Your last change is too big to save. Remove a pasted picture and it will save.',
        saved: 'Saved.'
    };
    let troubleJob = null;              // the open job a save failed for, until nothing is owed
    const tooBigPieces = new Set();     // components the server found too big (413): not sent again by the timer
    let saveRetryTimer = null;
    let lastSaveFailure = null;         // { jobId, at }: a quiet save's failure, for its caller
    let abandonedJob = null;            // the job she left with Leave without saving: nothing more is said about it
    let saveBarShown = '';              // '', 'failed', 'big' or 'saved'
    const leftFailed = new Set();       // jobs just left whose saves failed: looked at once they have all answered
    let saveBarTimer = null;

    function saveFailed(jobId, status, pieceId, opts) {
        console.warn('Save not taken by the server (' + (status || 'unreadable reply') + ') for job ' + jobId + (pieceId ? ', component ' + pieceId : ''));
        // Every failure, for a caller that must know its own save failed
        // (the status change), whatever the job.
        lastSaveFailure = { jobId, at: Date.now() };
        if (opts && opts.quiet) {
            // The job list's status change, replayed after an outage: its
            // caller has long returned, so the box is said here.
            if (opts.replay) statusNotSaved(jobId, true);
            return;
        }
        if (jobId === currentJobId) {
            // Made the view meanwhile (a takeover, the job archived): that
            // box names what was not saved.
            if (isViewed(jobId)) return;
            troubleJob = jobId;
            if (status === 413 && pieceId) tooBigPieces.add(pieceId);
            if (!saveRetryTimer) saveRetryTimer = setInterval(saveRetryTick, SAVE_RETRY_MS);
            return;   // the bar: saveStateCheck, once the queue is empty
        }
        // The job just left: said once every save of that leave has
        // answered, and only when the server is still missing something
        // (keepLeftCopy), so a later save of the same leave that lands is
        // never put back, and a failed stamp says nothing.
        if (leftCopy && leftCopy.jobId === jobId) { leftFailed.add(jobId); return; }
        leftSaveFailed(jobId);
    }

    // What the open job owes the server: lastSaveBody's { row, pieces }, or
    // null when the page's copy and the server's agree.
    function owedBody(jobId) {
        const job = getActiveJobs().find(j => j.id === jobId);
        const copy = copyFor(jobId);
        if (!job || !copy) return null;
        try { return lastSaveBody(job, copy); } catch (e) { return null; }
    }
    function owedNow(jobId) {
        return troubleJob === jobId && !!owedBody(jobId);
    }

    // After every answered save, and when the server comes back: the bar as
    // the open job stands, once nothing is on its way.
    function saveStateCheck() {
        if (!troubleJob) return;
        if (troubleJob !== currentJobId || isViewed(troubleJob)) { clearSaveTrouble(); return; }
        if (savesPending > 0 || saveDebounceTimer || _persistJobTimer) return;
        if (_serverDown) { showSaveBar(''); return; }   // the server-down banner speaks
        const body = owedBody(troubleJob);
        if (!body) { saveTroubleHealed(); return; }
        showSaveBar(body.pieces.some(p => tooBigPieces.has(p.id)) ? 'big' : 'failed');
    }
    function saveTroubleHealed() {
        const wasUp = saveBarShown === 'failed' || saveBarShown === 'big';
        troubleJob = null;
        tooBigPieces.clear();
        clearInterval(saveRetryTimer);
        saveRetryTimer = null;
        showSaveBar(wasUp ? 'saved' : '');
    }
    // The job stops being this page's open job (left, drawn anew, a view):
    // nothing more is sent for it and the bar goes. The boxes of those paths
    // name what was not saved.
    function clearSaveTrouble() {
        troubleJob = null;
        tooBigPieces.clear();
        clearInterval(saveRetryTimer);
        saveRetryTimer = null;
        showSaveBar('');
    }

    // Every 10 seconds while owed: the difference, sent again. Found by id in
    // the page's copy as it is now; never a component the server found too
    // big (5 MB every 10 seconds): her next change of it sends it, and so
    // does leaving.
    function saveRetryTick() {
        const jobId = troubleJob;
        if (!jobId || jobId !== currentJobId || isViewed(jobId)) { clearSaveTrouble(); return; }
        if (_serverDown || !holdsLock || leaveBusy || savesPending > 0 || saveDebounceTimer || _persistJobTimer) return;
        if (!sendOwed(jobId, false)) saveStateCheck();
    }
    // Sends each component that differs and the row when it differs. The
    // number sent; 0 when nothing is owed (or only a too-big component, left).
    function sendOwed(jobId, withTooBig) {
        const job = getActiveJobs().find(j => j.id === jobId);
        const body = owedBody(jobId);
        if (!job || !body) return 0;
        let sent = 0;
        body.pieces.forEach(p => {
            if (!withTooBig && tooBigPieces.has(p.id)) return;
            const comp = (job.components || []).find(c => c.id === p.id);
            if (comp) { persistComponent(comp, job); sent++; }
        });
        if (body.row) { persistJob(job); sent++; }
        return sent;
    }

    // The bar under the nav. It is in the page's flow and sticks under the
    // nav, and the sticky bars below read --top-bars, so it pushes the work
    // order down rather than covering Home or a button (the server-down
    // banner, fixed over the nav, is left as it is).
    function showSaveBar(kind) {
        const bar = document.getElementById('saveBar');
        if (!bar) return;
        clearTimeout(saveBarTimer);
        saveBarTimer = null;
        saveBarShown = kind;
        if (!kind) {
            bar.hidden = true;
            bar.className = 'save-bar';
            bar.textContent = '';
            document.documentElement.style.removeProperty('--top-bars');
            return;
        }
        bar.textContent = SAVE_BAR_WORDS[kind];
        bar.className = 'save-bar ' + (kind === 'saved' ? 'save-bar--saved' : 'save-bar--failed');
        bar.hidden = false;
        saveBarHeight();
        if (kind === 'saved') {
            const timer = setTimeout(() => { if (saveBarTimer === timer) showSaveBar(''); }, 4000);
            saveBarTimer = timer;
        }
    }

    // The sticky bars below the nav sit under the save bar while it shows.
    function saveBarHeight() {
        const bar = document.getElementById('saveBar');
        if (!bar || bar.hidden) { document.documentElement.style.removeProperty('--top-bars'); return; }
        document.documentElement.style.setProperty('--top-bars', (56 + bar.offsetHeight) + 'px');
    }

    // The page's copy of a job put back to what the server has (Leave without
    // saving, a save that failed after she left): nothing she threw away can
    // then be sent by a later save of the job, shown on the job list, or
    // drawn by an open whose fresh copy cannot be fetched.
    function putBackServerCopy(jobId, copy) {
        if (!copy || copy.jobId !== jobId) return;
        const jobs = getActiveJobs().slice();
        const i = jobs.findIndex(j => j.id === jobId);
        if (i < 0) return;
        const page = jobs[i];
        const back = Object.assign(deepCopy(copy.row), {
            components: (page.components || []).map(c => copy.pieces[c.id] ? deepCopy(copy.pieces[c.id]) : c)
        });
        if (rowVersions[jobId]) back.rowVersion = rowVersions[jobId];
        if (!back.components.some(c => c.id === back.activeComponentId) && back.components.length) back.activeComponentId = back.components[0].id;
        jobs[i] = back;
        setJobsCacheOnly(jobs);
    }

    // A save of a job that is not open and not just left failed (a replay
    // of the retry queue for a job left earlier): one box, with nothing to
    // compare it with. Not sent again: the job is not open.
    function leftSaveFailed(jobId, detail) {
        if (abandonedJob === jobId) return;
        const job = getActiveJobs().find(j => j.id === jobId);
        lockBoxWhenFree({ title: (job && job.jobNumber ? 'Job ' + job.jobNumber : 'This job') + ': your last change was not saved.',
            text: 'The server had a problem after you left the job.', detail: detail || '', primary: 'OK' });
    }
    // The job just left, once every save of that leave has answered
    // (keepLeftCopy, before it lets the copy go): a save failed since, or one
    // was owed when the leave stopped waiting (a slow server). Said only when
    // the server is still missing something; the page's copy is then put
    // back to the server's.
    function leftUnsaved(jobId, kept) {
        if (!leftFailed.delete(jobId) || abandonedJob === jobId || leftNoticeFor === kept) return;
        const job = getActiveJobs().find(j => j.id === jobId);
        let body = null;
        try { body = job ? lastSaveBody(job, kept) : null; } catch (e) { body = null; }
        if (!body) return;
        leftNoticeFor = kept;
        let items = null;
        try { items = safeUnsaved(pageSnapshot(jobId, false)); } catch (e) { items = null; }
        putBackServerCopy(jobId, kept);
        leftSaveFailed(jobId, items && items.length ? notSavedWords(items, 'left').detail : '');
    }
    // The job list's status change failed: put back by its caller; a
    // replay after an outage (its caller gone) fetches the list again.
    function statusNotSaved(jobId, replay) {
        const job = getActiveJobs().find(j => j.id === jobId);
        lockBoxWhenFree({ title: (job && job.jobNumber ? 'Job ' + job.jobNumber : 'This job') + ': the status was not saved.',
            text: 'The server had a problem. Try again in a moment.', primary: 'OK' });
        if (replay) refreshJobs().then(() => { if (landingShowing()) loadJobs(); });
    }

    // ── Leaving a job with a save owed ──
    // Every press that leaves the job open for editing comes through here:
    // Home, Lock instructions (after its filing), Change user (after its
    // confirm and filing), New Work Order and Duplicate Job (before anything),
    // and opening another job. Nothing waiting, on its way or owed: go at
    // once, exactly as before. Otherwise the page takes no clicks or keys
    // while what is waiting is sent and answered (5 s at most); still owed,
    // it is sent once more; still owed, the box. opts.stays: the press does
    // not itself leave the job (New Work Order, Duplicate Job), so Leave
    // without saving leaves it first; opts.stopAfterLeave: and then does not
    // go on (Duplicate Job, which reads the job it leaves).
    let leaveBusy = false;
    function leaveJob(go, opts) {
        if (leaveBusy) return;
        const jobId = currentJobId;
        if (!jobId || isViewed(jobId)) { go(); return; }
        // The Signoff due editor commits a moment after it loses focus: its
        // change counts as made.
        if (_signoffCommit) { try { _signoffCommit(); } catch (e) { /* nothing */ } }
        if (!(savesPending > 0 || saveDebounceTimer || _persistJobTimer || troubleJob === jobId)) { go(); return; }
        leaveGuard(jobId, opts).then(how => {
            if (!how) { if (opts && opts.onStay) opts.onStay(); return; }
            if (how === 'left' && opts && opts.stays) {
                showNoJobState();
                if (opts.stopAfterLeave) return;
            }
            go();
        }, e => {
            // A mistake in here never keeps her on the job: she leaves as she
            // always did.
            console.error('leaveGuard failed:', e);
            if (currentJobId === jobId && !isViewed(jobId) && !lostBoxOpen) go();
        });
    }
    // 'go' (saved, or nothing owed, or a conflict whose box speaks), 'left'
    // (Leave without saving: the page's copy is the server's again), or
    // false (Stay, or something else took the job: its box speaks).
    async function leaveGuard(jobId, opts) {
        leaveBusy = true;
        const seq = openSeq;
        const pressAt = Date.now();
        const still = () => currentJobId === jobId && openSeq === seq && !isViewed(jobId) && !lostBoxOpen;
        const conflict = () => !!(conflictMark && conflictMark.jobId === jobId && conflictMark.at >= pressAt);
        coverPage(true);
        const slow = setTimeout(() => { if (leaveBusy) showToast(LEAVE_SLOW_WORDS); }, 700);
        try {
            for (let attempt = 1; attempt <= 2; attempt++) {
                if (attempt === 2) sendOwed(jobId, true);
                const settled = await leaveSettled(still);
                if (!still()) return false;
                // A conflict (the reload box): she leaves as Home always did,
                // and the box speaks over the job list.
                if (conflict()) return 'go';
                // Still on its way after 5 s (a slow server): she leaves; what
                // the server is still missing once the leave's saves have all
                // answered, a change owed before included, is named then
                // for the job just left (leftUnsaved).
                if (!settled) { if (troubleJob === jobId) leftFailed.add(jobId); return 'go'; }
                if (!owedNow(jobId)) return 'go';
            }
            // A box already up (one for another job) is answered first: the
            // leave box would otherwise replace it and answer it No.
            while (boxShowing('lockModal') || boxShowing('reloadModal')) {
                await new Promise(resolve => setTimeout(resolve, 250));
                if (!still()) return false;
            }
            if (!owedNow(jobId)) return 'go';
            coverPage(false);
            quietLeaveToast();
            let items = null;
            try { items = safeUnsaved(pageSnapshot(jobId, false)); } catch (e) { items = null; }
            const many = !!items && items.length > 1;
            const w = items && items.length ? notSavedWords(items, 'left') : { detail: '' };
            const answer = await lockBox({
                title: many ? 'Your last changes could not be saved.' : 'Your last change could not be saved.',
                text: 'Stay on this job and the app keeps trying. Leave without saving and ' + (many ? 'they are' : 'it is') + ' lost.',
                detail: w.detail, primary: 'Stay on this job', cancel: 'Leave without saving',
                escape: 'primary', replaced: null, graceMs: Date.now() - pressAt > 1000 ? 1500 : 0
            });
            if (answer !== false || !still()) return false;   // Stay, or replaced by a box that speaks
            abandonJob(jobId);
            return 'left';
        } finally {
            clearTimeout(slow);
            quietLeaveToast();
            coverPage(false);
            leaveBusy = false;
        }
    }
    const LEAVE_SLOW_WORDS = 'Saving...';
    function quietLeaveToast() {
        const t = document.getElementById('backupToast');
        if (t && t.textContent === LEAVE_SLOW_WORDS) t.classList.remove('visible');
    }
    // Sends what is waiting and waits for the queue: true once nothing is on
    // its way or waiting, false after 5 s or when the job stopped being hers.
    async function leaveSettled(still) {
        const until = Date.now() + 5000;
        for (let pass = 0; pass < 8; pass++) {
            if (saveDebounceTimer || _persistJobTimer) sendWaitingSaves({ stay: true });
            await savesSettled(Math.max(0, until - Date.now()));
            if (!still()) return false;
            if (savesPending === 0 && !saveDebounceTimer && !_persistJobTimer) return true;
            if (Date.now() >= until) return false;
        }
        return false;
    }
    // Leave without saving: what the server does not have is thrown away
    // here, before she leaves, so nothing can send it later.
    function abandonJob(jobId) {
        dropWaitingSaves();
        takeRetryEntries(jobId);
        putBackServerCopy(jobId, copyFor(jobId));
        clearSaveTrouble();
        abandonedJob = jobId;
    }
    // While Home waits for the saves, the page takes no clicks or keys: a
    // click meant for the job list would land on the work order still under
    // it. A box that comes up meanwhile (the lock's, the reload box) is above
    // the cover and takes its keys.
    function coverPage(on) {
        let cover = document.getElementById('leaveCover');
        if (on && !cover) {
            cover = document.createElement('div');
            cover.id = 'leaveCover';
            cover.className = 'leave-cover';
            document.body.appendChild(cover);
        }
        if (cover) cover.hidden = !on;
    }
    window.addEventListener('keydown', e => {
        if (!leaveBusy || boxShowing('lockModal') || boxShowing('reloadModal')) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);

    // The house in the nav bar. Pressed with the keys (a click with no mouse
    // behind it), the cursor then goes to the row of the job just left when it
    // is on the page showing, else back to the house; after Stay in the leave
    // box, back to the house too (the box had moved it to its own button). A
    // mouse click, or a call from code, as before (KEYBOARD_PLAN.md 2.2).
    function goHome(event) {
        const byKey = !!(event && event.detail === 0);
        const left = currentJobId;
        // Not while a box is up (the leave guard also answers false when the
        // job was taken over, and the lost box is then on the screen).
        const house = () => { if (!boxUp()) focusQuiet(document.querySelector('.nav-home-btn')); };
        leaveJob(() => {
            showNoJobState();
            if (byKey && !focusJobRow(left, 'row')) house();
        }, byKey ? { onStay: house } : undefined);
    }

    function openNewJobModal() {
        if (currentJobId && !isViewed(currentJobId)) { leaveJob(openNewJobModalNow, { stays: true }); return; }
        openNewJobModalNow();
    }
    function openNewJobModalNow() {
        if (getActiveJobs().length >= MAX_ACTIVE_JOBS) {
            alert(`Max ${MAX_ACTIVE_JOBS} active jobs. Please archive or delete one first.`);
            return;
        }
        populateComponentsSelect();
        populateAssigneeSelect('newAssignedToPrepress', 'prepress');
        populateAssigneeSelect('newAssignedToTechservices', 'techservices');
        rememberBoxOpener('newJobModal');
        document.getElementById('newJobModal').style.display = 'block';
        focusBoxField('newJobModal', 'jobNumber');
    }

    // Populate an <select> with a department's assignee roster.
    // Preserves the leading "Unassigned" option, optionally sets a current value.
    function populateAssigneeSelect(selectId, deptId, currentValue) {
        const sel = document.getElementById(selectId);
        if (!sel) return;
        const roster = getAssigneeNames(deptId).slice();
        // Kept as an option even when it is not on the active roster (someone
        // since deactivated), as the header's Assigned to box does: otherwise
        // Edit Job opens blank and any Save writes Unassigned over the name
        // (the after-rollout batch, item 4).
        if (currentValue && !roster.includes(currentValue)) roster.unshift(currentValue);
        sel.innerHTML = '<option value="">Unassigned</option>';
        roster.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
        });
        sel.value = currentValue || '';
    }

    // opts.created: Create opened the new job, whose own drawing places the
    // cursor (KEYBOARD_PLAN.md 2.5); otherwise it goes back to the opener.
    function closeNewJobModal(opts) {
        const wasOpen = document.getElementById('newJobModal').style.display === 'block';
        document.getElementById('newJobModal').style.display = 'none';
        document.getElementById('newJobForm').reset();
        // Clear component selections
        document.querySelectorAll('#componentsSelect .component-option').forEach(opt => {
            opt.classList.remove('selected');
            const cb = opt.querySelector('input[type="checkbox"]');
            if (cb) cb.checked = false;
        });
        // Reset duplicate state
        _pendingDuplicate = null;
        document.querySelector('#newJobModal h2').textContent = 'Create New Job';
        document.getElementById('componentsSelectGroup').style.display = '';
        giveBackBoxCursor('newJobModal', wasOpen && !(opts && opts.created));
    }

    async function createNewJob() {
        const jobs = getActiveJobs();
        const num = document.getElementById('jobNumber').value.trim();
        if (!num) { alert('Job number is required.'); return; }
        if (jobs.some(j => j.jobNumber.trim() === num)) { alert('Job number exists!'); return; }

        const now = new Date().toISOString();

        // Duplicate flow: use stashed components; otherwise build from picker
        let components;
        if (_pendingDuplicate) {
            components = _pendingDuplicate.components;
        } else {
            const selectedComponents = getSelectedComponents();
            components = [];
            if (selectedComponents.length > 0) {
                selectedComponents.forEach((name, idx) => {
                    components.push({
                        id: 'comp_' + Date.now() + '_' + idx,
                        name: name,
                        instructions_prepress: '',
                        instructions_techservices: '',
                        instructionsHistory_prepress: '',
                        instructionsHistory_techservices: '',
                        checkboxes: {},
                        notes: {}
                    });
                });
            } else {
                components.push({
                    id: 'comp_' + Date.now(),
                    name: 'Main',
                    instructions_prepress: '',
                    instructions_techservices: '',
                    instructionsHistory_prepress: '',
                    instructionsHistory_techservices: '',
                    checkboxes: {},
                    notes: {}
                });
            }
        }

        const newJob = {
            id: Date.now().toString(),
            jobNumber: num,
            jobDescription: document.getElementById('jobDescription').value,
            clientName: document.getElementById('clientName').value,
            csrName: document.getElementById('csrName').value,
            assignedToPrepress: document.getElementById('newAssignedToPrepress').value,
            signoffDueDatePrepress: document.getElementById('signoffDueDatePrepress').value,
            signoffDueTimePrepress: document.getElementById('signoffDueTimePrepress').value,
            assignedToTechservices: document.getElementById('newAssignedToTechservices').value,
            signoffDueDateTechservices: document.getElementById('signoffDueDateTechservices').value,
            signoffDueTimeTechservices: document.getElementById('signoffDueTimeTechservices').value,
            version: '',
            status: 'new',
            dateCreated: now,
            createdBy: getUserName(),
            lastModified: now,
            lastModifiedBy: getUserName(),
            duplicatedFrom: _pendingDuplicate ? _pendingDuplicate.duplicatedFrom : undefined,
            components: components,
            activeComponentId: components[0].id
        };

        _pendingDuplicate = null;

        try {
            // The page's headers: the server stamps who made the job from
            // X-STS-User, never from the body (STAMPS_AND_VERSION_PLAN.md).
            const res = await fetch('/api/jobs', {
                method: 'POST',
                headers: apiHeaders(),
                body: JSON.stringify(newJob)
            });
            if (!res.ok) throw new Error('Failed to create job');
            const data = await res.json();
            rowVersions[newJob.id] = data.rowVersion;
            newJob.rowVersion = data.rowVersion;
        } catch (e) {
            showErrorModal("Couldn't create this job. Server may be busy.", 'Close');
            return;
        }

        // Cache only: the create above saved the new job, and the job still
        // open here (New Work Order or Duplicate from a work order) did not
        // change. loadJob sends what that job had waiting. The list is read
        // again after the await, in case a Refresh replaced it meanwhile.
        const jobsNow = getActiveJobs();
        jobsNow.push(newJob);
        setJobsCacheOnly(jobsNow);
        closeNewJobModal({ created: true });
        loadJobs();
        loadJob(newJob.id);
    }

    function closeJobDropdown() {
        document.getElementById('jobSelectorDropdown').classList.remove('open');
        document.body.style.overflow = '';
    }

    function toggleJobDropdown() {
        const dd = document.getElementById('jobSelectorDropdown');
        dd.classList.toggle('open');
        document.body.style.overflow = dd.classList.contains('open') ? 'hidden' : '';
    }

    function toggleSelectAllJobs(e) {
        const isChecked = e.target.checked;
        document.querySelectorAll('#jobListContainer .job-checkbox').forEach(cb => {
            cb.checked = isChecked;
        });
        updateDeleteSelectedButton();
    }

    function updateSelectAllCheckbox() {
        const allCheckboxes = document.querySelectorAll('#jobListContainer .job-checkbox');
        const checkedBoxes = document.querySelectorAll('#jobListContainer .job-checkbox:checked');
        const selectAllCheckbox = document.getElementById('selectAllJobsCheckbox');

        if (allCheckboxes.length === 0) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        } else if (checkedBoxes.length === 0) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        } else if (checkedBoxes.length === allCheckboxes.length) {
            selectAllCheckbox.checked = true;
            selectAllCheckbox.indeterminate = false;
        } else {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = true;
        }
    }

    function updateDeleteSelectedButton() {
        const checkedCount = document.querySelectorAll('#jobListContainer .job-checkbox:checked').length;
        const btn = document.getElementById('deleteSelectedBtn');
        btn.textContent = `Delete Selected (${checkedCount})`;
        btn.disabled = checkedCount === 0;
    }

    // A job somebody else is editing cannot be archived or deleted from the
    // list (the server refuses it, 423). The bulk presses collect them and say
    // so once, by job number and name; a single press says so through
    // lockRefused's box.
    async function lockSkipped(res, jobId) {
        if (!res || res.status !== 423) return null;
        let info = {};
        try { info = await res.json(); } catch (e) { info = {}; }
        const job = getActiveJobs().find(j => j.id === jobId);
        return { jobNumber: job && job.jobNumber ? job.jobNumber : jobId, who: holderName(info) };
    }
    function lockSkippedBox(verb, skipped) {
        if (!skipped.length) return Promise.resolve(true);
        const lines = skipped.map(s => s.jobNumber + ' (' + s.who + ' is editing it)');
        return lockBox({ title: 'Not ' + verb + ': ' + lines.join(', ') + '.', text: 'Open a job to take it over.', primary: 'OK' });
    }

    async function deleteSingleJob(jobId) {
        if (!(await verifyAdminPassword())) return;
        if (!(await confirmWithQc('Permanently delete this job?', [jobId], QC_DELETE_LEAD, 'Delete'))) return;

        try {
            const res = await fetch('/api/jobs/' + jobId, { method: 'DELETE', headers: apiHeaders(jobId) });
            if (await refusedByLock(res, jobId)) return;
            if (!res.ok) throw new Error('Failed to delete job');
        } catch (e) {
            showErrorModal("Couldn't delete this job.", 'Refresh');
            return;
        }

        let jobs = getActiveJobs();
        const idx = jobs.findIndex(j => j.id === jobId);
        if (idx > -1) jobs.splice(idx, 1);
        saveActiveJobs(jobs);
        delete rowVersions[jobId];

        if (currentJobId === jobId) {
            currentJobId = null;
            showNoJobState();
        }

        loadJobs();
        if (jobs.length === 0) closeJobDropdown();
    }

    async function deleteSelectedJobs() {
        const checkboxes = document.querySelectorAll('#jobListContainer .job-checkbox:checked');
        if (checkboxes.length === 0) {
            alert('No jobs selected!');
            return;
        }

        if (!(await verifyAdminPassword())) return;
        const idsToDelete = Array.from(checkboxes).map(cb => cb.getAttribute('data-job-id'));
        if (!(await confirmWithQc(`Delete ${checkboxes.length} selected job(s)?`,
            idsToDelete, QC_DELETE_LEAD, 'Delete'))) return;

        const deletedIds = [];
        const skipped = [];

        // Delete from server -- track which ones actually succeeded
        for (const id of idsToDelete) {
            try {
                const res = await fetch('/api/jobs/' + id, { method: 'DELETE', headers: apiHeaders(id) });
                if (res.ok) {
                    delete rowVersions[id];
                    deletedIds.push(id);
                } else {
                    const s = await lockSkipped(res, id);
                    if (s) skipped.push(s);
                }
            } catch (e) { /* continue with others */ }
        }

        let jobs = getActiveJobs();
        if (currentJobId && deletedIds.includes(currentJobId)) {
            currentJobId = null;
            showNoJobState();
        }

        jobs = jobs.filter(j => !deletedIds.includes(j.id));
        saveActiveJobs(jobs);
        loadJobs();
        lockSkippedBox('deleted', skipped);

        if (deletedIds.length < idsToDelete.length) {
            showErrorModal((idsToDelete.length - deletedIds.length) + " job(s) couldn't be deleted.", 'Refresh');
        }

        if (jobs.length === 0) closeJobDropdown();
    }

    // ── Landing page table bulk actions ──

    function toggleTableSelectAll(checked) {
        document.querySelectorAll('#jobTableBody .table-row-check').forEach(cb => { cb.checked = checked; });
        updateBulkBar();
    }

    function updateBulkBar() {
        const checked = document.querySelectorAll('#jobTableBody .table-row-check:checked');
        const bar = document.getElementById('bulkActionBar');
        const countEl = document.getElementById('bulkCount');
        const selectAll = document.getElementById('tableSelectAll');
        const allBoxes = document.querySelectorAll('#jobTableBody .table-row-check');
        if (checked.length > 0) {
            bar.style.display = '';
            countEl.textContent = checked.length + ' selected';
        } else {
            bar.style.display = 'none';
        }
        if (selectAll) {
            selectAll.checked = allBoxes.length > 0 && checked.length === allBoxes.length;
            selectAll.indeterminate = checked.length > 0 && checked.length < allBoxes.length;
        }
    }

    function clearTableSelection() {
        document.querySelectorAll('#jobTableBody .table-row-check').forEach(cb => { cb.checked = false; });
        const selectAll = document.getElementById('tableSelectAll');
        if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
        updateBulkBar();
    }

    function getSelectedTableJobIds() {
        return Array.from(document.querySelectorAll('#jobTableBody .table-row-check:checked'))
            .map(cb => cb.getAttribute('data-job-id'));
    }

    async function bulkArchiveJobs() {
        const ids = getSelectedTableJobIds();
        if (ids.length === 0) return;
        if (!(await confirmWithQc('Archive ' + ids.length + ' job' + (ids.length > 1 ? 's' : '') + '?',
            ids, QC_ARCHIVE_LEAD, 'Archive'))) return;

        let failed = 0;
        const skipped = [];
        const waiting = [];
        const pressAt = Date.now();
        for (const id of ids) {
            try {
                // Behind this page's own saves: a job left with Home a moment
                // ago may still have its last changes on the way, and an
                // archived job refuses them (item 5). One of hers that has
                // not reached the server keeps the job as it is.
                const out = await archiveAfterSaves(id, false, pressAt);
                if (!out.res) {
                    failed++;
                    if (out.why === 'conflict' || out.why === 'queued' || out.why === 'unsaved') waiting.push(out.number.replace(/^Job /, ''));
                    continue;
                }
                const res = out.res;
                if (!res.ok) {
                    failed++;
                    const s = await lockSkipped(res, id);
                    if (s) skipped.push(s);
                }
            } catch (e) { failed++; }
            finally { if (archivingJobId === id) archivingJobId = null; }
        }
        if (waiting.length) {
            lockBoxWhenFree({ title: 'Not archived: ' + waiting.join(', ') + '.', text: 'A change of yours to ' + (waiting.length === 1 ? 'it' : 'them') + ' has not reached the server yet. Try again in a moment.', primary: 'OK' });
        }

        if (currentJobId && ids.includes(currentJobId)) {
            currentJobId = null;
            showNoJobState();
        }

        await refreshJobs();
        loadJobs();
        clearTableSelection();
        lockSkippedBox('archived', skipped);
        const ok = ids.length - failed;
        if (failed > 0) {
            showToast(ok + ' archived, ' + failed + ' failed');
        } else {
            showToast(ok + ' job' + (ok > 1 ? 's' : '') + ' archived');
        }
    }

    async function bulkDeleteJobs() {
        const ids = getSelectedTableJobIds();
        if (ids.length === 0) return;
        if (!(await verifyAdminPassword())) return;
        if (!(await confirmWithQc('Permanently delete ' + ids.length + ' job' + (ids.length > 1 ? 's' : '') + '?',
            ids, QC_DELETE_LEAD, 'Delete'))) return;

        let failed = 0;
        const skipped = [];
        for (const id of ids) {
            try {
                const res = await fetch('/api/jobs/' + id, { method: 'DELETE', headers: apiHeaders(id) });
                if (res.ok) {
                    delete rowVersions[id];
                } else {
                    failed++;
                    const s = await lockSkipped(res, id);
                    if (s) skipped.push(s);
                }
            } catch (e) { failed++; }
        }

        if (currentJobId && ids.includes(currentJobId)) {
            currentJobId = null;
            showNoJobState();
        }

        await refreshJobs();
        loadJobs();
        clearTableSelection();   // as bulkArchiveJobs does: the bar would keep a count for rows that are gone
        lockSkippedBox('deleted', skipped);
        const ok = ids.length - failed;
        if (failed > 0) {
            showToast(ok + ' deleted, ' + failed + ' failed');
        } else {
            showToast(ok + ' job' + (ok > 1 ? 's' : '') + ' deleted');
        }
    }

    // Files each piece's instructions into its revisions under a timestamp and
    // empties the live box. Called by the work order's X and by archiving, and
    // deliberately NOT when the page closes (see the beforeunload handler).
    function closeCurrentJob() {
        // A viewed archived job is never filed into: nothing may be written.
        if (!currentJobId || isViewed(currentJobId)) return;
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components) return;

        const timestamp = new Date().toLocaleString('en-US', {
            month: '2-digit',
            day: '2-digit',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });

        // Process ALL components, both departments. The active component's
        // active department pulls from the editor (might have unsaved text);
        // everything else comes from stored dept-keyed fields.
        //
        // Nothing is written for a component this pass did not change. Both
        // persistComponent and persistJob stamp lastModified and
        // lastModifiedBy with whoever is on the page, so writing an unchanged
        // component put the reader's name on the record: a work order last
        // touched by David.Marra read Brandilee.Czajkowski after she opened it
        // and looked (measured 2026-09-17). The work order is the audit record
        // that gets printed to the PDF for Midnight, so only a real change may
        // move that name (David, PHASE3_PLAN question 8).
        const DEPTS = ['prepress', 'techservices'];
        let filedAnything = false;
        job.components.forEach(comp => {
            // Safety: ensure dept-keyed fields exist
            migrateInstructionsToPerDept(comp);

            let filed = false;
            DEPTS.forEach(deptId => {
                const instrKey = 'instructions_' + deptId;
                const histKey = 'instructionsHistory_' + deptId;

                let instructionsToSave;
                if (comp.id === currentComponentId && deptId === activeDepartment) {
                    // Active component + active tab: take from the live editor,
                    // unless nobody touched it since it was loaded: then the
                    // stored words, as for every other piece (the editor's HTML
                    // is Quill's rewrite of them). Emptiness is still the
                    // editor's, as before.
                    instructionsToSave = !quill.getText().trim() ? ''
                        : editorUntouched(comp, deptId) ? comp[instrKey] : editorHtml();
                } else {
                    // Everything else: take from stored field
                    const textOnly = (comp[instrKey] || '').replace(/<[^>]*>/g, '').trim();
                    instructionsToSave = textOnly ? comp[instrKey] : '';
                }

                if (!instructionsToSave) return;

                const byUser = getUserName() ? ' by ' + getUserName() : '';
                const revCount = ((comp[histKey] || '').match(/history-timestamp/g) || []).length + 1;
                const newHistoryEntry = '<div class="history-divider">\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500</div><div class="history-timestamp"><strong>(' + revCount + ') Updated' + byUser + ': ' + timestamp + '</strong></div><div class="history-content">' + instructionsToSave.replace(/\n/g, '<br>') + '</div>';

                comp[histKey] = comp[histKey]
                    ? newHistoryEntry + comp[histKey]
                    : newHistoryEntry;

                // Clear current instructions for this dept
                comp[instrKey] = '';
                filed = true;
            });

            // Only a component whose instructions this pass actually filed.
            if (filed) {
                filedAnything = true;
                persistComponent(comp, job);
            }
        });

        // Update UI if we're still viewing this job
        if (currentComponentId) {
            const currentComp = job.components.find(c => c.id === currentComponentId);
            if (currentComp) {
                const history = currentComp['instructionsHistory_' + activeDepartment] || '';
                document.getElementById('instructionsHistory').innerHTML = cleanHtml(history);
                document.getElementById('instructionsDisplay').innerHTML = cleanHtml(history);
                quill.setContents([]);
            }
        }

        // Same rule for the job row: saveActiveJobs debounces a persistJob,
        // which stamps the name too.
        if (filedAnything) saveActiveJobs(jobs);
    }

    // ========== THE EDIT LOCK: a gate, not a warning (EDIT_LOCK_PLAN.md, 2026-09-28) ==========
    //
    // A job is held by one person at a time, by name; her tabs and browsers
    // are one holder. A page that opens a job somebody else holds gets the
    // read-only view (startLockView): the work order as it is on the server,
    // redrawn when it changes, one line naming the holder and how long since
    // her last save, a Take over button. The server refuses every change from
    // anyone but the holder (423), and this page never writes a viewed job
    // (isViewed), so a page opened before the lock was taken, a page that
    // slept, and a stale page cannot write either. The holder's page gives the
    // lock up after the idle time without typing or clicking (idleRelease) and
    // is told by name when somebody takes over (lockLost). The numbers come
    // from the server with every lock reply. QC Review takes no lock and is
    // untouched (David, 2026-09-28).
    let lockHeartbeatTimer = null;
    let lockHeartbeatPeriod = 0;
    let lockTiming = { heartbeatMs: 30000, timeoutMs: 180000, pollMs: 15000, idleMs: 20 * 60000 };
    // One id per page load: the server keeps one person's pages apart, so
    // Home in one tab never uncovers the tab she is typing in. No crypto:
    // plain HTTP has no secure context.
    const LOCK_PAGE_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    let holdsLock = false;        // this page holds the open job (a granted open or heartbeat, or no answer yet)
    let lockHeldSince = 0;        // the server's clock when this page took it: a takeover newer than this was of this page
    let serverClockOffset = 0;    // the server's now minus this page's, from the last lock reply
    let lastActivity = Date.now();
    let idleMinutesCap = null;    // ?idleMinutes= on the address (hand tests): only ever shorter than the server's
    let lockTickBusy = false;
    let lockRefusedMark = null;   // the last 423 seen: { jobId, at }
    let lockBoxResolve = null;

    function adoptLockTiming(reply) {
        if (!reply) return;
        if (reply.timing && Number(reply.timing.heartbeatMs) > 0) lockTiming = Object.assign({}, lockTiming, reply.timing);
        if (Number(reply.now) > 0) serverClockOffset = Number(reply.now) - Date.now();
    }
    function serverNow() { return Date.now() + serverClockOffset; }
    function idleMs() {
        const cap = idleMinutesCap > 0 ? idleMinutesCap * 60000 : Infinity;
        return Math.min(lockTiming.idleMs, cap);
    }
    function idleTimeText() {
        const m = idleMs() / 60000;
        if (m >= 1) { const n = Math.round(m); return n + (n === 1 ? ' minute' : ' minutes'); }
        const s = Math.round(m * 60);
        return s + (s === 1 ? ' second' : ' seconds');
    }
    // A person as a key, as the server compares (user-list.js userKey).
    function userKeyOf(raw) {
        return String(raw == null ? '' : raw).split('\\').pop().split('@')[0].trim().toLowerCase();
    }
    // ?idleMinutes=<n> on the address shortens the idle time for a hand test
    // (never lengthens it), is read before the address is cleaned, and is
    // taken out of the address bar so a reload does not keep it.
    (function readIdleMinutes() {
        try {
            const params = new URLSearchParams(window.location.search);
            const raw = params.get('idleMinutes');
            if (raw == null) return;
            const n = Number(raw);
            if (Number.isFinite(n) && n > 0) idleMinutesCap = n;
            params.delete('idleMinutes');
            const rest = params.toString();
            window.history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash);
        } catch (e) { /* an old browser: the default time */ }
    })();

    // The page's user on every work order write, encoded as review.js encodes
    // it; the page id only on a write for the job this page holds, so a page
    // that believes it holds the job puts the server's entry back after a
    // restart, and a write for any other job (the list, a replayed save) never
    // takes a lock.
    // X-STS-Writer on every write: this page's id, so the server knows which
    // page made a job's last change (its last save as the tab closes may carry
    // a version its own save still on its way has moved; item 6). It takes no
    // lock: that is X-STS-Page's.
    function apiHeaders(jobId) {
        const h = { 'Content-Type': 'application/json', 'X-STS-User': encodeURIComponent(getUserName() || ''), 'X-STS-Writer': LOCK_PAGE_ID };
        if (jobId && holdsLock && jobId === currentJobId && !isViewed(jobId)) h['X-STS-Page'] = LOCK_PAGE_ID;
        return h;
    }
    function lockBody(extra) {
        const display = (window.userPicker && typeof window.userPicker.display === 'function') ? window.userPicker.display() : '';
        return JSON.stringify(Object.assign({ user: getUserName(), display: display || '', page: LOCK_PAGE_ID }, extra || {}));
    }
    // One lock request. null when the server did not answer (unreachable, or
    // the time the open waits ran out); otherwise the reply's JSON with
    // { ok, status }.
    async function lockRequest(method, jobId, extra, options) {
        options = options || {};
        const ctrl = (options.timeoutMs && typeof AbortController === 'function') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), options.timeoutMs) : null;
        try {
            // A read carries this page's id when it holds the job, so the
            // server can say whether its own hold is intact (thisPage).
            const init = { method, headers: apiHeaders(method === 'GET' ? jobId : undefined) };
            if (method !== 'GET') init.body = lockBody(extra);
            if (options.keepalive) init.keepalive = true;
            if (ctrl) init.signal = ctrl.signal;
            const res = await fetch('/api/jobs/' + encodeURIComponent(jobId) + '/lock', init);
            let data = null;
            try { data = await res.json(); } catch (e) { data = null; }
            if (!res.ok) return Object.assign({ ok: false, status: res.status }, data || {});
            adoptLockTiming(data);
            return Object.assign({ ok: true, status: res.status }, data || {});
        } catch (e) {
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    // Take the lock, or learn who holds it. { takeOver: true } moves it. The
    // open waits 3 s at most: with no answer the job opens as it always did and
    // the first heartbeat settles it.
    function checkJobLock(jobId, extra) { return lockRequest('POST', jobId, extra, { timeoutMs: 3000 }); }
    function readJobLock(jobId) { return lockRequest('GET', jobId, null, { timeoutMs: 5000 }); }
    // Let this page's hold go now, keepalive so a closing tab's release goes
    // out. The reply says what the job is (free, hers from another page, or
    // somebody else's), which the idle release reads.
    function releaseJobLock(jobId) {
        if (!jobId || isViewed(jobId)) return Promise.resolve(null);
        holdsLock = false;
        return lockRequest('DELETE', jobId, null, { keepalive: true });
    }
    // Leaving a job for the list or another job: the saves it sent on the way
    // out land first, so the lock is not free while its last change is still
    // in flight (a colleague opening in that instant would see it refused).
    function releaseAfterSaves(jobId) {
        const wasHolding = holdsLock;
        holdsLock = false;
        if (!jobId || !wasHolding || isViewed(jobId)) return;
        savesSettled(2000).then(() => {
            // Not when this page has opened the same job again meanwhile (Home
            // and straight back): the release would take the page it has just
            // registered off the server's entry and leave the job free while
            // it is being edited.
            if (openingJobId === jobId || (currentJobId === jobId && holdsLock)) return;
            lockRequest('DELETE', jobId, null, { keepalive: true });
        });
    }

    function startLockHeartbeat(jobId) {
        stopLockHeartbeat();
        lockHeartbeatPeriod = lockTiming.heartbeatMs;
        lockHeartbeatTimer = setInterval(() => { lockTick(jobId); }, lockHeartbeatPeriod);
        catchUpTimer = setInterval(() => { catchUpNow(); }, lockTiming.pollMs);
    }
    function stopLockHeartbeat() {
        if (lockHeartbeatTimer) {
            clearInterval(lockHeartbeatTimer);
            lockHeartbeatTimer = null;
        }
        if (catchUpTimer) {
            clearInterval(catchUpTimer);
            catchUpTimer = null;
        }
        catchUpSeq++;
        catchUpWaiting = false;
        catchUpAfterTick = false;
        // No ask outlives the job it was for.
        catchUpFollowTimers.forEach(clearTimeout);
        catchUpFollowTimers = [];
        clearTimeout(catchUpWriteFollow); catchUpWriteFollow = null;
        clearTimeout(catchUpKeysTimer); catchUpKeysTimer = null;
        clearTimeout(catchUpRetryTimer); catchUpRetryTimer = null;
    }

    // ── Catching up with one's own other window (David, 2026-09-28, check 7:
    // "Catch up") ──
    //
    // Her tabs are one holder, so each can save; before this a tab never
    // picked up the other's saves, and its next change met "Job updated on the
    // server." and was lost on Reload job. An editing page now asks the server
    // when it comes back into view, when the window gets focus, at the first
    // pointer move over it after it lost focus, and every pollMs while it is
    // on screen, and redraws in place with the latest copy: never while she is
    // typing, while a change of hers is waiting, on its way or not saved, or
    // while a box or a form is open; only while this page's own hold never
    // lapsed (a lapse is the heartbeat's to handle, lockRetaken). One token,
    // checked after every await and in the one synchronous block that
    // redraws, keeps a late answer off a job she has left.
    let catchUpTimer = null;
    let catchUpBusy = false;
    let catchUpAgain = false;     // a trigger came while an ask was running: ask again after it
    let catchUpSeq = 0;
    let catchUpWaiting = false;   // held back by a press: asked again when it comes up
    let catchUpAfterTick = false; // held back by the heartbeat: asked again when it has answered
    let catchUpKeysTimer = null;
    let catchUpRetryTimer = null;
    let catchUpFollowTimers = [];
    let catchUpWriteFollow = null;  // one ask again after a write a moment ago, never a pile of them
    let lastCatchUpSoon = 0;
    let lastCatchUpToast = 0;
    let pointerIsDown = false;
    let dragging = false;
    let lastKeyAt = 0;
    let windowFocused = document.hasFocus ? document.hasFocus() : true;
    let lastMoveAsk = 0;

    function anyBoxOpen() {
        for (const m of document.querySelectorAll('.modal')) {
            if (getComputedStyle(m).display !== 'none') return true;
        }
        const review = document.getElementById('reviewModal');
        if (review && review.classList.contains('is-open')) return true;
        if (document.querySelector('.inline-edit-input, .inline-edit-select, .inline-edit-signoff, .component-tab-name-input, ' +
            '.version-picker.open, .quick-pick-menu.open, .status-popover.open, .ql-picker.ql-expanded')) return true;
        if (Array.from(document.querySelectorAll('.meeting-attendees-panel')).some(p => !p.hasAttribute('hidden'))) return true;
        return false;
    }
    // '' when the page may be redrawn now. 'beat', 'saves', 'press' and
    // 'keys' hold it back for a moment and ask again when they end
    // (holdCatchUp); 'box' and 'server' wait for the next poll or trigger;
    // 'state' means this page is not editing a job it holds.
    function catchUpBlock() {
        if (!currentJobId || !holdsLock || isViewed(currentJobId) || openingJobId || lostBoxOpen) return 'state';
        if (lockTickBusy) return 'beat';
        if (saveDebounceTimer || _persistJobTimer || savesPending > 0) return 'saves';
        if (_serverDown || _retryQueue.length) return 'server';
        if (anyBoxOpen()) return 'box';
        if (pointerIsDown || dragging) return 'press';
        if (Date.now() - lastKeyAt < 1500) return 'keys';
        return '';
    }
    function holdCatchUp(block) {
        if (block === 'press') catchUpWaiting = true;
        else if (block === 'beat') catchUpAfterTick = true;
        else if (block === 'keys') {
            clearTimeout(catchUpKeysTimer);
            catchUpKeysTimer = setTimeout(() => { catchUpNow(); }, Math.max(100, 1600 - (Date.now() - lastKeyAt)));
        } else if (block === 'saves' && !catchUpRetryTimer) {
            catchUpRetryTimer = setTimeout(() => { catchUpRetryTimer = null; catchUpNow(); }, 800);
        }
    }
    // Coming back to a tab or a window: ask now and twice more, so the other
    // window's last saves (its job-row save goes 600 ms after each piece
    // save) are not missed by one early ask (build review B1).
    function catchUpSoon() {
        // Visibility and focus often come together: one return, one set.
        if (Date.now() - lastCatchUpSoon < 300) return;
        lastCatchUpSoon = Date.now();
        catchUpFollowTimers.forEach(clearTimeout);
        catchUpFollowTimers = [300, 800, 1500, 4000].map(ms => setTimeout(() => { catchUpNow(); }, ms));
        catchUpNow();
    }
    // Anything on the page the server does not have (a save that failed with
    // a server error leaves it only here): never redrawn away.
    function pageDiffers(jobId) {
        let snap = null;
        try { snap = pageSnapshot(jobId, true); } catch (e) { return true; }
        const items = safeUnsaved(snap);
        return !items || items.length > 0;
    }
    async function catchUpNow() {
        if (catchUpBusy) { catchUpAgain = true; return; }
        if (document.visibilityState !== 'visible') return;
        const block = catchUpBlock();
        if (block) { holdCatchUp(block); return; }
        catchUpWaiting = false;
        const jobId = currentJobId;
        const t = { jobId, seq: openSeq, n: ++catchUpSeq, serial: saveSerial, version: rowVersions[jobId] };
        const same = () => t.jobId === currentJobId && t.seq === openSeq && t.n === catchUpSeq &&
            t.serial === saveSerial && rowVersions[t.jobId] === t.version && !catchUpBlock();
        // An ask that something got in the way of: a press, a key, the
        // heartbeat or a save of her own asks again when it ends (build review
        // B2); only another job, Home, a view or a newer ask drops it.
        const heldBack = () => {
            if (t.jobId !== currentJobId || t.seq !== openSeq || t.n !== catchUpSeq) return;
            const b = catchUpBlock();
            holdCatchUp(b || 'saves');
        };
        catchUpBusy = true;
        try {
            const l = await readJobLock(jobId);
            if (!l || !l.ok) return;
            if (!same()) { heldBack(); return; }
            // Archived from her other window (or the list): said now, when she
            // comes back to this one, not at the next heartbeat after her
            // first click has been refused (item 5).
            if (l.archived) { if (holdsLock && !isViewed(jobId)) lockGone(jobId, { archived: true }); return; }
            if (!(l.held && l.mine && l.thisPage && !l.archived)) return;
            // Her other window saved a moment ago: it may have more on the
            // way (the job-row save after every piece save), so ask again.
            if (l.lastWrite && Number(l.now) - Number(l.lastWrite) < 3000 && !catchUpWriteFollow) {
                catchUpWriteFollow = setTimeout(() => { catchUpWriteFollow = null; catchUpNow(); }, 1200);
            }
            if (!(Number(l.rowVersion) > Number(t.version))) return;
            if (pageDiffers(jobId)) return;
            const fresh = await fetchJobFresh(jobId);
            if (!fresh || !fresh.job) return;
            if (!same()) { heldBack(); return; }
            const job = fresh.job;
            if (job.archivedDate || !Array.isArray(job.components) || !job.components.length) return;
            if (!(Number(job.rowVersion) > Number(t.version))) return;
            if (pageDiffers(jobId)) return;
            catchUpRedraw(job);
        } finally {
            catchUpBusy = false;
            if (catchUpAgain) { catchUpAgain = false; setTimeout(() => { catchUpNow(); }, 0); }
        }
    }
    // The latest copy drawn in place of the editing page: her department, her
    // piece, the page's and the box's scroll, and the caret only where focus
    // already was. Never moves focus: Quill's setSelection focuses the box,
    // which is the "next Space types into the instructions" bug the Quill fix
    // removed (QUILL_LOOK_PLAN.md).
    function catchUpRedraw(job) {
        const pieceId = currentComponentId;
        const y = window.scrollY;
        const editorScroll = quill.root.scrollTop;
        const inBox = quill.hasFocus();
        const range = inBox ? quill.getSelection() : null;
        const contentBefore = inBox ? quill.getContents() : null;
        const active = document.activeElement;
        const note = active && active.classList && active.classList.contains('notes')
            ? { el: active, start: active.selectionStart, end: active.selectionEnd, dir: active.selectionDirection } : null;
        job.activeDepartment = activeDepartment;
        job.activeComponentId = job.components.some(c => c.id === pieceId) ? pieceId : job.components[0].id;
        adoptFreshJob(job);
        rememberSavedJob(job);
        currentComponentId = job.activeComponentId;
        // Snapshots from before the redraw would put the other window's
        // saves back with one Ctrl+Z and save that (EDIT_LOCK_PLAN 11.4 item 6).
        clearAllUndoStacks();
        editorLoads.clear();
        renderComponentTabs();
        loadComponentData();
        quill.root.scrollTop = editorScroll;
        window.scrollTo(0, y);
        if (inBox && range && currentComponentId === pieceId && quill.hasFocus()) {
            let index = range.index;
            let length = range.length;
            try {
                const moved = contentBefore.diff(quill.getContents());
                const end = moved.transformPosition(index + length);
                index = moved.transformPosition(index);
                length = Math.max(0, end - index);
            } catch (e) { /* the old place, clamped */ }
            const last = Math.max(0, quill.getLength() - 1);
            index = Math.min(index, last);
            length = Math.min(length, last - index);
            quill.setSelection(index, length, 'silent');
        }
        if (note && currentComponentId === pieceId && document.activeElement === note.el) {
            try {
                const n = note.el.value.length;
                note.el.setSelectionRange(Math.min(note.start, n), Math.min(note.end, n), note.dir || 'none');
            } catch (e) { /* a box that takes no selection */ }
        }
        fieldDirty = false;
        const focused = document.activeElement;
        focusSnapshot = focused && ((focused.classList && focused.classList.contains('notes')) || quill.root.contains(focused)) ? captureState() : null;
        updateUndoRedoButtons();
        // One toast in a while: with two windows side by side, this one can
        // catch up every couple of seconds while she types in the other.
        if (Date.now() - lastCatchUpToast > 8000) {
            lastCatchUpToast = Date.now();
            const mine = userKeyOf(job.lastModifiedBy) === userKeyOf(getUserName());
            showToast(mine ? 'Updated with the changes saved in your other window.' : 'Updated with the latest saved copy.');
        }
    }
    // One tick: the idle test first (idle means no heartbeat, a release whose
    // reply says what the job is now), then the PUT, whose reply is read. A
    // job archived or deleted under this page is never re-taken; a job held by
    // somebody else means this page lost it; "took" means this page's hold had
    // lapsed (a restart, a sleep), so its copy is checked against the server.
    async function lockTick(jobId) {
        if (lockTickBusy || jobId !== currentJobId || isViewed(jobId) || !holdsLock) return;
        lockTickBusy = true;
        try {
            // Never idle out while the server is unreachable or still owed
            // saves for this job: the view would orphan the retry queue's
            // changes (a viewed job is never written) and the banner would
            // then say they synced. Nobody is kept out by waiting: during an
            // outage nobody can take anything, the entry lapses on its own,
            // and the flush re-asks for the lock when the server is back.
            // A save the server failed and the page still owes counts the
            // same (David, 2026-10-07: the job stays hers while it is owed;
            // a colleague can Take over, and her page then names it).
            const owes = _serverDown || _retryQueue.some(e => e.jobId === jobId) || owedNow(jobId);
            if (!owes && Date.now() - lastActivity >= idleMs()) { await idleRelease(jobId); return; }
            const r = await lockRequest('PUT', jobId);
            if (!r || !r.ok || jobId !== currentJobId || isViewed(jobId) || !holdsLock) return;
            if (lockHeartbeatTimer && lockHeartbeatPeriod !== lockTiming.heartbeatMs) {
                const held = catchUpAfterTick;
                startLockHeartbeat(jobId);
                catchUpAfterTick = held;
            }
            if (r.gone) { await lockGone(jobId, r); return; }
            if (!r.held || !r.mine) { await lockLost(jobId, r, { heartbeat: true }); return; }
            if (r.took) await lockRetaken(jobId);
        } finally {
            lockTickBusy = false;
            // A catch-up that fell on the heartbeat asks now (the poll and the
            // heartbeat are due together every other poll: build review S1).
            if (catchUpAfterTick) { catchUpAfterTick = false; catchUpNow(); }
        }
    }

    // GET one job from the server: { status, job }, or null when it did not
    // answer (within timeoutMs, when given: a print waits at most that long).
    async function fetchJobFresh(jobId, timeoutMs) {
        const ctrl = (timeoutMs && typeof AbortController === 'function') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
        try {
            const res = await fetch('/api/jobs/' + encodeURIComponent(jobId), ctrl ? { cache: 'no-store', signal: ctrl.signal } : { cache: 'no-store' });
            if (res.status === 404) return { status: 404, job: null };
            if (!res.ok) return null;
            const job = await res.json();
            return job && job.id ? { status: 200, job } : null;
        } catch (e) {
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    // The fresh copy takes the list's place, so the work order and its saves
    // start from the server's latest row and version (a list copy is older
    // than the holder's last save whenever a job was held).
    function adoptFreshJob(job) {
        if (!job || !job.id) return;
        forgetLeftCopy(job.id);
        const jobs = getActiveJobs().slice();
        const i = jobs.findIndex(j => j.id === job.id);
        if (i >= 0) jobs[i] = job; else jobs.push(job);
        if (job.rowVersion) rowVersions[job.id] = job.rowVersion;
        setJobsCacheOnly(jobs);
    }

    // ── What was not saved (EDIT_LOCK_PLAN 11.5 A; David, 2026-09-28: the box
    // says WHAT was not saved, typed words in quotes, a switch by its label, a
    // note by its label and value) ──
    //
    // pageSnapshot is taken first, before anything is dropped or closed: the
    // page's copy of the job with the screen read into the open piece the way
    // saveComponentState reads it, the editor's content and what Quill loaded.
    // unsavedItems compares it with what the server has (copyFor) only once
    // the saves on their way have landed or been refused, so a save that
    // landed drops out and a refused one stays. Each item says whether it is
    // still on screen: the view keeps the page's own copy until OK, but a box
    // that had to be closed, and a refused add or delete, are gone.
    const DEPT_WORDS = { prepress: 'Prepress', techservices: 'Tech Services' };
    const ROW_WORDS = [
        ['clientName', 'Customer'], ['jobDescription', 'Project'], ['csrName', 'CSR'],
        ['assignedToPrepress', 'Assigned to (Prepress)'], ['assignedToTechservices', 'Assigned to (Tech Services)']
    ];
    const EDIT_JOB_WORDS = [
        ['editJobDescription', 'jobDescription', 'Project Name'], ['editClientName', 'clientName', 'Client Name'],
        ['editCSRName', 'csrName', 'CSR Name'], ['editAssignedToPrepress', 'assignedToPrepress', 'Assigned to (Prepress)'],
        ['editAssignedToTechservices', 'assignedToTechservices', 'Assigned to (Tech Services)']
    ];
    let lostBoxOpen = false;   // the lost box is up: nothing redraws the page under it until OK
    let lastFiling = null;     // { jobId, press }: which press last filed the words into the Revisions
    let leftNoticeFor = null;  // the leftCopy a refusal after leaving has already been told about

    function pageSnapshot(jobId, readScreen) {
        const job = getActiveJobs().find(j => j.id === jobId);
        if (!job || !Array.isArray(job.components)) return null;
        const copy = deepCopy(job);
        let editor = null;
        if (readScreen && jobId === currentJobId && !isViewed(jobId) && currentComponentId) {
            const live = job.components.find(c => c.id === currentComponentId);
            const comp = copy.components.find(c => c.id === currentComponentId);
            if (live && comp) {
                comp.checkboxes = comp.checkboxes || {};
                comp.notes = comp.notes || {};
                if (!editorUntouched(live, activeDepartment)) comp['instructions_' + activeDepartment] = quill.getText().trim() ? editorHtml() : '';
                document.querySelectorAll('.field-row .toggle-switch input[type="checkbox"]').forEach(cb => {
                    const id = cb.getAttribute('data-id');
                    if (id) comp.checkboxes[id] = cb.checked;
                });
                document.querySelectorAll('.notes').forEach(inp => {
                    const id = inp.getAttribute('data-id');
                    if (id) comp.notes[id] = inp.value;
                });
                const load = editorLoads.get(jobId + '|' + live.id + '|' + activeDepartment);
                editor = { pieceId: live.id, dept: activeDepartment, content: quill.getContents(), load: load ? { stored: load.stored, content: load.content } : null };
            }
        }
        return { jobId, job: copy, editor, boxes: [], refused: [] };
    }

    // Words as the item quotes them: one line, pictures named, about 50
    // characters.
    function quoteWords(s, max) {
        max = max || 50;
        let t = String(s == null ? '' : s).replace(/￼/g, '[picture]').replace(/\s*\n\s*/g, ' / ').replace(/\s+/g, ' ').trim();
        if (t.length > max) {
            t = t.slice(0, max - 3);
            if (/\s/.test(t)) t = t.replace(/\s+\S*$/, '');
            t += '...';
        }
        return '"' + t + '"';
    }
    function plainValue(v) {
        const s = v == null ? '' : String(v);
        return s.trim() === '' ? '' : s;
    }
    function deltaText(delta) {
        return ((delta && delta.ops) || []).map(op => typeof op.insert === 'string' ? op.insert : '￼').join('');
    }
    // Quill's own reading of stored words, through the hidden editor (the same
    // TABLE matcher as the visible one), so both sides of a compare went
    // through the same rewrite.
    function storedDelta(html) {
        return summaryScratch().clipboard.convert({ html: instructionsAsHtml(html || ''), text: '' });
    }
    // The rewrites Quill does not keep stable across loads: spaces and Tabs
    // run together, a space at the start or end of a line, blank lines at the end.
    function evenSpaces(t) {
        return String(t || '').replace(/[ \t]/g, ' ').split('\n').map(l => l.replace(/ {2,}/g, ' ').trim()).join('\n').replace(/\n+$/, '');
    }
    // One department's words on one piece: what changed, as the item says it.
    function wordsChange(snap, piece, dept, before, after) {
        let a, b, same;
        const e = snap.editor;
        if (e && e.pieceId === piece.id && e.dept === dept && e.load && e.load.stored === before) {
            // The open box against what Quill loaded: only her edits differ.
            a = deltaText(e.load.content);
            b = deltaText(e.content);
            same = e.load.content.diff(e.content).ops.length === 0;
        } else {
            const da = storedDelta(before);
            const db = storedDelta(after);
            a = deltaText(da);
            b = deltaText(db);
            same = da.diff(db).ops.length === 0;
        }
        if (same) return null;
        a = evenSpaces(a);
        b = evenSpaces(b);
        if (a === b) return { kind: 'format' };
        if (a.replace(/\s+/g, ' ') === b.replace(/\s+/g, ' ')) return { kind: 'lines' };
        // Cut word by word, not letter by letter: a letter shared with the
        // next word used to pull that word into the quote ("a big box" to "a
        // box" read as "box" typed in place of "big box"; build review A-4).
        const wa = a.split(/(\s+)/);
        const wb = b.split(/(\s+)/);
        let i = 0;
        while (i < wa.length && i < wb.length && wa[i] === wb[i]) i++;
        let j = 0;
        while (j < wa.length - i && j < wb.length - i && wa[wa.length - 1 - j] === wb[wb.length - 1 - j]) j++;
        const ins = wb.slice(i, wb.length - j).join('').trim();
        const del = wa.slice(i, wa.length - j).join('').trim();
        if (/\u2500\u2500/.test(ins + del)) return { kind: 'summary' };
        // A change inside the summary block (Generate run again): more start
        // lines than end lines before the cut.
        const d = (window.DEPT_REGISTRY || {})[dept] || {};
        if (d.summaryMarkerStart && d.summaryMarkerEnd) {
            const before = wb.slice(0, i).join('');
            const count = m => before.split(m.trim()).length - 1;
            if (count(d.summaryMarkerStart) > count(d.summaryMarkerEnd)) return { kind: 'summary' };
        }
        if (!ins && !del) return { kind: 'format' };
        if (ins && !del) return { kind: 'typed', ins };
        if (del && !ins) return { kind: 'deleted', del };
        return { kind: 'replaced', ins, del };
    }
    // The label on the page for each switch and note, by data-id: the row's
    // own words, with the department when both panels use the same words.
    function fieldLabels() {
        const out = new Map();
        const counts = {};
        const depts = Object.entries(window.DEPT_REGISTRY || {});
        document.querySelectorAll('.dept-checklist .field-row').forEach(row => {
            const labelEl = row.querySelector('.field-label');
            if (!labelEl) return;
            const clone = labelEl.cloneNode(true);
            clone.querySelectorAll('.meeting-icon').forEach(n => n.remove());
            const label = clone.textContent.replace(/\s+/g, ' ').trim();
            if (!label) return;
            const panel = row.closest('.dept-checklist');
            const found = depts.find(([, d]) => panel && d.panelId === panel.id);
            counts[label] = (counts[label] || 0) + 1;
            row.querySelectorAll('.toggle-switch input[data-id], .notes[data-id]').forEach(el => {
                out.set(el.getAttribute('data-id'), { row, label, dept: found ? found[0] : '' });
            });
        });
        out.forEach(f => { if (counts[f.label] > 1 && DEPT_WORDS[f.dept]) f.label += ' (' + DEPT_WORDS[f.dept] + ')'; });
        const attendees = out.get('ts_cb90_attendees');
        if (attendees) out.set('ts_cb90_attendees', Object.assign({}, attendees, { label: 'Meeting attendees', own: true }));
        return out;
    }
    function signoffWords(date, time) {
        const d = date ? new Date(date + 'T00:00:00') : null;
        const day = d && !isNaN(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : (date || '');
        return [day, time || ''].filter(Boolean).join(', ');
    }
    // What the snapshot holds that the server does not: { text, kind }, kind
    // 'screen' (still drawn until OK), 'box' (a box that had to be closed) or
    // 'request' (an add or delete the lock refused), with pieceId (a piece's
    // change; newPiece when the piece itself is not on the server) or row (the
    // job row's), so a print can send those again. null when there is no copy
    // of what the server has to compare with.
    function unsavedItems(snap) {
        const saved = snap && copyFor(snap.jobId);
        if (!saved) return null;
        const items = [];
        const job = snap.job;
        const many = job.components.length > 1;
        const on = name => many ? ' (' + name + ')' : '';
        const labels = fieldLabels();
        job.components.forEach(p => {
            const base = saved.pieces[p.id];
            if (!base) { items.push({ text: 'new piece ' + quoteWords(p.name || ''), kind: 'screen', pieceId: p.id, newPiece: true }); return; }
            ['prepress', 'techservices'].forEach(dept => {
                const histKey = 'instructionsHistory_' + dept;
                if ((p[histKey] || '') !== (base[histKey] || '')) {
                    // Filed into the Revisions by a press the lock refused:
                    // named by that press (Lock instructions, Archive,
                    // Change user), and the words stay live on the job.
                    const press = (lastFiling && lastFiling.jobId === snap.jobId) ? lastFiling.press : 'Lock instructions';
                    items.push({ text: press + ': the ' + DEPT_WORDS[dept] + ' words were not moved into the Revisions' + on(p.name), kind: 'screen', pieceId: p.id });
                    return;
                }
                const key = 'instructions_' + dept;
                if ((p[key] || '') === (base[key] || '')) return;
                const ch = wordsChange(snap, p, dept, base[key] || '', p[key] || '');
                if (!ch) return;
                const where = ' the ' + DEPT_WORDS[dept] + ' instructions' + on(p.name);
                let text;
                if (ch.kind === 'typed') text = quoteWords(ch.ins) + ' typed in' + where;
                else if (ch.kind === 'deleted') text = quoteWords(ch.del) + ' deleted from' + where;
                else if (ch.kind === 'replaced') text = quoteWords(ch.ins, 30) + ' typed in place of ' + quoteWords(ch.del, 30) + ' in' + where;
                else if (ch.kind === 'summary') text = 'the summary from Generate in' + where;
                else if (ch.kind === 'lines') text = 'line breaks changed in' + where;
                else text = 'formatting or a picture changed in' + where;
                items.push({ text, kind: 'screen', pieceId: p.id });
            });
            // A row's switch and note are one item ("Press: "Canon"").
            const rows = new Map();
            const cur = { checkboxes: p.checkboxes || {}, notes: p.notes || {} };
            const was = { checkboxes: base.checkboxes || {}, notes: base.notes || {} };
            const change = id => {
                const f = labels.get(id);
                if (!f) return null;   // nothing on the page carries it (the summary fingerprints)
                const key = f.own ? id : f.row;
                if (!rows.has(key)) rows.set(key, { label: f.label, sw: null, note: null });
                return rows.get(key);
            };
            new Set(Object.keys(cur.checkboxes).concat(Object.keys(was.checkboxes))).forEach(id => {
                if (!!cur.checkboxes[id] === !!was.checkboxes[id]) return;
                const r = change(id);
                if (r) r.sw = !!cur.checkboxes[id];
            });
            new Set(Object.keys(cur.notes).concat(Object.keys(was.notes))).forEach(id => {
                if (plainValue(cur.notes[id]) === plainValue(was.notes[id])) return;
                const r = change(id);
                if (r) r.note = plainValue(cur.notes[id]);
            });
            rows.forEach(r => {
                let text;
                if (r.note) text = r.label + ': ' + quoteWords(r.note);
                else if (r.note === '' && r.sw === false) text = r.label + ' switched off';
                else if (r.sw !== null) text = r.label + ' switched ' + (r.sw ? 'on' : 'off') + (r.note === '' ? ', emptied' : '');
                else text = r.label + ' emptied';
                items.push({ text: text + on(p.name), kind: 'screen', pieceId: p.id });
            });
            if ((p.name || '') !== (base.name || '')) items.push({ text: (base.name || 'A piece') + ' renamed ' + quoteWords(p.name || ''), kind: 'screen', pieceId: p.id });
            if ((p.version || '') !== (base.version || '')) items.push({ text: (p.version ? 'Version ' + p.version : 'Version cleared') + on(p.name), kind: 'screen', pieceId: p.id });
        });
        const row = saved.row || {};
        ROW_WORDS.forEach(([key, label]) => {
            const now = String(job[key] == null ? '' : job[key]).trim();
            if (now === String(row[key] == null ? '' : row[key]).trim()) return;
            items.push({ text: now ? label + ': ' + quoteWords(now) : label + ' emptied', kind: 'screen', row: true });
        });
        ['prepress', 'techservices'].forEach(dept => {
            const suffix = dept === 'techservices' ? 'Techservices' : 'Prepress';
            const dk = 'signoffDueDate' + suffix, tk = 'signoffDueTime' + suffix;
            const d = String(job[dk] || '').trim(), t = String(job[tk] || '').trim();
            if (d === String(row[dk] || '').trim() && t === String(row[tk] || '').trim()) return;
            items.push({ text: 'Signoff due (' + DEPT_WORDS[dept] + ')' + ((d || t) ? ': ' + signoffWords(d, t) : ' cleared'), kind: 'screen', row: true });
        });
        if ((job.status || '') !== (row.status || '')) {
            const s = STATUS_MAP[job.status];
            items.push({ text: 'Status: ' + (s ? s.label : job.status), kind: 'screen', row: true });
        }
        // The job's record of a component deleted (its deletion log, saved
        // with the job row): the component is gone from the server already,
        // the line about it is not (SAVE_FAILURE_PLAN.md).
        const logged = new Set((Array.isArray(row.deletionLog) ? row.deletionLog : []).map(e => JSON.stringify(e)));
        (Array.isArray(job.deletionLog) ? job.deletionLog : []).forEach(e => {
            if (!logged.has(JSON.stringify(e))) items.push({ text: 'the note that ' + quoteWords((e && e.component) || '') + ' was deleted', kind: 'request', row: true });
        });
        return items.concat(snap.refused || [], snap.boxes || []);
    }
    // The sentence and the list for the box. where: 'lost' (her words stay on
    // screen until OK), 'retaken' (the latest copy is already drawn), 'left'
    // (the job was left before the refusal came back).
    function notSavedWords(items, where) {
        const screen = items.filter(i => i.kind === 'screen');
        const boxes = items.filter(i => i.kind === 'box');
        const many = items.length > 1;
        let text;
        if (!items.length) text = 'Everything you changed before that was saved.';
        else if (where === 'lost' && screen.length === items.length) {
            text = many ? 'Your last changes were not saved. They are still on your screen until you press OK.'
                        : 'Your last change was not saved. It is still on your screen until you press OK.';
        } else if (where === 'lost' && boxes.length === items.length) {
            text = 'What you had typed in an open box was not saved. Everything before that was.';
        } else if (where === 'lost' && screen.length) {
            text = 'Your last changes were not saved. What is still on your screen stays there until you press OK.';
        } else text = many ? 'Your last changes were not saved.' : 'Your last change was not saved.';
        const marked = where === 'lost' && screen.length && boxes.length;
        const lines = items.map(i => i.text + (marked && i.kind === 'box' ? ' (in a box that closed)' : ''));
        let detail = '';
        if (lines.length === 1) detail = 'Not saved: ' + lines[0] + '.';
        else if (lines.length > 1) {
            detail = 'Not saved:\n' + lines.slice(0, 5).map(l => '- ' + l).join('\n') +
                (lines.length > 5 ? '\n- and ' + (lines.length - 5) + ((lines.length - 5) === 1 ? ' more change' : ' more changes') : '');
        }
        return { text, detail };
    }
    // The list for a snapshot, or null when it cannot be worked out: a
    // mistake in here must never stop the page turning read only.
    function safeUnsaved(snap) {
        try { return snap ? unsavedItems(snap) : null; } catch (e) { return null; }
    }

    // This page's hold had lapsed and the heartbeat took the job back. Nothing
    // to do while the row is as this page left it; when it moved, her copy is
    // stale, so the job is let go and she gets the view with the latest copy
    // and Start editing. The box names anything of hers that was not saved;
    // the latest copy is already drawn, so it never says "on your screen".
    async function lockRetaken(jobId) {
        const stoppedPrint = printChecking;
        const fresh = await fetchJobFresh(jobId);
        if (jobId !== currentJobId || isViewed(jobId) || !holdsLock) return;
        if (!fresh || !fresh.job) return;
        if (fresh.job.rowVersion === rowVersions[jobId]) return;
        let snap = null;
        try { snap = pageSnapshot(jobId, true); } catch (e) { snap = null; }
        stopLockHeartbeat();
        const waiting = !!(saveDebounceTimer || _persistJobTimer);
        dropWaitingSaves();
        const r = await releaseJobLock(jobId);
        if (jobId !== currentJobId || isViewed(jobId)) return;
        let boxes = [];
        try { boxes = closeEditorsForView(); } catch (e) { boxes = []; }
        adoptFreshJob(fresh.job);
        if (fresh.job.archivedDate) { showNoJobState(); viewArchivedJob(jobId, { quietIfGone: true }); return; }
        showLockView(fresh.job, { lock: (r && r.ok) ? r : null, keepScroll: true, keepPlace: true });
        await savesSettled(3000);
        if (snap) { snap.boxes = boxes; snap.refused = takeRefused(jobId); }
        const items = safeUnsaved(snap);
        let text = '';
        let detail = '';
        if (items && items.length) { const w = notSavedWords(items, 'retaken'); text = w.text; detail = w.detail; }
        else if (!items && waiting) text = 'Your last change was not saved.';
        if (r && r.ok && !r.held) text += (text ? ' ' : '') + 'Press Start editing to carry on with the latest copy.';
        if (stoppedPrint) text += (text ? ' ' : '') + PRINT_STOPPED;
        lockBox({ title: 'This job was changed while your page was away.', text, detail, primary: 'OK', graceMs: 1500 });
    }

    // The job was archived or deleted under this page (her other window, the
    // job list): nothing more can be saved into it.
    // Since item 5 the server refuses every change to an archived job, so what
    // was waiting is never sent and the box names what the server does not
    // have, as the lost box does (it used to drop the typing without a word).
    // The wall goes up at once with her words still on screen; OK goes to the
    // job list, as before. One box a job: a second refusal, the heartbeat or a
    // print finding it too while the box is up, adds nothing.
    let goneBoxFor = null;
    async function lockGone(jobId, r) {
        r = r || {};
        if (goneBoxFor === jobId || (archivingJobId === jobId && !r.refused)) return;
        goneBoxFor = jobId;
        const stoppedPrint = printChecking;
        const archived = !!r.archived;
        const editing = jobId === currentJobId && !isViewed(jobId);
        let snap = null;
        if (editing) { try { snap = pageSnapshot(jobId, true); } catch (e) { snap = null; } }
        stopLockHeartbeat();
        holdsLock = false;
        const waiting = !!(saveDebounceTimer || _persistJobTimer);
        dropWaitingSaves();
        let viewing = false;
        try {
            let boxes = [];
            const job = editing ? getActiveJobs().find(j => j.id === jobId) : null;
            if (job && Array.isArray(job.components) && job.components.length) {
                try { boxes = closeEditorsForView(); } catch (e) { boxes = []; }
                enterView(job, archived ? 'archived' : 'locked');
                viewing = true;
                lostBoxOpen = true;
                viewLock = null;
                viewNotice = archived ? '' : 'deleted';
                renderComponentTabs();
                renderViewLine();
                // The saves already on their way land or are refused first, so
                // the list names only what the server does not have.
                await savesSettled(5000);
            }
            const queued = takeRetryEntries(jobId);
            if (snap) { snap.boxes = boxes; snap.refused = takeRefused(jobId); }
            const items = editing ? safeUnsaved(snap) : [];
            let text = archived ? 'It is in the Archived list.' : '';
            let detail = '';
            if (items && items.length) {
                const w = notSavedWords(items, 'lost');
                text += (text ? ' ' : '') + w.text;
                detail = w.detail;
            } else if (!items && (waiting || r.refused)) text += (text ? ' ' : '') + 'Your last change was not saved.';
            if (queued) text += (text ? ' ' : '') + queued + (queued === 1 ? ' change' : ' changes') + ' made while the server was unreachable ' + (queued === 1 ? 'was' : 'were') + ' not saved.';
            if (stoppedPrint) text += (text ? ' ' : '') + PRINT_STOPPED;
            // Her next Enter or Space must not press OK for her while her
            // words are still on screen.
            await lockBox({ title: archived ? 'This job was archived.' : 'This job was deleted.', text, detail, primary: 'OK', graceMs: 1500 });
        } finally {
            goneBoxFor = null;
            if (viewing) lostBoxOpen = false;
        }
        if (jobId !== currentJobId || (isViewed(jobId) && !viewing)) return;
        setJobsCacheOnly(getActiveJobs().filter(j => j.id !== jobId));
        showNoJobState();
        refreshJobs().then(() => { if (landingShowing()) loadJobs(); });
    }

    // Somebody else holds the job this page was editing: a takeover, or a
    // page whose hold lapsed while another person opened the job. The page
    // turns read only at once with her words still on screen (the wall is up,
    // every control that changes the job is hidden), the box says who and
    // whether her last change was saved, and OK draws the latest copy.
    async function lockLost(jobId, facts, opts) {
        opts = opts || {};
        facts = facts || {};
        // Read now: the print that found this has ended by the time the box's
        // words are put together below.
        const stoppedPrint = printChecking;
        if (jobId !== currentJobId) return;
        if (isViewed(jobId)) {
            if (facts.held !== undefined) { viewLock = facts; renderViewLine(); }
            return;
        }
        // What the page holds, read before anything is dropped or closed.
        let snap = null;
        try { snap = pageSnapshot(jobId, true); } catch (e) { snap = null; }
        stopLockHeartbeat();
        holdsLock = false;
        const waiting = !!(saveDebounceTimer || _persistJobTimer);
        dropWaitingSaves();
        const job = getActiveJobs().find(j => j.id === jobId);
        if (!job) return;
        let boxes = [];
        try { boxes = closeEditorsForView(); } catch (e) { boxes = []; }
        // Nothing redraws the page under the box until OK: it says her words
        // are still on screen (a visibility flip used to poll and redraw the
        // holder's copy under it, EDIT_LOCK_PLAN 11.4 item 5).
        lostBoxOpen = true;
        try {
            enterView(job, 'locked');
            viewCopyUnchecked = true;
            // The piece tabs lose their x, + and rename now, not only at OK:
            // they draw from the same copy, so her words stay (build review S5).
            renderComponentTabs();
            viewLock = facts.held !== undefined ? facts : null;
            viewNotice = '';
            renderViewLine();
            // The saves already on their way land or are refused first (the
            // wall is up, so none joins the queue now): the list then names
            // only what the server does not have.
            await savesSettled(5000);
            const refused = !!opts.refused || lockRefusedSeen(jobId);
            const queued = takeRetryEntries(jobId);
            if (snap) { snap.boxes = boxes; snap.refused = takeRefused(jobId); }
            const items = safeUnsaved(snap);
            const tookOver = !!(facts.takenFromKey && facts.takenFromKey === userKeyOf(getUserName()) && facts.takenAt && facts.takenAt > lockHeldSince);
            const who = holderName(facts);
            const title = tookOver ? who + ' took over this job at ' + clockText(facts.takenAt) + '.' : who + ' is editing this job.';
            let text;
            let detail = '';
            if (items) {
                const w = notSavedWords(items, 'lost');
                text = w.text;
                detail = w.detail;
            } else if (waiting || refused) text = 'Your last change was not saved. It is still on your screen until you press OK.';
            else if (boxes.length) text = 'What you had typed in an open box was not saved. Everything before that was.';
            else text = 'Everything you changed before that was saved.';
            if (queued) text += ' ' + queued + (queued === 1 ? ' change' : ' changes') + ' made while the server was unreachable ' + (queued === 1 ? 'was' : 'were') + ' not saved.';
            // Found while a print was being checked (a refusal of its own
            // save, its own ask, a heartbeat meanwhile): the box is what she
            // got instead of the print.
            if (stoppedPrint) text += ' ' + PRINT_STOPPED;
            // The box did not follow her own click: her next Enter or Space must
            // not press OK for her while her words are still on screen.
            await lockBox({ title, text, detail, primary: 'OK', graceMs: 1500 });
        } finally {
            lostBoxOpen = false;
        }
        if (jobId !== currentJobId || !isViewed(jobId)) return;
        const fresh = await fetchJobFresh(jobId);
        if (jobId !== currentJobId || !isViewed(jobId)) return;
        const offList = () => setJobsCacheOnly(getActiveJobs().filter(j => j.id !== jobId));
        if (fresh && fresh.status === 404) { offList(); viewNotice = 'deleted'; viewLock = null; renderViewLine(); return; }
        if (fresh && fresh.job) {
            if (fresh.job.archivedDate) { offList(); viewedJob = fresh.job; becomeArchivedView(); return; }
            redrawView(fresh.job);
        }
        startViewPoll(jobId);
        viewPollNow(jobId, viewPollSeq);
    }
    function holderName(facts) {
        return (facts && (facts.byDisplay || facts.lockedByDisplay || facts.by || facts.lockedBy)) || 'Someone';
    }
    function clockText(ms) {
        const d = new Date(Number(ms) || Date.now());
        return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    function lockRefusedSeen(jobId) {
        return !!(lockRefusedMark && lockRefusedMark.jobId === jobId && Date.now() - lockRefusedMark.at < 5000);
    }

    // A 423 from any write: somebody else holds the job. The open job goes to
    // the lost path; a job that is not open (the list's status change, a
    // replayed save) gets the one-line box.
    function lockRefused(jobId, info) {
        info = info || {};
        lockRefusedMark = { jobId, at: Date.now() };
        if (jobId === currentJobId && !isViewed(jobId)) { lockLost(jobId, info, { refused: true }); return; }
        if (jobId === currentJobId && isViewed(jobId)) {
            // Not while the lost box is still gathering its list: a refused
            // archive can arrive after the first refusal turned the page read
            // only, and belongs in that box.
            if (!lostBoxOpen) takeRefused(jobId);
            if (info.held !== undefined) { viewLock = info; renderViewLine(); }
            return;
        }
        const job = getActiveJobs().find(j => j.id === jobId);
        if (!leftRefusal(jobId, info, job)) {
            lockBox({ title: holderName(info) + ' is editing ' + (job && job.jobNumber ? 'job ' + job.jobNumber : 'this job') + '.', text: 'Open it to take over, or wait until they have finished.', primary: 'OK', graceMs: 1500 });
        }
        refreshJobs().then(() => { if (landingShowing()) loadJobs(); });
    }
    // A save for the job this page has just left (Home, the X, Lock
    // instructions, another job) refused because somebody took it over before
    // this page heard: the box says who and what was not saved, once per
    // leave. Nothing is on screen any more, so it never says so. True when it
    // told her.
    function leftRefusal(jobId, info, job) {
        if (!leftCopy || leftCopy.jobId !== jobId) return false;
        if (leftNoticeFor === leftCopy) return true;
        let snap = null;
        try { snap = pageSnapshot(jobId, false); } catch (e) { snap = null; }
        if (snap) snap.refused = takeRefused(jobId);
        const items = safeUnsaved(snap);
        if (!items || !items.length) return false;
        leftNoticeFor = leftCopy;
        const tookOver = !!(info.takenFromKey && info.takenFromKey === userKeyOf(getUserName()) && info.takenAt && info.takenAt > lockHeldSince);
        const number = job && job.jobNumber ? 'job ' + job.jobNumber : 'this job';
        const w = notSavedWords(items, 'left');
        lockBox({ title: holderName(info) + (tookOver ? ' took over ' + number + ' at ' + clockText(info.takenAt) + '.' : ' is editing ' + number + '.'),
            text: w.text, detail: w.detail, primary: 'OK', graceMs: 1500 });
        return true;
    }
    // For the direct writes (archive, delete, import): true when the reply was
    // a 423, after telling the person.
    async function refusedByLock(res, jobId) {
        if (!res || res.status !== 423) return false;
        let info = {};
        try { info = await res.json(); } catch (e) { info = {}; }
        lockRefused(jobId, info);
        return true;
    }

    // ── An archived job refuses changes (item 5, ARCHIVED_WRITES_PLAN.md) ──
    // The server answers 410 to any change to an archived job: her own other
    // window before it heard, a job list loaded before the archive, a replayed
    // save. what: an add or a delete, named in the box as the lock's are.
    // True when the reply was a 410, after telling the person.
    async function refusedByArchive(res, jobId, what) {
        if (!res || res.status !== 410) return false;
        if (what) recordRefused(jobId, what);
        archivedRefused(jobId);
        return true;
    }
    // The 410's counterpart of lockRefused. The open job goes to lockGone,
    // which names what was not saved; the job just left gets one box naming
    // it; any other job (the list's status change, a replay) one line, and the
    // list is fetched again so the job leaves it. Several refusals of one job
    // give one box.
    let archivedMark = null;   // the last 410 seen: { jobId, at }
    function archivedRefused(jobId) {
        const again = !!(archivedMark && archivedMark.jobId === jobId && Date.now() - archivedMark.at < 5000);
        archivedMark = { jobId, at: Date.now() };
        if (jobId === currentJobId && !isViewed(jobId)) { lockGone(jobId, { archived: true, refused: true }); return; }
        if (jobId === currentJobId) {
            if (!lostBoxOpen) takeRefused(jobId);
            return;
        }
        const job = getActiveJobs().find(j => j.id === jobId);
        const queued = takeRetryEntries(jobId);
        // Never over another box (the lost or gone box, a Take over
        // question): it waits until that one has closed (lockBoxWhenFree).
        const left = leftArchived(jobId, job);
        if (!left && !again) {
            const mine = !!(justArchived && justArchived.jobId === jobId && Date.now() - justArchived.at < 10000);
            const number = job && job.jobNumber ? 'Job ' + job.jobNumber : mine ? justArchived.number : 'This job';
            let text = mine ? 'A change made while it was being archived was not saved.' : 'Restore it from the Archived list to change it.';
            if (queued) text += ' ' + queued + (queued === 1 ? ' change' : ' changes') + ' made while the server was unreachable ' + (queued === 1 ? 'was' : 'were') + ' not saved.';
            lockBoxWhenFree({ title: number + (mine ? ' was archived.' : ' is archived.'), text, primary: 'OK', graceMs: 1500 });
        } else takeRefused(jobId);
        refreshJobs().then(() => { if (landingShowing()) loadJobs(); });
    }
    // After this page's own archive landed: the job is left the way Home
    // leaves it, while it is still the open one, so what was waiting goes out
    // (and is refused and named, below) instead of being dropped. The screen
    // is read first, for that box: by the time a refusal comes back the job
    // is off the list.
    function leaveArchivedJob(jobId) {
        if (currentJobId !== jobId || isViewed(jobId)) return;
        // Another job is being opened: that open leaves this one (and its
        // waiting saves) itself; leaving here would cancel it (build review 6).
        if (openingJobId && openingJobId !== jobId) return;
        let snap = null;
        try { snap = pageSnapshot(jobId, true); } catch (e) { snap = null; }
        if (justArchived && justArchived.jobId === jobId) justArchived.snap = snap;
        showNoJobState();
    }
    // A save for the job this page has just left, refused because the job was
    // archived before it landed: the box says what was not saved, once per
    // leave, as leftRefusal does for the lock. True when it told her.
    function leftArchived(jobId, job) {
        if (!leftCopy || leftCopy.jobId !== jobId) return false;
        if (leftNoticeFor === leftCopy) return true;
        let snap = null;
        const mine = justArchived && justArchived.jobId === jobId && justArchived.snap;
        if (mine) snap = Object.assign({}, justArchived.snap, { refused: [], boxes: [] });
        else { try { snap = pageSnapshot(jobId, false); } catch (e) { snap = null; } }
        if (snap) snap.refused = takeRefused(jobId);
        const items = safeUnsaved(snap);
        // Her own archive, and nothing of hers lost (only a job row's saved
        // time was refused): no box at all (build review 5).
        if (mine && items && !items.length) return 'nothing';
        if (!items || !items.length) return false;
        leftNoticeFor = leftCopy;
        const w = notSavedWords(items, 'left');
        const number = job && job.jobNumber ? 'Job ' + job.jobNumber : mine ? justArchived.number : 'This job';
        lockBoxWhenFree({ title: number + ' was archived.', text: w.text, detail: w.detail, primary: 'OK', graceMs: 1500 });
        return true;
    }
    // The job this page is archiving, from the moment the request is sent
    // until the page has left it: its own heartbeat or catch-up finding the
    // job archived meanwhile is not news.
    let archivingJobId = null;
    // The last archive this page made: a change of hers refused just after it
    // (made while the request was on its way) is named as such.
    let justArchived = null;   // { jobId, at }
    let conflictMark = null;   // the last 409 on a save: { jobId, at }
    function unsavedNow(jobId) {
        let snap = null;
        try { snap = pageSnapshot(jobId, false); } catch (e) { return null; }
        return safeUnsaved(snap);
    }
    // The archive request, sent from the save queue behind every save this
    // page has queued: the words the Archive button files into the Revisions
    // used to land after the archive (measured 41 ms after), and an archived
    // job now refuses them. For the job she has open (wasOpen) it goes only
    // once the server has everything the page has; what did not land is sent
    // once more first. It is not sent when a save of this job since the press
    // met a conflict (the reload box says so, and a line here), when the job
    // was lost to somebody else or archived meanwhile (their boxes say so; the
    // lost box lists the archive), or when a change still did not land (a box
    // names it). Resolves the archive's reply, or null when it was not sent.
    // Never awaited inside a queued save: it queues its own steps.
    // The job whose archive is waiting on the queue: its copy of what the
    // server has is kept until then (Home drops it once its own saves have
    // landed, and the archive's second look needs it; build review 1).
    let archiveWaiting = null;
    async function archiveAfterSaves(jobId, wasOpen, pressAt) {
        const step = () => {
            if (conflictMark && conflictMark.jobId === jobId && conflictMark.at >= pressAt) return { why: 'conflict' };
            if (wasOpen && isViewed(jobId)) {
                // Lost to somebody else: the lost box, still gathering its
                // list behind this queue, names the archive too.
                if (viewKind === 'locked') recordRefused(jobId, 'archiving the job');
                return { why: 'view' };
            }
            // Changes made while the server was unreachable, not sent yet: an
            // archive now would have them refused when they are (build review 2).
            if (_retryQueue.some(e => e.jobId === jobId)) return { why: 'queued' };
            const items = (wasOpen || copyFor(jobId)) ? unsavedNow(jobId) : [];
            if (items && items.length) return { why: 'unsaved', items };
            archivingJobId = jobId;
            return fetch('/api/jobs/' + jobId + '/archive', { method: 'POST', headers: apiHeaders(jobId) }).then(res => ({ res }));
        };
        const job = getActiveJobs().find(j => j.id === jobId);
        const number = job && job.jobNumber ? 'Job ' + job.jobNumber : 'This job';
        archiveWaiting = jobId;
        try {
            let out;
            try {
                out = await queueSave(step);
                if (out.why === 'unsaved' && !_serverDown) {
                    sendUnsavedAgain(jobId, out.items);
                    out = await queueSave(step);
                }
            } catch (e) {
                // The archive's answer was lost (the network): the job may be
                // archived all the same, so the server is asked before she is
                // told it was not (build review 4).
                const fresh = await fetchJobFresh(jobId);
                if (!(fresh && fresh.job && fresh.job.archivedDate)) throw e;
                out = { res: { ok: true, status: 200 } };
            }
            out.number = number;
            if (out.res && out.res.ok) justArchived = { jobId, at: Date.now(), number };
            return out;
        } finally {
            if (archiveWaiting === jobId) archiveWaiting = null;
        }
    }
    // Why an archive press did not archive, said once (the lost and gone
    // boxes speak for themselves).
    function tellNotArchived(out) {
        const number = out.number || 'This job';
        if (out.why === 'conflict') showToast(number + ' was not archived: it changed in another window. Reload it, then press Archive again.');
        else if (out.why === 'queued' || (out.why === 'unsaved' && _serverDown)) {
            lockBoxWhenFree({ title: number + ' was not archived.', text: 'Some of your changes to it have not reached the server yet. Press Archive again once the server is back and they have been sent.', primary: 'OK' });
        } else if (out.why === 'unsaved') {
            const w = notSavedWords(out.items, 'left');
            lockBoxWhenFree({ title: number + ' was not archived.', text: w.text + ' Press Archive to try again.', detail: w.detail, primary: 'OK' });
        }
    }
    // A box that must not answer one already up (a Take over question, the
    // lost or gone box) with No: it waits until that one has closed (build
    // review 7).
    function lockBoxWhenFree(opts) {
        const show = () => {
            if (boxShowing('lockModal') || boxShowing('reloadModal') || lostBoxOpen) { setTimeout(show, 250); return; }
            lockBox(opts);
        };
        show();
    }

    // No typing or clicking for the idle time: this page lets the job go and
    // says so. Its last saves go first; the release's reply says whether the
    // job is now free, still hers from another window, or somebody else's.
    async function idleRelease(jobId) {
        if (jobId !== currentJobId || isViewed(jobId) || !holdsLock) return;
        const stoppedPrint = printChecking;
        // A header box or a piece name left open is saved as a click away
        // would save it, before the page lets go; a form that needs its own
        // Save (Edit Job, Add piece) is closed below and named.
        try { commitOpenBoxes(); } catch (e) { /* closed below */ }
        // What the page holds now: a save that fails on the way out (a server
        // error) is named in the box rather than dropped (build review A-6).
        let snap = null;
        try { snap = pageSnapshot(jobId, true); } catch (e) { snap = null; }
        sendWaitingSaves();
        stopLockHeartbeat();
        await savesSettled(2000);
        if (jobId !== currentJobId || isViewed(jobId)) return;
        if (_serverDown || _retryQueue.some(e => e.jobId === jobId)) { holdsLock = true; startLockHeartbeat(jobId); return; }
        const r = await releaseJobLock(jobId);
        if (jobId !== currentJobId || isViewed(jobId)) return;
        if (!r) {
            // The server did not answer: the hold is kept and the page carries
            // on editing; the next tick tries again.
            holdsLock = true;
            startLockHeartbeat(jobId);
            return;
        }
        if (r.ok && r.held && !r.mine) { await lockLost(jobId, r, {}); return; }
        const fresh = await fetchJobFresh(jobId);
        if (jobId !== currentJobId || isViewed(jobId)) return;
        if (fresh && fresh.status === 404) { await lockGone(jobId, { archived: false }); return; }
        const job = (fresh && fresh.job) || getActiveJobs().find(j => j.id === jobId);
        if (!job) return;
        if (fresh && fresh.job) adoptFreshJob(fresh.job);
        let boxes = [];
        try { boxes = closeEditorsForView(); } catch (e) { boxes = []; }
        if (job.archivedDate) { showNoJobState(); viewArchivedJob(jobId, { quietIfGone: true }); return; }
        const stillMine = !!(r.ok && r.held && r.mine);
        showLockView(job, { lock: r.ok ? r : null, notice: stillMine ? '' : 'idle', keepScroll: true, keepPlace: true });
        if (!(fresh && fresh.job)) viewCopyUnchecked = true;
        if (snap) { snap.boxes = boxes; snap.refused = takeRefused(jobId); }
        const items = safeUnsaved(snap) || boxes;
        const w = items.length ? notSavedWords(items, 'retaken') : null;
        // Her other window still holds the job: this window let go, the job
        // did not unlock (build review S2).
        lockBox({
            title: stillMine ? 'This window stopped editing after ' + idleTimeText() + ' without typing or clicking.'
                             : 'This job was unlocked after ' + idleTimeText() + ' without typing or clicking.',
            text: (w ? w.text + ' ' : '') + (stillMine ? 'You still have the job open in another window. Press Edit here to edit in this one.' : 'Press Start editing to carry on.') + (stoppedPrint ? ' ' + PRINT_STOPPED : ''),
            detail: w ? w.detail : '',
            primary: 'OK',
            graceMs: 1500
        });
    }
    // An open header box (Customer, Component) or piece name, saved the way
    // Enter or a click away saves it.
    function commitOpenBoxes() {
        // The Signoff due editor too: the snapshot taken next must hold what
        // it commits, or a date saved on the way out reads as not saved.
        if (_signoffCommit) { try { _signoffCommit(); } catch (e) { /* nothing */ } }
        document.querySelectorAll('.inline-edit-input').forEach(el => {
            try { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: false })); } catch (e) { /* nothing */ }
        });
        document.querySelectorAll('.component-tab-name-input').forEach(el => {
            try { if (typeof el.onblur === 'function') el.onblur(); } catch (e) { /* nothing */ }
        });
    }

    // The app's own box for the lock: a title, one line, OK, and Cancel when
    // asked. Enter is the first button. A box already up is answered No first.
    // opts.graceMs: for a box that did not follow the person's own click (a
    // takeover, a lapsed hold, the idle release), Enter and Space are
    // swallowed and OK is not focused until the grace has passed, so a typist
    // whose fingers are still going does not press OK with her next key and
    // lose the words the box says are still on screen.
    // opts.escape: 'primary' makes Escape answer as the first button (the
    // leave box's Stay), not as the second. opts.replaced: what this box
    // answers when another box replaces it (default false, as before); the
    // leave box answers null, so a takeover's box is never read as its
    // Leave without saving.
    const LOCK_BOX_REPLACED = {};
    function lockBox(opts) {
        opts = opts || {};
        return new Promise(resolve => {
            const modal = document.getElementById('lockModal');
            if (!modal) { resolve(true); return; }
            // The box up now is answered No and let go (its done() clears
            // lockBoxResolve itself; clearing it first made done() return
            // early, so that box's caller waited for ever: found 2026-09-28
            // by item 4's build review, a print that never ended).
            if (lockBoxResolve) lockBoxResolve(LOCK_BOX_REPLACED);
            const titleEl = document.getElementById('lockModalTitle');
            const textEl = document.getElementById('lockModalText');
            const detailEl = document.getElementById('lockModalDetail');
            const ok = document.getElementById('lockModalOk');
            const cancel = document.getElementById('lockModalCancel');
            titleEl.textContent = opts.title || '';
            textEl.textContent = opts.text || '';
            textEl.style.display = opts.text ? '' : 'none';
            // What was not saved, on its own lines under a blank line; set or
            // cleared by every box, so no box shows an earlier one's list.
            if (detailEl) {
                detailEl.textContent = opts.detail || '';
                detailEl.style.display = opts.detail ? '' : 'none';
            }
            const content = modal.querySelector('.lock-modal-content');
            if (content) content.classList.toggle('lock-modal-content--detail', !!opts.detail);
            ok.textContent = opts.primary || 'OK';
            cancel.textContent = opts.cancel || 'Cancel';
            cancel.style.display = opts.cancel ? '' : 'none';
            const graceUntil = Date.now() + (Number(opts.graceMs) || 0);
            let graceTimer = null;
            const onKey = e => {
                if (modal.style.display !== 'block') return;
                if (Date.now() < graceUntil && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); return; }
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
                else if (e.key === 'Escape' && opts.escape === 'primary') { e.preventDefault(); e.stopPropagation(); done(true); }
                else if (e.key === 'Escape' && opts.cancel) { e.preventDefault(); e.stopPropagation(); done(false); }
            };
            const done = value => {
                if (lockBoxResolve !== finish) return;
                lockBoxResolve = null;
                if (value === LOCK_BOX_REPLACED) value = 'replaced' in opts ? opts.replaced : false;
                if (graceTimer) clearTimeout(graceTimer);
                modal.style.display = 'none';
                ok.onclick = null;
                cancel.onclick = null;
                document.removeEventListener('keydown', onKey, true);
                resolve(value);
            };
            const finish = value => done(value);
            lockBoxResolve = finish;
            ok.onclick = () => done(true);
            cancel.onclick = () => done(false);
            document.addEventListener('keydown', onKey, true);
            modal.style.display = 'block';
            const focusOk = () => { if (lockBoxResolve === finish) { try { ok.focus(); } catch (e) { /* nothing */ } } };
            if (graceUntil > Date.now()) {
                try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) { /* nothing */ }
                graceTimer = setTimeout(focusOk, graceUntil - Date.now());
            } else {
                focusOk();
            }
        });
    }

    // Anything half open on the holder's page when the job stops being hers:
    // the Edit Job form, the Add piece form, a header box being edited, a
    // piece being renamed, the Signoff due editor. Each has its own way to
    // close without writing. Answers what was typed into them and thrown
    // away, one item a box, only where it differs from what the box opened
    // with, so the box can name it instead of saying "everything was saved".
    function closeEditorsForView() {
        const items = [];
        const add = text => items.push({ text, kind: 'box' });
        const shown = id => { const m = document.getElementById(id); return !!m && m.style.display === 'block'; };
        const form = document.getElementById('editJobForm');
        if (shown('editJobModal') && form && form._opened) {
            EDIT_JOB_WORDS.forEach(([id, key, label]) => {
                const el = document.getElementById(id);
                if (!el) return;
                const value = String(el.value || '').trim();
                if (value !== form._opened[key]) add(value ? label + ': ' + quoteWords(value) : label + ' emptied');
            });
        }
        const addName = document.getElementById('newComponentName');
        if (shown('addComponentModal') && addName && addName.value.trim()) add('new piece ' + quoteWords(addName.value.trim()));
        try { closeEditJobModal(); } catch (e) { /* not open */ }
        try { closeAddComponentModal(); } catch (e) { /* not open */ }
        // A question box (Summary outdated before a print, a confirm) is
        // answered No: its buttons would act on a job this page no longer holds.
        try { if (openWarning) openWarning(false); } catch (e) { /* not open */ }
        // A text box counts when its words differ from what it opened with; a
        // select commits on change, so nothing typed can be pending in it.
        document.querySelectorAll('.inline-edit-input').forEach(el => {
            const value = el.value.trim();
            if (el._opened === undefined || value !== el._opened) {
                const field = el.closest('.job-field');
                const label = field && field.querySelector('.job-field-label');
                const name = label ? label.textContent.trim() : 'A header box';
                add(value ? name + ': ' + quoteWords(value) : name + ' emptied');
            }
            try { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) { /* nothing */ }
        });
        // A piece name: put back what it opened with and close it the way a
        // click away does (Escape only blurs, which does nothing to a box
        // without focus).
        document.querySelectorAll('.component-tab-name-input').forEach(el => {
            const value = el.value.trim();
            if (value && value !== el._opened) add((el._opened || 'A piece') + ' renamed ' + quoteWords(value));
            el.value = el._opened || '';
            try { if (typeof el.onblur === 'function') el.onblur(); } catch (e) { /* nothing */ }
        });
        document.querySelectorAll('.inline-edit-select').forEach(el => {
            try { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) { /* nothing */ }
        });
        document.querySelectorAll('.inline-edit-signoff').forEach(editor => {
            const date = editor.querySelector('.inline-edit-date');
            const time = editor.querySelector('.inline-edit-time');
            const opened = editor._opened;
            if (opened && date && time && (date.value !== opened.date || time.value !== opened.time)) {
                const words = signoffWords(date.value, time.value);
                add('Signoff due (' + (DEPT_WORDS[opened.dept] || '') + ')' + (words ? ': ' + words : ' cleared'));
            }
            if (date) { try { date.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) { /* nothing */ } }
        });
        return items;
    }

    function setReadOnly(enabled) {
        const badge = document.getElementById('readonlyBadge');
        // The header's status is a Tab stop only where it can be changed.
        document.getElementById('headerStatusBadge').tabIndex = enabled ? -1 : 0;
        if (enabled) {
            document.body.classList.add('read-only');
            if (badge) badge.style.display = '';
            quill.disable();
        } else {
            document.body.classList.remove('read-only');
            if (badge) badge.style.display = 'none';
            quill.enable();
        }
    }

    // Typing or clicking anywhere on the page, the QC Review window included
    // (its root stops these on the bubble; a capture listener on the document
    // runs first), keeps the job.
    ['keydown', 'mousedown', 'pointerdown', 'wheel', 'touchstart'].forEach(name => {
        document.addEventListener(name, () => { lastActivity = Date.now(); }, true);
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') {
            // Leaving this tab for the other: what is waiting goes now, so the
            // other tab's catch-up finds it (build review B1). Not the Signoff
            // due editor's commit: a plain switch must not close it.
            if (currentJobId && holdsLock && !isViewed(currentJobId)) sendWaitingSaves({ keepSignoff: true, stay: true });
            return;
        }
        if (viewedJob && viewKind === 'locked') viewPollNow(viewedJob.id, viewPollSeq);
        else catchUpSoon();
    });
    // The catch-up's triggers and its short holds: a key (not a bare Shift,
    // Ctrl, Alt or the like, so the Alt of an Alt+Tab does not count), a press
    // held down (asked again 300 ms after it comes up, once the click's own
    // save has started), the window getting focus, the first pointer move over
    // a window that has not got focus (the hover before a click into a window
    // beside the other), and the QC Review window closing.
    const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS'];
    document.addEventListener('keydown', e => { if (!MODIFIER_KEYS.includes(e.key)) lastKeyAt = Date.now(); }, true);
    document.addEventListener('pointerdown', e => { if (e.isPrimary !== false) { pointerIsDown = true; dragging = false; } }, true);
    const pointerUp = () => {
        if (!pointerIsDown && !catchUpWaiting) return;
        pointerIsDown = false;
        if (catchUpWaiting && !dragging) setTimeout(() => { catchUpNow(); }, 300);
    };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => document.addEventListener(name, pointerUp, true));
    // A drag of selected words starts with a pointercancel while the button
    // is still down: held separately until it drops (build review B5).
    // Bubble phase: Quill cancels a drag it will not do, and a cancelled one
    // never ends with dragend.
    document.addEventListener('dragstart', e => { if (!e.defaultPrevented) dragging = true; });
    const dragEnd = () => {
        if (!dragging) return;
        dragging = false;
        catchUpWaiting = true;
        pointerUp();
    };
    ['dragend', 'drop'].forEach(name => document.addEventListener(name, dragEnd, true));
    document.addEventListener('pointermove', e => {
        if (pointerIsDown && !(e.buttons & 1)) pointerUp();
        if (windowFocused || Date.now() - lastMoveAsk < 2000) return;
        lastMoveAsk = Date.now();
        catchUpNow();
    }, true);
    window.addEventListener('focus', e => {
        if (e.target !== window) return;
        windowFocused = true;
        catchUpSoon();
    });
    window.addEventListener('blur', e => {
        if (e.target !== window) return;
        windowFocused = false;
        pointerIsDown = false;
        dragging = false;
        // Leaving this window for the other one beside it: what is waiting
        // goes now, so the other window's catch-up (on the hover before a
        // click) finds her last change whole, not half (the piece saved and
        // the job row still 600 ms away). As on hiding, never the Signoff
        // due editor's commit.
        if (currentJobId && holdsLock && !isViewed(currentJobId)) sendWaitingSaves({ keepSignoff: true, stay: true });
    });
    document.addEventListener('sts-review-closed', () => { catchUpNow(); });
    // ========== END THE EDIT LOCK ==========

    // Every way into a work order. Asks for the lock first: granted (or no
    // answer within 3 s: the first heartbeat settles it), the job opens for
    // editing from a fresh copy of its row; held by somebody else, the
    // read-only view; archived meanwhile, the archived View.
    let openingJobId = null;   // the job of the newest open still on its way
    async function loadJob(jobId, opts) {
        if (!jobId || !getActiveJobs().some(j => j.id === jobId)) return;
        // Leaving a job open for editing for another one (the job selector,
        // a new job just made): a save still owed asks Stay or Leave first
        // (SAVE_FAILURE_PLAN.md).
        if (currentJobId && currentJobId !== jobId && !isViewed(currentJobId) && !(opts && opts.leaveChecked)) {
            // stays: Leave without saving leaves the job first, so its old
            // screen is never left editable if the other job cannot be drawn.
            leaveJob(() => { loadJob(jobId, Object.assign({}, opts, { leaveChecked: true })); }, { stays: true });
            return;
        }
        const seq = ++openSeq;
        openingJobId = jobId;
        try {
            const reply = await checkJobLock(jobId);
            // The person moved on during the round trip (Home, another job, a
            // View, the QC window): a lock granted for a job nobody has open is
            // let go at once and nothing is drawn (decision 8's rule, kept). A
            // newer open of the SAME job (a double click, or Home and back)
            // keeps its hold: this page's release would take the page it just
            // registered off the server's entry.
            if (seq !== openSeq) {
                if (reply && reply.ok && !reply.locked && !reply.archived && openingJobId !== jobId && currentJobId !== jobId) lockRequest('DELETE', jobId);
                return;
            }
            if (reply && reply.ok && reply.archived) {
                leaveOpenJob(jobId);
                showNoJobState();
                viewArchivedJob(jobId, { quietIfGone: true });
                return;
            }
            if (reply && reply.ok && reply.locked) { await startLockView(jobId, reply, seq); return; }
            // Saves sent on the way out (Home, Lock instructions, leaving
            // another job) land before the fresh copy is read: read earlier,
            // it can predate them, and her next change, carrying the version
            // their replies bring back, would overwrite them.
            if (savesPending > 0) {
                await savesSettled(5000);
                if (seq !== openSeq) {
                    if (reply && reply.ok && !reply.locked && !reply.archived && openingJobId !== jobId && currentJobId !== jobId) lockRequest('DELETE', jobId);
                    return;
                }
            }
            const fresh = await fetchJobFresh(jobId);
            if (seq !== openSeq) {
                if (reply && reply.ok && openingJobId !== jobId && currentJobId !== jobId) lockRequest('DELETE', jobId);
                return;
            }
            if (fresh && fresh.status === 404) {
                showToast('This job is not there any more.');
                setJobsCacheOnly(getActiveJobs().filter(j => j.id !== jobId));
                if (!currentJobId) showNoJobState();
                return;
            }
            if (fresh && fresh.job && fresh.job.archivedDate) {
                leaveOpenJob(jobId);
                showNoJobState();
                viewArchivedJob(jobId, { quietIfGone: true });
                return;
            }
            // A job with no components cannot be drawn (R10, the after-rollout
            // batch, item 8): it used to fail half way and keep the lock this
            // open had just taken for 3 minutes. It says so, lets the lock go
            // at once, and leaves the person where they were. Whether such a
            // job should open so a component can be added is not decided.
            const listed = getActiveJobs().find(j => j.id === jobId);
            const pieces = fresh && fresh.job ? fresh.job.components : listed && listed.components;
            if (Array.isArray(pieces) && !pieces.length) {
                lockRequest('DELETE', jobId);
                const number = (fresh && fresh.job && fresh.job.jobNumber) || (listed && listed.jobNumber);
                lockBoxWhenFree({ title: (number ? 'Job ' + number : 'This job') + ' has no components.',
                    text: 'It cannot be opened. It can still be archived or deleted from the job list.', primary: 'OK' });
                if (!currentJobId) showNoJobState();
                return;
            }
            if (fresh && fresh.job && Array.isArray(fresh.job.components) && fresh.job.components.length) {
                if (opts && opts.place) {
                    // Back from the view on the tab and piece it was on (the
                    // page's copy only; it goes with the next real change).
                    fresh.job.activeDepartment = opts.place.dept || fresh.job.activeDepartment;
                    if (fresh.job.components.some(c => c.id === opts.place.piece)) fresh.job.activeComponentId = opts.place.piece;
                }
                adoptFreshJob(fresh.job);
            }
            drawJob(jobId, { now: reply && reply.ok ? reply.now : 0 });
        } finally {
            if (seq === openSeq) openingJobId = null;
        }
    }

    // Leaving whatever is open for another job: a View ends; an open job is
    // left the way Home leaves it (what is waiting is sent, its instructions
    // stay live, its lock is let go once those saves have landed). Only Lock
    // instructions files instructions into the revisions (David, 2026-09-20
    // and 2026-09-26).
    function leaveOpenJob(nextId) {
        if (viewedJob) { endView(); currentJobId = null; currentComponentId = null; }
        if (currentJobId && currentJobId !== nextId) {
            const leaving = currentJobId;
            sendWaitingSaves();
            stopLockHeartbeat();
            releaseAfterSaves(leaving);
            keepLeftCopy(leaving);
        }
    }
    // The job being left keeps its copy of what the server has, so a save
    // refused after she left can still say what was not saved (leftRefusal).
    // Only for the saves sent on the way out: once they have landed or been
    // refused it goes, so a later refusal for that job (a status change from
    // the list, a delete) gets the ordinary box and never names somebody
    // else's saved work as hers (build review A-1, A-3). Kept while the
    // server is unreachable: a replay refused later still names what it had.
    function keepLeftCopy(jobId) {
        if (!savedCopy || savedCopy.jobId !== jobId) return;
        const kept = savedCopy;
        leftCopy = kept;
        savedCopy = null;
        const drop = () => {
            if (leftCopy !== kept) return;
            if (_retryQueue.some(e => e.jobId === jobId)) { setTimeout(drop, 5000); return; }
            if (archiveWaiting === jobId) { setTimeout(drop, 500); return; }
            // Every save of the leave has answered: a failure among them is
            // said now, if the server is still missing anything.
            leftUnsaved(jobId, kept);
            leftCopy = null;
            leftNoticeFor = null;
        };
        _saveQueue.then(drop, drop);
    }
    // The page's copy of a job replaced by the server's: nothing left to compare.
    function forgetLeftCopy(jobId) {
        if (leftCopy && (!jobId || leftCopy.jobId === jobId)) { leftCopy = null; leftNoticeFor = null; }
    }

    // The work order for editing, from the copy in the list (loadJob has just
    // put the server's fresh copy there). This page holds the lock from here:
    // the heartbeat keeps it, the idle test lets it go, a takeover is told.
    function drawJob(jobId, opts) {
        let jobs = getActiveJobs();
        let job = jobs.find(j => j.id === jobId);
        if (!job) return;
        leaveOpenJob(jobId);
        // Drawn from the server's copy: nothing owed (SAVE_FAILURE_PLAN.md).
        clearSaveTrouble();
        if (abandonedJob === jobId) abandonedJob = null;

        // Track rowVersion for optimistic locking
        if (job.rowVersion) rowVersions[job.id] = job.rowVersion;
        // What the server has, before the migrations below touch the page's
        // copy (their saves move it on when they land).
        rememberSavedJob(job);
        refusedRequests = null;

        // Migrate old job format to components if needed
        if (!job.components) {
            job = migrateJobToComponents(job);
            const jobIdx = jobs.findIndex(j => j.id === jobId);
            jobs[jobIdx] = job;
            saveActiveJobs(jobs);
        }

        // Per-component migration: split shared instructions into per-dept fields
        let migratedAny = false;
        job.components.forEach(c => {
            const before = JSON.stringify(Object.keys(c).sort());
            migrateInstructionsToPerDept(c);
            const after = JSON.stringify(Object.keys(c).sort());
            if (before !== after) migratedAny = true;
        });
        if (migratedAny) saveActiveJobs(jobs);

        // Clear undo/redo stacks (both depts) when switching jobs
        clearAllUndoStacks();
        editorLoads.clear();
        focusSnapshot = null;
        fieldDirty = false;
        updateUndoRedoButtons();

        currentJobId = jobId;
        currentComponentId = job.activeComponentId || job.components[0].id;
        localStorage.setItem('prepressActiveJob', jobId);
        localStorage.setItem('prepressActiveJobTime', Date.now().toString());

        // Stamp access time locally so recent list reorders on open.
        // Only update the local cache -- don't trigger a server persist,
        // because opening a job is not a real change.
        job.lastAccessed = new Date().toISOString();
        jobsCache = jobs;

        drawWorkOrder(job);
        document.getElementById('masterCheckbox').disabled = false;
        setReadOnly(false);

        // This page holds the job from here (granted, or the server gave no
        // answer and the first heartbeat or write settles it).
        holdsLock = true;
        lockHeldSince = (opts && opts.now) || serverNow();
        lastActivity = Date.now();
        startLockHeartbeat(jobId);
        // review.js owns the header's QC buttons, as it already owns QC
        // Review. It is told a work order is showing, and which department
        // tab, so Send to Prepress / Send to Tech Services can follow the tab
        // (START_NEW_JOB_PLAN). Nothing here reads review.js.
        announceJob('sts-job-opened', jobId, activeDepartment);
        settleCursorOnOpen();
    }

    // The drawing half of opening a work order, shared by loadJob and the
    // archive View so the two cannot drift. It draws the job it is given (and,
    // through the readers, shownJob()) and writes nothing.
    function drawWorkOrder(job) {
        updatePrintHeader(job);

        document.getElementById('noJobState').style.display = 'none';
        document.getElementById('printHeader').style.display = 'block';
        document.getElementById('sopContent').style.display = 'block';
        document.getElementById('searchInput').disabled = false;

        // Restore active department (default to prepress for new/old jobs)
        const savedDept = job.activeDepartment || 'prepress';
        activeDepartment = savedDept;
        const deptConfig = window.DEPT_REGISTRY[savedDept] || window.DEPT_REGISTRY.prepress;
        document.querySelectorAll('.dept-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.dept === savedDept);
        });
        document.querySelectorAll('.dept-checklist').forEach(panel => {
            panel.classList.toggle('active', panel.id === deptConfig.panelId);
        });
        const sidebarTitleEl = document.getElementById('sidebarTitle');
        if (sidebarTitleEl) sidebarTitleEl.textContent = deptConfig.sidebarTitle || 'Instructions';
        const printHeadingEl = document.getElementById('printHeading');
        if (printHeadingEl) printHeadingEl.textContent = deptConfig.printHeading || 'Instructions';

        // Render component tabs
        renderComponentTabs();

        // Load current component data
        loadComponentData();
    }

    // One place for the three notices review.js listens for. Guarded, because
    // a browser without CustomEvent, or a listener that throws, must never
    // stop a work order opening.
    function announceJob(name, jobId, dept) {
        try {
            document.dispatchEvent(new CustomEvent(name, { detail: { jobId: jobId || '', dept: dept || '' } }));
        } catch (e) { /* the buttons simply stay hidden */ }
    }

    // Typing is saved 400 ms after the last key, and at least every 2 s while
    // the keys keep coming: the pause used to be the only trigger, so someone
    // typing steadily could have a whole sentence unsaved, which is what a
    // takeover would lose (EDIT_LOCK_PLAN 4.3). A save mid-typing reads the
    // editor and changes nothing on screen.
    const SAVE_DEBOUNCE_MS = 400;
    const SAVE_MAX_WAIT_MS = 2000;
    let saveDebounceStarted = 0;
    function debouncedSaveJobState() {
        const now = Date.now();
        if (!saveDebounceTimer) saveDebounceStarted = now;
        clearTimeout(saveDebounceTimer);
        const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, saveDebounceStarted + SAVE_MAX_WAIT_MS - now));
        saveDebounceTimer = setTimeout(() => { saveDebounceTimer = null; saveJobState(); }, wait);
    }

    // options go to saveComponentState (its `before`). Hands back what it
    // did: { job, comp, unchanged } or { job, comp, sent } (the piece's save).
    function saveJobState(options) {
        // Back to null, so "typing is waiting" (sendWaitingSaves, the unload
        // flush) means just that, and never reads an old screen over a copy
        // the page has since refreshed.
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
        if (!currentJobId || !currentComponentId) return {};

        // Clear active-dept redo stack when actual changes are saved (not during undo/redo)
        if (!isUndoRedo && getActiveRedoStack().length > 0) {
            redoStacks[activeDepartment] = [];
            updateUndoRedoButtons();
        }

        const saved = saveComponentState(options);
        const { job, comp } = saved;
        if (!job || !comp) return saved;

        // UI updates beyond the data write (active dept only)
        const instructions = comp['instructions_' + activeDepartment] || '';
        const history = comp['instructionsHistory_' + activeDepartment] || '';
        const fullInstructions = instructionsAsHtml(instructions) + (instructions && history ? '<br><br>' : '') + history;
        document.getElementById('instructionsDisplay').innerHTML = cleanHtml(fullInstructions);

        updatePrintHeader(job);
        updateRowVisibility();
        updateCompletion();
        updateRequiredIndicators();
        return saved;
    }

    function updatePrintHeader(job) {
        const formatDate = (d) => new Date(d).toLocaleDateString('en-US', {month:'2-digit',day:'2-digit',year:'numeric'});
        const formatDateTime = (d) => new Date(d).toLocaleString('en-US', {month:'2-digit',day:'2-digit',year:'numeric', hour:'numeric', minute:'2-digit', hour12:true});

        // Billboard header (screen)
        document.getElementById('printJobNumber').textContent = job.jobNumber;
        document.getElementById('printClientName').textContent = job.clientName;
        document.getElementById('printCSRName').textContent = job.csrName || '';
        // Component name + version
        const comp = job.components ? job.components.find(c => c.id === currentComponentId) : null;
        document.getElementById('printComponent').textContent = comp ? comp.name : '';
        updateVersionDisplay(comp ? (comp.version || '') : '');
        renderHeaderStatusBadge(job);

        // Signoff due (dept-aware: reflects active tab, same as Assigned to).
        // Hide field entirely if both date and time are empty for the active dept.
        const dueField = document.getElementById('printSignoffDueField');
        const dueDateEl = document.getElementById('printSignoffDueDate');
        const dueTimeEl = document.getElementById('printSignoffDueTime');
        if (dueField && dueDateEl && dueTimeEl) {
            const dateKey = activeDepartment === 'techservices' ? 'signoffDueDateTechservices' : 'signoffDueDatePrepress';
            const timeKey = activeDepartment === 'techservices' ? 'signoffDueTimeTechservices' : 'signoffDueTimePrepress';
            const rawDate = (job[dateKey] || '').trim();
            const rawTime = (job[timeKey] || '').trim();
            let dateStr = '';
            if (rawDate) {
                const d = new Date(rawDate + 'T00:00:00');
                dateStr = isNaN(d.getTime())
                    ? rawDate
                    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            }
            dueDateEl.textContent = dateStr;
            dueTimeEl.textContent = rawTime;
            const show = !!(dateStr || rawTime);
            dueField.style.display = show ? '' : 'none';
            const prevDivider = dueField.previousElementSibling;
            if (prevDivider && prevDivider.classList && prevDivider.classList.contains('job-field-divider')) {
                prevDivider.style.display = show ? '' : 'none';
            }
        }

        // Assigned to (dept-aware: reflects active tab)
        const assigneeKey = activeDepartment === 'techservices' ? 'assignedToTechservices' : 'assignedToPrepress';
        const assigneeVal = (job[assigneeKey] || '').trim();
        const assigneeEl = document.getElementById('printAssignedTo');
        if (assigneeEl) {
            assigneeEl.textContent = assigneeVal || 'Unassigned';
            assigneeEl.classList.toggle('job-field-value--placeholder', !assigneeVal);
        }
        // Print PDF header: Signoff due replaces the Assigned-to cell.
        // Compact format example: "5/13/26 4pm" or "5/13/26 8:30am".
        const pfSignoff = document.getElementById('pf-signoff');
        if (pfSignoff) {
            const pfDateKey = activeDepartment === 'techservices' ? 'signoffDueDateTechservices' : 'signoffDueDatePrepress';
            const pfTimeKey = activeDepartment === 'techservices' ? 'signoffDueTimeTechservices' : 'signoffDueTimePrepress';
            const pfRawDate = (job[pfDateKey] || '').trim();
            const pfRawTime = (job[pfTimeKey] || '').trim();
            const parts = [];
            if (pfRawDate) {
                const d = new Date(pfRawDate + 'T00:00:00');
                if (!isNaN(d.getTime())) {
                    parts.push((d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(-2));
                } else {
                    parts.push(pfRawDate);
                }
            }
            if (pfRawTime) {
                // "8:30 AM" -> "8:30am"; "9:00 AM" -> "9am"; "12:00 PM" -> "12pm"
                let t = pfRawTime.replace(':00', '');
                t = t.replace(/\s*(AM|PM)\s*$/i, function(_, mp) { return mp.toLowerCase(); });
                parts.push(t);
            }
            pfSignoff.textContent = parts.join(' ');
        }
        document.getElementById('printCreated').textContent = formatDateTime(job.dateCreated) + byLabel(job.createdBy);
        document.getElementById('printModified').textContent = formatDateTime(job.lastModified) + byLabel(job.lastModifiedBy);

        // Header modified timestamp
        const hmWrap = document.getElementById('headerModifiedWrap');
        if (job.headerModified) {
            document.getElementById('printHeaderModified').textContent = formatDateTime(job.headerModified) + byLabel(job.headerModifiedBy);
            hmWrap.style.display = '';
        } else {
            hmWrap.style.display = 'none';
        }

        // Deletion log indicator (dropdown)
        const dlWrap = document.getElementById('deletionLogWrap');
        if (job.deletionLog && job.deletionLog.length > 0) {
            document.getElementById('deletionLogCount').textContent = job.deletionLog.length;
            const list = document.getElementById('deletionLogList');
            // Most recent first
            const sorted = job.deletionLog.slice().reverse();
            list.innerHTML = sorted.map(e =>
                '<div class="deletion-log-item">' + escHtml(e.component) + ' deleted' + (e.deletedBy ? ' by ' + escHtml(e.deletedBy) : '') + ' ' + formatDateTime(e.deletedAt) + '</div>'
            ).join('');
            dlWrap.style.display = '';
        } else {
            dlWrap.style.display = 'none';
        }

        // Duplicated from indicator
        const dfWrap = document.getElementById('duplicatedFromWrap');
        if (job.duplicatedFrom) {
            document.getElementById('printDuplicatedFrom').textContent = '#' + job.duplicatedFrom;
            dfWrap.style.display = '';
        } else {
            dfWrap.style.display = 'none';
        }

        // Stacked layout (print PDF)
        document.getElementById('pf-jobnum').textContent = job.jobNumber;
        document.getElementById('pf-client').textContent = job.clientName;
        const projectRow = document.getElementById('pf-project-row');
        if (job.jobDescription) {
            document.getElementById('pf-project').textContent = job.jobDescription;
            projectRow.style.display = '';
        } else {
            projectRow.style.display = 'none';
        }
        document.getElementById('pf-csr').textContent = job.csrName || '';
        document.getElementById('pf-component').textContent = comp ? comp.name : '';
        document.getElementById('pf-created').textContent = formatDateTime(job.dateCreated) + byLabel(job.createdBy);
        document.getElementById('pf-modified').textContent = formatDateTime(job.lastModified) + byLabel(job.lastModifiedBy);

        const pfHmWrap = document.getElementById('pf-header-modified-wrap');
        if (job.headerModified) {
            document.getElementById('pf-header-modified').textContent = formatDateTime(job.headerModified) + byLabel(job.headerModifiedBy);
            pfHmWrap.style.display = '';
        } else {
            pfHmWrap.style.display = 'none';
        }
        const pfDfWrap = document.getElementById('pf-duplicated-wrap');
        if (job.duplicatedFrom) {
            document.getElementById('pf-duplicated').textContent = '#' + job.duplicatedFrom;
            pfDfWrap.style.display = '';
        } else {
            pfDfWrap.style.display = 'none';
        }
    }

    function updateCompletion() {
        // No-op: completion tracking removed — not every toggle needs to be checked per job
    }

    function toggleAllCheckboxes(e) {
        if (!currentJobId) return;
        pushToUndo(false);
        const masterChecked = e.target.checked;
        // Scope to active department panel only
        const panel = document.querySelector('.dept-checklist.active');
        if (!panel) return;
        panel.querySelectorAll('.field-row .toggle-switch input[type="checkbox"]').forEach(cb => {
            cb.checked = masterChecked;
        });
        // Clear non-file-path fields when unchecking (preserve fp* paths)
        if (!masterChecked) {
            panel.querySelectorAll('.field-row .notes').forEach(input => {
                const noteId = input.getAttribute('data-id') || '';
                if (!noteId.startsWith('fp') && !noteId.startsWith('ts_fp')) input.value = '';
            });
        }
        // Update all group checkboxes in active panel
        panel.querySelectorAll('.group-check').forEach(gc => {
            gc.checked = masterChecked;
            gc.indeterminate = false;
        });
        saveJobState();
    }

    function updateGroupCheckboxes() {
        document.querySelectorAll('.section-group').forEach(group => {
            const groupCheckbox = group.querySelector('.group-check');
            if (!groupCheckbox) return;

            const items = group.querySelectorAll('.field-row .toggle-switch input[type="checkbox"]');
            const checkedItems = group.querySelectorAll('.field-row .toggle-switch input[type="checkbox"]:checked');

            if (items.length === 0) {
                groupCheckbox.checked = false;
                groupCheckbox.indeterminate = false;
            } else if (checkedItems.length === 0) {
                groupCheckbox.checked = false;
                groupCheckbox.indeterminate = false;
            } else if (checkedItems.length === items.length) {
                groupCheckbox.checked = true;
                groupCheckbox.indeterminate = false;
            } else {
                groupCheckbox.checked = false;
                groupCheckbox.indeterminate = true;
            }
        });
    }

    function updateMasterCheckbox() {
        // Scope to active department panel
        const panel = document.querySelector('.dept-checklist.active') || document;
        const allCheckboxes = panel.querySelectorAll('.field-row .toggle-switch input[type="checkbox"]');
        const checkedBoxes = panel.querySelectorAll('.field-row .toggle-switch input[type="checkbox"]:checked');
        const masterCheckbox = document.getElementById('masterCheckbox');

        if (allCheckboxes.length === 0) {
            masterCheckbox.checked = false;
            masterCheckbox.indeterminate = false;
        } else if (checkedBoxes.length === 0) {
            masterCheckbox.checked = false;
            masterCheckbox.indeterminate = false;
        } else if (checkedBoxes.length === allCheckboxes.length) {
            masterCheckbox.checked = true;
            masterCheckbox.indeterminate = false;
        } else {
            masterCheckbox.checked = false;
            masterCheckbox.indeterminate = true;
        }
    }

    // Reset switches off the rows of the department tab showing, on the
    // component showing, and keeps every note (the after-rollout batch, item 5,
    // R15). It used to empty the component's switches for both departments,
    // with no Undo. Now it is one Undo step, like the select-all switch whose
    // reach it shares, and the screen is saved the ordinary way, so the other
    // department's switches are never touched.
    function resetChecklist() {
        if (!currentJobId || !currentComponentId || isViewed(currentJobId)) return;
        const job = getActiveJobs().find(j => j.id === currentJobId);
        const comp = job && job.components ? job.components.find(c => c.id === currentComponentId) : null;
        const panel = document.querySelector('.dept-checklist.active');
        if (!comp || !panel) return;
        if (!confirm('Reset the ' + (DEPT_WORDS[activeDepartment] || 'department') + ' switches on "' + comp.name + '"? Notes are kept.')) return;
        pushToUndo(false);
        panel.querySelectorAll('.field-row .toggle-switch input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        panel.querySelectorAll('.group-check').forEach(gc => {
            gc.checked = false;
            gc.indeterminate = false;
        });
        saveJobState();
        updateMasterCheckbox();
    }

    async function archiveJob() {
        // The id is taken once: the warning is awaited (it asks the QC column
        // first, for up to 1.5 s, before the box shows), and she can move to
        // another job in that time. Warning about one job and archiving
        // another is the one way this could do real harm.
        const jobId = currentJobId;
        // Hidden while viewing; archiving an archived job would re-date it.
        if (!jobId || isViewed(jobId)) return;
        if (!(await confirmWithQc('Archive this job?', [jobId], QC_ARCHIVE_LEAD, 'Archive'))) return;
        const pressAt = Date.now();
        const wasOpen = currentJobId === jobId;
        if (wasOpen) {
            lastFiling = { jobId, press: 'Archive' };
            closeCurrentJob(); // Add timestamp before archiving
            sendWaitingSaves();
        }

        try {
            let res;
            try {
                // Behind this page's own saves (item 5).
                const out = await archiveAfterSaves(jobId, wasOpen, pressAt);
                if (!out.res) { tellNotArchived(out); return; }
                res = out.res;
                if (res.status === 423) recordRefused(jobId, 'archiving the job');
                if (await refusedByLock(res, jobId)) return;
                if (!res.ok) throw new Error('Failed to archive job');
            } catch (e) {
                showErrorModal("Couldn't archive this job.", 'Refresh');
                return;
            }

            // Left while it is still the open job, so a change made while the
            // request was on its way is sent, refused and named (it used to be
            // dropped without a word), then taken off the list.
            leaveArchivedJob(jobId);
            const active = getActiveJobs();
            const idx = active.findIndex(j => j.id === jobId);
            if (idx > -1) active.splice(idx, 1);
            // Cache only: by now another job may be the open one.
            setJobsCacheOnly(active);
            loadJobs();
        } finally {
            if (archivingJobId === jobId) archivingJobId = null;
        }
    }

    // ========== ARCHIVE BROWSER ==========

    let archivePage = 1;
    let archivePageSize = 10;
    let archiveSearchQuery = '';
    let _archiveCache = [];

    async function renderArchivedJobs() {
        const container = document.getElementById('archivedJobs');
        if (!container) return;
        // The Deleted jobs panel under it reloads with it, from every place
        // the Archived list does (Home, any delete, the red x).
        renderDeletedJobs();
        try {
            const res = await fetch('/api/archive');
            if (res.ok) _archiveCache = await res.json();
        } catch (e) { _archiveCache = []; }
        renderArchivePage();
    }

    // The column holding both panels is hidden while both are.
    function syncArchiveCol() {
        const col = document.getElementById('archiveCol');
        const archived = document.getElementById('archivedJobs');
        const deleted = document.getElementById('deletedJobs');
        if (col) col.hidden = (!archived || archived.hidden) && (!deleted || deleted.hidden);
    }

    // Filter the cached archive by the search box. Matches only the fields the
    // archive row actually shows -- job number, client, description -- so every
    // result is explainable by what is on screen.
    function filteredArchive() {
        if (!archiveSearchQuery) return _archiveCache;
        return _archiveCache.filter(j => {
            const searchable = (j.jobNumber + ' ' + j.clientName + ' ' + (j.jobDescription || '')).toLowerCase();
            return searchable.includes(archiveSearchQuery);
        });
    }

    function renderArchivePage() {
        const container = document.getElementById('archivedJobs');
        const list = document.getElementById('archiveList');
        if (!container || !list) return;

        // Nothing archived at all -- hide the whole panel, as before.
        if (_archiveCache.length === 0) {
            container.hidden = true;
            list.innerHTML = '';
            syncArchiveCol();
            return;
        }
        container.hidden = false;
        syncArchiveCol();
        _archiveCache.sort((a, b) => new Date(b.archivedDate || b.lastModified || 0) - new Date(a.archivedDate || a.lastModified || 0));

        const archive = filteredArchive();

        // Count badge says "3 of 27" while a search is active so a filtered
        // number is never mistaken for the archive total.
        const countEl = document.getElementById('archiveCount');
        if (countEl) {
            countEl.textContent = archiveSearchQuery
                ? archive.length + ' of ' + _archiveCache.length
                : String(_archiveCache.length);
        }
        const sizeEl = document.getElementById('archivePageSizeSelect');
        if (sizeEl) sizeEl.value = String(archivePageSize);

        if (archive.length === 0) {
            list.innerHTML = '<div class="archive-empty">No archived jobs match &ldquo;' +
                escHtml(archiveSearchQuery) + '&rdquo;.</div>';
            return;
        }

        // Pages come off the filtered list, not the full cache.
        const totalPages = Math.ceil(archive.length / archivePageSize);
        if (archivePage > totalPages) archivePage = totalPages;
        if (archivePage < 1) archivePage = 1;
        const start = (archivePage - 1) * archivePageSize;
        const visible = archive.slice(start, start + archivePageSize);
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

        const items = visible.map(j => {
            const desc = j.jobDescription ? ' - ' + j.jobDescription : '';
            const label = j.jobNumber + ' - ' + j.clientName + desc;
            const d = j.archivedDate ? new Date(j.archivedDate) : null;
            const dateStr = d ? months[d.getMonth()] + ' ' + d.getDate() : '';
            // The name and View open the job read only (David, 2026-09-27:
            // a click to look must never bring a job back); only Restore
            // restores. Both answer the one listener on #archiveList below.
            return '<div class="archive-item" title="Archived ' + (d ? d.toLocaleDateString() : '') + '">' +
                '<span class="archive-item-text" data-job-id="' + escHtml(j.id) + '">' + escHtml(label) + '</span>' +
                '<span class="archive-item-date">' + dateStr + '</span>' +
                '<button type="button" class="mini-btn archive-view-btn" data-job-id="' + escHtml(j.id) + '">View</button>' +
                '<button type="button" class="mini-btn archive-restore-btn" data-job-id="' + escHtml(j.id) + '">Restore</button>' +
                '<button type="button" class="mini-btn mini-delete archive-delete-btn" data-job-id="' + escHtml(j.id) + '" title="Delete permanently">&times;</button>' +
                '</div>';
        }).join('');

        let paginationHtml = '';
        if (totalPages > 1) {
            paginationHtml = '<div class="archive-pagination">' +
                '<button class="mini-btn"' + (archivePage <= 1 ? ' disabled' : '') + ' onclick="setArchivePage(' + (archivePage - 1) + ')">&laquo; Prev</button>' +
                '<span class="archive-page-info">Page ' + archivePage + ' of ' + totalPages + '</span>' +
                '<button class="mini-btn"' + (archivePage >= totalPages ? ' disabled' : '') + ' onclick="setArchivePage(' + (archivePage + 1) + ')">Next &raquo;</button>' +
                '</div>';
        }

        list.innerHTML = items + paginationHtml;
    }

    function setArchivePage(p) { archivePage = p; renderArchivePage(); }
    function setArchivePageSize(n) { archivePageSize = parseInt(n, 10); archivePage = 1; renderArchivePage(); }

    // ── Archive search (filters the archive panel only) ──
    // Mirrors the landing search: 150ms debounce, back to page 1 on every change.
    (function() {
        const input = document.getElementById('archiveSearchInput');
        if (!input) return;
        let debounceTimer;
        input.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                archiveSearchQuery = input.value.trim().toLowerCase();
                archivePage = 1;
                renderArchivePage();
            }, 150);
        });
    })();

    // ========== DELETED JOBS (item 7, DELETED_QC_PLAN.md) ==========
    // A deleted job's QC record is kept: its history, every signed sheet and
    // who deleted it and when (the delete writes that line). This panel lists
    // those jobs, newest delete first, and a row opens the record read only in
    // the QC Review window, which takes no lock. The server searches and pages
    // (/api/reviews/deleted), because the list is asked for on every Home.
    // Anyone who picked a name may open it (David, 2026-09-29).

    const DELETED_PAGE_SIZE = 10;
    let deletedPage = 1;
    let deletedSearchQuery = '';
    let deletedSeq = 0;
    let deletedReply = null;

    async function renderDeletedJobs() {
        const seq = ++deletedSeq;
        const params = new URLSearchParams({ q: deletedSearchQuery, offset: String((deletedPage - 1) * DELETED_PAGE_SIZE), limit: String(DELETED_PAGE_SIZE) });
        let reply = null;
        let status = 0;
        try {
            const res = await fetch('/api/reviews/deleted?' + params.toString());
            status = res.status;
            reply = await res.json();
        } catch (e) { reply = null; }
        if (seq !== deletedSeq) return;   // a newer ask is on its way
        if (reply && reply.available && Array.isArray(reply.jobs)) {
            deletedReply = reply;
        } else if ((status === 503 && reply && reply.available === false) || status === 401) {
            // QC Review not set up, or no name picked: no panel, as the QC
            // column hides.
            deletedReply = null;
        } else {
            // The server away or a fault: the last good copy stays, as the
            // QC column's does.
            return;
        }
        // A page emptied by a narrower search or fewer jobs: the last page.
        if (deletedReply && !deletedReply.jobs.length && deletedReply.matching > 0 && deletedPage > 1) {
            deletedPage = Math.ceil(deletedReply.matching / DELETED_PAGE_SIZE);
            renderDeletedJobs();
            return;
        }
        renderDeletedPage();
    }

    function renderDeletedPage() {
        const container = document.getElementById('deletedJobs');
        const list = document.getElementById('deletedList');
        if (!container || !list) return;
        const reply = deletedReply;
        if (!reply || !reply.total) {
            container.hidden = true;
            list.innerHTML = '';
            syncArchiveCol();
            return;
        }
        container.hidden = false;
        syncArchiveCol();
        const countEl = document.getElementById('deletedCount');
        if (countEl) countEl.textContent = deletedSearchQuery ? reply.matching + ' of ' + reply.total : String(reply.total);
        if (!reply.matching) {
            list.innerHTML = '<div class="archive-empty">No deleted jobs match &ldquo;' + escHtml(deletedSearchQuery) + '&rdquo;.</div>';
            return;
        }
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const items = reply.jobs.map(j => {
            // The Archived list's label: the parts the record has.
            const label = [j.jobNumber, j.clientName, j.jobDescription].filter(v => String(v || '').trim()).join(' - ');
            const d = j.deletedAt ? new Date(j.deletedAt) : null;
            const ok = d && !isNaN(d.getTime());
            const dateStr = ok ? months[d.getMonth()] + ' ' + d.getDate() : '';
            // As the record's own line words it: "Deleted Sep 29 2026, 3:05 PM by David Marra".
            const clock = ok ? (d.getHours() % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + (d.getHours() >= 12 ? 'PM' : 'AM') : '';
            const title = 'Deleted' + (ok ? ' ' + dateStr + ' ' + d.getFullYear() + ', ' + clock : '') + (j.deletedBy ? ' by ' + j.deletedBy : '');
            return '<div class="archive-item deleted-item" title="' + escHtml(title) + '">' +
                '<span class="archive-item-text deleted-item-text" data-job-id="' + escHtml(j.jobId) + '">' + escHtml(label) + '</span>' +
                '<span class="archive-item-date">' + dateStr + '</span>' +
                '<button type="button" class="mini-btn deleted-open-btn" data-job-id="' + escHtml(j.jobId) + '">QC record</button>' +
                '</div>';
        }).join('');
        const totalPages = Math.max(1, Math.ceil(reply.matching / DELETED_PAGE_SIZE));
        let paginationHtml = '';
        if (totalPages > 1) {
            paginationHtml = '<div class="archive-pagination">' +
                '<button type="button" class="mini-btn deleted-page-btn" data-page="' + (deletedPage - 1) + '"' + (deletedPage <= 1 ? ' disabled' : '') + '>&laquo; Prev</button>' +
                '<span class="archive-page-info">Page ' + deletedPage + ' of ' + totalPages + '</span>' +
                '<button type="button" class="mini-btn deleted-page-btn" data-page="' + (deletedPage + 1) + '"' + (deletedPage >= totalPages ? ' disabled' : '') + '>Next &raquo;</button>' +
                '</div>';
        }
        list.innerHTML = items + paginationHtml;
    }

    (function() {
        const list = document.getElementById('deletedList');
        if (list) {
            // Every button answers here, by its own class, so an id is only
            // ever an attribute value.
            list.addEventListener('click', e => {
                const page = e.target.closest('.deleted-page-btn');
                if (page && list.contains(page)) {
                    if (page.disabled) return;
                    deletedPage = Math.max(1, parseInt(page.getAttribute('data-page'), 10) || 1);
                    renderDeletedJobs();
                    return;
                }
                const el = e.target.closest('.deleted-open-btn, .deleted-item-text');
                if (!el || !list.contains(el)) return;
                const id = el.getAttribute('data-job-id');
                if (id && typeof window.openReview === 'function') window.openReview(id, 'prepress');
            });
        }
        // Mirrors the Archived search: 150ms after the last key, page 1.
        const input = document.getElementById('deletedSearchInput');
        if (!input) return;
        let debounceTimer;
        input.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                deletedSearchQuery = input.value.trim().toLowerCase();
                deletedPage = 1;
                renderDeletedJobs();
            }, 150);
        });
    })();

    // ── View: an archived job's work order, read only (ARCHIVE_VIEW_PLAN) ──
    // The name or View on an Archived row opens the job as it was stored,
    // with its QC one click away (the header's QC Review button), and leaves
    // it archived. Nothing is saved, stamped or locked: the job is held in
    // viewedJob, never in the active list, which every function that
    // changes a work order reads (so they find nothing), the few that do not
    // read it test isViewed(), and the controls that change a job are hidden
    // (body.archive-view). Home, or anything that opens another job, ends it.
    (function() {
        const list = document.getElementById('archiveList');
        if (!list) return;
        // Every button on a row answers here, by its own class, so an id
        // brought in by Import is only ever an attribute value.
        list.addEventListener('click', e => {
            const el = e.target.closest('.archive-view-btn, .archive-item-text, .archive-restore-btn, .archive-delete-btn');
            if (!el || !list.contains(el)) return;
            const id = el.getAttribute('data-job-id');
            if (el.classList.contains('archive-restore-btn')) unarchiveJob(id);
            else if (el.classList.contains('archive-delete-btn')) deleteArchivedJob(id);
            else viewArchivedJob(id);
        });
    })();

    let openSeq = 0;   // moved on by every View, Home, job opened and QC window opened

    // Brings the Archived list to the top of the screen, below the bars that
    // stay put when the page scrolls (the nav bar, the job list's filters),
    // which would otherwise cover its header and first rows. Measured, not
    // assumed: the bars' heights change with the window's width.
    function scrollBelowBars(el) {
        el.scrollIntoView({ block: 'start' });
        // A short page cannot bring it to the top: then nothing covers it.
        if (el.getBoundingClientRect().top > 5) return;
        const x = el.getBoundingClientRect().left + 20;
        let covered = 0;
        for (let y = 0; y < 400; y += 4) {
            const hit = document.elementFromPoint(x, y);
            if (hit && el.contains(hit)) break;
            covered = y + 4;
        }
        if (covered) window.scrollBy(0, -(covered + 8));
    }

    function isViewed(jobId) {
        return !!viewedJob && !!jobId && viewedJob.id === jobId;
    }

    // The job on screen, for the functions that draw it and print it. Never
    // for one that changes it: those keep reading the active list.
    function shownJob() {
        if (viewedJob && viewedJob.id === currentJobId) return viewedJob;
        return getActiveJobs().find(j => j.id === currentJobId);
    }

    // options.quietIfGone: the email link, where a job that is not there lands
    // quietly on the list, as it did before.
    async function viewArchivedJob(jobId, options) {
        if (!jobId) return;
        const seq = ++openSeq;
        openingJobId = null;
        // Stale once anything else happened: another View, a job opened,
        // Home, or the QC Review window opened from the job list meanwhile.
        const reviewOpen = () => { const m = document.getElementById('reviewModal'); return !!m && m.classList.contains('is-open'); };
        const stale = () => seq !== openSeq || !landingShowing() || reviewOpen();
        // The press can wait up to 5 s for saves on their way: the button says so.
        const btn = document.querySelector('#archiveList .archive-view-btn[data-job-id="' + String(jobId).replace(/["\\]/g, '') + '"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Opening...'; }
        try {
            await openArchived(jobId, options, seq, stale);
        } finally {
            if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = 'View'; }
        }
    }

    async function openArchived(jobId, options, seq, stale) {
        // Saves already on their way land first (as refreshJobs waits): Home's
        // own last save, or the last filing of a job just archived, and any
        // conflict they meet, while the job list is still showing.
        await savesSettled(5000);
        if (stale()) return;
        if (_retryQueue.length) {
            showToast('Earlier changes are still being saved. Try again in a moment.');
            return;
        }
        let res = null;
        let job = null;
        try {
            res = await fetch('/api/jobs/' + encodeURIComponent(jobId));
            if (res.ok) job = await res.json();
        } catch (e) { job = null; }
        if (stale()) return;
        if (res && res.status === 404) {
            if (!(options && options.quietIfGone)) showToast('This job is not there any more.');
            renderArchivedJobs();
            return;
        }
        if (!job || !job.id) {
            showToast('Could not open this job. Try again.');
            return;
        }
        // The server's own test: archived when archivedDate is neither empty
        // nor missing. A job restored since the list was drawn is not opened.
        if (!job.archivedDate) {
            showToast('This job is not archived any more. It is on the job list.');
            await refreshJobs();
            if (seq === openSeq && landingShowing()) loadJobs();
            return;
        }
        if (!Array.isArray(job.components) || !job.components.length) {
            showToast('This job has no pieces to show.');
            return;
        }
        startView(job);
    }

    // The read-only view of a job: an archived one (decision 8) or a live one
    // somebody else holds (EDIT_LOCK_PLAN). One wall for both: the job is held
    // in viewedJob, every writer refuses isViewed, every control that changes
    // a job is hidden (hide-in-view), the notes are readOnly, Quill is
    // disabled. The line above the header says which (renderViewLine).
    let viewKind = '';        // 'archived' or 'locked' while a view is open
    let viewLock = null;      // the last lock facts for a locked view
    let viewNotice = '';      // 'idle' or 'deleted': what the line says instead of the lock
    let viewPollTimer = null;
    let viewPollSeq = 0;
    let viewPollBusy = false;
    let redrawWaiting = false;   // the server has a newer copy the view could not draw yet
    // The view shows the page's own copy, not one the server gave it (a
    // takeover before OK, a lost box whose fetch failed, the idle release
    // with no answer): it can hold words the server refused at the server's
    // own version, so the next poll or print fetches whatever the version says.
    let viewCopyUnchecked = false;

    // The wall and the classes, without drawing: lockLost keeps the holder's
    // words on screen until OK, so it puts the wall up first and draws later.
    function enterView(job, kind) {
        // Nothing more is sent for a job the page only shows; the box of the
        // path that made it a view names what was not saved.
        clearSaveTrouble();
        viewedJob = job;
        viewKind = kind;
        currentJobId = job.id;
        if (!job.components.some(c => c.id === currentComponentId)) currentComponentId = job.components[0].id;
        clearAllUndoStacks();
        focusSnapshot = null;
        fieldDirty = false;
        // Never remembered, so a reload lands on the job list, not on this
        // job and not on an older one remembered before it.
        localStorage.removeItem('prepressActiveJob');
        localStorage.removeItem('prepressActiveJobTime');
        document.body.classList.remove('job-view--archived', 'job-view--locked');
        document.body.classList.add('job-view', 'job-view--' + kind);
        setReadOnly(true);
        // Note boxes can still be selected and copied (a file path), not typed
        // in. Only those not read only already are marked, so endView gives
        // back exactly what it took.
        document.querySelectorAll('.notes').forEach(el => {
            if (!el.readOnly) { el.readOnly = true; el.setAttribute('data-view-readonly', ''); }
        });
        // The attendees button still shows who attended, but does not open
        // (a button with pointer-events off still answers Tab and Enter).
        document.querySelectorAll('.meeting-attendees-btn').forEach(btn => {
            btn.disabled = true;
            btn.classList.remove('is-open');
        });
        document.querySelectorAll('.meeting-attendees-panel').forEach(panel => panel.setAttribute('hidden', ''));
        // A view's switches are inert only to the mouse: the ones that are
        // Tab stops leave the order, and one with the cursor loses it, or
        // Space would flip it on screen (KEYBOARD_PLAN.md 2.8).
        document.querySelectorAll(SWITCH_STOPS).forEach(el => {
            if (document.activeElement === el) el.blur();
            if (el.tabIndex >= 0) { el.tabIndex = -1; el.setAttribute('data-view-notab', ''); }
        });
        updateUndoRedoButtons();
    }

    function startView(job, opts) {
        opts = opts || {};
        const kind = opts.kind || 'archived';
        if (opts.keepPlace && currentJobId === job.id) {
            // The idle release and a lapsed hold draw the same job again: the
            // person stays on the tab and piece she was on (the page's copy
            // only; a viewed job is never written).
            job.activeDepartment = activeDepartment;
            if (job.components.some(c => c.id === currentComponentId)) job.activeComponentId = currentComponentId;
        }
        currentComponentId = job.components.some(c => c.id === job.activeComponentId)
            ? job.activeComponentId : job.components[0].id;
        editorLoads.clear();
        viewCopyUnchecked = false;
        enterView(job, kind);
        if (kind === 'archived') { viewLock = null; viewNotice = ''; }
        renderViewLine();
        drawWorkOrder(job);
        setReadOnly(true);
        updateUndoRedoButtons();
        if (!opts.keepScroll) window.scrollTo(0, 0);
        // An archived view takes no lock, keeps no rowVersion, and announces
        // no sts-job-opened (the server needs a live job for Send to
        // Prepress). A locked view announces it (showLockView): the press
        // writes only the QC tables and needs no lock. QC Review opens on
        // currentJobId and the server answers it read only.
        settleCursorOnOpen();
    }

    // The read-only view of a live job somebody else holds (or, after the idle
    // release, of a job this page let go). The line follows the lock; a poll
    // every pollMs while the page is visible redraws the work order when the
    // holder saves. Send to Prepress / Send to Tech Services stay available:
    // they change nothing on the job (David: QC Review is not part of this).
    function showLockView(job, opts) {
        opts = opts || {};
        viewLock = opts.lock || null;
        viewNotice = opts.notice || '';
        startView(job, { kind: 'locked', keepScroll: !!opts.keepScroll, keepPlace: !!opts.keepPlace });
        announceJob('sts-job-opened', job.id, activeDepartment);
        startViewPoll(job.id);
        renderViewLine();
        // No facts yet (a release the server did not answer): ask now rather
        // than leave "Checking who has this job..." up for a whole poll.
        if (!viewLock && !viewNotice) viewPollNow(job.id, viewPollSeq);
    }

    // loadJob found the job held by somebody else: the fresh copy, then the view.
    async function startLockView(jobId, reply, seq) {
        const fresh = await fetchJobFresh(jobId);
        if (seq !== openSeq) return;
        if (fresh && fresh.status === 404) {
            showToast('This job is not there any more.');
            setJobsCacheOnly(getActiveJobs().filter(j => j.id !== jobId));
            if (!currentJobId) showNoJobState();
            return;
        }
        if (!fresh || !fresh.job || !Array.isArray(fresh.job.components) || !fresh.job.components.length) {
            showToast('Could not open this job. Try again.');
            if (!currentJobId) showNoJobState();
            return;
        }
        if (fresh.job.archivedDate) {
            leaveOpenJob(jobId);
            showNoJobState();
            viewArchivedJob(jobId, { quietIfGone: true });
            return;
        }
        leaveOpenJob(jobId);
        adoptFreshJob(fresh.job);
        showLockView(fresh.job, { lock: reply });
    }

    // The words above the header, and the one button that goes with them.
    // The line is green when this person can edit the job from here (nobody
    // holds it, it was unlocked by the idle time, or it is hers from another
    // window), in the app's own "Server connection restored" green, and amber
    // otherwise (David, 2026-09-28: "Edit" was not clear enough; the words
    // say the job is unlocked and the button what it does).
    function renderViewLine() {
        const line = document.getElementById('viewLine');
        if (!line) return;
        line.textContent = '';
        let free = false;
        if (!viewedJob) { setViewLineFree(line, false); return; }
        let text = '';
        let action = '';
        let label = '';
        if (viewKind === 'archived') {
            const d = new Date(viewedJob.archivedDate);
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            text = (isNaN(d.getTime()) ? 'Archived.' : 'Archived ' + months[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear() + '.') + ' Read only.';
        } else if (viewNotice === 'deleted') {
            text = 'This job was deleted.';
            action = 'home'; label = 'Home';
        } else if (viewLock && viewLock.held && !viewLock.mine) {
            const saved = lastSavedText();
            text = holderName(viewLock) + ' is editing this job' + (saved ? ', last saved ' + saved : '') + '.';
            if (redrawWaiting) text += ' Newer changes are waiting; click away from your selection to see them.';
            action = 'takeover'; label = 'Take over';
        } else if (viewLock && viewLock.held && viewLock.mine) {
            text = 'You have this job open in another window.';
            action = 'edit'; label = 'Edit here';
            free = true;
        } else if (viewNotice === 'idle') {
            text = 'Unlocked after ' + idleTimeText() + ' without typing or clicking.';
            action = 'edit'; label = 'Start editing';
            free = true;
        } else if (viewLock && viewLock.held === false) {
            text = 'Unlocked. Nobody is editing this job now.';
            action = 'edit'; label = 'Start editing';
            free = true;
        } else {
            // The server has not said yet: never a guess in green.
            text = 'Checking who has this job...';
        }
        setViewLineFree(line, free);
        line.appendChild(document.createTextNode(text));
        if (action) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'view-line-btn';
            btn.setAttribute('data-view-action', action);
            btn.textContent = label;
            line.appendChild(btn);
        }
    }
    // Green for a job this person can edit from here; the READ-ONLY badge
    // steps aside meanwhile (the line and its button say it all).
    function setViewLineFree(line, free) {
        line.classList.toggle('view-line--free', !!free);
        document.body.classList.toggle('job-view--free', !!free);
    }
    // When the holder last saved: the later of the lock's own last write (the
    // server's clock) and the row's stamp when it is hers (the browser's clock,
    // as reported), so a service restart never says "no changes yet" for a
    // job she has had open for an hour.
    function lastSavedAt() {
        if (!viewLock || !viewLock.held) return 0;
        let t = Number(viewLock.lastWrite) || 0;
        const row = viewedJob || {};
        if (row.lastModified && userKeyOf(row.lastModifiedBy) === (viewLock.byKey || userKeyOf(viewLock.by))) {
            const stamp = Date.parse(row.lastModified);
            if (stamp > t) t = stamp;
        }
        return t;
    }
    function agoText(ms) {
        const s = Math.max(0, Math.round((serverNow() - ms) / 1000));
        if (s < 60) return 'just now';
        if (s < 3600) return Math.round(s / 60) + ' min ago';
        if (s < 36 * 3600) { const h = Math.round(s / 3600); return h + ' h ago'; }
        const d = Math.round(s / 86400);
        return d === 1 ? 'yesterday' : d + ' days ago';
    }
    // A clock time, with the date when it was not today ("Sep 25, 4:23 PM").
    function whenText(ms) {
        const d = new Date(Number(ms) || Date.now());
        const today = new Date();
        const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
        return (sameDay ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ') + clockText(ms);
    }
    function seenText(ms) {
        const s = Math.max(0, Math.round((serverNow() - ms) / 1000));
        if (s < 60) return s + ' s ago';
        return agoText(ms);
    }
    function lastSavedText() {
        const t = lastSavedAt();
        return t ? agoText(t) : '';
    }

    // The line's one button.
    document.addEventListener('click', e => {
        const btn = e.target && e.target.closest ? e.target.closest('#viewLine .view-line-btn') : null;
        if (!btn) return;
        const action = btn.getAttribute('data-view-action');
        if (action === 'takeover') takeOverJob();
        else if (action === 'edit') editFromView();
        else if (action === 'home') showNoJobState();
    });

    // Take over: the confirm names the holder, when she last saved, and when
    // her page was last seen. No admin password (David, 2026-09-28): nothing
    // older than her last save is lost, and her page is told.
    async function takeOverJob() {
        if (!viewedJob || viewKind !== 'locked') return;
        const jobId = viewedJob.id;
        const l = viewLock || {};
        const who = holderName(l);
        const savedAt = lastSavedAt();
        const seen = l.lastSeen ? seenText(l.lastSeen) : '';
        let text = who + (savedAt ? ' last saved it ' + agoText(savedAt) + ' (' + whenText(savedAt) + ').' : ' has not saved anything yet.');
        text += seen ? ' That window was last in touch ' + seen + '; if it is still open it will be told and turn read only.'
                     : ' If that window is still open it will be told and turn read only.';
        const yes = await lockBox({ title: 'Take over this job from ' + who + '?', text, primary: 'Take over', cancel: 'Cancel' });
        if (!yes || currentJobId !== jobId || !isViewed(jobId)) return;
        const r = await checkJobLock(jobId, { takeOver: true });
        if (!r) { showToast('Could not reach the server. Try again.'); return; }
        if (currentJobId !== jobId || !isViewed(jobId)) return;
        if (r.archived) { becomeArchivedView(); return; }
        editFromView();
    }

    // Edit from the view: the job is free (or already hers from another
    // window). loadJob asks for the lock and opens from a fresh copy.
    function editFromView() {
        if (!viewedJob || viewKind !== 'locked') return;
        const job = viewedJob;
        const place = { dept: activeDepartment, piece: currentComponentId };
        adoptFreshJob(job);
        endView();
        currentJobId = null;
        currentComponentId = null;
        loadJob(job.id, { place });
    }

    // The view's poll: who holds the job now, and whether the row moved.
    function startViewPoll(jobId) {
        stopViewPoll();
        const seq = ++viewPollSeq;
        viewPollTimer = setInterval(() => { viewPollNow(jobId, seq); }, lockTiming.pollMs);
    }
    function stopViewPoll() {
        viewPollSeq++;
        if (viewPollTimer) { clearInterval(viewPollTimer); viewPollTimer = null; }
    }
    async function viewPollNow(jobId, seq) {
        // Never under the lost box: it says her words are still on screen,
        // and OK draws the latest copy itself.
        if (lostBoxOpen) return;
        if (viewPollBusy || seq !== viewPollSeq || document.visibilityState !== 'visible') return;
        if (!viewedJob || viewedJob.id !== jobId || viewKind !== 'locked') return;
        viewPollBusy = true;
        try {
            const l = await readJobLock(jobId);
            if (seq !== viewPollSeq || !viewedJob || viewedJob.id !== jobId || viewKind !== 'locked') return;
            // Gone or archived: off the job list too, which holds the same copy.
            const offList = () => setJobsCacheOnly(getActiveJobs().filter(j => j.id !== jobId));
            if (l && l.status === 404) { offList(); viewNotice = 'deleted'; viewLock = null; stopViewPoll(); renderViewLine(); return; }
            if (!l || !l.ok) return;
            if (l.archived) {
                offList();
                const fresh = await fetchJobFresh(jobId);
                if (seq !== viewPollSeq || !viewedJob || viewedJob.id !== jobId) return;
                // Under a selection the copy moves on and the screen does not:
                // a print draws it first (redrawWaiting, viewLatestForPrint).
                if (fresh && fresh.job) { if (canRedrawView()) redrawView(fresh.job); else { viewedJob = fresh.job; redrawWaiting = true; } }
                becomeArchivedView();
                return;
            }
            viewLock = l;
            // "Unlocked after 20 minutes" only until somebody else has had the
            // job or it changed: then the plain free line (build review S4).
            if (viewNotice === 'idle' && ((l.held && !l.mine) || l.rowVersion !== viewedJob.rowVersion)) viewNotice = '';
            if (l.rowVersion !== viewedJob.rowVersion || viewCopyUnchecked) {
                if (!canRedrawView()) {
                    // Newer on the server, held back: the line says so rather
                    // than "last saved just now" over an old copy.
                    redrawWaiting = true;
                } else {
                    const fresh = await fetchJobFresh(jobId);
                    if (seq !== viewPollSeq || !viewedJob || viewedJob.id !== jobId || viewKind !== 'locked') return;
                    if (fresh && fresh.status === 404) { offList(); viewNotice = 'deleted'; viewLock = null; stopViewPoll(); renderViewLine(); return; }
                    if (fresh && fresh.job) {
                        if (fresh.job.archivedDate) { offList(); redrawView(fresh.job); becomeArchivedView(); return; }
                        redrawView(fresh.job);
                    }
                }
            }
            renderViewLine();
        } finally { viewPollBusy = false; }
    }
    // Not while the QC Review window is open over it, and not under a
    // selection somebody is making in the work order (the header, the box,
    // a note): a redraw would take it away mid-copy.
    function canRedrawView() {
        if (lostBoxOpen) return false;
        const m = document.getElementById('reviewModal');
        if (m && m.classList.contains('is-open')) return false;
        const s = window.getSelection ? window.getSelection() : null;
        if (s && s.rangeCount && !s.isCollapsed) {
            const node = s.anchorNode || s.focusNode;
            const el = node && (node.nodeType === 1 ? node : node.parentElement);
            if (el && el.closest && el.closest('#printHeader, #sopContent')) return false;
        }
        return true;
    }
    // The window over the view closing, or a selection going, lets a held
    // redraw through at once rather than at the next poll.
    document.addEventListener('sts-review-closed', () => {
        if (redrawWaiting && viewedJob && viewKind === 'locked') viewPollNow(viewedJob.id, viewPollSeq);
    });
    document.addEventListener('selectionchange', () => {
        if (redrawWaiting && viewedJob && viewKind === 'locked' && canRedrawView()) viewPollNow(viewedJob.id, viewPollSeq);
    });
    // The job's latest copy drawn in place: the reader keeps the department
    // tab, the piece (the first when hers was deleted) and the scroll.
    function redrawView(job) {
        if (!viewedJob || !job || !Array.isArray(job.components) || !job.components.length) return;
        redrawWaiting = false;
        viewCopyUnchecked = false;
        const pieceId = currentComponentId;
        const y = window.scrollY;
        const editorScroll = quill.root.scrollTop;
        viewedJob = job;
        // The list reads the same copy: after a lost box it would otherwise
        // keep her refused values (a status) until the next Refresh. Every
        // writer refuses a viewed job, so the wall is unchanged.
        if (viewKind === 'locked' && !job.archivedDate) adoptFreshJob(job);
        currentComponentId = job.components.some(c => c.id === pieceId) ? pieceId : job.components[0].id;
        editorLoads.clear();
        updatePrintHeader(job);
        renderComponentTabs();
        loadComponentData();
        updateUndoRedoButtons();
        quill.root.scrollTop = editorScroll;
        window.scrollTo(0, y);
    }
    // The job was archived while it was viewed: the archived View from here.
    function becomeArchivedView() {
        if (!viewedJob) return;
        stopViewPoll();
        viewKind = 'archived';
        viewLock = null;
        viewNotice = '';
        document.body.classList.remove('job-view--locked');
        document.body.classList.add('job-view--archived');
        renderViewLine();
        announceJob('sts-job-closed', '', '');
    }
    // The retry queue's entries for one job: counted and forgotten, for the
    // lost path's box.
    function takeRetryEntries(jobId) {
        const mine = _retryQueue.filter(e => e.jobId === jobId).length;
        if (mine) _retryQueue = _retryQueue.filter(e => e.jobId !== jobId);
        retryDropped += mine;
        return mine;
    }

    // Takes away everything a view put on the page. Nothing when no view.
    function endView() {
        if (!viewedJob) return;
        stopViewPoll();
        viewedJob = null;
        viewKind = '';
        viewLock = null;
        viewNotice = '';
        redrawWaiting = false;
        viewCopyUnchecked = false;
        document.body.classList.remove('job-view', 'job-view--archived', 'job-view--locked', 'job-view--free');
        const line = document.getElementById('viewLine');
        if (line) { line.textContent = ''; line.classList.remove('view-line--free'); }
        document.querySelectorAll('.notes[data-view-readonly]').forEach(el => {
            el.readOnly = false;
            el.removeAttribute('data-view-readonly');
        });
        document.querySelectorAll('.meeting-attendees-btn').forEach(btn => { btn.disabled = false; });
        document.querySelectorAll('[data-view-notab]').forEach(el => { el.tabIndex = 0; el.removeAttribute('data-view-notab'); });
        setReadOnly(false);
    }

    async function unarchiveJob(jobId) {
        const active = getActiveJobs();
        if (active.length >= MAX_ACTIVE_JOBS) {
            alert('Max ' + MAX_ACTIVE_JOBS + ' active jobs. Archive or delete one first.');
            return;
        }
        try {
            const res = await fetch('/api/jobs/' + jobId + '/unarchive', { method: 'POST' });
            if (!res.ok) throw new Error('Failed to unarchive');
        } catch (e) {
            showErrorModal("Couldn't restore this job.", 'Refresh');
            return;
        }
        await refreshJobs();
        loadJobs();
        showNoJobState();
    }

    async function deleteArchivedJob(jobId) {
        if (!(await verifyAdminPassword())) return;
        if (!confirm('Permanently delete this archived job?')) return;
        try {
            const res = await fetch('/api/jobs/' + jobId, { method: 'DELETE', headers: apiHeaders(jobId) });
            if (!res.ok) throw new Error('Server returned ' + res.status);
        } catch (e) {
            showErrorModal("Couldn't delete this archived job.", 'Close');
            return;
        }
        renderArchivedJobs();
    }

    // ========== COMPONENT TEMPLATES ==========

    function getTemplates() {
        try {
            return JSON.parse(localStorage.getItem('prepressTemplates') || '[]');
        } catch (e) { return []; }
    }

    function saveTemplates(templates) {
        localStorage.setItem('prepressTemplates', JSON.stringify(templates));
    }

    async function saveAsTemplate() {
        if (!currentJobId || !currentComponentId) return;
        if (!(await verifyAdminPassword())) return;
        saveComponentState();
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components) return;
        const comp = job.components.find(c => c.id === currentComponentId);
        if (!comp) return;

        const defaultName = comp.name + ' - ' + (job.clientName || 'Template');
        const name = prompt('Template name:', defaultName);
        if (!name || !name.trim()) return;

        const templates = getTemplates();
        // Check for duplicate name
        if (templates.some(t => t.name === name.trim())) {
            if (!confirm('A template named "' + name.trim() + '" already exists. Replace it?')) return;
            const idx = templates.findIndex(t => t.name === name.trim());
            templates.splice(idx, 1);
        }

        templates.push({
            id: 'tpl_' + Date.now(),
            name: name.trim(),
            componentName: comp.name,
            checkboxes: { ...comp.checkboxes },
            notes: forgetSummaryFingerprints({ ...comp.notes }),
            createdDate: new Date().toISOString()
        });
        saveTemplates(templates);
        renderTemplatesCol();
        alert('Template "' + name.trim() + '" saved.');
    }

    async function deleteTemplate(tplId) {
        if (!(await verifyAdminPassword())) return;
        if (!confirm('Delete this template?')) return;
        const templates = getTemplates();
        const idx = templates.findIndex(t => t.id === tplId);
        if (idx > -1) {
            templates.splice(idx, 1);
            saveTemplates(templates);
            renderTemplatesCol();
        }
    }

    function renderTemplatesCol() {
        const container = document.getElementById('templatesCol');
        if (!container) return;
        const templates = getTemplates();
        if (templates.length === 0) {
            container.innerHTML = '';
            return;
        }
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const items = templates.map(t => {
            const d = t.createdDate ? new Date(t.createdDate) : null;
            const dateStr = d ? months[d.getMonth()] + ' ' + d.getDate() : '';
            return '<div class="template-item-v2" title="' + escHtml(t.componentName) + ' - Created ' + (d ? d.toLocaleDateString() : '') + '">' +
                '<span class="template-item-v2-text">' + escHtml(t.name) + '</span>' +
                '<span class="template-item-v2-date">' + dateStr + '</span>' +
                '<button class="mini-btn mini-delete" onclick="deleteTemplate(\'' + t.id + '\')" title="Delete template">&times;</button>' +
                '</div>';
        }).join('');
        container.innerHTML =
            '<div class="bottom-section-header">' +
            '<span class="bottom-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>Templates</span>' +
            '<span class="bottom-count">' + templates.length + '</span>' +
            '</div>' +
            items;
    }

    function populateTemplateDropdown(selectId) {
        const sel = document.getElementById(selectId);
        if (!sel) return;
        const templates = getTemplates();
        // Keep "None" option, remove old template options
        sel.innerHTML = '<option value="">None (blank component)</option>';
        templates.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name;
            sel.appendChild(opt);
        });
    }

    function onTemplateSelected(sel) {
        if (!sel.value) return;
        const templates = getTemplates();
        const tpl = templates.find(t => t.id === sel.value);
        if (!tpl) return;
        // Pre-fill component name from template
        const nameInput = document.getElementById('newComponentName');
        if (nameInput && !nameInput.value.trim()) {
            nameInput.value = tpl.componentName;
        }
    }

    function applyTemplateToComponent(tplId, job, comp) {
        if (!tplId) return;
        const templates = getTemplates();
        const tpl = templates.find(t => t.id === tplId);
        if (!tpl) return;
        comp.checkboxes = { ...tpl.checkboxes };
        comp.notes = forgetSummaryFingerprints({ ...tpl.notes });
    }

    // ========== ADMIN PASSWORD ==========
    // Simple obfuscation (btoa) — not cryptographic, just prevents casual reading in localStorage.
    // This is a guard against accidental deletion, not a security system.
    // Admin hash moved to server -- crypto.subtle requires HTTPS,
    // which is unavailable on the LAN (http://192.168.x.x).

    let _adminPwResolve = null;
    // Held only between a successful prompt and the write that follows, so the
    // server can re-check the password on the write itself instead of trusting
    // a "yes" from the browser. Cleared as soon as it is read.
    let _lastAdminPassword = null;

    function takeAdminPassword() {
        const pw = _lastAdminPassword;
        _lastAdminPassword = null;
        return pw;
    }

    async function verifyAdminPassword() {
        return new Promise(resolve => {
            _adminPwResolve = resolve;
            const modal = document.getElementById('adminPasswordModal');
            const input = document.getElementById('adminPasswordInput');
            const error = document.getElementById('adminPwError');
            input.value = '';
            input.type = 'password';
            document.getElementById('adminPwEyeOpen').style.display = '';
            document.getElementById('adminPwEyeClosed').style.display = 'none';
            error.style.display = 'none';
            modal.style.display = 'flex';
            setTimeout(() => input.focus(), 50);
        });
    }

    async function submitAdminPassword() {
        const input = document.getElementById('adminPasswordInput');
        const pw = input.value;
        if (!pw) return;
        try {
            const res = await fetch('/api/verify-admin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pw })
            });
            const data = await res.json();
            if (!data.verified) {
                document.getElementById('adminPwError').style.display = '';
                input.select();
                return;
            }
        } catch (e) {
            showErrorModal("Couldn't verify password. Server may be down.", 'Close');
            return;
        }
        document.getElementById('adminPasswordModal').style.display = 'none';
        _lastAdminPassword = pw;
        if (_adminPwResolve) { _adminPwResolve(true); _adminPwResolve = null; }
    }

    function cancelAdminPassword() {
        document.getElementById('adminPasswordModal').style.display = 'none';
        if (_adminPwResolve) { _adminPwResolve(false); _adminPwResolve = null; }
    }

    function toggleAdminPwVisibility() {
        const input = document.getElementById('adminPasswordInput');
        const eyeOpen = document.getElementById('adminPwEyeOpen');
        const eyeClosed = document.getElementById('adminPwEyeClosed');
        if (input.type === 'password') {
            input.type = 'text';
            eyeOpen.style.display = 'none';
            eyeClosed.style.display = '';
        } else {
            input.type = 'password';
            eyeOpen.style.display = '';
            eyeClosed.style.display = 'none';
        }
        input.focus();
    }

    async function deleteJob() {
        // Taken once, as archiveJob does and for the same reason.
        const jobId = currentJobId;
        // Hidden while viewing; the Archived list's red x deletes an archived job.
        if (!jobId || isViewed(jobId)) return;
        if (!(await verifyAdminPassword())) return;
        if (!(await confirmWithQc('Permanently delete this job?', [jobId], QC_DELETE_LEAD, 'Delete'))) return;

        try {
            const res = await fetch('/api/jobs/' + jobId, { method: 'DELETE', headers: apiHeaders(jobId) });
            if (await refusedByLock(res, jobId)) return;
            if (!res.ok) throw new Error('Failed to delete job');
        } catch (e) {
            showErrorModal("Couldn't delete this job.", 'Refresh');
            return;
        }

        const jobs = getActiveJobs();
        const idx = jobs.findIndex(j => j.id === jobId);
        if (idx > -1) jobs.splice(idx, 1);
        // Cache only: by now another job may be the open one.
        setJobsCacheOnly(jobs);
        delete rowVersions[jobId];
        loadJobs();
        if (currentJobId === jobId) {
            currentJobId = null;
            showNoJobState();
        }
    }

    function showNoJobState() {
        // Leaving a View ends it before anything else. A view never saved or
        // locked anything, so with no job open the send and the lock release
        // below have nothing to do, and ordinary Home is untouched.
        const leftView = !!viewedJob;
        if (viewedJob) { endView(); currentJobId = null; currentComponentId = null; }
        openSeq++;   // a View still waiting for its answer is now stale
        openingJobId = null;
        // Home, Lock instructions and Change user all end here: what was typed
        // or changed in the last moment goes first, while the job is still open.
        sendWaitingSaves();
        // A save owed for the job (Leave without saving, the lost and gone
        // paths, an import over it) is not sent again once it is left; one
        // still on its way that fails is named for the job just left.
        clearSaveTrouble();
        // Let the lock go once those saves have landed (a colleague opening in
        // that instant would otherwise see the last change refused).
        stopLockHeartbeat();
        if (currentJobId) { releaseAfterSaves(currentJobId); keepLeftCopy(currentJobId); }
        setReadOnly(false);

        localStorage.removeItem('prepressActiveJob');
        localStorage.removeItem('prepressActiveJobTime');
        announceJob('sts-job-closed', '', '');
        document.getElementById('noJobState').style.display = 'block';
        document.getElementById('printHeader').style.display = 'none';
        document.getElementById('sopContent').style.display = 'none';
        document.getElementById('masterCheckbox').disabled = true;
        document.getElementById('masterCheckbox').checked = false;
        const searchEl = document.getElementById('searchInput');
        searchEl.disabled = true;
        searchEl.value = '';
        // Clearing the box by code fires nothing, so its highlights go here.
        document.querySelectorAll('.field-row.search-highlight').forEach(row => row.classList.remove('search-highlight'));
        updateLandingGreeting();
        // Back from a View: to the Archived list, on the page and search it
        // was on (both are kept), once it has been drawn again.
        renderArchivedJobs().then(() => {
            const panel = document.getElementById('archivedJobs');
            if (leftView && panel && !panel.hidden && landingShowing()) scrollBelowBars(panel);
        });
        renderTemplatesCol();
        // Refresh the landing page table
        const jobs = getActiveJobs();
        jobs.sort((a, b) => new Date(b.lastAccessed || b.lastModified || b.dateCreated) - new Date(a.lastAccessed || a.lastModified || a.dateCreated));
        applyLandingFilters();
        const container = document.getElementById('jobListContainer');
        container.innerHTML = '';
        if (jobs.length === 0) {
            container.innerHTML = '<div class="no-jobs-message">No jobs available</div>';
        } else {
            jobs.forEach(j => {
                const jobItem = document.createElement('div');
                jobItem.className = 'job-item';
                jobItem.setAttribute('data-job-id', j.id);
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'job-checkbox';
                checkbox.setAttribute('data-job-id', j.id);
                checkbox.onclick = (e) => { e.stopPropagation(); updateDeleteSelectedButton(); updateSelectAllCheckbox(); };
                const text = document.createElement('span');
                text.className = 'job-item-text';
                const desc = j.jobDescription ? ` - ${j.jobDescription}` : '';
                text.textContent = `${j.jobNumber} - ${j.clientName}${desc}`;
                text.onclick = () => { loadJob(j.id); closeJobDropdown(); };
                const deleteBtn = document.createElement('button');
                deleteBtn.type = 'button';
                deleteBtn.className = 'job-item-delete';
                deleteBtn.innerHTML = '\u00d7';
                deleteBtn.title = 'Delete this job';
                deleteBtn.onclick = (e) => { e.stopPropagation(); deleteSingleJob(j.id); };
                jobItem.appendChild(checkbox);
                jobItem.appendChild(text);
                jobItem.appendChild(deleteBtn);
                container.appendChild(jobItem);
            });
        }
        document.getElementById('selectAllJobsCheckbox').checked = false;
        updateDeleteSelectedButton();
        currentJobId = null;
        currentComponentId = null;
        clearAllUndoStacks();
        focusSnapshot = null;
        fieldDirty = false;
        updateUndoRedoButtons();
    }

    /* ════════════════════════════════════════════════════════════════
       DEPARTMENT SWITCHING
       ════════════════════════════════════════════════════════════════ */
    function switchDepartment(deptId) {
        if (deptId === activeDepartment) return;

        // If the user was mid-edit (focused field had keystrokes), push the
        // current state into the OUTGOING dept's undo stack so undo remains
        // reachable after returning.
        if (currentJobId && fieldDirty) pushToUndo(true);
        fieldDirty = false;
        focusSnapshot = null;

        // Save editor → outgoing dept's field BEFORE flipping activeDepartment.
        // That saves any typing still waiting too, so its timer goes: fired
        // later it would read the incoming department's screen instead.
        if (currentJobId) {
            saveComponentState();
            clearTimeout(saveDebounceTimer);
            saveDebounceTimer = null;
        }

        activeDepartment = deptId;
        announceJob('sts-dept-changed', currentJobId, deptId);

        // Toggle tab active state
        document.querySelectorAll('.dept-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.dept === deptId);
        });

        // Toggle checklist panel visibility
        const dept = window.DEPT_REGISTRY[deptId];
        document.querySelectorAll('.dept-checklist').forEach(panel => {
            panel.classList.toggle('active', panel.id === dept.panelId);
        });
        // A note box in a hidden panel was sized to nothing when the piece
        // loaded, so the panel now showing is sized again.
        autoResizeAllTextareas();

        // Which tab is showing is kept in this page's copy of the job, never
        // sent on its own (see setJobsCacheOnly): a real change sends it with
        // the row.
        if (currentJobId) {
            const jobs = getActiveJobs();
            const job = jobs.find(j => j.id === currentJobId);
            if (job && !isViewed(job.id)) {
                job.activeDepartment = deptId;
                setJobsCacheOnly(jobs);
            }
        }

        // Swap editor content to the incoming dept's instructions + history.
        // The load uses source 'api' so text-change listeners treat it as
        // programmatic, not a user edit.
        if (currentJobId) {
            // The piece on screen, a viewed archived job's included.
            // getCurrentComponent stays on the active list: Generate uses it.
            const shown = shownJob();
            const comp = shown && shown.components ? shown.components.find(c => c.id === currentComponentId) : null;
            if (comp) {
                migrateInstructionsToPerDept(comp);
                const instr = comp['instructions_' + deptId] || '';
                const hist = comp['instructionsHistory_' + deptId] || '';
                loadEditor(comp, deptId);
                document.getElementById('instructionsHistory').innerHTML = cleanHtml(hist);
                const fullInstructions = instructionsAsHtml(instr) + (instr && hist ? '<br><br>' : '') + hist;
                document.getElementById('instructionsDisplay').innerHTML = cleanHtml(fullInstructions);
                quill.root.scrollTop = 0;
                // Reset QC strip — it's scenario-specific to the previous state
                const qcStrip = document.getElementById('qcInlineStrip');
                if (qcStrip) qcStrip.style.display = 'none';
                // Rebuild revision timeline against the newly-pasted history DOM
                buildRevisionTimeline();
            }
        }

        // Update sidebar title and print heading for active department
        const sidebarEl = document.getElementById('sidebarTitle');
        if (sidebarEl && dept.sidebarTitle) sidebarEl.textContent = dept.sidebarTitle;
        const printEl = document.getElementById('printHeading');
        if (printEl && dept.printHeading) printEl.textContent = dept.printHeading;

        // Update dropdowns and required indicators for the active department
        updateDeptDropdowns();
        updateRequiredIndicators();
        updateRowVisibility();
        updateMasterCheckbox();
        updateGroupCheckboxes();

        // Refresh undo/redo button enabled-state against the incoming dept's stacks
        updateUndoRedoButtons();

        // Refresh billboard assignee (dept-aware)
        if (currentJobId) {
            const job2 = shownJob();
            if (job2) updatePrintHeader(job2);
        }
    }

    // Update dropdowns using the active department's registry
    function updateDeptDropdowns() {
        const dept = window.DEPT_REGISTRY[activeDepartment];
        if (!dept || !dept.updateDropdowns) return;
        const job = shownJob();
        if (!job || !job.components) return;
        const comp = job.components.find(c => c.id === currentComponentId);
        if (!comp) return;
        dept.updateDropdowns(comp);
    }

    // Get required fields from active department's registry
    function getDeptRequiredFields() {
        const dept = window.DEPT_REGISTRY[activeDepartment];
        if (!dept) return [];
        const job = shownJob();
        const comp = job && job.components ? job.components.find(c => c.id === currentComponentId) : null;
        return dept.getRequiredFields(comp);
    }

    // Gray out a checklist row (toggle, text input, dropdown button) by its note input data-id.
    // Saved values are kept; the row just cannot be edited.
    function setFieldRowDisabled(noteId, disabled) {
        const input = document.querySelector('[data-id="' + noteId + '"]');
        if (!input) return;
        const row = input.closest('.field-row');
        if (!row) return;
        const checkbox = row.querySelector('.toggle-switch input[type="checkbox"]');
        const btn = row.querySelector('.quick-pick-btn');
        input.disabled = disabled;
        if (checkbox) checkbox.disabled = disabled;
        if (btn) btn.disabled = disabled;
        row.classList.toggle('field-row-disabled', disabled);
    }

    function updateRowVisibility() {
        // First, mark individual rows and handle empty notes
        document.querySelectorAll('.field-row').forEach(item => {
            const checkbox = item.querySelector('.toggle-switch input[type="checkbox"]');
            const noteInput = item.querySelector('.notes');
            const hasCheckbox = checkbox && checkbox.checked;
            const hasNote = noteInput && noteInput.value.trim() !== '';

            // Mark empty notes for hiding in print
            if (noteInput) {
                if (!hasNote) {
                    noteInput.classList.add('empty-note');
                } else {
                    noteInput.classList.remove('empty-note');
                }
            }

            // Filepath rows: only count as content when toggled on
            const noteId = noteInput ? (noteInput.getAttribute('data-id') || '') : '';
            const isFilepath = noteId.startsWith('fp') || noteId.startsWith('ts_fp');
            const showContent = isFilepath ? hasCheckbox : (hasCheckbox || hasNote);

            if (showContent) {
                item.classList.add('has-content');
            } else {
                item.classList.remove('has-content');
            }
        });

        // Gray out Prepress rows that do not apply to this piece type (see getDisabledFields in prepress.js):
        // Indicia unless envelope, postcard, or self-mailer; Print marks, Number Up, Head info, Binding info on envelopes
        const job_rv = shownJob();
        const comp_rv = job_rv && job_rv.components ? job_rv.components.find(c => c.id === currentComponentId) : null;
        const dept = window.DEPT_REGISTRY.prepress;
        if (dept) {
            const disabled = dept.getDisabledFields(comp_rv);
            ['sp7n'].concat(dept.ENVELOPE_DISABLED_FIELDS).forEach(id => setFieldRowDisabled(id, disabled.includes(id)));
        }

        // Then, mark entire groups based on whether they have any content
        document.querySelectorAll('.section-group').forEach(group => {
            const hasAnyContent = group.querySelectorAll('.field-row.has-content').length > 0;
            if (hasAnyContent) {
                group.classList.add('has-content');
            } else {
                group.classList.remove('has-content');
            }
        });
    }

    // Sanitize text for use in PDF filename (remove/replace problematic characters)
    function sanitizeForFilename(text) {
        return text.replace(/\./g, '_').replace(/[<>:"/\\|?*]/g, '_');
    }

    // Track print version per job+component so filenames auto-increment
    function getPrintFilename(jobNumber, compName) {
        const base = `${jobNumber} - ${sanitizeForFilename(compName)}`;
        const key = `printVersion:${base}`;
        const count = parseInt(localStorage.getItem(key) || '0', 10) + 1;
        localStorage.setItem(key, count);
        return count === 1 ? base : `${base} (v${count})`;
    }

    function escHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    // A value inside an inline handler (onclick="loadJob(...)"): a script
    // string first, then an attribute. The browser decodes the attribute
    // before it runs the handler, so escHtml alone lets a quote back in and
    // the value out of its string (the overall review's R01, 2026-10-01).
    function jsArg(value) {
        return escHtml(JSON.stringify(String(value)));
    }

    // Static field map — mirrors the section-group DOM structure so print
    // can read from saved data instead of scraping the live page.
    const PRINT_SECTIONS = [
        { title: 'Piece Specs', fields: [
            { cbId: 'sp1', noteId: 'sp1n', label: 'Previous Job#' },
            { cbId: 'ps3', noteId: 'ps3n', label: 'Flat Size' },
            { cbId: 'ps4', noteId: 'ps4n', label: 'Finished Size' },
            { cbId: 'sp2', noteId: 'sp2n', label: 'Presswork' },
            { cbId: 'sp3', noteId: 'sp3n', label: 'Press' },
            { cbId: 'ps1', noteId: 'ps1n', label: 'Sheet size' },
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
    ];

    // ========== CLEAN IFRAME PRINT ==========
    //
    // The printed work order (item 6b: design 2a, picked by David with Claude
    // Design, and his answers of 2026-09-29; PRINT_REFRESH_PLAN.md): bigger
    // text, less wasted space, and values easy to copy with nothing extra.
    // The tick is a drawn mark, so it never copies. A path prints under its
    // label, on one line, in a fixed-width face: in Chrome's PDF viewer a
    // triple-click copies a line, and a label beside the path would come with
    // it (tested). Which rows print, the header fields, their order and the
    // file name are what they were.

    // Rows that hold a path: every File Path box but Record Counts (fp6),
    // which prints as an ordinary value (David, 2026-09-29).
    function isPrintPath(cbId) {
        return (cbId.startsWith('fp') || cbId.startsWith('ts_fp')) && cbId !== 'fp6';
    }
    // A path line too long for the line prints smaller, sized from its length,
    // so it stays whole on one line (David: shrink to fit). 716px is the line
    // (739px across the page, less the tick and its gap, less a little); 0.6
    // is Courier New's width per character, the wider of the two faces, so
    // the path fits in either; a tab counts as 8. 13px holds 91 characters and
    // the floor of 8px 149; a longer line wraps at 8px (David, 2026-09-29).
    // Anything longer than the page would make Chrome shrink the whole sheet.
    function printPathSize(lines) {
        const longest = Math.max(1, ...lines.map(l => l.replace(/\t/g, '        ').length));
        return Math.max(8, Math.min(13, Math.floor(716 / (longest * 0.6) * 10) / 10));
    }
    // Text for a CSS string (the page footer), every character but letters,
    // digits, space, comma and full stop escaped, so a piece named "</style>"
    // stays a name (as review.js cssString).
    function printCssString(text) {
        return '"' + String(text).replace(/[^A-Za-z0-9 ,.]/gu, ch => '\\' + ch.codePointAt(0).toString(16) + ' ') + '"';
    }

    // The sheet's own styles. The accent is each piece's --acc, because Print
    // All as One PDF keeps only the first piece's head. The Quill block is the
    // signed sheet's (styles.css, "Quill in the signed sheet") word for word
    // with .instr-body for .review-sheet-instructions, so lists, indents and
    // sizes print as they show there; dev/print-sheet-check.js compares them.
    const PRINT_SHEET_CSS = [
        '* { margin:0; padding:0; box-sizing:border-box; }',
        // Margin boxes (the footer) take the root's font, or print in a serif.
        'html { font-family: Arial, Helvetica, sans-serif; color:#1a1a2e; }',
        'body { font-size:11px; }',
        '@page { margin: 0.5in 0.4in;',
        '  @bottom-center { content: ""; border-top:1px solid #d8d8e0; }',
        '  @bottom-right { content: "Page " counter(page) " of " counter(pages); font-size:10.5px; color:#6b6b80; border-top:1px solid #d8d8e0; vertical-align:top; padding-top:6px; } }',
        'b, strong { font-weight:700; }',
        '.wo-piece { break-before:page; }',
        '.wo-band { padding:6px 12px; border-radius:6px; background:var(--acc); color:#fff; font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:0.12em; margin-bottom:12px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }',
        '.wo-head { display:grid; row-gap:10px; column-gap:18px; margin-bottom:8px; }',
        '.wo-r1 { grid-row:1; }',
        '.wo-r2 { grid-row:2; }',
        '.wo-cell { display:flex; flex-direction:column; gap:2px; min-width:0; }',
        '.wo-cell-label { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.1em; color:#6b6b80; }',
        '.wo-cell-value { font-size:18px; font-weight:700; color:#1a1a2e; overflow-wrap:anywhere; }',
        '.wo-cell-value.wo-job { font-size:22px; color:var(--acc); }',
        '.wo-cell-value.wo-project { font-size:15px; }',
        '.wo-cell-value.wo-version { color:var(--acc); }',
        '.wo-meta { display:flex; justify-content:space-between; gap:16px; font-size:11px; color:#6b6b80; padding-top:5px; border-top:2px solid #1a1a2e; margin-bottom:18px; }',
        '.wo-meta-v { color:#3d3d56; font-weight:500; }',
        '.wo-meta-dup { color:var(--acc); font-weight:600; }',
        '.wo-printed { flex:none; }',
        '.wo-title { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--acc); padding-bottom:3px; border-bottom:2px solid var(--acc); break-after:avoid; }',
        '.wo-instr { display:flex; flex-direction:column; gap:6px; margin-bottom:20px; }',
        '.instr-body { font-size:14.5px; line-height:1.5; color:#000; overflow-wrap:anywhere; }',
        '.wo-rev { border-top:1px solid #ddd; padding-top:8px; margin-top:14px; }',
        '.wo-rev:first-child { margin-top:8px; }',
        '.wo-rev-head { font-size:11px; font-weight:700; color:#6b6b80; margin-bottom:4px; break-after:avoid; }',
        // Pasted text keeps its colours in the stored words: on paper the text
        // is black, and a background prints only when it is the app's own
        // highlight yellow (#fef3a0, stored as rgb(254, 243, 160)), which then
        // prints whatever the print box's Background graphics says (David,
        // 2026-09-29).
        '.instr-body, .instr-body * { color:#000 !important; }',
        '.instr-body [style*="background"] { background:none !important; }',
        '.instr-body mark, .instr-body [style*="254, 243, 160"], .instr-body [style*="254,243,160"], .instr-body [style*="fef3a0" i] { background:#fef3a0 !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }',
        // Nothing stored may be wider than the page, or Chrome shrinks the
        // whole sheet to fit it: a <pre> or a wide table an import can bring.
        '.instr-body pre { white-space:pre-wrap; }',
        '.instr-body table { width:auto !important; max-width:100%; }',
        '.wo-sections { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); column-gap:28px; row-gap:18px; align-items:start; }',
        // A section stays whole on one page, as it always has (a section
        // taller than a page still breaks). That also keeps a split
        // section's down-then-across order, which a page break inside it
        // would scramble.
        '.wo-section { break-inside:avoid; }',
        '.wo-full { grid-column:1 / -1; }',
        '.wo-split { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); grid-auto-flow:column; column-gap:28px; }',
        '.wo-row { display:flex; gap:8px; align-items:flex-start; padding:6px 0; border-bottom:1px solid #e8e8ee; break-inside:avoid; }',
        '.wo-tick { width:11px; height:11px; flex:none; margin-top:3px; display:flex; align-items:center; justify-content:center; background:var(--acc); -webkit-print-color-adjust:exact; print-color-adjust:exact; }',
        '.wo-tick::after { content:""; width:3px; height:6px; border-right:1.6px solid #fff; border-bottom:1.6px solid #fff; transform:translateY(-1px) rotate(45deg); }',
        '.wo-tick.wo-off { background:#fff; border:1.5px solid #999; }',
        '.wo-tick.wo-off::after { display:none; }',
        '.wo-label { font-size:11px; line-height:17px; color:#6b6b80; flex:none; width:140px; white-space:nowrap; }',
        '.wo-value { font-size:14px; line-height:17px; font-weight:700; color:#1a1a2e; flex:1; min-width:0; white-space:pre-wrap; overflow-wrap:anywhere; }',
        '.wo-value.wo-name { white-space:normal; }',
        '.wo-stack { display:flex; flex-direction:column; gap:2px; flex:1; min-width:0; }',
        '.wo-stack .wo-label { width:auto; }',
        '.wo-path { font-family: Consolas, "Courier New", monospace; font-weight:400; line-height:17px; color:#1a1a2e; white-space:pre-wrap; overflow-wrap:anywhere; }',
        '/* Quill (start) */',
        '.instr-body ol, .instr-body ul { padding-left: 1.5em; margin: 2px 0; }',
        '.instr-body ul { list-style-type: disc; }',
        '.instr-body ol { counter-reset: list-0 list-1 list-2 list-3 list-4 list-5 list-6 list-7 list-8 list-9; }',
        '.instr-body li[data-list] { list-style-type: none; padding-left: 1.5em; position: relative; counter-set: list-1 list-2 list-3 list-4 list-5 list-6 list-7 list-8 list-9; }',
        '.instr-body li[data-list] > .ql-ui { position: absolute; }',
        '.instr-body li[data-list] > .ql-ui::before { display: inline-block; margin-left: -1.5em; margin-right: 0.3em; text-align: right; white-space: nowrap; width: 1.2em; }',
        '.instr-body li[data-list=bullet] > .ql-ui::before { content: "•"; }',
        '.instr-body li[data-list=checked] > .ql-ui::before { content: "☑"; }',
        '.instr-body li[data-list=unchecked] > .ql-ui::before { content: "☐"; }',
        '.instr-body li[data-list=ordered] { counter-increment: list-0; }',
        '.instr-body li[data-list=ordered] > .ql-ui::before { content: counter(list-0, decimal) ". "; }',
        '.instr-body li[data-list].ql-indent-1 { counter-set: list-2 list-3 list-4 list-5 list-6 list-7 list-8 list-9; }',
        '.instr-body li[data-list=ordered].ql-indent-1 { counter-increment: list-1; }',
        '.instr-body li[data-list=ordered].ql-indent-1 > .ql-ui::before { content: counter(list-1, lower-alpha) ". "; }',
        '.instr-body li[data-list].ql-indent-2 { counter-set: list-3 list-4 list-5 list-6 list-7 list-8 list-9; }',
        '.instr-body li[data-list=ordered].ql-indent-2 { counter-increment: list-2; }',
        '.instr-body li[data-list=ordered].ql-indent-2 > .ql-ui::before { content: counter(list-2, lower-roman) ". "; }',
        '.instr-body li[data-list].ql-indent-3 { counter-set: list-4 list-5 list-6 list-7 list-8 list-9; }',
        '.instr-body li[data-list=ordered].ql-indent-3 { counter-increment: list-3; }',
        '.instr-body li[data-list=ordered].ql-indent-3 > .ql-ui::before { content: counter(list-3, decimal) ". "; }',
        '.instr-body li[data-list].ql-indent-4 { counter-set: list-5 list-6 list-7 list-8 list-9; }',
        '.instr-body li[data-list=ordered].ql-indent-4 { counter-increment: list-4; }',
        '.instr-body li[data-list=ordered].ql-indent-4 > .ql-ui::before { content: counter(list-4, lower-alpha) ". "; }',
        '.instr-body li[data-list].ql-indent-5 { counter-set: list-6 list-7 list-8 list-9; }',
        '.instr-body li[data-list=ordered].ql-indent-5 { counter-increment: list-5; }',
        '.instr-body li[data-list=ordered].ql-indent-5 > .ql-ui::before { content: counter(list-5, lower-roman) ". "; }',
        '.instr-body li[data-list].ql-indent-6 { counter-set: list-7 list-8 list-9; }',
        '.instr-body li[data-list=ordered].ql-indent-6 { counter-increment: list-6; }',
        '.instr-body li[data-list=ordered].ql-indent-6 > .ql-ui::before { content: counter(list-6, decimal) ". "; }',
        '.instr-body li[data-list].ql-indent-7 { counter-set: list-8 list-9; }',
        '.instr-body li[data-list=ordered].ql-indent-7 { counter-increment: list-7; }',
        '.instr-body li[data-list=ordered].ql-indent-7 > .ql-ui::before { content: counter(list-7, lower-alpha) ". "; }',
        '.instr-body li[data-list].ql-indent-8 { counter-set: list-9; }',
        '.instr-body li[data-list=ordered].ql-indent-8 { counter-increment: list-8; }',
        '.instr-body li[data-list=ordered].ql-indent-8 > .ql-ui::before { content: counter(list-8, lower-roman) ". "; }',
        '.instr-body .ql-indent-1 { padding-left: 3em; }',
        '.instr-body li.ql-indent-1 { padding-left: 4.5em; }',
        '.instr-body .ql-indent-2 { padding-left: 6em; }',
        '.instr-body li.ql-indent-2 { padding-left: 7.5em; }',
        '.instr-body .ql-indent-3 { padding-left: 9em; }',
        '.instr-body li.ql-indent-3 { padding-left: 10.5em; }',
        '.instr-body .ql-indent-4 { padding-left: 12em; }',
        '.instr-body li.ql-indent-4 { padding-left: 13.5em; }',
        '.instr-body .ql-indent-5 { padding-left: 15em; }',
        '.instr-body li.ql-indent-5 { padding-left: 16.5em; }',
        '.instr-body .ql-indent-6 { padding-left: 18em; }',
        '.instr-body li.ql-indent-6 { padding-left: 19.5em; }',
        '.instr-body .ql-indent-7 { padding-left: 21em; }',
        '.instr-body li.ql-indent-7 { padding-left: 22.5em; }',
        '.instr-body .ql-indent-8 { padding-left: 24em; }',
        '.instr-body li.ql-indent-8 { padding-left: 25.5em; }',
        '.instr-body .ql-size-small { font-size: 0.75em; }',
        '.instr-body .ql-size-large { font-size: 1.5em; }',
        '.instr-body .ql-size-huge { font-size: 2.5em; }',
        '.instr-body .ql-align-center { text-align: center; }',
        '.instr-body .ql-align-right { text-align: right; }',
        '.instr-body .ql-align-justify { text-align: justify; }',
        '.instr-body blockquote { border-left: 4px solid #ccc; margin: 5px 0; padding-left: 16px; }',
        '.instr-body img { max-width: 100%; height: auto; }',
        '/* Quill (end) */',
        // The signed sheet positions its list markers, and Chrome draws
        // positioned text after everything else on the page, so a list copied
        // out of the PDF came out last, each number after its line: the same
        // look, in order.
        '.instr-body li[data-list], .instr-body li[data-list] > .ql-ui { position: static; }'
    ].join('\n');

    function buildPrintHTML(job, comp, deptId) {
        const resolvedDeptId = deptId || activeDepartment;
        const dept = window.DEPT_REGISTRY[resolvedDeptId] || window.DEPT_REGISTRY.prepress;
        const accentColor = dept.printAccent || '#CB333B';
        const printTitle = dept.printHeading || 'Instructions';
        const printSections = dept.PRINT_SECTIONS || PRINT_SECTIONS;

        const formatDateTime = (d) => new Date(d).toLocaleString('en-US', {month:'2-digit',day:'2-digit',year:'numeric', hour:'numeric', minute:'2-digit', hour12:true});

        // Build sections from saved data (not from the live DOM)
        const checks = comp.checkboxes || {};
        const notes = comp.notes || {};
        // Rows grayed out for this piece type are left off the printout
        const disabledFields = dept.getDisabledFields ? dept.getDisabledFields(comp) : [];
        const sections = [];
        printSections.forEach(section => {
            const rows = [];
            section.fields.forEach(f => {
                if (disabledFields.includes(f.noteId)) return;
                const checked = !!checks[f.cbId];
                const val = (notes[f.noteId] || '').trim();
                // Filepath rows: only print when toggled on (text alone is not enough)
                const isFilepath = f.cbId.startsWith('fp') || f.cbId.startsWith('ts_fp');
                if (isFilepath ? checked : (checked || val)) {
                    rows.push({ label: f.label, val, checked, path: isPrintPath(f.cbId) });
                }
            });
            if (rows.length > 0) sections.push({ title: section.title, rows });
        });

        // Build instructions HTML from saved data (strip summary marker lines from print).
        // Collect every registered dept's marker strings so we strip them all — that way
        // a TS component's "── TS Summary ──" lines vanish on print just as cleanly as
        // a prepress component's "── Specs ──" lines, with no per-dept branching here.
        function stripSpecsMarkers(html) {
            // Parsed in a document of its own, where nothing in it can run
            // (R25); the sheet then prints in the sandboxed frame.
            const div = inertBody(html);
            const allMarkers = [];
            Object.values(window.DEPT_REGISTRY || {}).forEach(d => {
                if (d.summaryMarkerStart) allMarkers.push(d.summaryMarkerStart);
                if (d.summaryMarkerEnd)   allMarkers.push(d.summaryMarkerEnd);
            });
            const walker = div.ownerDocument.createTreeWalker(div, NodeFilter.SHOW_TEXT);
            const toRemove = [];
            while (walker.nextNode()) {
                const text = walker.currentNode.textContent;
                if (allMarkers.some(m => text.includes(m))) {
                    // Remove the closest block-level parent (<p>) or the text node's parent
                    let el = walker.currentNode.parentElement;
                    while (el && el !== div && el.tagName !== 'P' && el.tagName !== 'LI') el = el.parentElement;
                    if (el && el !== div) toRemove.push(el);
                }
            }
            toRemove.forEach(el => el.remove());
            return div.innerHTML;
        }
        const instrHTML = stripSpecsMarkers(instructionsAsHtml(comp['instructions_' + resolvedDeptId]));
        const historyHTML = comp['instructionsHistory_' + resolvedDeptId] || '';
        // Words, or a picture: instructions that are only a picture were left
        // off the print before (the plan critique, 2026-09-29).
        const hasInstructions = instrHTML.replace(/<[^>]*>/g, '').trim() || /<img/i.test(instrHTML);
        const hasHistory = historyHTML.replace(/<[^>]*>/g, '').trim() || /<img/i.test(historyHTML);

        // This piece's own revision history, newest round first. Lock instructions
        // empties the instructions box into this blob, so for a filed piece the
        // history IS the instructions and has to reach the printed work order.
        // The blob is one HTML string of divider / timestamp / content triples
        // (closeCurrentJob builds them), parsed here on a detached div the same
        // way stripSpecsMarkers above reads its markers. It is deliberately never
        // read from the live page: #instructionsHistory and #revisionTimeline hold
        // whichever piece is on screen, which in a print-all is not the piece we
        // were handed.
        function buildRevisionsHTML(html) {
            const div = inertBody(html);
            const stamps = Array.from(div.querySelectorAll('.history-timestamp'));
            return stamps.map((ts, idx) => {
                // Stored newest first and R1 is the oldest, so the number the
                // timeline shows falls out of the position, as it does there.
                const revNum = stamps.length - idx;
                const content = ts.nextElementSibling;
                return '<div class="wo-rev"><div class="wo-rev-head">R' + revNum + ' - ' + escHtml(ts.textContent.replace(/^\(\d+\)\s*/, '')) + '</div>' +
                    '<div class="instr-body">' + (content ? content.innerHTML : '') + '</div></div>';
            }).join('');
        }
        // Filed verbatim by closeCurrentJob, marker lines and all, so the history
        // is stripped the same way the live instructions are just above.
        const revisionsHTML = hasHistory ? buildRevisionsHTML(stripSpecsMarkers(historyHTML)) : '';

        // One title on both departments: the band above names the department
        // (David, 2026-09-29: on Prepress it said "Prepress Instructions" twice).
        let instrSection = '';
        if (hasInstructions || revisionsHTML) {
            instrSection = '<div class="wo-instr"><div class="wo-title">Instructions</div>' +
                (hasInstructions ? '<div class="instr-body">' + instrHTML + '</div>' : '') +
                (revisionsHTML ? '<div>' + revisionsHTML + '</div>' : '') + '</div>';
        }

        // One row: a drawn tick (a grey square when the switch is off but the
        // box has words), then the label and the value. A path puts its label
        // above it, each line of the box on a line of its own; a row with
        // nothing but its switch prints its name in the value's style.
        function rowHTML(r) {
            const tick = '<span class="wo-tick' + (r.checked ? '' : ' wo-off') + '"></span>';
            if (r.path && r.val) {
                const lines = r.val.split(/\r?\n/).map(l => l.trim());
                return '<div class="wo-row">' + tick + '<div class="wo-stack"><span class="wo-label">' + escHtml(r.label) + '</span>' +
                    '<span class="wo-path" style="font-size:' + printPathSize(lines) + 'px;">' + escHtml(lines.join('\n')) + '</span></div></div>';
            }
            if (!r.val) return '<div class="wo-row">' + tick + '<span class="wo-value wo-name">' + escHtml(r.label) + '</span></div>';
            return '<div class="wo-row">' + tick + '<span class="wo-label">' + escHtml(r.label) + '</span>' +
                '<span class="wo-value">' + escHtml(r.val).replace(/\n/g, '<br>') + '</span></div>';
        }
        // Sections pair up two across, in order. A section holding a path row
        // runs full width and ends the run; the last of a run with an odd
        // count runs full width with its rows in two columns that read down,
        // then across.
        const laid = [];
        let run = [];
        const endRun = () => {
            run.forEach((s, i) => laid.push({ s, split: run.length % 2 === 1 && i === run.length - 1 }));
            run = [];
        };
        sections.forEach(s => {
            if (s.rows.some(r => r.path)) { endRun(); laid.push({ s, full: true }); }
            else run.push(s);
        });
        endRun();
        const sectionsHTML = laid.map(({ s, full, split }) =>
            '<div class="wo-section' + (full || split ? ' wo-full' : '') + '"><div class="wo-title">' + escHtml(s.title) + '</div>' +
            (split ? '<div class="wo-split" style="grid-template-rows:repeat(' + Math.ceil(s.rows.length / 2) + ',auto);">' : '<div>') +
            s.rows.map(rowHTML).join('') + '</div></div>').join('');

        // Signoff due (dept-aware via resolvedDeptId). Compact format: "5/13/26 4pm" or "5/13/26 8:30am".
        // Cell only renders when at least one of date/time is set for the active dept.
        const pfDateKey = resolvedDeptId === 'techservices' ? 'signoffDueDateTechservices' : 'signoffDueDatePrepress';
        const pfTimeKey = resolvedDeptId === 'techservices' ? 'signoffDueTimeTechservices' : 'signoffDueTimePrepress';
        const pfRawDate = (job[pfDateKey] || '').trim();
        const pfRawTime = (job[pfTimeKey] || '').trim();
        const pfSignoffParts = [];
        if (pfRawDate) {
            const d = new Date(pfRawDate + 'T00:00:00');
            if (!isNaN(d.getTime())) {
                pfSignoffParts.push((d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(-2));
            } else {
                pfSignoffParts.push(pfRawDate);
            }
        }
        if (pfRawTime) {
            let t = pfRawTime.replace(':00', '');
            t = t.replace(/\s*(AM|PM)\s*$/i, function(_, mp) { return mp.toLowerCase(); });
            pfSignoffParts.push(t);
        }
        const pfSignoffStr = pfSignoffParts.join(' ');

        // The header: row 1 Job #, Client, CSR; row 2 Project (an empty cell
        // when there is none, so Component stays under Client), Component, and
        // Signoff due and Version when there are. Placed by row, so a Version
        // with a Signoff due makes a fourth, narrow column, as the table did.
        const cell = (row, label, value, cls) => '<div class="wo-cell wo-r' + row + '"><div class="wo-cell-label">' + label + '</div>' +
            '<div class="wo-cell-value' + (cls ? ' ' + cls : '') + '">' + escHtml(value) + '</div></div>';
        const headCols = 'minmax(0,1fr) minmax(0,1.2fr) minmax(0,1fr)' + (pfSignoffStr && comp.version ? ' auto' : '');
        const headHTML = '<div class="wo-head" style="grid-template-columns:' + headCols + ';">' +
            cell(1, 'Job #', job.jobNumber, 'wo-job') + cell(1, 'Client', job.clientName) + cell(1, 'CSR', job.csrName) +
            (job.jobDescription ? cell(2, 'Project', job.jobDescription, 'wo-project') : '<div class="wo-cell wo-r2"></div>') +
            cell(2, 'Component', comp.name) +
            (pfSignoffStr ? cell(2, 'Signoff due', pfSignoffStr) : '') +
            (comp.version ? cell(2, 'Version', comp.version, 'wo-version') : '') + '</div>';

        // Every page names its piece at the foot. Each piece's pages are a page
        // of their own name (by its place on the job, never its id, which an
        // import can bring in any shape), so Print All as One PDF, one
        // document, names the right piece on each page; its page count runs
        // through the whole file (David, 2026-09-29).
        const pageName = 'wo' + (Math.max(0, (job.components || []).findIndex(c => c.id === comp.id)) + 1);
        const footCss = '@page ' + pageName + ' { @bottom-left { content: ' + printCssString('Job ' + (job.jobNumber || '') + ' · ' + (comp.name || '')) +
            '; font-size:10.5px; color:#6b6b80; border-top:1px solid #d8d8e0; vertical-align:top; padding-top:6px; } }';

        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>${escHtml(job.jobNumber)} - ${escHtml(sanitizeForFilename(comp.name))}</title>
<style>
${PRINT_SHEET_CSS}
</style>
</head><body>
<div class="wo-piece" style="page:${pageName};--acc:${accentColor};">
<style>${footCss}</style>
<div class="wo-band">${escHtml(printTitle)}</div>
${headHTML}
<div class="wo-meta"><span>Created: <span class="wo-meta-v">${formatDateTime(job.dateCreated)}${job.createdBy ? ' by ' + escHtml(job.createdBy) : ''}</span>
    &nbsp;&middot;&nbsp;
    Modified: <span class="wo-meta-v">${formatDateTime(job.lastModified)}${job.lastModifiedBy ? ' by ' + escHtml(job.lastModifiedBy) : ''}</span>
    ${job.headerModified ? '&nbsp;&middot;&nbsp; Header edited: <span class="wo-meta-v">' + formatDateTime(job.headerModified) + (job.headerModifiedBy ? ' by ' + escHtml(job.headerModifiedBy) : '') + '</span>' : ''}
    ${job.duplicatedFrom ? '&nbsp;&middot;&nbsp; Duplicated from: <span class="wo-meta-dup">#' + escHtml(job.duplicatedFrom) + '</span>' : ''}</span>
<span class="wo-printed">Printed: <span class="wo-meta-v">${formatDateTime(new Date().toISOString())}</span></span></div>
${instrSection}
<div class="wo-sections">${sectionsHTML}</div>
</div>
</body></html>`;
    }

    function printViaIframe(html, pdfName, onDone) {
        let iframe = document.getElementById('printFrame');
        if (iframe) iframe.remove();
        iframe = document.createElement('iframe');
        iframe.id = 'printFrame';
        // Set before the frame is in the page, or it does not apply: nothing
        // in the sheet runs (a <script>, an onerror, in stored instructions),
        // but this page may write its document and ask it to print, as the
        // signed sheet's Export frame does (R25, the after-rollout batch, item
        // 12; EXPORT_PLAN). afterprint still reaches the handler below: run
        // in a real kiosk-printing Chrome, 2026-10-02.
        iframe.setAttribute('sandbox', 'allow-same-origin allow-modals');
        iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;height:600px;border:none;';
        document.body.appendChild(iframe);
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        doc.open();
        doc.write(html);
        doc.close();
        const originalTitle = document.title;
        if (pdfName) document.title = pdfName;
        iframe.contentWindow.onafterprint = () => { document.title = originalTitle; iframe.remove(); if (onDone) onDone(); };
        setTimeout(() => { iframe.contentWindow.print(); }, 100);
    }

    // ========== A PRINT PRINTS THE LATEST SAVED COPY (item 4) ==========
    //
    // Every print (the three in the Print menu, and Ctrl+P, the browser's own
    // print of the work order screen) printed the page's own copy of the job.
    // Since item 3 a read-only view follows the holder's saves every 15 s and
    // an editing page catches up with its own other window, but a print
    // pressed in between printed the older copy (measured 2026-09-28: the
    // holder's change on the server, the view printed 0.15 s later with the old
    // Press on it; PRINT_LATEST_PLAN.md). David, 2026-09-28: "Check, then print
    // latest". So a print first makes the page's copy the latest saved one:
    // her own changes sent and landed, the server asked whether the job moved,
    // the latest copy drawn in place when it did. A change of hers the server
    // did not take, a takeover the page had not heard about, or a job gone
    // stops the print with the box that says why, ending "Nothing was
    // printed."; no answer asks Print anyway or Cancel. The work order PDF is
    // the record the CSR attaches to Midnight.
    const PRINT_STOPPED = 'Nothing was printed.';
    const PRINT_CHECK_MS = 3000;
    let printBusy = false;       // one print at a time: a second press while one is checked does nothing
    // A print is being checked and has not been made: a box that takes the
    // job from this page meanwhile (lockLost, lockGone, lockRetaken) is what
    // she gets instead of the print, and says so.
    let printChecking = false;
    let printPressedAt = 0;       // a box that opens a while after the press may meet her typing again
    let printSlowTimer = null;    // "Getting the latest copy to print...", after 0.7 s of checking
    const PRINT_SLOW_WORDS = 'Getting the latest copy to print...';

    // The four prints share this: one at a time, the latest saved copy first,
    // then make(same, piece) builds and makes the print. same() answers
    // whether the page is still on the copy latestForPrint left it on; make()
    // asks it right before printing. piece.gone: the piece she was on is no
    // longer on the job (the latest copy is drawn on its first piece), which a
    // print of that one piece must not hide.
    async function withLatestCopy(make) {
        const jobId = currentJobId;
        const seq = openSeq;
        if (!jobId || printBusy) return;
        const startPiece = currentComponentId;
        const startName = ((shownJob() || {}).components || []).map(c => c.id === startPiece ? c.name : null).find(Boolean) || 'The piece';
        printBusy = true;
        printChecking = true;
        printPressedAt = Date.now();
        // A check that takes a moment (her saves still going, a slow server) says so.
        printSlowTimer = setTimeout(() => { if (printChecking) showToast(PRINT_SLOW_WORDS); }, 700);
        try {
            const ok = await latestForPrint(jobId);
            quietPrintToast();
            if (!ok || currentJobId !== jobId || openSeq !== seq) return;
            const viewed = isViewed(jobId);
            const same = () => currentJobId === jobId && openSeq === seq && isViewed(jobId) === viewed && (viewed || holdsLock) && !lostBoxOpen;
            // Gone: not on the job any more (she may have clicked another piece meanwhile).
            const gone = !((shownJob() || {}).components || []).some(c => c.id === startPiece);
            await make(same, { gone, name: startName });
        } finally {
            quietPrintToast();
            printBusy = false;
            printChecking = false;
        }
    }
    // The check's toast goes when the check ends or a box asks her something.
    function quietPrintToast() {
        clearTimeout(printSlowTimer);
        printSlowTimer = null;
        const t = document.getElementById('backupToast');
        if (t && t.textContent === PRINT_SLOW_WORDS) t.classList.remove('visible');
    }
    // A box that opens more than a second after the press may meet her
    // typing again: Enter and Space are held off for a moment (lockBox graceMs).
    function printBoxGrace() {
        return Date.now() - printPressedAt > 1000 ? 1500 : 0;
    }

    // True when the print may go on (the page's copy is now the latest saved
    // one, or she chose Print anyway); false when it must not (a box says why).
    async function latestForPrint(jobId) {
        try {
            if (isViewed(jobId)) return await viewLatestForPrint(jobId);
            return await holderLatestForPrint(jobId);
        } catch (e) {
            // A mistake in here never prints in silence and never stops printing for good.
            console.error('latestForPrint failed:', e);
            if (currentJobId !== jobId) return false;
            return askPrintAnyway('unknown');
        }
    }

    // The page that holds the job. Anything that turns it into a view, lets
    // its hold go or takes it off the job on the way (a refusal, a takeover, a
    // heartbeat's finding, Home) ends the print: the box that did it says why.
    async function holderLatestForPrint(jobId) {
        const seq = openSeq;
        const still = () => currentJobId === jobId && openSeq === seq && !isViewed(jobId) && holdsLock && !lostBoxOpen;
        // 1. Her own changes go now: a header box or piece name still open
        // (Ctrl+P leaves it open; a click on Print has closed it already), the
        // screen read into the piece as every print did, the Signoff due
        // commit and the job row's timer. Redo stays when nothing changed
        // (saveJobState empties it before it looks).
        try { commitOpenBoxes(); } catch (e) { /* the saves below still go */ }
        const redo = redoStacks[activeDepartment];
        const saved = saveJobState();
        if (saved && saved.unchanged && redo && redo.length && !redoStacks[activeDepartment].length) {
            redoStacks[activeDepartment] = redo;
            updateUndoRedoButtons();
        }
        sendWaitingSaves({ stay: true });
        // Again from the top after anything not saved was sent once more,
        // or when she typed while the server was asked (her own save moves
        // the version, which must not read as her other window's).
        let sentAgain = false;
        for (let pass = 1; pass <= 4; pass++) {
            // 2. Every save on its way lands or is refused. A 423 has made
            // the page the view by then (lockLost's enterView comes before its
            // first wait) and a 409 has opened the reload box.
            if (!(await printSavesSettled(jobId, still))) return false;
            // 3. The heartbeat's tick on its way first (it can find the job
            // taken over, or changed while the page was away), then the
            // server's word: who holds the job and its version, one SELECT.
            if (!(await tickSettled())) return askPrintAnyway('server');
            if (!still()) return false;
            const serial = saveSerial;
            let l = await lockRequest('GET', jobId, null, { timeoutMs: PRINT_CHECK_MS });
            if (!still()) return false;
            if (l && !l.ok && l.status === 404) { lockGone(jobId, { archived: false }); return false; }
            if (!l) return askPrintAnyway('server');
            if (!l.ok) return askPrintAnyway('unknown');
            if (l.archived) { lockGone(jobId, { archived: true }); return false; }
            // Taken over, and this page had not heard: told now, not at the next heartbeat.
            if (l.held && !l.mine) { lockLost(jobId, l); return false; }
            if (!(l.held && l.mine && l.thisPage)) {
                // Her own hold lapsed (a sleep, a restart): the heartbeat's
                // own test, now. It takes the job back quietly, or says it
                // changed while the page was away and turns the page into the view.
                if (!(await heartbeatNow(jobId))) return askPrintAnyway('server');
                if (!still()) return false;
                l = await lockRequest('GET', jobId, null, { timeoutMs: PRINT_CHECK_MS });
                if (!still()) return false;
                if (l && !l.ok && l.status === 404) { lockGone(jobId, { archived: false }); return false; }
                if (!l) return askPrintAnyway('server');
                if (!l.ok) return askPrintAnyway('unknown');
                if (l.archived) { lockGone(jobId, { archived: true }); return false; }
                if (l.held && !l.mine) { lockLost(jobId, l); return false; }
                if (!(l.held && l.mine && l.thisPage)) return askPrintAnyway('server');
            }
            // She typed (or a save of hers went) while the server was asked:
            // from the top, so the answer is read against her latest version.
            if (saveSerial !== serial || savesPending > 0 || saveDebounceTimer || _persistJobTimer) continue;
            // The row moved since this page's copy: her other window saved,
            // or an import replaced the job.
            const moved = Number(l.rowVersion) !== Number(rowVersions[jobId] || 0);
            // 4. Anything on the page the server does not have (a save that
            // failed with a server error, now or earlier: the page's copy
            // already holds it, so a later print would not even send it) goes
            // once more; what still does not land is named, and nothing prints.
            const items = unsavedForPrint(jobId);
            if (!items) return askPrintAnyway('unknown');
            if (items.length) {
                // Her other window changed the job too: a conflict, as her next save would find.
                if (moved) { showReloadModal(); return false; }
                if (!sentAgain) { sendUnsavedAgain(jobId, items); sentAgain = true; continue; }
                const w = notSavedWords(items, 'retaken');
                quietPrintToast();
                lockBox({ title: items.length > 1 ? 'Your last changes could not be saved.' : 'Your last change could not be saved.',
                    text: PRINT_STOPPED + ' Press Print again to try once more.', detail: w.detail, primary: 'OK', graceMs: printBoxGrace() });
                return false;
            }
            // 5. The latest copy drawn in place first, as the catch-up draws it.
            if (moved) {
                const fresh = await fetchJobFresh(jobId, PRINT_CHECK_MS);
                if (!still()) return false;
                if (fresh && fresh.status === 404) { lockGone(jobId, { archived: false }); return false; }
                const job = fresh && fresh.job;
                if (!job || !Array.isArray(job.components) || !job.components.length) return askPrintAnyway('server');
                if (job.archivedDate) { lockGone(jobId, { archived: true }); return false; }
                if (!(await tickSettled())) return askPrintAnyway('server');
                if (!still()) return false;
                if (saveSerial !== serial || savesPending > 0 || saveDebounceTimer || _persistJobTimer) continue;
                if (Number(job.rowVersion) !== Number(rowVersions[jobId] || 0)) {
                    if (pageDiffers(jobId)) { showReloadModal(); return false; }
                    catchUpRedraw(job);
                    // Her other window saved a moment ago: its job row can
                    // still be on the way (it goes 600 ms after each piece
                    // save), so the catch-up asks again shortly, as it does
                    // after its own ask.
                    if (l.lastWrite && Number(l.now) - Number(l.lastWrite) < 3000 && !catchUpWriteFollow) {
                        catchUpWriteFollow = setTimeout(() => { catchUpWriteFollow = null; catchUpNow(); }, 1200);
                    }
                }
            }
            return true;
        }
        // She kept typing through every pass: this print cannot be sure.
        return askPrintAnyway('unknown');
    }
    // The saves on their way land or are refused (at most 5 s). False when
    // the print must not go on: the page was turned into the view or left, the
    // reload box is up, or she answered Cancel to the question the server's
    // silence asks (her changes queued while it is unreachable, or no answer).
    async function printSavesSettled(jobId, still) {
        const until = Date.now() + 5000;
        for (;;) {
            // Typed or changed while the check waits (a slow server, and she
            // carried on): sent now too, so the check waits for it as well.
            if (saveDebounceTimer || _persistJobTimer) { saveJobState(); sendWaitingSaves({ stay: true }); }
            await savesSettled(Math.max(0, until - Date.now()));
            if (!still() || boxShowing('reloadModal')) return false;
            if ((savesPending === 0 && !saveDebounceTimer && !_persistJobTimer) || Date.now() >= until) break;
        }
        if (_retryQueue.some(e => e.jobId === jobId)) return askPrintAnyway('queued');
        if (savesPending > 0 || saveDebounceTimer || _persistJobTimer) return askPrintAnyway('server');
        return true;
    }
    // What the page holds that the server does not, or null when that cannot
    // be worked out (then the print asks, rather than guess).
    function unsavedForPrint(jobId) {
        let snap = null;
        try { snap = pageSnapshot(jobId, true); } catch (e) { return null; }
        return safeUnsaved(snap);
    }
    // Each piece with a change the server does not have, and the job row when
    // one of its fields is not saved, sent once more through the save queue.
    function sendUnsavedAgain(jobId, items) {
        const job = getActiveJobs().find(j => j.id === jobId);
        if (!job) return;
        const pieces = new Set(items.filter(i => i.pieceId && !i.newPiece).map(i => i.pieceId));
        job.components.forEach(c => { if (pieces.has(c.id)) persistComponent(c, job); });
        if (items.some(i => i.row)) persistJob(job);
    }
    // The heartbeat's tick on its way, if any, has answered (at most 3 s).
    async function tickSettled() {
        const until = Date.now() + PRINT_CHECK_MS;
        while (lockTickBusy && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
        return !lockTickBusy;
    }
    // The heartbeat's own tick, now, for a print. False when it did not
    // answer in time.
    async function heartbeatNow(jobId) {
        if (!(await tickSettled())) return false;
        const done = lockTick(jobId).then(() => true, () => false);
        return Promise.race([done, new Promise(resolve => setTimeout(() => resolve(false), PRINT_CHECK_MS))]);
    }

    // A read-only view (a job somebody else holds, or an archived job). It
    // never writes: the lock is asked, and the latest copy drawn when the row
    // moved (or the view holds a copy the server never gave it), even under a
    // selection: the print is what she asked for. A poll answer still on its
    // way when the print draws is dropped (startViewPoll).
    async function viewLatestForPrint(jobId) {
        const seq = openSeq;
        const still = () => currentJobId === jobId && openSeq === seq && isViewed(jobId) && !lostBoxOpen;
        const l = await lockRequest('GET', jobId, null, { timeoutMs: PRINT_CHECK_MS });
        if (!still()) return false;
        if (l && !l.ok && l.status === 404) { viewJobGone(jobId); return false; }
        if (!l) return askPrintAnyway('server');
        if (!l.ok) return askPrintAnyway('unknown');
        const locked = viewKind === 'locked';
        if (locked && !l.archived) {
            viewLock = l;
            if (viewNotice === 'idle' && ((l.held && !l.mine) || Number(l.rowVersion) !== Number(viewedJob.rowVersion))) viewNotice = '';
        }
        // Archiving does not move the version, so the archived flag counts
        // too; a job made again (an import of a deleted job starts at version
        // 1) can land on the very version the view has, so the saved time
        // counts as well (the view's copy came from the server).
        const moved = viewCopyUnchecked || redrawWaiting || Number(l.rowVersion) !== Number(viewedJob.rowVersion) ||
            String(l.lastModified || '') !== String(viewedJob.lastModified || '') || (locked && !!l.archived) || (!locked && !l.archived);
        if (moved) {
            const fresh = await fetchJobFresh(jobId, PRINT_CHECK_MS);
            if (!still()) return false;
            if (fresh && fresh.status === 404) { viewJobGone(jobId); return false; }
            const job = fresh && fresh.job;
            if (!job || !Array.isArray(job.components) || !job.components.length) return askPrintAnyway('server');
            redrawView(job);
            if (locked && job.archivedDate) {
                setJobsCacheOnly(getActiveJobs().filter(j => j.id !== jobId));
                becomeArchivedView();
            } else if (locked) {
                startViewPoll(jobId);
            }
        }
        renderViewLine();
        return true;
    }
    // The job a view shows was deleted: the line says so (a live view) and a
    // box says nothing was printed.
    function viewJobGone(jobId) {
        if (viewKind === 'locked') {
            setJobsCacheOnly(getActiveJobs().filter(j => j.id !== jobId));
            viewNotice = 'deleted';
            viewLock = null;
            stopViewPoll();
            renderViewLine();
        }
        quietPrintToast();
        lockBox({ title: 'This job was deleted.', text: PRINT_STOPPED, primary: 'OK', graceMs: printBoxGrace() });
    }
    // No answer, or her changes queued while the server is unreachable: she
    // decides. Print anyway prints the page's copy, as every print did
    // before. The app's own box: it takes the keys (Enter is Print anyway,
    // Escape is Cancel), so nothing she presses reaches the work order under
    // it. A box already up is the answer: none goes over it.
    function askPrintAnyway(why) {
        if (lostBoxOpen || boxShowing('lockModal') || boxShowing('reloadModal')) return Promise.resolve(false);
        const text = why === 'queued' ? 'The server cannot be reached, so your latest changes are not saved yet and this print may not match the saved work order.'
            : why === 'server' ? 'The server did not answer in time, so this print may not show the latest saved changes.'
            : 'This print may not show the latest saved changes.';
        quietPrintToast();
        return lockBox({ title: 'The latest copy could not be checked.', text, primary: 'Print anyway', cancel: 'Cancel', graceMs: printBoxGrace() });
    }
    function boxShowing(id) {
        const m = document.getElementById(id);
        return !!m && m.style.display === 'block';
    }
    // Print Current and Ctrl+P print one piece: when the piece she was on was
    // deleted meanwhile, the latest copy is drawn on the first piece, and that
    // is not what she asked to print.
    function pieceGoneBox(piece) {
        lockBox({ title: quoteWords(piece.name) + ' is no longer on this job.', text: PRINT_STOPPED, primary: 'OK', graceMs: printBoxGrace() });
    }
    // The Summary outdated question, asked on the latest copy. When its box
    // waited on her, the latest copy is made sure of again, and a copy drawn
    // anew meanwhile is not printed without her seeing it first. comp: the
    // one piece Print Current asks about. True when the print goes on.
    async function summariesThenStillLatest(job, comp, same) {
        const asked = canUpdateSummaries(job) && outdatedSummaries(job, activeDepartment).some(o => !comp || o.comp.id === comp.id);
        if (!(await summariesReadyToPrint(job, activeDepartment, comp || undefined))) return false;
        if (!same()) return false;
        if (!asked) return true;
        if (!(await latestForPrint(job.id)) || !same()) return false;
        if (shownJob() !== job) {
            lockBox({ title: 'The work order changed while that box was open.', text: PRINT_STOPPED + ' Press Print again to print the latest copy.', primary: 'OK', graceMs: printBoxGrace() });
            return false;
        }
        return true;
    }

    // Ctrl+P on a work order: the browser's own print of the screen, as it
    // always was, but of the latest copy. Held and ignored while a print is
    // being checked or asks her something (its boxes, Summary outdated
    // included), and under the lock box or the reload box, so a held or second
    // press never prints the screen unchecked. Left to the browser on the job
    // list and under any other box (the QC Review window too); review.js takes
    // it first while a signed QC sheet is open. Chrome's own menu Print and
    // Ctrl+Shift+P cannot be held back: they print the screen as it is.
    function printScreen() {
        return withLatestCopy(async (same, piece) => {
            if (!same()) return;
            if (piece.gone) { pieceGoneBox(piece); return; }
            // The print box can hold the page while it is open: nothing found
            // from here on stops a print that is already being made.
            printChecking = false;
            window.print();
        });
    }
    document.addEventListener('keydown', e => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== 'p') return;
        if (e.defaultPrevented) return;
        // A job being opened over the one on screen (Take over, Start editing): held, nothing printed.
        if (openingJobId && document.getElementById('printHeader').style.display === 'block') { e.preventDefault(); return; }
        if (!currentJobId || document.getElementById('printHeader').style.display !== 'block') return;
        if (printBusy || lostBoxOpen || boxShowing('lockModal') || boxShowing('reloadModal')) { e.preventDefault(); return; }
        if (Array.from(document.querySelectorAll('.modal')).some(m => getComputedStyle(m).display !== 'none')) return;
        e.preventDefault();
        if (!e.repeat) printScreen();
    });

    async function printChecklist() {
        if (!currentJobId) {
            // A job being opened (Take over, Start editing) prints nothing and says nothing.
            if (!openingJobId) alert('No job selected to print!');
            return;
        }
        document.getElementById('printDropdown').classList.remove('open');
        await withLatestCopy(async (same, piece) => {
            if (piece.gone) { pieceGoneBox(piece); return; }
            const job = shownJob();
            const comp = job?.components?.find(c => c.id === currentComponentId);
            if (!job || !comp) return;

            // Fields changed since the last Generate? Print Current asks about the
            // open piece (summariesReadyToPrint); the job and the piece are the
            // page's own objects, so a rebuild is in them by the time this prints.
            if (!(await summariesThenStillLatest(job, comp, same))) return;

            const html = buildPrintHTML(job, comp);
            printViaIframe(html, getPrintFilename(job.jobNumber, comp.name));
        });
    }

    // ========== SELECTIVE EXPORT ==========

    let _exportArchiveCache = [];
    async function exportJobs() {
        const active = getActiveJobs();
        try {
            const res = await fetch('/api/archive');
            if (res.ok) _exportArchiveCache = await res.json();
        } catch (e) { _exportArchiveCache = []; }
        const archive = _exportArchiveCache;
        const list = document.getElementById('exportJobList');
        let html = '';

        if (active.length > 0) {
            html += '<div class="export-section-label">Active Jobs</div>';
            active.forEach(j => {
                const desc = j.jobDescription ? ` - ${j.jobDescription}` : '';
                const label = `${j.jobNumber} - ${j.clientName}${desc}`;
                html += `<div class="export-job-row"><input type="checkbox" id="exp-${escHtml(j.id)}" data-source="active" data-job-id="${escHtml(j.id)}" onchange="updateExportCount()"><label for="exp-${escHtml(j.id)}">${escHtml(label)}</label></div>`;
            });
        }
        if (archive.length > 0) {
            html += '<div class="export-section-label">Archived Jobs</div>';
            archive.forEach(j => {
                const desc = j.jobDescription ? ` - ${j.jobDescription}` : '';
                const label = `${j.jobNumber} - ${j.clientName}${desc}`;
                html += `<div class="export-job-row"><input type="checkbox" id="exp-${escHtml(j.id)}" data-source="archive" data-job-id="${escHtml(j.id)}" onchange="updateExportCount()"><label for="exp-${escHtml(j.id)}">${escHtml(label)}</label></div>`;
            });
        }

        if (!html) { alert('No jobs to export.'); return; }

        list.innerHTML = html;
        document.getElementById('exportSelectAll').checked = false;
        updateExportCount();
        document.getElementById('exportModal').style.display = 'block';
    }

    function toggleExportSelectAll(checked) {
        document.querySelectorAll('#exportJobList input[type="checkbox"]').forEach(cb => { cb.checked = checked; });
        updateExportCount();
    }

    function updateExportCount() {
        const count = document.querySelectorAll('#exportJobList input[type="checkbox"]:checked').length;
        const btn = document.getElementById('exportConfirmBtn');
        btn.textContent = 'Export (' + count + ')';
        btn.disabled = count === 0;
    }

    function closeExportModal() {
        document.getElementById('exportModal').style.display = 'none';
    }

    function doExport() {
        const active = getActiveJobs();
        const archive = _exportArchiveCache || [];
        const checked = document.querySelectorAll('#exportJobList input[type="checkbox"]:checked');
        const selectedActive = [];
        const selectedArchive = [];
        checked.forEach(cb => {
            const id = cb.dataset.jobId;
            if (cb.dataset.source === 'active') {
                const j = active.find(x => x.id === id);
                if (j) selectedActive.push(j);
            } else {
                const j = archive.find(x => x.id === id);
                if (j) selectedArchive.push(j);
            }
        });
        if (selectedActive.length === 0 && selectedArchive.length === 0) return;

        const data = {
            prepressJobs: selectedActive,
            prepressJobsArchive: selectedArchive,
            exportDate: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'prepress-jobs-' + new Date().toISOString().split('T')[0] + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        closeExportModal();
    }

    // ========== IMPORT WITH UPDATE SUPPORT ==========

    let pendingImportData = null;

    function importJobs(event) {
        const file = event.target.files[0];
        if (!file) return;
        event.target.value = '';

        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = JSON.parse(e.target.result);
                if (!data.prepressJobs && !data.prepressJobsArchive) {
                    showErrorModal("This file isn't a valid export.", 'Close');
                    return;
                }
                showImportSummary(data);
            } catch (err) {
                showErrorModal("Couldn't read this file.", 'Close');
            }
        };
        reader.readAsText(file);
    }

    async function showImportSummary(data) {
        const existingJobs = getActiveJobs();
        let existingArchive = [];
        try {
            const archRes = await fetch('/api/archive');
            if (archRes.ok) existingArchive = await archRes.json();
        } catch (e) { /* proceed with empty */ }
        const importedJobs = data.prepressJobs || [];
        const importedArchive = data.prepressJobsArchive || [];

        const existingActiveMap = {};
        existingJobs.forEach(j => { existingActiveMap[(j.jobNumber || '').trim()] = j; });
        const existingArchiveMap = {};
        existingArchive.forEach(j => { existingArchiveMap[(j.jobNumber || '').trim()] = j; });

        // Classify each imported job
        function classifyJob(j, existing, target) {
            if (!existing) return { job: j, target, status: 'new' };
            if (existing.lastModified === j.lastModified) return { job: j, target, status: 'skip' };
            const importedDate = new Date(j.lastModified || 0);
            const localDate = new Date(existing.lastModified || 0);
            const isNewer = importedDate > localDate;
            return { job: j, target, status: isNewer ? 'newer' : 'older', existingId: existing.id, existingCreatedBy: existing.createdBy || '', importedDate, localDate };
        }

        const classified = [];
        importedJobs.forEach(j => {
            classified.push(classifyJob(j, existingActiveMap[(j.jobNumber || '').trim()], 'active'));
        });
        importedArchive.forEach(j => {
            classified.push(classifyJob(j, existingArchiveMap[(j.jobNumber || '').trim()], 'archive'));
        });

        const newCount = classified.filter(c => c.status === 'new').length;
        const newerCount = classified.filter(c => c.status === 'newer').length;
        const olderCount = classified.filter(c => c.status === 'older').length;
        const skipCount = classified.filter(c => c.status === 'skip').length;

        if (newCount === 0 && newerCount === 0 && olderCount === 0) {
            showWarningModal('All jobs in the file already exist and are up to date.', [], { type: 'info', okLabel: 'Close' });
            return;
        }

        // Build summary
        const parts = [];
        if (newCount > 0) parts.push('<strong>' + newCount + '</strong> new');
        if (newerCount > 0) parts.push('<strong>' + newerCount + '</strong> newer than local');
        if (olderCount > 0) parts.push('<strong>' + olderCount + '</strong> older than local');
        if (skipCount > 0) parts.push('<strong>' + skipCount + '</strong> already up to date');
        document.getElementById('importSummary').innerHTML = parts.join(', ');

        // Build job list with date details
        const fmtDate = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const badgeLabel = { new: 'New', newer: 'Newer', older: 'Older', skip: 'Up to date' };
        const badgeClass = { new: 'badge-new', newer: 'badge-new', older: 'badge-older', skip: 'badge-skip' };
        const listHtml = classified.map(c => {
            const desc = c.job.jobDescription ? ' - ' + c.job.jobDescription : '';
            const label = c.job.jobNumber + ' - ' + c.job.clientName + desc;
            const targetLabel = c.target === 'archive' ? ' <span style="color:var(--ink-muted);font-size:11px;">(archived)</span>' : '';
            let dateInfo = '';
            if (c.status === 'newer' || c.status === 'older') {
                dateInfo = '<div style="font-size:11px;color:var(--ink-muted);padding-left:4px;">File: ' + fmtDate(c.importedDate) + '  /  Local: ' + fmtDate(c.localDate) + '</div>';
            }
            const checked = c.status === 'newer' || c.status === 'new' ? ' checked' : '';
            const checkboxHtml = (c.status === 'newer' || c.status === 'older') ? '<input type="checkbox" class="import-check" data-idx="' + classified.indexOf(c) + '"' + checked + ' style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer;flex-shrink:0;">' : '';
            return '<div class="import-job-row" style="flex-wrap:wrap;"><span class="import-badge ' + badgeClass[c.status] + '">' + badgeLabel[c.status] + '</span>' + checkboxHtml + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(label) + targetLabel + '</span>' + dateInfo + '</div>';
        }).join('');
        document.getElementById('importJobList').innerHTML = listHtml;

        // Store for confirm
        pendingImportData = classified;
        const btn = document.getElementById('importConfirmBtn');
        btn.textContent = 'Import (' + (newCount + newerCount) + ')';
        document.getElementById('importModal').style.display = 'block';
    }

    function closeImportModal() {
        document.getElementById('importModal').style.display = 'none';
        pendingImportData = null;
    }

    async function confirmImport() {
        if (!pendingImportData) return;
        // Build set of checked older/newer items
        const checkedIdxs = new Set();
        document.querySelectorAll('#importJobList .import-check:checked').forEach(cb => {
            checkedIdxs.add(parseInt(cb.dataset.idx));
        });

        // Importing over a job that has QC on it (PHASE1_PLAN section 8, built
        // 2026-09-20). The job keeps its id, so its gate rows and its whole
        // history survive, but its pieces are replaced by the ones in the file.
        // A checklist filled in against a piece that does not come back is left
        // stranded: the QC Review window calls it "a part no longer on this
        // job", and a department that had passed stops reading as passed,
        // because a pass is counted per piece now on the job. Nothing is lost
        // and nothing is blocked; she is told before it happens.
        const overwriting = [];
        pendingImportData.forEach((c, i) => {
            if (c.status === 'skip' || !c.existingId) return;
            if ((c.status === 'newer' || c.status === 'older') && !checkedIdxs.has(i)) return;
            overwriting.push(c);
        });
        // Only when a checklist really would be stranded. Import had no confirm
        // at all before this, and a box on an import that loses nothing would
        // be noise on the commonest path of all: a job's own export going back
        // in, where every piece keeps its id and nothing is lost.
        const importLines = [];
        if (overwriting.length) {
            try { await refreshBoard(); } catch (e) { /* keep the last good copy */ }
            overwriting.forEach(o => {
                strandedByImport(o.existingId, o.job).forEach(name => {
                    importLines.push((o.job.jobNumber || 'This job') + ': ' + name);
                });
            });
        }
        if (importLines.length && !(await showWarningModal(
            'Import over ' + overwriting.length + ' job' + (overwriting.length > 1 ? 's' : '') + '?',
            [QC_IMPORT_LEAD].concat(importLines),
            { type: 'qc', okLabel: 'Import', cancelLabel: 'Cancel', showCancel: true }))) return;

        // Importing over the job open for editing on this page (R17, the
        // after-rollout batch, item 10): it is left first, the way Home leaves
        // it (what is waiting is sent, its lock let go once that has landed),
        // so no click on the old screen can save its switches, notes or words
        // back over the import. It opens again from the job list, from the
        // imported copy.
        if (currentJobId && !isViewed(currentJobId) && overwriting.some(o => o.existingId === currentJobId)) {
            showNoJobState();
            await savesSettled(5000);
        }

        // A job somebody else is editing is not imported over (the server
        // would refuse the import, 423): asked first, so nothing is written
        // for it, and named at the end.
        const heldIds = new Set();
        const heldLines = [];
        const lockBefore = new Map();   // what each job was, for a failed import's check
        for (const o of overwriting) {
            const l = await readJobLock(o.existingId);
            lockBefore.set(o.existingId, l);
            if (l && l.ok && l.held && !l.mine) {
                heldIds.add(o.existingId);
                heldLines.push((o.job.jobNumber || o.existingId) + ' (' + holderName(l) + ' is editing it)');
            }
        }

        let addedCount = 0;
        let updatedCount = 0;
        let failedCount = 0;      // new jobs that could not be saved
        const notImported = [];   // job numbers left as they were (2A)
        const unsure = [];        // job numbers the server could not be asked about (2C)

        for (const c of pendingImportData) {
            const idx = pendingImportData.indexOf(c);
            if (c.status === 'skip') continue;
            if ((c.status === 'newer' || c.status === 'older') && !checkedIdxs.has(idx)) continue;
            if (c.existingId && heldIds.has(c.existingId)) continue;

            // A new job is stamped with the importing user, so a job brought
            // into the server appears under her My Jobs (ee35d50). Over a
            // job already here its creator stays who it was (R18, the
            // after-rollout batch, item 9): the import is not who created it.
            var importer = getUserName();
            if (c.status === 'new') { if (importer) c.job.createdBy = importer; }
            else c.job.createdBy = c.existingCreatedBy || c.job.createdBy;

            if (c.status === 'new') {
                try {
                    // Made by the importer (X-STS-User); X-STS-Import tells
                    // the server to keep the file's "last changed" name with
                    // its date (STAMPS_AND_VERSION_PLAN.md).
                    const res = await fetch('/api/jobs', {
                        method: 'POST',
                        headers: Object.assign(apiHeaders(), { 'X-STS-Import': '1' }),
                        body: JSON.stringify(c.job)
                    });
                    if (!res.ok) throw new Error('Server rejected create');
                    addedCount++;
                } catch (e) {
                    failedCount++;
                }
                continue;
            }

            // Update existing: the server replaces the job and every piece in
            // one step, so it is all of the file or nothing (David,
            // 2026-10-11; IMPORT_RECOVERY_PLAN.md). The job keeps its own id
            // (the file is matched by job number) and the file's piece ids,
            // which keeps each checklist with its piece. No timeout: "no
            // answer" must mean the network or the server dropped it.
            const number = c.job.jobNumber || c.existingId;
            c.job.id = c.existingId;
            let res = null;
            try {
                res = await fetch('/api/jobs/' + encodeURIComponent(c.existingId) + '/import', {
                    method: 'POST', headers: apiHeaders(c.existingId), body: JSON.stringify(c.job)
                });
            } catch (e) { res = null; }
            if (res && res.ok) { updatedCount++; continue; }
            // Somebody opened the job since the check above: named as held.
            const heldNow = await lockSkipped(res, c.existingId);
            if (heldNow) {
                heldLines.push(number + ' (' + heldNow.who + ' is editing it)');
                continue;
            }
            // Anything else: the server is asked what the job is now. The
            // file's time on it means the import went in (its reply was lost).
            // "As it was" only when the route answered (it answers once its
            // batch has committed or rolled back) and the version is the one
            // read before; no answer, a read that failed or a version that
            // moved cannot tell (the batch may still be running, or a
            // colleague saved), so the box says it may not have gone in.
            const now = await readJobLock(c.existingId);
            const was = lockBefore.get(c.existingId);
            if (now && now.ok && c.job.lastModified && now.lastModified === c.job.lastModified) updatedCount++;
            else if (res && now && now.ok && was && was.ok && Number(now.rowVersion) === Number(was.rowVersion)) notImported.push(number);
            else unsure.push(number);
        }

        await refreshJobs();
        loadJobs();
        closeImportModal();
        if (failedCount > 0 || notImported.length || unsure.length) {
            // The box's title is HTML: the numbers go in escaped.
            const names = list => Array.from(new Set(list)).map(escHtml).join(', ');
            let text = 'Imported ' + addedCount + ' added, ' + updatedCount + ' updated.';
            if (failedCount > 0) text += ' ' + failedCount + " couldn't be saved.";
            const one = list => new Set(list).size === 1;
            if (notImported.length) text += ' ' + names(notImported) + " couldn't be imported. " +
                (one(notImported) ? 'It is as it was before the import.' : 'They are as they were before the import.');
            if (unsure.length) text += ' ' + names(unsure) + ' may not have been imported. Import the file again: if ' +
                (one(unsure) ? 'it shows as Up to date, it went in.' : 'they show as Up to date, they went in.');
            showErrorModal(text, 'Refresh');
        } else {
            showToast(addedCount + ' added, ' + updatedCount + ' updated');
        }
        if (heldLines.length) {
            lockBox({ title: 'Not imported: ' + heldLines.join(', ') + '.', text: 'Open a job to take it over, then import again.', primary: 'OK' });
        }
    }

    function toggleCollapse(titleEl) {
        const group = titleEl.closest('.section-group');
        group.classList.toggle('collapsed');
    }

    // Undo/Redo functionality. State belongs to a single department — each
    // tab has its own undo/redo stack, so `department` is recorded for
    // cross-tab safety (restoreState refuses to apply state from another dept).
    function captureState() {
        if (!currentJobId || !currentComponentId) return null;
        const state = {
            jobId: currentJobId,
            componentId: currentComponentId,
            department: activeDepartment,
            // The content, not the HTML: pasting Quill's HTML back rewrites
            // some of it again (a run of spaces typed with nbsp, blank lines at
            // the end, a colour style), so an Undo back to where it started
            // still changed the words.
            content: quill.getContents(),
            checkboxes: {},
            notes: {}
        };
        document.querySelectorAll('.field-row .toggle-switch input[type="checkbox"]').forEach(cb => {
            const id = cb.getAttribute('data-id');
            if (id) state.checkboxes[id] = cb.checked;
        });
        document.querySelectorAll('.notes').forEach(inp => {
            const id = inp.getAttribute('data-id');
            if (id) state.notes[id] = inp.value;
        });
        // Generate's fingerprints live in the piece's notes with no input
        // behind them, so they are carried by hand: an Undo that puts an older
        // block back must bring its fingerprint, or the next print is quiet
        // over a stale summary.
        state.fingerprints = summaryFingerprintsOf(getCurrentComponent(), activeDepartment);
        return state;
    }

    function restoreState(state) {
        if (!state || state.jobId !== currentJobId) return;
        // Per-dept undo: a snapshot from another department should never
        // apply here. The stack-per-dept design keeps them separated, but
        // this guard catches any accidental cross-dept leak.
        if (state.department && state.department !== activeDepartment) return;
        isUndoRedo = true;

        // If the state is for a different component, switch to it first
        if (state.componentId && state.componentId !== currentComponentId) {
            // Save current component state first
            saveComponentState();
            currentComponentId = state.componentId;

            // Update job's active component
            const jobs = getActiveJobs();
            const job = jobs.find(j => j.id === currentJobId);
            if (job) {
                job.activeComponentId = state.componentId;
                saveActiveJobs(jobs);
            }

            renderComponentTabs();
        }

        // Taken before anything is put back, so the save below sees a
        // fingerprint that moved on its own (saveComponentState).
        const restored = getCurrentComponent();
        const before = restored ? componentSignature(restored) : undefined;
        // Not remembered as a load (editorLoads): an Undo is a real change.
        quill.setContents(state.content, 'api');
        document.querySelectorAll('.field-row .toggle-switch input[type="checkbox"]').forEach(cb => {
            const id = cb.getAttribute('data-id');
            if (id && state.checkboxes.hasOwnProperty(id)) {
                cb.checked = state.checkboxes[id];
            }
        });
        document.querySelectorAll('.notes').forEach(inp => {
            const id = inp.getAttribute('data-id');
            if (id && state.notes.hasOwnProperty(id)) {
                inp.value = state.notes[id];
            }
        });
        restoreSummaryFingerprints(restored, state.fingerprints);
        saveJobStateWithoutHistory({ before });
        autoResizeAllTextareas();
        updateMasterCheckbox();
        updateGroupCheckboxes();
        updateRowVisibility();
        isUndoRedo = false;
    }

    function pushToUndo(clearRedo = true, explicitState = null) {
        if (isUndoRedo || undoRedoCooldown) return;
        const state = explicitState || captureState();
        if (state) {
            const stackDept = state.department || activeDepartment;
            const undoStack = undoStacks[stackDept] || (undoStacks[stackDept] = []);
            undoStack.push(state);
            if (undoStack.length > MAX_UNDO_HISTORY) {
                undoStack.shift();
            }
            if (clearRedo) {
                redoStacks[stackDept] = [];
            }
            updateUndoRedoButtons();
        }
    }

    function undo() {
        const undoStack = getActiveUndoStack();
        const redoStack = getActiveRedoStack();
        if (undoStack.length === 0 || !currentJobId || isViewed(currentJobId)) return;
        undoRedoCooldown = true;
        const currentState = captureState();
        if (currentState) {
            redoStack.push(currentState);
            if (redoStack.length > MAX_UNDO_HISTORY) {
                redoStack.shift();
            }
        }
        const prevState = undoStack.pop();
        restoreState(prevState);
        updateUndoRedoButtons();
        setTimeout(() => { undoRedoCooldown = false; }, 100);
    }

    function redo() {
        const undoStack = getActiveUndoStack();
        const redoStack = getActiveRedoStack();
        if (redoStack.length === 0 || !currentJobId || isViewed(currentJobId)) return;
        undoRedoCooldown = true;
        const currentState = captureState();
        if (currentState) {
            undoStack.push(currentState);
            if (undoStack.length > MAX_UNDO_HISTORY) {
                undoStack.shift();
            }
        }
        const nextState = redoStack.pop();
        restoreState(nextState);
        updateUndoRedoButtons();
        setTimeout(() => { undoRedoCooldown = false; }, 100);
    }

    function updateUndoRedoButtons() {
        // Button state reflects the active department's stacks only.
        const undoStack = getActiveUndoStack();
        const redoStack = getActiveRedoStack();
        document.querySelector('.btn-undo').disabled = undoStack.length === 0 || !currentJobId;
        document.querySelector('.btn-redo').disabled = redoStack.length === 0 || !currentJobId;
    }

    function saveJobStateWithoutHistory(options) {
        const saved = saveComponentState(options);
        const { job, comp } = saved;
        if (!job || !comp) return saved;

        const instructions = comp['instructions_' + activeDepartment] || '';
        const history = comp['instructionsHistory_' + activeDepartment] || '';
        const fullInstructions = instructionsAsHtml(instructions) + (instructions && history ? '<br><br>' : '') + history;
        document.getElementById('instructionsDisplay').innerHTML = cleanHtml(fullInstructions);

        updatePrintHeader(job);
        updateRowVisibility();
        updateCompletion();
        return saved;
    }

    // Keyboard shortcuts for undo/redo. Under a box (New Job, Edit Job, Add
    // Component, Manage CSRs...) they are the box's own: its typing is taken
    // back natively, never the work order behind it (KEYBOARD_PLAN.md 2.7).
    document.addEventListener('keydown', function(e) {
        if (boxUp()) return;
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            undo();
        } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
            e.preventDefault();
            redo();
        }
    });

    // Search functionality
    document.getElementById('searchInput').addEventListener('input', function(e) {
        const searchTerm = e.target.value.toLowerCase().trim();

        // Remove previous highlights
        document.querySelectorAll('.field-row.search-highlight').forEach(item => {
            item.classList.remove('search-highlight');
        });

        if (!searchTerm) return;

        // Find matching items (scoped to active department panel)
        const activePanel = document.querySelector('.dept-checklist.active') || document;
        const items = activePanel.querySelectorAll('.field-row');
        let firstMatch = null;

        items.forEach(item => {
            const labelEl = item.querySelector('.field-label');
            if (!labelEl) return;
            const taskText = labelEl.textContent.toLowerCase();
            if (taskText.includes(searchTerm)) {
                item.classList.add('search-highlight');
                // Expand the section if collapsed
                const group = item.closest('.section-group');
                if (group && group.classList.contains('collapsed')) {
                    group.classList.remove('collapsed');
                }
                if (!firstMatch) firstMatch = item;
            }
        });

        // Scroll to first match
        if (firstMatch) {
            firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    });

    // Guard flag: prevents scroll/resize handlers from closing a dropdown
    // that was just opened (focus() can trigger a scroll on the checklist-panel)
    let _qpJustOpened = false;

    // Quick Pick Feature - Combobox with dropdown presets
    function toggleQuickPick(btn) {
        // A pick sets the box by code, which readOnly does not stop.
        if (isViewed(currentJobId)) return;
        const wrapper = btn.closest('.quick-pick-wrapper');
        const menu = wrapper.querySelector('.quick-pick-menu');

        // Close all other open menus first
        document.querySelectorAll('.quick-pick-menu.open').forEach(m => {
            if (m !== menu) {
                m.classList.remove('open', 'open-up');
            }
        });

        // Finished Size's choices come from the Flat Size box and the piece
        // type as they are now, so they are made afresh each time it opens.
        if (menu.dataset.optionsFrom === 'finishedSize' && !menu.classList.contains('open')) {
            const flat = document.querySelector('[data-id="ps3n"]');
            const comp = getCurrentComponent();
            menu.dataset.options = JSON.stringify(window.DEPT_REGISTRY.prepress.finishedSizeOptions(
                parseDims(flat ? flat.value.trim() : ''), comp ? comp.name : ''));
            delete menu.dataset.populated;
        }

        // Populate menu if not already done
        if (!menu.dataset.populated) {
            const options = JSON.parse(menu.dataset.options);
            menu.innerHTML = options.map(opt => {
                const escaped = opt.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                let display = opt;
                if (opt.includes('\u2003')) {
                    const idx = opt.indexOf('\u2003');
                    display = '<span class="qp-dim">' + opt.slice(0, idx) + '</span><span class="qp-desc">' + opt.slice(idx + 1) + '</span>';
                }
                return `<div class="quick-pick-option" data-value="${escaped}">${display}</div>`;
            }).join('');
            menu.dataset.populated = 'true';

            // Add click handlers to options
            menu.querySelectorAll('.quick-pick-option').forEach(option => {
                option.addEventListener('click', function() {
                    selectQuickPick(this);
                });
            });
        }

        // Toggle menu
        if (menu.classList.contains('open')) {
            menu.classList.remove('open', 'open-up');
        } else {
            menu.classList.add('open');

            // Suppress scroll-triggered close for one frame (focus() can scroll checklist-panel)
            _qpJustOpened = true;
            requestAnimationFrame(() => { _qpJustOpened = false; });

            // Focus the input so typing filters immediately
            const input = wrapper.querySelector('input.notes') || wrapper.querySelector('input');
            if (input) {
                input.focus({ preventScroll: true });
                // Show all options on open — typing will filter via the input event handler
                filterQuickPickOptions(menu, '');
            }

            // Position with fixed coordinates so it floats above all containers
            const rect = wrapper.getBoundingClientRect();
            const menuMinW = Math.max(rect.width, 220);
            menu.style.width = 'auto';
            menu.style.minWidth = menuMinW + 'px';

            // Allow dropdown to extend left if not enough room to the right
            const spaceRight = window.innerWidth - rect.left - 16;
            if (spaceRight >= menuMinW) {
                menu.style.left = rect.left + 'px';
                menu.style.maxWidth = spaceRight + 'px';
            } else {
                // Shift left so dropdown fits within viewport
                const shiftedLeft = Math.max(8, window.innerWidth - menuMinW - 16);
                menu.style.left = shiftedLeft + 'px';
                menu.style.maxWidth = (window.innerWidth - shiftedLeft - 16) + 'px';
            }

            const spaceBelow = window.innerHeight - rect.bottom - 8;
            const spaceAbove = rect.top - 8;

            if (spaceBelow >= 160 || spaceBelow >= spaceAbove) {
                // Open downward
                menu.classList.remove('open-up');
                menu.style.top = rect.bottom + 'px';
                menu.style.maxHeight = Math.min(320, spaceBelow) + 'px';
            } else {
                // Open upward
                menu.classList.add('open-up');
                menu.style.maxHeight = Math.min(320, spaceAbove) + 'px';
                const menuHeight = Math.min(menu.scrollHeight, parseInt(menu.style.maxHeight));
                menu.style.top = (rect.top - menuHeight) + 'px';
            }
        }
    }

    // Shared filter logic for all quick-pick dropdowns
    function getFilterText(input, wrapper) {
        const raw = input.value;
        // For field-row inputs (comma-separated), filter on text after last comma
        if (wrapper.closest('.field-row') && raw.includes(',')) {
            return raw.split(',').pop().trim().toLowerCase();
        }
        return raw.toLowerCase();
    }

    function filterQuickPickOptions(menu, filterText) {
        const options = menu.querySelectorAll('.quick-pick-option');
        let firstStartsWith = null;
        let firstContains = null;

        options.forEach(opt => {
            const text = opt.textContent.toLowerCase();
            if (!filterText) {
                opt.style.display = '';
                opt.classList.remove('highlighted');
                return;
            }
            const startsWith = text.startsWith(filterText);
            const contains = text.includes(filterText);

            opt.style.display = contains ? '' : 'none';
            opt.classList.remove('highlighted');

            if (startsWith && !firstStartsWith) {
                firstStartsWith = opt;
            } else if (contains && !firstContains) {
                firstContains = opt;
            }
        });

        if (filterText) {
            const toHighlight = firstStartsWith || firstContains;
            if (toHighlight) {
                toHighlight.classList.add('highlighted');
                toHighlight.scrollIntoView({ block: 'nearest' });
            }
        }
    }

    // ========== GENERATE SPECS SUMMARY ==========

    // Indicia text blocks keyed by dropdown label
    const INDICIA_BLOCKS = {
        'First Class':
            'FIRST-CLASS MAIL\nU.S. POSTAGE\nPAID\nZIP Code <99999>\nPermit No. <9999>',
        'Presorted First Class':
            'PRESORTED\nFIRST-CLASS MAIL\nU.S. POSTAGE\nPAID\nZIP Code <99999>\nPermit No. <9999>',
        'Presorted Standard':
            'PRSRT STD\nU.S. POSTAGE\nPAID\nZIP Code <99999>\nPermit No. <9999>',
        'Nonprofit':
            'NONPROFIT ORG\nU.S. POSTAGE\nPAID\nZIP Code <99999>\nPermit No. <9999>'
    };

    // Address block text blocks keyed by dropdown label
    const ADDRESS_BLOCKS = {
        'OEL + Codeline + Lines 1-10':
            'OEL + Codeline + variable address lines 1-10',
        'OEL + Lines 1-10':
            'OEL + variable address lines 1-10',
        'Codeline + Lines 1-10':
            'Codeline + variable address lines 1-10',
        'Lines 1-10':
            'Variable address lines 1-10',
        'EDDM Res & Bus':
            'EDDM: Residential & Business (excludes PO Boxes)\n****ECRWSSEDDM\nPostal Customer',
        'EDDM Res Only':
            'EDDM: Residential Only\n****ECRWSSEDDM\nResidential Customer',
        'EDDM PO Box Only':
            'EDDM: PO Box Only\n****ECRWSSEDDM\nPO Box Holder'
    };

    const SPECS_MARKER_START = '\u2500\u2500 Specs \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500';
    const SPECS_MARKER_END = '\u2500\u2500 End Specs \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500';

    // Fingerprint piece specs for stale-block detection
    const SPEC_FIELDS = ['sp1','ps3','ps4','sp2','sp3','ps1','ps14','ps13','sp7','ps10','sp6','sp4','ps11','vp1','ps12','vp3'];
    function specsFingerprint(comp) {
        if (!comp) return '';
        const checks = comp.checkboxes || {};
        const notes = comp.notes || {};
        // Grayed-out rows count as empty, matching Generate, so renaming a component
        // to or from a type that grays rows out marks its summary outdated
        const disabledFields = window.DEPT_REGISTRY.prepress.getDisabledFields(comp);
        // The piece's name (the summary opens with it), then only the fields
        // the summary reads: ticked and not greyed out, each with its value
        // trimmed as the summary trims it, in id order. So a field added to
        // the list later changes nothing until somebody ticks it, and a stray
        // space is not a change.
        const fields = SPEC_FIELDS.filter(f => checks[f] && !disabledFields.includes(f + 'n')).sort().map(f => f + '=' + (notes[f + 'n'] || '').trim());
        return [comp.name || ''].concat(fields).join('|');
    }

    // Show styled QC warning modal, returns a Promise<boolean>
    // type: 'qc' (red), 'required' (gold), 'stale' (neutral), 'info' (neutral, OK only)
    // #qcWarningModal is one element shared by every caller, so only one box
    // can really be open. Before this, a second call attached a second pair of
    // listeners to the same buttons and one click settled both promises: with
    // the QC warning now on six presses, a double press could archive a job on
    // a single Yes. The live call is settled as Cancel before the new one draws.
    let openWarning = null;
    let warningOpener = null;      // what had the cursor before the box (KEYBOARD_PLAN.md 2.7)
    let warningReplacing = false;  // a box being replaced keeps that opener
    function showWarningModal(title, items, opts) {
        const type = (opts && opts.type) || 'qc';
        const okLabel = (opts && opts.okLabel) || 'Print Anyway';
        // The cancel button is shared markup, so its label has to be set on every
        // call, not just when a caller overrides it.
        const cancelLabel = (opts && opts.cancelLabel) || 'Cancel';
        const showCancel = opts && opts.showCancel !== undefined ? opts.showCancel : type !== 'info';
        return new Promise(resolve => {
            const modal = document.getElementById('qcWarningModal');
            const header = document.getElementById('qcWarningHeader');
            const list = document.getElementById('qcWarningList');
            const btnOk = document.getElementById('qcWarningProceed');
            const btnCancel = document.getElementById('qcWarningCancel');

            header.innerHTML = title;
            modal.dataset.type = type;
            list.innerHTML = items.map(w => '<li>' + escHtml(w) + '</li>').join('');
            btnOk.textContent = okLabel;
            btnCancel.textContent = cancelLabel;
            btnCancel.style.display = showCancel ? '' : 'none';

            // The cursor goes into the box, on its Cancel-side button (No,
            // Cancel, Print as is) or its only one, and back to what had it
            // when the box closes (KEYBOARD_PLAN.md 2.7). A box replacing
            // another keeps the first one's opener.
            const opener = openWarning ? warningOpener : rememberCursor(modal);

            // Whatever was showing on this element is answered No and let go
            // of first, so exactly one pair of listeners is ever attached.
            if (openWarning) { warningReplacing = true; openWarning(false); warningReplacing = false; }
            openWarning = cleanup;
            warningOpener = opener;
            modal.style.display = 'block';
            // Only when it is the box on top: under Manage CSRs and its admin
            // box (later in the page) the button cannot be seen or pressed.
            if (topBox() === modal) focusQuiet(showCancel ? btnCancel : btnOk);

            function cleanup(result) {
                if (openWarning === cleanup) openWarning = null;
                modal.style.display = 'none';
                btnOk.removeEventListener('click', onOk);
                btnCancel.removeEventListener('click', onCancel);
                if (!warningReplacing) { warningOpener = null; restoreCursor(opener); }
                resolve(result);
            }
            function onOk() { cleanup(true); }
            function onCancel() { cleanup(false); }
            btnOk.addEventListener('click', onOk);
            if (showCancel) btnCancel.addEventListener('click', onCancel);
        });
    }

    // Show a styled error modal with an action button (Refresh, Close, Try Again, etc.)
    // Returns a promise that resolves true if the action button was clicked.
    function showErrorModal(message, actionLabel) {
        const btn = actionLabel || 'Close';
        const isRefresh = btn === 'Refresh';
        return showWarningModal(message, [], { type: 'required', okLabel: btn }).then(function(clicked) {
            if (clicked && isRefresh) { refreshJobs().then(function() { loadJobs(); }); }
            return clicked;
        });
    }

    function showQcWarning(compNames, warnings, okLabel) {
        const nameSpan = '<span class="qc-comp-name">' + escHtml(compNames) + '</span>';
        return showWarningModal('QC Warnings for ' + nameSpan, warnings, { type: 'qc', okLabel: okLabel || 'Print Anyway' });
    }

    // Parse dimension string like "8.5″ x 14″", "8.5x3.5" or "8 1/2 x 11" into [w, h]
    function parseDims(str) {
        if (!str) return null;
        // A dropdown choice's name follows an em-space ("6″ x 9.5″  6x9.5 Env"),
        // or a bracket once Generate has tidied it ("6″ x 9.5″ (6x9.5 Env)"):
        // only the size before it counts, or the x in the name splits it again.
        // Then strip quote/prime marks, but preserve 'x' for splitting
        const clean = str.split('\u2003')[0].split('(')[0]
                        .replace(/[\u2033\u201d\u2032"'\u2035\u2036\u2037\u2057\u2018\u2019\u201c\u201d\u00b4`\u2103\u2109\u00b0\u2070-\u209f]/g, '')
                        .trim();
        // Split on 'x' (case-insensitive, with optional surrounding whitespace)
        const parts = clean.split(/\s*x\s*/i);
        if (parts.length !== 2) return null;
        const w = parseInches(parts[0]);
        const h = parseInches(parts[1]);
        if (isNaN(w) || isNaN(h)) return null;
        return [w, h];
    }

    // One side of a size: "8.5", "8 1/2", "8-1/2" or "1/2". Letters are
    // stripped first (handles "9.5 No. 10 Env" -> "9.5"). A fraction used to
    // be dropped ("8 1/2" read as 8), which raised wrong QC warnings.
    function parseInches(text) {
        const s = text.replace(/[a-zA-Z]/g, '').trim();
        let m = s.match(/^(\d+)[\s-]+(\d+)\/(\d+)/);
        if (m && Number(m[3])) return Number(m[1]) + m[2] / m[3];
        m = s.match(/^(\d+)\/(\d+)/);
        if (m && Number(m[2])) return m[1] / m[2];
        return parseFloat(s);
    }

    // Parse N-up value like "2-Up" into number
    function parseNUp(str) {
        if (!str) return null;
        const m = str.match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    // Compute the maximum N-up that physically fits on the sheet.
    // Shared by validateSpecs and the live Number Up hint so both stay in lockstep.
    function computeMaxNUp(flatDims, sheetDims) {
        if (!flatDims || !sheetDims) return null;
        const [fw, fh] = flatDims;
        const [sw, sh] = sheetDims;
        const fit1 = Math.floor(sw / fw) * Math.floor(sh / fh);
        const fit2 = Math.floor(sw / fh) * Math.floor(sh / fw);
        return Math.max(fit1, fit2);
    }

    // Build plain English paragraph from component's checked piece specs
    function generateSpecsSummary(comp) {
        if (!comp) return '';
        const checks = comp.checkboxes || {};
        const notes = comp.notes || {};
        const name = comp.name || 'Component';
        const disabledFields = window.DEPT_REGISTRY.prepress.getDisabledFields(comp);

        // Helper: get value only if checkbox is checked and value is non-empty.
        // Rows grayed out for this piece type count as empty.
        function val(cbId, noteId) {
            if (disabledFields.includes(noteId)) return '';
            return (checks[cbId] && (notes[noteId] || '').trim()) ? notes[noteId].trim() : '';
        }

        // Normalize em-spaces from dropdown descriptions: "4.125″ x 9.5″   No. 10 Env" → "4.125″ x 9.5″ (No. 10 Env)"
        function cleanVal(cbId, noteId) {
            const raw = val(cbId, noteId);
            const emIdx = raw.indexOf('\u2003');
            if (emIdx !== -1) {
                const dims = raw.substring(0, emIdx).trim();
                const desc = raw.substring(emIdx).replace(/\u2003+/g, '').trim();
                return desc ? dims + ' (' + desc + ')' : dims;
            }
            return raw.replace(/  +/g, ' ').trim();
        }

        const flatSize    = cleanVal('ps3', 'ps3n');
        const finishedSize = cleanVal('ps4', 'ps4n');
        const presswork   = val('sp2', 'sp2n');
        const press       = val('sp3', 'sp3n');
        const sheetSize   = cleanVal('ps1', 'ps1n');
        const printMarks  = val('ps14', 'ps14n');
        const numberUp    = val('ps13', 'ps13n');
        const indicia     = val('sp7', 'sp7n');
        const headInfo    = val('ps10', 'ps10n');
        const binding     = val('sp6', 'sp6n');
        const specialColor = val('sp4', 'sp4n');
        const prevJob     = val('sp1', 'sp1n');

        // Variable print fields
        const addressBlk  = checks['ps11'] ? (notes['ps11n'] || '').trim() : '';
        const barCamera   = checks['vp1']  ? (notes['vp1n']  || '').trim() : '';
        const barInserter = checks['ps12'] ? (notes['ps12n'] || '').trim() : '';
        const matchJob    = checks['vp3']  ? (notes['vp3n']  || '').trim() : '';

        // Build the main sentence
        const parts = [];

        // Opening: "[Name] prints [N-up] on [sheet] on the [press]"
        let opener = name;
        const hasPress = press && press !== 'N/A';
        if (numberUp && sheetSize && hasPress) {
            opener += ' prints ' + numberUp.toLowerCase() + ' on ' + sheetSize + ' sheets on the ' + press;
        } else if (numberUp && sheetSize) {
            opener += ' prints ' + numberUp.toLowerCase() + ' on ' + sheetSize + ' sheets';
        } else if (sheetSize && hasPress) {
            opener += ' prints on ' + sheetSize + ' sheets on the ' + press;
        } else if (hasPress) {
            opener += ' prints on the ' + press;
        } else if (sheetSize) {
            opener += ' prints on ' + sheetSize + ' sheets';
        } else {
            opener += ' specs';
        }

        // Print marks
        if (printMarks) {
            const marksLower = printMarks.toLowerCase();
            if (marksLower === 'crop and bleeds' || marksLower === 'crops and bleeds') {
                opener += ' with crop marks and bleeds';
            } else if (marksLower === 'crops only') {
                opener += ' with crop marks, no bleeds';
            } else if (marksLower === 'bleeds only') {
                opener += ' with bleeds, no crop marks';
            }
        }
        parts.push(opener + '.');

        // Flat size + finished size
        if (flatSize && finishedSize) {
            // Only say "folded" when a flat dimension is roughly double a finished dimension
            const fDims = parseDims(flatSize);
            const fnDims = parseDims(finishedSize);
            let isFold = false;
            if (fDims && fnDims) {
                const [fw, fh] = fDims;
                const [nw, nh] = fnDims;
                isFold = (Math.abs(fw - nw * 2) < 0.2 || Math.abs(fh - nh * 2) < 0.2 ||
                          Math.abs(fw - nh * 2) < 0.2 || Math.abs(fh - nw * 2) < 0.2);
            }
            parts.push('Flat size is ' + flatSize + ', finishing at ' + finishedSize + (isFold ? ' folded.' : '.'));
        } else if (flatSize) {
            parts.push('Flat size is ' + flatSize + '.');
        } else if (finishedSize) {
            parts.push('Finished size is ' + finishedSize + '.');
        }

        // Presswork
        if (presswork) {
            // Parse "Color, Duplex \u2013 4/4" into readable form
            const pwLower = presswork.toLowerCase();
            if (pwLower.includes('duplex')) {
                const ink = presswork.split('\u2013').pop().trim() || presswork.split('-').pop().trim();
                const colorType = pwLower.includes('b&w') && pwLower.includes('color') ? 'Color/B&W' :
                                  pwLower.includes('b&w') ? 'B&W' : 'Color';
                parts.push(colorType + ' duplex (' + ink + ').');
            } else if (pwLower.includes('simplex')) {
                const ink = presswork.split('\u2013').pop().trim() || presswork.split('-').pop().trim();
                const colorType = pwLower.includes('b&w') && pwLower.includes('color') ? 'Color/B&W' :
                                  pwLower.includes('b&w') ? 'B&W' : 'Color';
                parts.push(colorType + ' simplex (' + ink + ').');
            } else {
                parts.push('Presswork: ' + presswork + '.');
            }
        }

        // Head info
        if (headInfo) parts.push('Orientation: ' + headInfo + '.');

        // Binding
        if (binding) parts.push('Binding: ' + binding + '.');

        // Special color
        if (specialColor) parts.push('Special color: ' + specialColor + '.');

        // Previous job
        if (prevJob) parts.push('Reprinted from job ' + prevJob + '.');

        // Variable print
        if (checks['ps11'] && addressBlk && !ADDRESS_BLOCKS[addressBlk]) {
            parts.push('Variable address block (' + addressBlk + ').');
        } else if (checks['ps11'] && !addressBlk) {
            parts.push('Variable address block.');
        }
        if (checks['vp1'])  parts.push('Includes camera-read 2D barcode' + (barCamera ? ' (' + barCamera + ')' : '') + '.');
        if (checks['ps12']) parts.push('Includes inserter 2D barcode' + (barInserter ? ' (' + barInserter + ')' : '') + '.');
        if (checks['vp3'])  parts.push(matchJob ? matchJob + ' match job.' : 'Match job.');

        let result = parts.join(' ');

        // Indicia: add label + full text block
        if (indicia && INDICIA_BLOCKS[indicia]) {
            result += '\n\nIndicia: ' + indicia + '\n' + INDICIA_BLOCKS[indicia];
        }

        // Address block: add label + full text block
        if (addressBlk && ADDRESS_BLOCKS[addressBlk]) {
            result += '\n\nAddress Block: ' + ADDRESS_BLOCKS[addressBlk];
        }

        return result;
    }

    // QC validation: check for physically impossible spec combinations
    function validateSpecs(comp) {
        if (!comp) return [];
        const checks = comp.checkboxes || {};
        const notes = comp.notes || {};
        const warnings = [];
        const disabledFields = window.DEPT_REGISTRY.prepress.getDisabledFields(comp);

        // Rows grayed out for this piece type count as empty, so they raise no warnings
        function val(cbId, noteId) {
            if (disabledFields.includes(noteId)) return '';
            return (checks[cbId] && (notes[noteId] || '').trim()) ? notes[noteId].trim() : '';
        }

        const flatSize    = val('ps3', 'ps3n');
        const finishedSize = val('ps4', 'ps4n');
        const sheetSize   = val('ps1', 'ps1n');
        const numberUp    = val('ps13', 'ps13n');
        const printMarks  = val('ps14', 'ps14n');
        const presswork   = val('sp2', 'sp2n');
        const press       = val('sp3', 'sp3n');
        const specialColor = val('sp4', 'sp4n');
        const compName    = (comp.name || '').toLowerCase();

        const flatDims  = parseDims(flatSize);
        const sheetDims = parseDims(sheetSize);
        const finDims   = parseDims(finishedSize);
        const nUp       = parseNUp(numberUp);

        // Check: flat pieces fit on sheet at given N-up.
        // Adjacent pieces with bleeds share cuts (one blade through two bleeds), so bleed
        // is NOT added per-piece. Grip edge and outer bleed boundary are press-setup
        // decisions the operator has already made when specifying N-up. The QC only
        // catches geometric impossibility (can N pieces physically fit?). Math lives in
        // computeMaxNUp() near parseNUp() so the live hint under Number Up can reuse it.
        if (flatDims && sheetDims && nUp && nUp > 0) {
            const maxFit = computeMaxNUp(flatDims, sheetDims);
            if (nUp > maxFit) {
                warnings.push(nUp + '-up of ' + flatSize + ' does not fit on ' + sheetSize + ' sheet (max ' + maxFit + '-up).');
            }
        }

        // Check: the finished piece fits inside the flat it is cut or folded
        // from, either way round. A piece that is never folded (a postcard)
        // finishes at its flat size, so the same size passes, written either
        // way round (David, 2026-10-15). This compared areas: every flat piece
        // was flagged, and a 5x5 from a 4x12 flat was not.
        if (flatDims && finDims) {
            const [fw, fh] = flatDims;
            const [nw, nh] = finDims;
            const slack = 0.01;   // "3.667" for a third of 11
            const fitsInside = (nw <= fw + slack && nh <= fh + slack) ||
                               (nw <= fh + slack && nh <= fw + slack);
            if (!fitsInside) {
                warnings.push('Finished size (' + finishedSize + ') does not fit inside flat size (' + flatSize + ').');
            }
        }

        // Check: duplex on Kirk-Rudy
        if (press && press.toLowerCase() === 'kirk-rudy' && presswork && presswork.toLowerCase().includes('duplex')) {
            warnings.push('Kirk-Rudy cannot print duplex.');
        }

        // Check: envelope component on sheet-fed press (Canon/Titan)
        const isEnv = isEnvelopeComponent(compName);
        if (isEnv && press && (press.toLowerCase().includes('canon') || press.toLowerCase().includes('titan'))) {
            warnings.push(comp.name + ' assigned to ' + press + '. Envelopes typically run on Kirk-Rudy.');
        }

        // Check: Titan prints black only, simplex or duplex (1/0, 1/1). Any
        // side in color is a warning, 4/1 and 1/4 included (David, 2026-10-15);
        // "Color/B&W" used to pass because it says B&W.
        if (press && press.toLowerCase().includes('titan')) {
            const pwLower = (presswork || '').toLowerCase();
            const inks = (pwLower.match(/(\d+)\s*\/\s*(\d+)/) || []).slice(1).map(Number);
            if (pwLower.includes('color') || inks.some(n => n > 1)) {
                warnings.push('Titan is B&W only but presswork is set to ' + presswork + '.');
            }
            if (specialColor) {
                warnings.push('Titan is B&W only but special color is listed (' + specialColor + ').');
            }
        }

        // Check: flat larger than sheet (even at 1-up, no N-up required)
        if (flatDims && sheetDims && !nUp) {
            const [fw, fh] = flatDims;
            const [sw, sh] = sheetDims;
            const normalFits = fw <= sw && fh <= sh;
            const rotatedFits = fh <= sw && fw <= sh;
            if (!normalFits && !rotatedFits) {
                warnings.push('Flat (' + flatSize + ') is larger than sheet (' + sheetSize + ') in both orientations.');
            }
        }

        // Check: head info on simplex (head orientation is meaningless for single-sided)
        const headInfo = val('ps10', 'ps10n');
        if (headInfo && presswork && presswork.toLowerCase().includes('simplex')) {
            warnings.push('Head orientation (' + headInfo + ') set but presswork is simplex (single-sided).');
        }

        // Check: duplex on labels/stickers (inherently single-sided formats)
        const SINGLE_SIDED_FORMATS = ['label', 'sticker'];
        if (presswork && presswork.toLowerCase().includes('duplex') && SINGLE_SIDED_FORMATS.some(f => compName.includes(f))) {
            warnings.push('Duplex presswork on ' + comp.name + '. Labels and stickers are typically single-sided.');
        }

        // Check: indicia/address block mismatch (mail-carrier components only).
        // Not a window envelope: its address is on the piece inside, showing
        // through the window, and is never printed on it (David, 2026-10-15).
        const MAIL_CARRIERS = ['envelope', 'postcard', 'self-mailer'];
        const isMailCarrier = MAIL_CARRIERS.some(kw => compName.includes(kw)) &&
                              !compName.includes('bre') && !compName.includes('window');
        const indicia = val('sp7', 'sp7n');
        const addressBlk = checks['ps11'] ? (notes['ps11n'] || '').trim() : '';
        if (isMailCarrier && indicia && !addressBlk) {
            warnings.push('Mail class (' + indicia + ') set but no address block specified.');
        }

        // Check: N-up specified but no sheet size
        if (nUp && nUp > 1 && !sheetSize) {
            warnings.push(numberUp + ' specified but no sheet size. Cannot verify imposition.');
        }

        // Check: crops or bleeds specified but sheet has no trim room
        if (flatDims && sheetDims && printMarks) {
            const marksLower = printMarks.toLowerCase();
            const hasCrops = marksLower.includes('crop');
            const hasBleeds = marksLower.includes('bleed');

            if (hasCrops || hasBleeds) {
                // Calculate how much sheet space the flat(s) occupy in the best arrangement
                const n = nUp || 1;
                // Try both orientations, pick the one that fits
                const arrangements = [
                    [Math.ceil(n / Math.max(1, Math.floor(sheetDims[1] / flatDims[1]))) , Math.max(1, Math.floor(sheetDims[1] / flatDims[1]))],
                    [Math.max(1, Math.floor(sheetDims[0] / flatDims[0])), Math.ceil(n / Math.max(1, Math.floor(sheetDims[0] / flatDims[0])))]
                ];
                // Shop convention: crops and bleeds both add 0.125" per side (0.25" total per dimension).
                // Do not inflate this for bleed. Adjacent pieces share cuts with their neighbors,
                // and the outer boundary only needs the standard 1/8" bleed allowance.
                const minMargin = 0.125;

                // Simpler check: compare sheet to flat for 1-up, or total occupied area for N-up
                const usedW = flatDims[0] * (nUp ? Math.ceil(Math.sqrt(nUp)) : 1);
                const usedH = flatDims[1] * (nUp ? Math.ceil(nUp / Math.ceil(Math.sqrt(nUp))) : 1);

                // Per-dimension margin check (flat vs sheet directly for most practical cases)
                const marginW = sheetDims[0] - flatDims[0];
                const marginH = sheetDims[1] - flatDims[1];
                // Also check rotated
                const marginWr = sheetDims[0] - flatDims[1];
                const marginHr = sheetDims[1] - flatDims[0];

                const normalFit = marginW >= minMargin * 2 && marginH >= minMargin * 2;
                const rotatedFit = marginWr >= minMargin * 2 && marginHr >= minMargin * 2;

                if (!normalFit && !rotatedFit && n <= 1) {
                    const label = hasCrops && hasBleeds ? 'Crops and bleeds' : hasCrops ? 'Crop marks' : 'Bleeds';
                    if (marginW < 0.01 || marginH < 0.01 || marginWr < 0.01 || marginHr < 0.01) {
                        // At least one dimension matches exactly
                        warnings.push(label + ' selected but flat (' + flatSize + ') fills the sheet (' + sheetSize + ') with no trim margin. Remove print marks or use a larger sheet.');
                    } else {
                        warnings.push(label + ' selected but sheet (' + sheetSize + ') leaves less than ' + (minMargin * 2) + '\u2033 trim margin around flat (' + flatSize + ').');
                    }
                }
            }
        }

        return warnings;
    }

    // Insert or replace the specs block in Quill
    // Registry hooks: prepress's existing summary functions become its registry
    // methods. TS registers its own equivalents in js/techservices.js. Each dept
    // owns its own generator, validator, fingerprint, markers, and fingerprint-
    // field name — so prepress and TS cannot bleed into each other's content,
    // markers, or staleness state. The Quill at any moment only holds the
    // active dept's instructions (per comp['instructions_' + activeDepartment]),
    // so a TS-summary marker is invisible when prepress is active and vice versa.
    window.DEPT_REGISTRY.prepress.generateSummary       = generateSpecsSummary;
    window.DEPT_REGISTRY.prepress.validateSummary       = validateSpecs;
    window.DEPT_REGISTRY.prepress.summaryFingerprint    = specsFingerprint;
    window.DEPT_REGISTRY.prepress.summaryMarkerStart    = SPECS_MARKER_START;
    window.DEPT_REGISTRY.prepress.summaryMarkerEnd      = SPECS_MARKER_END;
    window.DEPT_REGISTRY.prepress.summaryFingerprintField = 'specsFingerprint';

    // Generic dispatcher: reads the active department from the registry and
    // uses ITS generator + markers + fingerprint. Replaces the prepress-only
    // generateSpecsBlock(). Falls back gracefully if a future dept hasn't
    // implemented generateSummary yet. Hands back the piece's save (see
    // saveComponentState) or nothing, for Update & Print to wait on.
    async function generateSummaryBlock() {
        if (!currentJobId || !currentComponentId || isViewed(currentJobId)) return;
        // View Read-Only (the lock banner) disables the editor, and Quill drops
        // every edit on a disabled editor: the block would stay as it is while
        // the fingerprint below moved, under the reader's name.
        if (!quill.isEnabled()) return;

        const dept = window.DEPT_REGISTRY[activeDepartment];
        if (!dept || typeof dept.generateSummary !== 'function') return;

        // Save current state first so we read latest values
        saveComponentState();
        const comp = getCurrentComponent();
        if (!comp) return;
        // Taken before this function writes anything into the piece, so the
        // save at the end sees the fingerprint move even when the words do not
        // (saveComponentState's options.before).
        const before = componentSignature(comp);

        // Run dept-scoped QC validation (TS returns [] until rules are written).
        // As a method, never through a copied variable (the Tech Services
        // fingerprint broke that way; PRINT_UPDATE_PLAN.md).
        const warnings = typeof dept.validateSummary === 'function' ? dept.validateSummary(comp) : [];

        // Generate the paragraph
        const summary = dept.generateSummary(comp);
        if (!summary || !summary.trim()) {
            showWarningModal('Nothing to generate', ['No fields are checked. Fill in some fields first.'], { type: 'info', okLabel: 'OK' });
            return;
        }

        // Show inline QC warnings (generate always proceeds)
        const strip = document.getElementById('qcInlineStrip');
        const stripList = document.getElementById('qcInlineList');
        if (warnings.length > 0) {
            stripList.innerHTML = warnings.map(w => '<li>' + escHtml(w) + '</li>').join('');
            strip.style.display = '';
        } else {
            strip.style.display = 'none';
        }

        // Marker lines in a shape nobody can rebuild safely (a lone marker, two
        // Starts, a block and a stray line): the person fixes them by hand.
        // Update & Print leaves such a piece alone too (outdatedSummaries).
        if (summaryBlockShape(editorDocText(quill), dept).kind === 'odd') {
            showWarningModal('Summary lines out of order', ['Delete the grey marker lines by hand, then press Generate again.'], { type: 'info', okLabel: 'OK' });
            return;
        }

        // Capture undo state before modifying
        pushToUndo(true);

        // The block goes in through the same writer Update & Print uses on a
        // piece that is not open; only the caret is this editor's own business.
        // Written as an 'api' change, not 'user': it is not typing, and Quill
        // moves the caret (which focuses the box, and the focus listener resets
        // the typing flag) before it announces the change, so a 'user' change
        // here was pushed as a second undo entry and the first Ctrl+Z did
        // nothing visible.
        const placed = writeSummaryBlock(quill, dept, summary, 'api');
        rememberSummaryFingerprint(dept, comp);
        quill.setSelection(placed.caret);
        // What the next keystroke pushes: the piece as it is now, fingerprint
        // and grey marker lines included (the focus that came with the caret
        // snapshotted it half way through).
        fieldDirty = false;
        focusSnapshot = captureState();

        const saved = saveJobState({ before });
        return saved && saved.sent;
    }

    // Back-compat shim: any leftover callers of generateSpecsBlock route through
    // the new dispatcher. Safe to remove once all callsites are migrated.
    async function generateSpecsBlock() { return generateSummaryBlock(); }

    // ── The summary block and its fingerprint (PRINT_UPDATE_PLAN.md) ──
    //
    // Generate writes a department's summary between two marker lines and
    // remembers a fingerprint of the fields it read, inside the piece's notes
    // under the department's own key (summaryFingerprintField), so it is saved
    // with the piece and a print on any day, in any browser, can tell that the
    // fields have moved since (David, 2026-09-27: after a reload too). It used
    // to sit on the piece object itself, which the server never stored, so a
    // reload forgot it. Nothing reads notes by enumeration except
    // componentSignature, which is exactly what should see it; the print and
    // the screen read notes by the ids in PRINT_SECTIONS.

    // The departments that have a summary at all.
    function summaryDepts() {
        return Object.values(window.DEPT_REGISTRY || {}).filter(d => d.summaryMarkerStart && d.summaryMarkerEnd && d.summaryFingerprintField && typeof d.summaryFingerprint === 'function');
    }
    function summaryFingerprintStored(dept, comp) {
        return ((comp && comp.notes) || {})[dept.summaryFingerprintField] || '';
    }
    // A method call on purpose: the Tech Services fingerprint reads its own
    // registry, and a copy of the function called on its own handed back ''
    // (every print after Generate said outdated; Print All's Update stored '').
    function summaryFingerprintNow(dept, comp) {
        return dept.summaryFingerprint(comp) || '';
    }
    // A fingerprint is remembered and the fields no longer match it. A block
    // with none (every piece from before this build) is never outdated: there
    // is nothing to compare against until its next Generate.
    function summaryOutdated(dept, comp) {
        const stored = summaryFingerprintStored(dept, comp);
        return !!stored && stored !== summaryFingerprintNow(dept, comp);
    }
    function rememberSummaryFingerprint(dept, comp) {
        comp.notes = comp.notes || {};
        comp.notes[dept.summaryFingerprintField] = summaryFingerprintNow(dept, comp);
    }
    // A copy (Duplicate Job, Duplicate Component, a template) keeps the notes
    // and not the block, so it must not keep a fingerprint for a block it does
    // not have. Returns the same notes, for use in place.
    function forgetSummaryFingerprints(notes) {
        if (notes) summaryDepts().forEach(d => { delete notes[d.summaryFingerprintField]; });
        return notes;
    }
    // The undo snapshot's copy of a piece's fingerprint for one department
    // (undefined where none is remembered), and the way back. One department
    // only: the undo stacks are per department, and a snapshot that carried the
    // other department's key put that key back from a moment whose block it
    // did not restore (the build review, 2026-09-27).
    function summaryFingerprintsOf(comp, deptId) {
        const dept = window.DEPT_REGISTRY[deptId];
        const out = {};
        if (dept && dept.summaryFingerprintField) out[dept.summaryFingerprintField] = ((comp && comp.notes) || {})[dept.summaryFingerprintField];
        return out;
    }
    function restoreSummaryFingerprints(comp, fingerprints) {
        if (!comp || !fingerprints) return;
        comp.notes = comp.notes || {};
        Object.keys(fingerprints).forEach(key => {
            if (fingerprints[key] === undefined) delete comp.notes[key];
            else comp.notes[key] = fingerprints[key];
        });
    }

    // The stored words as text, for reading the marker lines: the raw HTML
    // would miss a marker Quill has split across two spans (a partial re-style).
    function storedText(stored) {
        return inertBody(instructionsAsHtml(stored)).textContent || '';
    }
    // An editor's text with one placeholder character per picture: getText()
    // leaves pictures out, so its indexes are short by one per picture above
    // the block, and deleteText, insertText and formatText count pictures.
    function editorDocText(q) {
        return q.getContents().ops.map(op => typeof op.insert === 'string' ? op.insert : '\uFFFC').join('');
    }

    // Where a department's marker lines stand in some words (an editor's
    // text, or the stored words as text), in order, and the shape they make:
    //   none    no marker line: a first block goes at the caret or the end
    //   block   Start then End: replaced where it stands
    //   repair  End then Start, or End, Start, End: what Print All's rebuild
    //           left before 2026-09-27 (the block reversed above the words,
    //           then the words deleted on a second pass; production has run
    //           it since 2026-05-25). Replaced from the first marker line
    //           through the last, keeping every paragraph before the first
    //           and after the last: the person's words after the Start
    //           survive, and what follows the last End (the old summary, or a
    //           note typed later) is kept as ordinary words, not guessed at.
    //   odd     anything else with a marker in it (a lone marker, two Starts,
    //           a block and a stray line): Update & Print leaves the piece
    //           alone and the box says so by name, and Generate says so and
    //           does nothing, so the person deletes the grey lines by hand.
    //           Nothing guesses which paragraph is a summary and which is a
    //           person's words.
    // Nothing ever adds a second block while a marker line exists: that is
    // what armed the deletion of a person's words on the next pass.
    function summaryBlockShape(text, dept) {
        const marks = [];
        [[dept.summaryMarkerStart, 'S'], [dept.summaryMarkerEnd, 'E']].forEach(([m, kind]) => {
            for (let i = text.indexOf(m); i !== -1; i = text.indexOf(m, i + m.length)) marks.push({ at: i, len: m.length, kind });
        });
        marks.sort((a, b) => a.at - b.at);
        const order = marks.map(m => m.kind).join('');
        const kind = !marks.length ? 'none' : order === 'SE' ? 'block' : (order === 'ES' || order === 'ESE') ? 'repair' : 'odd';
        const first = marks[0];
        const last = marks[marks.length - 1];
        return { kind, start: first ? first.at : -1, length: first ? (last.at + last.len) - first.at : 0 };
    }

    // Writes the department's block into a Quill editor (the visible one from
    // Generate, the hidden one from Update & Print) and styles the marker
    // lines small and grey. One change, not a delete and an insert: the focus
    // listener snapshots the piece whenever the caret moves, and a snapshot
    // taken between the two left an Undo that put back a box with the block
    // deleted and nothing in its place. Never moves the caret: on the hidden
    // editor that would reach the page's own selection. Hands back where the
    // caret belongs. Callers refuse the odd shape first.
    function writeSummaryBlock(q, dept, summary, source) {
        const Delta = Quill.import('delta');
        const markerStart = dept.summaryMarkerStart;
        const markerEnd = dept.summaryMarkerEnd;
        const fullBlock = markerStart + '\n' + summary + '\n' + markerEnd;
        const editorText = editorDocText(q);
        const shape = summaryBlockShape(editorText, dept);
        let insertAt;
        let caret;
        if (shape.kind !== 'none') {
            q.updateContents(new Delta().retain(shape.start).delete(shape.length).insert(fullBlock), source);
            insertAt = shape.start;
            caret = insertAt + fullBlock.length;
        } else {
            // First time: at the caret (the hidden editor has none: the end)
            const selection = q.getSelection();
            const index = selection ? selection.index : q.getLength() - 1;
            const prefix = (index > 0 && editorText.charAt(index - 1) !== '\n') ? '\n' : '';
            const text = prefix + fullBlock + '\n';
            q.updateContents(new Delta().retain(index).insert(text), source);
            insertAt = index + prefix.length;
            caret = index + text.length;
        }
        const markerFormat = { size: 'small', color: '#b0b0b0' };
        const freshText = editorDocText(q);
        const sIdx = freshText.indexOf(markerStart, insertAt > 2 ? insertAt - 2 : 0);
        const eIdx = freshText.indexOf(markerEnd, insertAt > 2 ? insertAt - 2 : 0);
        if (sIdx !== -1) q.formatText(sIdx, markerStart.length, markerFormat, 'silent');
        if (eIdx !== -1) q.formatText(eIdx, markerEnd.length, markerFormat, 'silent');
        return { caret };
    }

    // The hidden editor that rebuilds a block on a piece that is not open:
    // Quill's own reading and writing of the stored words, so the piece is
    // stored exactly as the visible editor would store it (spiked 2026-09-27
    // on Quill 2.0.3: byte for byte the same HTML for the same rebuild). Made
    // once, never in the document, no theme, no toolbar; its edits are 'api',
    // so nothing this page listens for on the visible editor fires.
    let summaryScratchEditor = null;
    function summaryScratch() {
        if (!summaryScratchEditor) {
            summaryScratchEditor = new Quill(document.createElement('div'), { modules: { toolbar: false, history: { maxStack: 0 } } });
            stripTablesOnPaste(summaryScratchEditor);
        }
        return summaryScratchEditor;
    }
    // Rebuilds one department's block on a piece that is not open. Answers
    // whether the piece changed: the same words and fingerprint again (a field
    // undone while the box was up) change nothing and stamp nobody.
    function rebuildSummaryHidden(dept, deptId, comp, summary) {
        const key = 'instructions_' + deptId;
        const wordsBefore = comp[key] || '';
        const fingerprintBefore = summaryFingerprintStored(dept, comp);
        const q = summaryScratch();
        const html = instructionsAsHtml(wordsBefore);
        if (html) q.setContents(q.clipboard.convert({ html, text: '' }), 'api');
        else q.setContents([], 'api');
        writeSummaryBlock(q, dept, summary, 'api');
        // Never empty: the block's own words are in it.
        comp[key] = q.root.innerHTML;
        q.setContents([], 'api');
        rememberSummaryFingerprint(dept, comp);
        return comp[key] !== wordsBefore || summaryFingerprintStored(dept, comp) !== fingerprintBefore;
    }

    // A viewed archived job and a page in View Read-Only (the lock banner)
    // print what is stored and are never asked: neither may write a piece.
    function canUpdateSummaries(job) {
        return !isViewed(job.id) && !document.body.classList.contains('read-only');
    }
    // The pieces a print must ask about for the department showing: a marker
    // line in the stored words and a remembered fingerprint the fields no
    // longer match. Each says what Update & Print would do with it: rebuilt,
    // or left alone with the reason the box gives (leftAlone).
    function outdatedSummaries(job, deptId) {
        const dept = window.DEPT_REGISTRY[deptId];
        if (!dept || !summaryDepts().includes(dept)) return [];
        const out = [];
        (job.components || []).forEach(comp => {
            const kind = summaryBlockShape(storedText(comp['instructions_' + deptId]), dept).kind;
            if (kind === 'none' || !summaryOutdated(dept, comp)) return;
            const summary = (dept.generateSummary(comp) || '').trim();
            const open = comp.id === currentComponentId && deptId === activeDepartment;
            const leftAlone = kind === 'odd' ? 'its summary lines are out of order and are left as they are. ' + (open ? 'Delete' : 'Open it, delete') + ' the grey marker lines by hand, then press Generate.'
                : !summary ? 'no fields are ticked, so its summary is left as it is.' : '';
            out.push({ comp, kind, summary, leftAlone });
        });
        return out;
    }
    // The one box the three prints share. Print as is is what Cancel always
    // did (the stored words print unchanged), named for what it does.
    function confirmSummaryUpdate(outdated) {
        const nameSpan = '<span class="qc-comp-name">' + escHtml(outdated.map(o => o.comp.name).join(', ')) + '</span>';
        const lines = ['Fields have changed since the last Generate.'].concat(outdated.filter(o => o.leftAlone).map(o => o.comp.name + ': ' + o.leftAlone));
        // Every named piece left alone: nothing to rebuild, so one button.
        const nothingToRebuild = outdated.every(o => o.leftAlone);
        return showWarningModal('Summary outdated for ' + nameSpan, lines, nothingToRebuild
            ? { type: 'stale', okLabel: 'Print', showCancel: false }
            : { type: 'stale', okLabel: 'Update & Print', cancelLabel: 'Print as is' });
    }
    // Update & Print: every named piece that can be updated is rebuilt and
    // sent, and the print waits until the server has taken them all. The open
    // piece goes through Generate itself (its undo snapshot, the QC strip, the
    // editor); any other piece through the hidden editor. Answers false when a
    // save was refused (the reload box is then showing) or could not go, so
    // nothing prints that the record did not take.
    async function updateSummaries(job, deptId, outdated) {
        const dept = window.DEPT_REGISTRY[deptId];
        const sends = [];
        outdated.forEach(o => {
            if (o.leftAlone) return;
            // Asked again: a field undone while the box was open is not rebuilt.
            if (!summaryOutdated(dept, o.comp)) return;
            // The summary too: Ctrl+Z reaches the work order behind the box.
            const summary = (dept.generateSummary(o.comp) || '').trim();
            if (!summary) return;
            if (o.comp.id === currentComponentId && deptId === activeDepartment) {
                sends.push(generateSummaryBlock());
                return;
            }
            if (rebuildSummaryHidden(dept, deptId, o.comp, summary)) sends.push(stampAndSendPiece(job, o.comp));
        });
        // A save that failed outright (a 500) rejects; it counts as not landed.
        // At most 10 s: one print at a time waits on this (withLatestCopy).
        const landed = await Promise.race([
            Promise.all(sends.map(sent => Promise.resolve(sent).then(v => v === undefined ? true : v, () => false))),
            new Promise(resolve => setTimeout(() => resolve(sends.map(() => false)), 10000))
        ]);
        const ok = landed.every(Boolean);
        // The reload box (a 409), the lock's box (a 423: the job is somebody
        // else's now, and the page is a view of it) and the server-down banner
        // already explain themselves; anything else gets a line, so nothing
        // fails in silence.
        const lockModal = document.getElementById('lockModal');
        if (!ok && !_serverDown && document.getElementById('reloadModal').style.display !== 'block'
            && !(lockModal && lockModal.style.display === 'block') && !isViewed(job.id)) {
            showErrorModal('The summary could not be saved, so nothing was printed. Try again.', 'Close');
        }
        return ok;
    }
    // The question every print asks first. Answers false when the print must
    // not go on (a rebuilt piece's save was refused).
    async function summariesReadyToPrint(job, deptId, onlyComp) {
        if (!canUpdateSummaries(job)) return true;
        const outdated = outdatedSummaries(job, deptId).filter(o => !onlyComp || o.comp.id === onlyComp.id);
        if (!outdated.length) return true;
        if (!(await confirmSummaryUpdate(outdated))) return true;
        return updateSummaries(job, deptId, outdated);
    }

    function selectQuickPick(optionEl) {
        if (isViewed(currentJobId)) return;
        const wrapper = optionEl.closest('.quick-pick-wrapper');
        const input = wrapper.querySelector('input.notes') || wrapper.querySelector('input');
        const menu = wrapper.querySelector('.quick-pick-menu');
        const newValue = optionEl.dataset.value;

        // Indicia dropdown: just set the value (Generate button handles CSR Instructions insertion)

        // Check if this is a field-row item (supports multiple) or form field (single value)
        const isFieldRow = wrapper.closest('.field-row');

        if (isFieldRow) {
            // Replace value (not append)
            input.value = newValue;

            // Auto-check the toggle when a selection is made
            const checkbox = isFieldRow.querySelector('.toggle-switch input[type="checkbox"]');
            if (checkbox && input.value.trim()) {
                checkbox.checked = true;
            }
        } else {
            // For form fields, just replace the value
            input.value = newValue;
        }

        menu.classList.remove('open');

        // Trigger save if job is loaded
        if (currentJobId) {
            saveJobState();
        }
    }

    // Close Quick Pick menus when clicking outside
    document.addEventListener('click', e => {
        if (!e.target.closest('.quick-pick-wrapper')) {
            document.querySelectorAll('.quick-pick-menu.open').forEach(m => m.classList.remove('open', 'open-up'));
        }
        if (!e.target.closest('.deletion-log-dropdown')) {
            document.querySelectorAll('.deletion-log-dropdown.open').forEach(d => d.classList.remove('open'));
        }
    });

    // Close Quick Pick menus on scroll outside the menu/modal, or on resize
    window.addEventListener('scroll', (e) => {
        if (_qpJustOpened) return;
        if (e.target.closest && (e.target.closest('.quick-pick-menu') || e.target.closest('.modal-content'))) return;
        document.querySelectorAll('.quick-pick-menu.open').forEach(m => m.classList.remove('open', 'open-up'));
    }, true);
    window.addEventListener('resize', () => {
        if (_qpJustOpened) return;
        document.querySelectorAll('.quick-pick-menu.open').forEach(m => m.classList.remove('open', 'open-up'));
    });

    // Quick-pick dropdown opens only via chevron button click (toggleQuickPick).
    // No auto-open on field focus — prevents dropdown covering the field when tabbing through.

    // Filter dropdown options as user types in input
    document.addEventListener('input', e => {
        const wrapper = e.target.closest('.quick-pick-wrapper');
        if (wrapper && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
            const menu = wrapper.querySelector('.quick-pick-menu');
            if (!menu || !menu.classList.contains('open')) return;

            filterQuickPickOptions(menu, getFilterText(e.target, wrapper));
        }
    });

    // Keyboard navigation for Quick Pick menus
    document.addEventListener('keydown', e => {
        const wrapper = e.target.closest('.quick-pick-wrapper');
        if (!wrapper) return;

        const menu = wrapper.querySelector('.quick-pick-menu');
        if (!menu || !menu.classList.contains('open')) return;

        const visibleOptions = Array.from(menu.querySelectorAll('.quick-pick-option')).filter(opt => opt.style.display !== 'none');
        const highlighted = menu.querySelector('.quick-pick-option.highlighted');
        let currentIndex = highlighted ? visibleOptions.indexOf(highlighted) : -1;

        // Arrow down - move to next option (stop at end)
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (visibleOptions.length > 0 && currentIndex < visibleOptions.length - 1) {
                visibleOptions.forEach(opt => opt.classList.remove('highlighted'));
                currentIndex = currentIndex + 1;
                visibleOptions[currentIndex].classList.add('highlighted');
                visibleOptions[currentIndex].scrollIntoView({ block: 'nearest' });
            }
        }

        // Arrow up - move to previous option (stop at beginning)
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (visibleOptions.length > 0 && currentIndex > 0) {
                visibleOptions.forEach(opt => opt.classList.remove('highlighted'));
                currentIndex = currentIndex - 1;
                visibleOptions[currentIndex].classList.add('highlighted');
                visibleOptions[currentIndex].scrollIntoView({ block: 'nearest' });
            }
        }

        // Enter key selects highlighted option
        if (e.key === 'Enter') {
            if (highlighted && highlighted.style.display !== 'none') {
                selectQuickPick(highlighted);
                e.preventDefault();
            }
        }

        // Escape key closes the menu
        if (e.key === 'Escape') {
            menu.classList.remove('open', 'open-up');
            e.preventDefault();
        }

        // Tab key closes menu (allow default tab behavior)
        if (e.key === 'Tab') {
            menu.classList.remove('open', 'open-up');
        }
    });

    // ========== COMPONENT TABS FUNCTIONALITY ==========

    // Migrate old job format to new component-based format
    function migrateJobToComponents(job) {
        if (!job.components) {
            const compId = 'comp_' + Date.now();
            job.components = [{
                id: compId,
                name: 'Main',
                instructions_prepress: job.instructions || '',
                instructions_techservices: '',
                instructionsHistory_prepress: job.instructionsHistory || '',
                instructionsHistory_techservices: '',
                checkboxes: job.checkboxes || {},
                notes: job.notes || {}
            }];
            job.activeComponentId = compId;
            // Remove old fields
            delete job.instructions;
            delete job.instructionsHistory;
            delete job.checkboxes;
            delete job.notes;
        }
        return job;
    }

    // One-time per-component migration: split legacy shared instructions
    // into per-dept fields. Keeps a backup of the legacy value for one cycle
    // so a botched migration is recoverable. Idempotent: safe to re-run.
    function migrateInstructionsToPerDept(comp) {
        if (comp.instructions !== undefined
            && comp.instructions_prepress === undefined
            && comp.instructions_techservices === undefined) {
            comp._instructions_legacy_backup = comp.instructions;
            comp.instructions_prepress = comp.instructions;
            delete comp.instructions;
        }
        if (comp.instructionsHistory !== undefined
            && comp.instructionsHistory_prepress === undefined
            && comp.instructionsHistory_techservices === undefined) {
            comp._instructionsHistory_legacy_backup = comp.instructionsHistory;
            comp.instructionsHistory_prepress = comp.instructionsHistory;
            delete comp.instructionsHistory;
        }
        if (comp.instructions_prepress === undefined) comp.instructions_prepress = '';
        if (comp.instructions_techservices === undefined) comp.instructions_techservices = '';
        if (comp.instructionsHistory_prepress === undefined) comp.instructionsHistory_prepress = '';
        if (comp.instructionsHistory_techservices === undefined) comp.instructionsHistory_techservices = '';
    }

    // Get current component from current job
    function getCurrentComponent() {
        if (!currentJobId || !currentComponentId) return null;
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components) return null;
        return job.components.find(c => c.id === currentComponentId);
    }

    // Render component tabs
    function renderComponentTabs() {
        const job = shownJob();
        if (!job || !job.components) return;
        // A viewed archived job cannot be renamed, added to or cut.
        const viewing = isViewed(job.id);

        const container = document.getElementById('componentTabs');
        container.innerHTML = '';

        job.components.forEach(comp => {
            const tab = document.createElement('div');
            tab.className = 'component-tab' + (comp.id === currentComponentId ? ' active' : '');
            tab.setAttribute('data-component-id', comp.id);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'component-tab-name';
            nameSpan.textContent = (comp.version ? comp.version + ' ' : '') + comp.name;
            nameSpan.onclick = () => switchComponent(comp.id);
            if (!viewing) nameSpan.ondblclick = (e) => { e.stopPropagation(); startRenameComponent(comp.id); };

            tab.appendChild(nameSpan);

            // Only show delete button if more than one component
            if (job.components.length > 1 && !viewing) {
                const deleteBtn = document.createElement('button');
                deleteBtn.type = 'button';
                deleteBtn.className = 'close-tab';
                deleteBtn.innerHTML = '\u00d7';
                deleteBtn.title = 'Delete this component';
                deleteBtn.onclick = (e) => { e.stopPropagation(); deleteComponent(comp.id); };
                tab.appendChild(deleteBtn);
            }

            container.appendChild(tab);
        });

        // Add "+" button if under max
        if (job.components.length < MAX_COMPONENTS && !viewing) {
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'add-tab-btn';
            addBtn.innerHTML = '+';
            addBtn.title = 'Add new component';
            addBtn.onclick = openAddComponentModal;
            container.appendChild(addBtn);
        }
    }

    // Switch to a different component
    function switchComponent(componentId) {
        if (componentId === currentComponentId) return;

        // Capture any in-progress edit into undo before the switch replaces
        // the editor/form contents with the new component's data.
        if (currentJobId && fieldDirty) pushToUndo(true);
        fieldDirty = false;
        focusSnapshot = null;

        // Save current component state first. That saves any typing still
        // waiting too, so its timer goes: fired later it would read the
        // incoming piece's screen instead.
        if (currentComponentId) {
            saveComponentState();
            clearTimeout(saveDebounceTimer);
            saveDebounceTimer = null;
        }

        currentComponentId = componentId;

        // Which piece is showing is kept in this page's copy only, as the
        // department tab (switchDepartment).
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (job && !isViewed(job.id)) {
            job.activeComponentId = componentId;
            setJobsCacheOnly(jobs);
        }

        // Load the new component's data
        loadComponentData();
        renderComponentTabs();
    }

    // Save current component state to storage (shared core for all save operations)
    // What a piece holds, for deciding whether it really changed. An unticked
    // box and an empty note read the same whether they are stored or simply
    // absent: a piece that has never been saved holds no boxes at all, while
    // the screen has 51 of them and 42 notes, so reading the screen into it
    // adds 93 empty keys that nobody typed. Everything else is compared as it
    // is, so a field added later is never quietly dropped.
    function componentSignature(comp) {
        const out = {};
        Object.keys(comp).sort().forEach(key => {
            if (key !== 'checkboxes' && key !== 'notes') {
                out[key] = comp[key];
                return;
            }
            const held = comp[key] || {};
            const kept = {};
            Object.keys(held).sort().forEach(id => {
                const value = held[id];
                if (value === true || (typeof value === 'string' && value.trim() !== '')) kept[id] = value;
            });
            out[key] = kept;
        });
        return JSON.stringify(out);
    }

    function saveComponentState(options) {
        if (!currentJobId || !currentComponentId || isViewed(currentJobId)) return {};
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components) return {};

        const comp = job.components.find(c => c.id === currentComponentId);
        if (!comp) return {};

        // What the piece holds now, before the screen is read into it. Every
        // write below stamps lastModified and lastModifiedBy with whoever is on
        // the page, so a piece that did not change must not be written at all:
        // switching department or piece, or leaving the work order, called this
        // and put the reader's name on the record (measured 2026-09-17: a work
        // order last touched by David.Marra read Brandilee.Czajkowski after she
        // opened it and clicked the Tech Services tab). The work order is the
        // audit record printed to the PDF for Midnight, so only a real change
        // may move that name (David, PHASE3_PLAN question 8).
        //
        // The comparison is of the whole piece, so anything the migration below
        // adds counts as a change and is saved. A caller that wrote into the
        // piece before calling (Generate's fingerprint, an Undo's) passes the
        // signature it took first as options.before, or its own write would be
        // in both halves of the comparison and never count.
        const before = (options && options.before) || componentSignature(comp);

        // Ensure dept-keyed fields exist (safety net for pre-migration data
        // that slipped through loadJob's migration pass).
        migrateInstructionsToPerDept(comp);

        // Words nobody touched since they were loaded stay exactly as stored:
        // the editor's HTML is Quill's rewrite of them (see editorLoads).
        const instrKey = 'instructions_' + activeDepartment;
        if (!editorUntouched(comp, activeDepartment)) {
            comp[instrKey] = quill.getText().trim() ? editorHtml() : '';
        }

        document.querySelectorAll('.field-row .toggle-switch input[type="checkbox"]').forEach(cb => {
            const id = cb.getAttribute('data-id');
            if (id) comp.checkboxes[id] = cb.checked;
        });

        document.querySelectorAll('.notes').forEach(inp => {
            const id = inp.getAttribute('data-id');
            if (id) comp.notes[id] = inp.value;
        });

        // Nothing on this piece moved: the caller still gets it back, and the
        // screen still redraws, but nothing is written and no name changes.
        if (componentSignature(comp) === before) return { job, comp, unchanged: true };
        return { job, comp, sent: stampAndSendPiece(job, comp) };
    }

    // A real change to a piece: the job is stamped with whoever is on the
    // page, the job row goes 600 ms later (saveActiveJobs) and the piece goes
    // now. Returns the piece's save (true once the server took it, false when
    // it was refused or could not be sent), so a caller that must know it
    // landed, such as Update & Print before it prints, can wait for it.
    function stampAndSendPiece(job, comp) {
        job.lastModified = new Date().toISOString();
        job.lastModifiedBy = getUserName();
        saveActiveJobs(getActiveJobs());
        return persistComponent(comp, job);
    }

    // Load component data into the UI
    function loadComponentData() {
        const job = shownJob();
        if (!job || !job.components) return;

        const comp = job.components.find(c => c.id === currentComponentId);
        if (!comp) return;

        // Clear QC inline strip from previous component/job
        document.getElementById('qcInlineStrip').style.display = 'none';

        // Ensure dept-keyed fields exist
        migrateInstructionsToPerDept(comp);

        // Load instructions for the active department
        const instructions = comp['instructions_' + activeDepartment] || '';
        const history = comp['instructionsHistory_' + activeDepartment] || '';
        loadEditor(comp, activeDepartment);
        document.getElementById('instructionsHistory').innerHTML = cleanHtml(history);

        // For print display, combine current and history
        const fullInstructions = instructionsAsHtml(instructions) + (instructions && history ? '<br><br>' : '') + history;
        document.getElementById('instructionsDisplay').innerHTML = cleanHtml(fullInstructions);

        // Scroll to top
        quill.root.scrollTop = 0;

        // Load checkboxes
        document.querySelectorAll('.field-row .toggle-switch input[type="checkbox"]').forEach(cb => {
            const id = cb.getAttribute('data-id');
            cb.checked = comp.checkboxes[id] || false;
        });

        // Load notes
        document.querySelectorAll('.notes').forEach(inp => {
            const id = inp.getAttribute('data-id');
            inp.value = comp.notes[id] || '';
        });

        autoResizeAllTextareas();
        updateRowVisibility();
        updateCompletion();
        updateMasterCheckbox();
        updateGroupCheckboxes();

        // Update print header with current component
        updatePrintHeader(job);

        // Build revision timeline
        buildRevisionTimeline();

        // Context-aware dropdowns (all departments)
        Object.values(window.DEPT_REGISTRY || {}).forEach(dept => {
            if (dept.updateDropdowns) {
                const comp_dd = job.components.find(c => c.id === currentComponentId);
                if (comp_dd) dept.updateDropdowns(comp_dd);
            }
        });

        // Required fields
        updateRequiredIndicators();

        // Two widgets drawn from the boxes above, which were set by code (no
        // event): without this they kept the previous job's attendees and
        // "Max on this sheet" until something was clicked.
        if (typeof window.syncMeetingAttendees === 'function') window.syncMeetingAttendees();
        updateNumberUpHint();
    }

    // Add a new component
    async function addComponent(name, templateId) {
        if (!currentJobId) return;

        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components) return;

        if (job.components.length >= MAX_COMPONENTS) {
            alert(`Maximum ${MAX_COMPONENTS} components allowed per job.`);
            return;
        }

        // Save current component first
        saveComponentState();

        // Generate unique name if component with same name exists
        let finalName = name;
        const existingNames = job.components.map(c => c.name);

        if (existingNames.includes(name)) {
            // Find the next available number
            let counter = 2;
            while (existingNames.includes(`${name} ${counter}`)) {
                counter++;
            }
            finalName = `${name} ${counter}`;
        }

        const newComp = {
            id: 'comp_' + Date.now(),
            name: finalName,
            instructions_prepress: '',
            instructions_techservices: '',
            instructionsHistory_prepress: '',
            instructionsHistory_techservices: '',
            checkboxes: {},
            notes: {}
        };

        // Apply template if selected
        if (templateId) applyTemplateToComponent(templateId, job, newComp);

        // Create on server
        try {
            if (!await createComponentOnServer(job, newComp)) return;
        } catch (e) {
            showErrorModal("Couldn't add component.", 'Close');
            return;
        }
        pieceAddedAskBoard();

        job.components.push(newComp);
        job.activeComponentId = newComp.id;
        job.lastModified = new Date().toISOString();
        job.lastModifiedBy = getUserName();
        saveActiveJobs(jobs);

        currentComponentId = newComp.id;
        loadComponentData();
        renderComponentTabs();
    }

    // Delete a component
    async function deleteComponent(componentId) {
        if (!currentJobId) return;

        const asked = getActiveJobs().find(j => j.id === currentJobId);
        if (!asked || !asked.components || asked.components.length <= 1) return;
        const askedComp = asked.components.find(c => c.id === componentId);
        if (!askedComp) return;

        if (!(await confirmPieceDelete(asked, askedComp))) return;

        // The box waits on the board and on the person, and the page's copy of
        // the job can be replaced meanwhile (a catch-up, a lost lock): read it
        // again, and go on only while it is still the job open for editing,
        // with this piece and another on it.
        if (currentJobId !== asked.id || isViewed(currentJobId)) return;
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components || job.components.length <= 1) return;
        const comp = job.components.find(c => c.id === componentId);
        if (!comp) return;

        // Delete from server
        try {
            await deleteComponentOnServer(job, componentId);
        } catch (e) {
            // Refused by the lock: the lost path has already said who holds
            // the job; the piece stays on screen.
            if (!e || !e.locked) showErrorModal("Couldn't delete component.", 'Close');
            return;
        }

        // Audit trail
        if (!job.deletionLog) job.deletionLog = [];
        job.deletionLog.push({
            component: comp.name,
            deletedBy: getUserName() || 'Unknown',
            deletedAt: new Date().toISOString()
        });

        const idx = job.components.findIndex(c => c.id === componentId);
        job.components.splice(idx, 1);

        // If deleting current component, switch to first one
        if (currentComponentId === componentId) {
            currentComponentId = job.components[0].id;
            job.activeComponentId = currentComponentId;
            loadComponentData();
        }

        job.lastModified = new Date().toISOString();
        job.lastModifiedBy = getUserName();
        saveActiveJobs(jobs);
        renderComponentTabs();
        updatePrintHeader(job);
    }

    // Start renaming a component (double-click)
    function startRenameComponent(componentId) {
        if (isViewed(currentJobId)) return;
        const tab = document.querySelector(`.component-tab[data-component-id="${componentId}"]`);
        if (!tab) return;

        const nameSpan = tab.querySelector('.component-tab-name');
        // Get the actual component name (without version prefix that renderComponentTabs prepends)
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        const comp = job && job.components ? job.components.find(c => c.id === componentId) : null;
        const currentName = comp ? comp.name : nameSpan.textContent;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'component-tab-name-input';
        input.value = currentName;
        input.maxLength = 30;

        // Closed with the name it opened with (Escape, or a double-click by
        // habit and a click away): the tab is put back and nothing is written,
        // the same rule as the header's boxes, so no name goes on the job.
        // An emptied box is the same: no change.
        const opened = String(currentName).trim();
        input._opened = opened;   // read by closeEditorsForView: was anything typed here
        const finishRename = () => {
            const typed = input.value.trim();
            if (!typed || typed === opened) { renderComponentTabs(); return; }
            renameComponent(componentId, typed);
        };

        input.onblur = finishRename;
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                input.value = currentName;
                input.blur();
            }
        };

        nameSpan.replaceWith(input);
        input.focus();
        input.select();
    }

    // Rename a component
    function renameComponent(componentId, newName) {
        if (!currentJobId) return;

        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components) return;

        const comp = job.components.find(c => c.id === componentId);
        if (!comp) return;

        // The piece goes to the server below as this page holds it, so the
        // screen is read into it first, as every other save of it does (Print
        // All's Update & Print can have left other words in the page's copy).
        if (componentId === currentComponentId) saveComponentState();
        comp.name = newName;
        job.lastModified = new Date().toISOString();
        job.lastModifiedBy = getUserName();
        saveActiveJobs(jobs);
        // The job row's save leaves the pieces out, so the piece goes itself.
        // It used to ride on the next tab click's save of the instructions,
        // and only when Quill had rewritten them.
        persistComponent(comp, job);
        renderComponentTabs();
    }

    // Add Component Modal functions
    function openAddComponentModal() {
        populateTemplateDropdown('addComponentTemplate');
        document.getElementById('addComponentTemplate').value = '';
        document.getElementById('addComponentModal').style.display = 'block';
        document.getElementById('newComponentName').value = '';
        document.getElementById('newComponentName').focus();
    }

    function closeAddComponentModal() {
        document.getElementById('addComponentModal').style.display = 'none';
        document.getElementById('addComponentForm').reset();
    }

    // Dropdown functions. Opened with the keys (a click with no mouse behind
    // it), the cursor goes to the first item; a mouse click, or a call from
    // code, as before. Nothing under a box (KEYBOARD_PLAN.md 2.3).
    function togglePrintDropdown(event) { toggleNavMenu('printDropdown', 'moreDropdown', event); }
    function toggleMoreDropdown(event) { toggleNavMenu('moreDropdown', 'printDropdown', event); }
    function toggleNavMenu(id, otherId, event) {
        if (boxUp()) return;
        document.getElementById(otherId).classList.remove('open');
        const menu = document.getElementById(id);
        menu.classList.toggle('open');
        if (menu.classList.contains('open') && event && event.detail === 0) focusQuiet(navMenuItems(menu)[0]);
    }

    // ========== HELP MODAL: the User Guide (USER_GUIDE_PLAN.md) ==========
    // Two tabs, STS Work Order and QC Review. The book button opens the tab
    // read last in this browser (STS Work Order the first time); the Guide
    // button in the QC Review window opens the QC Review tab over the window.
    // The printer button prints the tab showing (David, 2026-10-02).
    const HELP_TABS = {
        work: { tab: 'helpTabWork', panel: 'helpPanelWork', title: 'STS Work Order User Guide' },
        qc:   { tab: 'helpTabQc',   panel: 'helpPanelQc',   title: 'QC Review User Guide' }
    };
    let helpTab = 'work';
    let helpOpener = null;     // what had focus before the guide opened
    let helpPageTitle = '';    // the page's own title, while a print box wears the guide's

    function savedHelpTab() {
        try {
            const tab = localStorage.getItem('stsHelpTab');
            return HELP_TABS[tab] ? tab : 'work';
        } catch (e) { return 'work'; }
    }

    function showHelpTab(tab, focusTab) {
        helpTab = HELP_TABS[tab] ? tab : 'work';
        Object.keys(HELP_TABS).forEach(key => {
            const on = key === helpTab;
            const button = document.getElementById(HELP_TABS[key].tab);
            button.setAttribute('aria-selected', on ? 'true' : 'false');
            button.tabIndex = on ? 0 : -1;
            document.getElementById(HELP_TABS[key].panel).hidden = !on;
        });
        try { localStorage.setItem('stsHelpTab', helpTab); } catch (e) { /* not kept in this browser */ }
        if (focusTab) document.getElementById(HELP_TABS[helpTab].tab).focus();
    }

    function openHelpModal(tab) {
        const modal = document.getElementById('helpModal');
        if (modal.style.display !== 'block') helpOpener = document.activeElement;
        modal.style.display = 'block';
        showHelpTab(HELP_TABS[tab] ? tab : savedHelpTab());
        document.getElementById(HELP_TABS[helpTab].panel).scrollTop = 0;
        // Focus goes to the guide's own box, which shows no ring. On a tab
        // it drew a focus ring beside the red line of the selected tab, after
        // a key press only, so it came and went (David's hand test, 2026-10-02).
        modal.querySelector('.help-modal-content').focus();
    }

    function closeHelpModal() {
        document.getElementById('helpModal').style.display = 'none';
        restoreHelpTitle();
        const back = helpOpener;
        helpOpener = null;
        // Back to what opened it (the book button, or the Guide button in the
        // QC Review window) while it is still on screen.
        if (back && back.isConnected && typeof back.focus === 'function' && back.offsetParent !== null) back.focus();
    }

    function restoreHelpTitle() {
        if (helpPageTitle) document.title = helpPageTitle;
        helpPageTitle = '';
    }

    // The printed tab: light colours whatever the theme, the drawings in
    // colour, the guide's own title on top and the page count at the foot. The
    // chip colours are the job list's (.review-board-chip in styles.css).
    const HELP_PRINT_CSS = `
@page { margin: 16mm 15mm 18mm; @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 9pt Arial, sans-serif; color: #6b6b80; } }
html { font-family: Arial, Helvetica, sans-serif; }
body { font-size: 10.5pt; line-height: 1.5; color: #1a1a2e; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { font-family: Georgia, serif; font-size: 17pt; margin: 0 0 14pt; padding-bottom: 6pt; border-bottom: 2px solid #d8d5cf; }
h3 { font-family: Georgia, serif; font-size: 13pt; margin: 16pt 0 5pt; break-after: avoid; }
h4 { font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.04em; margin: 10pt 0 3pt; break-after: avoid; }
p { margin: 0 0 6pt; }
ul, ol { padding-left: 18pt; margin: 0 0 6pt; }
li { margin-bottom: 3pt; }
strong { font-weight: 700; }
table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin: 6pt 0; break-inside: avoid; }
td { padding: 3pt 6pt; border-bottom: 1px solid #e8e6e1; vertical-align: top; }
td:first-child { width: 32%; }
dl { margin: 4pt 0 6pt; }
dt { font-weight: 700; margin-top: 6pt; break-after: avoid; }
dd { margin: 1pt 0 0 14pt; color: #3d3d56; }
.help-start, .help-section-limits { background: #edecea; border-radius: 6pt; padding: 8pt 12pt; margin: 6pt 0 10pt; }
.help-start h3, .help-section-limits h3 { margin-top: 0; }
.help-aside { font-size: 9.5pt; color: #6b6b80; }
.help-say::before { content: "\\201C"; }
.help-say::after { content: "\\201D"; }
.help-outside { font-size: 7.5pt; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #6b6b80; border: 1px dashed #b8b5ae; border-radius: 6pt; padding: 0 4pt; margin-left: 3pt; white-space: nowrap; }
.help-btn { display: inline-block; font-size: 8.5pt; font-weight: 700; padding: 1pt 6pt; border-radius: 3pt; white-space: nowrap; border: 1px solid transparent; }
.help-btn--red { background: #CB333B; color: #ffffff; }
.help-btn--navy { background: #1e3a5f; color: #ffffff; }
.help-btn--ink { background: #1a1a2e; color: #ffffff; }
.help-btn--outline { color: #CB333B; border: 1px solid #CB333B; }
.help-btn--quiet { color: #3d3d56; border: 1px solid #d8d5cf; }
.help-chip { display: inline-block; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap; padding: 1pt 6pt; border-radius: 8pt; border: 1px solid #d8d5cf; color: #6b6b80; }
.help-chip.is-corrections { border: 1px solid #CB333B; background: #CB333B; color: #ffffff; }
.help-chip.is-recheck { border: 1px solid #CB333B; color: #CB333B; }
.help-chip.is-in-review { border: 1px dashed #CB333B; color: #3d3d56; }
.help-chip.is-ready { border: 1px dashed #6b6b80; color: #3d3d56; }
.help-chip.is-new-job { border: 1px solid #6b6b80; color: #3d3d56; }
.help-chip.is-came-back { border: 1px solid #1e3a5f; background: #1e3a5f; color: #f6f5f2; }
.help-chip.is-send-to-csr { border: 1px dashed #1e3a5f; color: #1e3a5f; }
.help-chip.is-with-csr { border: 1px solid #1e3a5f; color: #1e3a5f; }
.help-chip.is-csr-passed { border: 1px solid #1e3a5f; background: rgba(30,58,95,0.10); color: #1e3a5f; }
.help-words { display: grid; grid-template-columns: 90pt 1fr; gap: 3pt 10pt; }
.help-words dt, .help-words dd { margin: 0; }
.help-steps { list-style: none; margin: 7.5pt 0 9pt; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.help-steps .help-step { margin: 0; break-inside: avoid; display: flex; flex-direction: column; gap: 8px; padding: 8px; background: #ffffff; border: 1px solid #e8e6e1; border-radius: 6px; }
.help-step-head { display: flex; align-items: flex-start; gap: 6px; }
.help-step-no { flex: none; font-size: 12px; font-weight: 700; line-height: 1.45; color: #6b6b80; }
.help-step-title { font-size: 13.5px; font-weight: 700; line-height: 1.3; color: #1a1a2e; }
.help-steps .help-step-text { margin: 0; font-size: 13px; line-height: 1.45; color: #3d3d56; }
.help-who { margin-left: auto; flex: none; padding: 0 6px; font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em; line-height: 1.6; text-transform: uppercase; color: #6b6b80; border: 1px solid #d8d5cf; border-radius: 8px; }
.help-pic { height: 80px; box-sizing: border-box; overflow: hidden; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 6px; padding: 8px 10px; line-height: 1.5; background: #f6f5f2; border: 1px solid #e8e6e1; border-radius: 6px; }
.help-pic--tight { padding: 7px 10px; gap: 5px; }
.help-pic--bar { padding: 0; justify-content: flex-start; gap: 0; }
.help-pic-row { display: flex; align-items: center; gap: 5px; }
.help-pic-row--wrap { flex-wrap: wrap; }
.help-pic-arrow { flex: none; color: #6b6b80; }
.help-pic-input { display: flex; align-items: center; width: 100%; max-width: 180px; box-sizing: border-box; padding: 2px 8px; overflow: hidden; white-space: nowrap; font-size: 12px; line-height: 1.5; color: #1a1a2e; background: #ffffff; border: 1.5px solid #d8d5cf; border-radius: 6px; }
.help-pic-input.is-focus { border-color: #CB333B; }
.help-pic-input svg { flex: none; margin-right: 5px; color: #6b6b80; }
.help-pic-hint { font-size: 11.5px; color: #6b6b80; }
.help-pic-caret { display: inline-block; width: 1px; height: 13px; margin-left: 1px; background: #1a1a2e; }
.help-pic-tabs { display: flex; width: 100%; white-space: nowrap; font-size: 11.5px; font-weight: 700; line-height: 1.5; border-bottom: 2px solid #e8e6e1; }
.help-pic-tabs > span { padding: 1px 8px 2px; color: #6b6b80; }
.help-pic-tabs > .is-on { margin-bottom: -2px; color: #CB333B; border-bottom: 2px solid #CB333B; }
.help-pic-line { width: 100%; box-sizing: border-box; padding: 4px 8px; font-size: 11px; font-weight: 700; line-height: 1.45; color: #1a1a2e; background: #fef3cd; border: 1px solid #ffc107; border-radius: 6px; }
.help-pic-pill { display: inline-block; margin-left: 6px; padding: 0 8px; vertical-align: 1px; font-size: 10.5px; font-weight: 700; line-height: 1.6; color: #ffffff; background: #1a1a2e; border-radius: 999px; }
.help-pic-depts { display: flex; gap: 2px; width: 100%; white-space: nowrap; font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; line-height: 1.5; text-transform: uppercase; border-bottom: 1px solid #d8d5cf; }
.help-pic-depts > span { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; color: #6b6b80; background: #ccc8c1; border-radius: 5px 5px 0 0; }
.help-pic-depts > .is-on { color: #ffffff; background: #CB333B; }
.help-pic-dot { width: 6px; height: 6px; box-sizing: border-box; border: 1.5px solid currentColor; border-radius: 50%; }
.help-pic-depts > .is-on .help-pic-dot { background: currentColor; }
.help-pic-field { display: flex; align-items: center; gap: 6px; white-space: nowrap; font-size: 11.5px; font-weight: 700; line-height: 1.4; color: #1a1a2e; }
.help-pic-switch { position: relative; flex: none; width: 26px; height: 14px; background: #CB333B; border-radius: 8px; }
.help-pic-switch::after { content: ""; position: absolute; top: 2px; left: 14px; width: 10px; height: 10px; background: #ffffff; border-radius: 50%; }
.help-pic-bar { display: flex; align-items: center; gap: 6px; flex: none; width: 100%; height: 28px; box-sizing: border-box; padding: 0 8px; background: #1a1a2e; }
.help-pic-navbtn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; font-size: 9px; line-height: 1; color: #ffffff; background: rgba(255,255,255,0.14); border-radius: 6px; }
.help-pic-home { flex: none; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; box-sizing: border-box; background: rgba(255,255,255,0.1); border: 2px solid rgba(255,255,255,0.25); border-radius: 50%; }
.help-pic-rule { flex: none; width: 1px; height: 14px; background: rgba(255,255,255,0.2); }
.help-pic-brand { font-family: Georgia, serif; font-size: 12.5px; font-weight: 700; color: #ffffff; white-space: nowrap; }
.help-pic-menu { margin: 3px 0 0 8px; overflow: hidden; white-space: nowrap; font-size: 11.5px; line-height: 1.5; background: #ffffff; border: 1px solid #e8e6e1; border-radius: 6px; }
.help-pic-menu > span { display: block; padding: 2px 10px; color: #3d3d56; }
.help-pic-menu > .is-on { color: #CB333B; background: #fceced; }
.help-pic-below { padding: 10px 10px 0; }
.help-pic .help-btn { font-size: 12px; line-height: 1.6; padding: 1px 9px; border: 1.5px solid transparent; border-radius: 6px; }
.help-pic .help-btn--red { border-color: #CB333B; }
.help-pic .help-btn--sunken { color: #3d3d56; background: #edecea; border-color: #d8d5cf; font-weight: 600; }
.help-pic .help-btn--sm { padding: 1px 8px; font-size: 11px; line-height: 1.5; border-width: 1px; }
.help-btn--icon { display: inline-flex; align-items: center; gap: 4px; }
.help-flow { margin: 6pt 0; font-size: 9.5pt; line-height: 1.4; }
.help-flow-head, .help-flow-row { display: flex; flex-wrap: wrap; column-gap: 9pt; padding-left: 50px; }
.help-flow-head { border-bottom: 1.5px solid #d8d5cf; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6b6b80; break-after: avoid; }
.help-flow-head > .help-flow-who, .help-flow-head > .help-flow-what { padding: 0 0 4pt; }
.help-flow-steps { list-style: none; margin: 0; padding: 0; }
.help-flow-step { position: relative; margin: 0; break-inside: avoid; }
.help-flow-step.is-fix-top, .help-flow-step.is-fix, .help-flow-step.is-keep { break-after: avoid; }
.help-flow-row { position: relative; border-bottom: 1px solid #e8e6e1; }
.help-flow-no { position: absolute; left: 18px; top: 5px; width: 22px; font-weight: 700; color: #6b6b80; }
.help-flow-who { flex: 0 0 100px; padding: 5px 0; font-weight: 700; white-space: nowrap; }
.help-flow-what { flex: 1 1 210px; min-width: 0; padding: 5px 0; }
.help-flow-press { flex: none; width: 162px; padding: 3px 0; }
.help-flow-chip { flex: none; width: 136px; box-sizing: border-box; padding: 3px 0 3px 7pt; border-left: 1.5px solid #d8d5cf; }
.help-flow-act { flex: none; display: flex; }
.help-flow-head .help-flow-press, .help-flow-head .help-flow-chip { padding-top: 0; padding-bottom: 4pt; }
.help-flow-step.is-out .help-flow-who, .help-flow-step.is-out .help-flow-what { color: #6b6b80; }
.help-flow-press .help-outside { margin: 2px 0 0; }
.help-flow-step.is-fix-top::before, .help-flow-step.is-fix::before, .help-flow-step.is-fix-end::before { content: ""; position: absolute; left: 3px; width: 8px; border-left: 1.5px solid #CB333B; }
.help-flow-step.is-fix-top::before { top: 14px; bottom: -1px; border-top: 1.5px solid #CB333B; border-radius: 5px 0 0 0; }
.help-flow-step.is-fix::before { top: -1px; bottom: -1px; }
.help-flow-step.is-fix-end::before { top: -1px; bottom: 12px; border-bottom: 1.5px solid #CB333B; border-radius: 0 0 0 5px; }
.help-flow-step.is-fix-top::after { content: ""; position: absolute; left: 10px; top: 10.25px; border-top: 4.5px solid transparent; border-bottom: 4.5px solid transparent; border-left: 6px solid #CB333B; }
.help-flow-again { margin: 0; padding: 1px 0 5px 18px; font-size: 8.5pt; color: #3d3d56; border-bottom: 1px solid #e8e6e1; }
.help-flow-round { display: flex; align-items: center; padding: 4px 0 5px; border-bottom: 1px solid #e8e6e1; color: #1e3a5f; }
.help-flow-round svg { flex: none; width: 13px; margin-right: 5px; }
.help-flow-round span { padding: 0 7px; font-size: 8.5pt; font-weight: 700; border: 1.5px dashed #1e3a5f; border-radius: 10px; }
.help-pic-map, .help-pic-bigline { break-inside: avoid; }
.help-pic-map { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px 22px; margin: 6px 0 12px; }
.help-map-win { flex: 3 1 380px; min-width: 0; max-width: 540px; box-sizing: border-box; overflow: hidden; line-height: 1.4; background: #ffffff; border: 1px solid #d8d5cf; border-radius: 10px; }
.help-map-win, .help-map-head, .help-map-tabs, .help-map-left, .help-map-right, .help-map-block, .help-map-bbody, .help-map-entry { display: block; }
.help-map-head { display: flex; align-items: center; justify-content: space-between; padding: 7px 10px 0; }
.help-map-title { font-family: Georgia, serif; font-size: 12px; font-weight: 700; color: #1a1a2e; }
.help-map-x { font-size: 14px; line-height: 1; color: #6b6b80; }
.help-map-tabs { display: flex; align-items: flex-end; gap: 2px; padding: 6px 10px 0; border-bottom: 1px solid #d8d5cf; }
.help-map-tab { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; font-size: 8px; font-weight: 700; letter-spacing: 0.06em; line-height: 1.3; text-transform: uppercase; white-space: nowrap; color: #6b6b80; background: #edecea; border-radius: 4px 4px 0 0; }
.help-map-tab.is-on { color: #ffffff; background: #CB333B; }
.help-map-dot { width: 5px; height: 5px; box-sizing: border-box; border: 1.2px solid currentColor; border-radius: 50%; }
.help-map-tab.is-on .help-map-dot { background: currentColor; }
.help-map-tabs .help-map-no { align-self: center; margin: 0 0 3px 8px; }
.help-map-body { display: grid; grid-template-columns: minmax(0, 1fr) 31%; }
.help-map-left { min-width: 0; display: flex; flex-direction: column; gap: 5px; padding: 8px 9px 9px 12px; background: #f6f5f2; }
.help-map-bhead { position: relative; display: flex; align-items: center; gap: 5px; padding: 4px 7px; color: #6b6b80; background: #ffffff; border: 1px solid #e8e6e1; border-radius: 6px; }
.help-map-block.is-open .help-map-bhead { border-color: #d8d5cf; border-radius: 6px 6px 0 0; }
.help-map-bbody { padding: 5px 7px 6px; background: #ffffff; border: 1px solid #d8d5cf; border-top: none; border-radius: 0 0 6px 6px; }
.help-map-btns { display: flex; justify-content: flex-end; align-items: center; gap: 4px; padding-bottom: 5px; margin-bottom: 5px; border-bottom: 1px solid #e8e6e1; }
.help-map-btn { flex: none; height: 13px; box-sizing: border-box; border-radius: 3px; }
.help-map-btn.is-outline { width: 54px; border: 1.2px solid #CB333B; }
.help-map-btn.is-navy { width: 44px; background: #1e3a5f; }
.help-map-btn.is-red { align-self: flex-start; width: 62%; height: 14px; background: #CB333B; }
.help-map-stitle { display: flex; align-items: center; gap: 5px; padding-bottom: 3px; margin-bottom: 3px; border-bottom: 1.5px solid #CB333B; }
.help-map-checkall { flex: none; width: 30px; height: 11px; box-sizing: border-box; background: #f6f5f2; border: 1px solid #d8d5cf; border-radius: 999px; }
.help-map-line { position: relative; display: flex; align-items: center; gap: 5px; padding: 3px 1px; color: #6b6b80; }
.help-map-box { flex: none; width: 8px; height: 8px; box-sizing: border-box; border: 1.2px solid #6b6b80; border-radius: 2px; }
.help-map-box.is-on { background: #CB333B; border-color: #CB333B; }
.help-map-na { flex: none; width: 13px; height: 8px; box-sizing: border-box; border: 1px solid #d8d5cf; border-radius: 2px; }
.help-map-line svg, .help-map-bhead svg { flex: none; }
.help-map-fill { flex: 1; }
.help-map-bar { flex: none; height: 4px; border-radius: 2px; background: #b0aca2; }
.help-map-bar.is-name { height: 6px; border-radius: 3px; background: #6b6b80; }
.help-map-bar.is-title { width: 42%; height: 5px; background: #CB333B; }
.help-map-bar.is-label { width: 38%; background: #6b6b80; }
.help-map-bar.is-when { width: 40%; height: 3px; }
.help-map-bar.w24 { width: 24%; } .help-map-bar.w28 { width: 28%; } .help-map-bar.w32 { width: 32%; } .help-map-bar.w36 { width: 36%; } .help-map-bar.w44 { width: 44%; } .help-map-bar.w50 { width: 50%; } .help-map-bar.w70 { width: 70%; } .help-map-bar.w80 { width: 80%; } .help-map-bar.w88 { width: 88%; }
.help-map-right { position: relative; min-width: 0; display: flex; flex-direction: column; gap: 6px; padding: 9px 9px 10px 12px; background: #ffffff; border-left: 1px solid #d8d5cf; }
.help-map-acttitle { display: flex; align-items: center; gap: 5px; margin-top: 4px; }
.help-map-entry { display: flex; flex-direction: column; gap: 3px; padding-top: 5px; border-top: 1px solid #e8e6e1; }
.help-map-no { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; font-size: 9.5px; font-weight: 700; line-height: 1; color: #ffffff; background: #CB333B; border-radius: 50%; }
.help-map-no.is-pin { position: absolute; box-shadow: 0 0 0 2px #ffffff; }
.help-map-bhead .help-map-no.is-pin { left: -11px; top: 50%; transform: translateY(-50%); box-shadow: 0 0 0 2px #f6f5f2; }
.help-map-line .help-map-no.is-pin { left: -17px; top: 50%; transform: translateY(-50%); }
.help-map-right .help-map-no.is-pin { left: -9px; top: 7px; }
.help-map-key { flex: 1 1 180px; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 7px 16px; margin-top: 2px; font-size: 13px; font-weight: 700; line-height: 1.4; color: #1a1a2e; }
.help-map-key > span { display: flex; align-items: center; gap: 8px; }
.help-map-key .help-map-no { width: 18px; height: 18px; font-size: 10.5px; }
.help-pic-bigline { display: block; max-width: 470px; margin: 6px 0 10px; }
.help-bigline-row { display: flex; align-items: center; gap: 12px; padding: 8px 10px 8px 12px; background: #ffffff; border: 1px solid #d8d5cf; border-radius: 8px; }
.help-bigline-box { flex: none; width: 20px; height: 20px; box-sizing: border-box; border: 2px solid #6b6b80; border-radius: 4px; }
.help-bigline-words { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 17px; line-height: 1.4; color: #3d3d56; }
.help-bigline-na { flex: none; box-sizing: border-box; width: 48px; padding: 5px 0; text-align: center; font-size: 13px; font-weight: 700; letter-spacing: 0.03em; line-height: 1.2; color: #6b6b80; border: 1.5px solid #d8d5cf; border-radius: 6px; }
.help-bigline-flag { flex: none; display: flex; align-items: center; justify-content: center; width: 34px; height: 34px; color: #6b6b80; }
.help-bigline-labels { display: flex; align-items: flex-start; gap: 12px; padding: 0 10px 0 12px; font-size: 12px; font-weight: 700; line-height: 1.3; color: #6b6b80; }
.help-bigline-labels > span:not(.help-map-fill) { flex: none; display: flex; flex-direction: column; align-items: center; white-space: nowrap; }
.help-bigline-labels > span:not(.help-map-fill)::before { content: ""; width: 1.5px; height: 7px; background: #6b6b80; }
.help-bigline-labels > span.is-box { width: 20px; align-items: flex-start; }
.help-bigline-labels .is-box::before { margin-left: 9px; }
.help-bigline-labels .is-na { width: 48px; }
.help-bigline-labels .is-flag { width: 34px; }
`;

    function printHelpGuide() {
        const info = HELP_TABS[helpTab];
        const panel = document.getElementById(info.panel);
        if (!panel) return;
        const old = document.getElementById('helpPrintFrame');
        if (old) old.remove();
        const iframe = document.createElement('iframe');
        iframe.id = 'helpPrintFrame';
        iframe.style.cssText = 'position:fixed;left:-9999px;width:0;height:0;';
        document.body.appendChild(iframe);
        const doc = iframe.contentDocument;
        doc.open();
        doc.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title></title><style>' + HELP_PRINT_CSS +
            '</style></head><body><h1>' + escHtml(info.title) + '</h1>' + panel.innerHTML + '</body></html>');
        doc.close();
        doc.title = info.title;
        // Chrome names the PDF after the page's own title, not the frame's
        // (EXPORT_PLAN), so the page wears the guide's while the box is open.
        if (!helpPageTitle) helpPageTitle = document.title;
        document.title = info.title;
        iframe.contentWindow.onafterprint = () => { iframe.remove(); restoreHelpTitle(); };
        setTimeout(() => iframe.contentWindow.print(), 200);
    }

    // Close help modal on backdrop click
    document.getElementById('helpModal').addEventListener('click', function(e) {
        if (e.target === this) closeHelpModal();
    });
    // The guide's keys, whatever has focus, while the guide is the top box.
    // Ctrl+Z / Ctrl+Y anywhere on the page rewind the work order (the undo
    // listener further up), and the guide can be open over a work order or over
    // the QC Review window, which must never touch the work order behind it. A
    // click on the guide's plain text leaves focus on the page, not in the
    // guide, so a listener on the guide alone would miss those keys; this one
    // listens on the whole page before anything else (capture, registered
    // before review.js's own). Tab goes round the guide's own controls: past
    // its end, focus would land in the QC Review window under it, which stops
    // every key at its root. The arrow keys move between the tabs. A box that
    // opens over the guide (the edit lock's, the user picker) keeps its keys.
    function helpFocusables() {
        return Array.from(document.getElementById('helpModal').querySelectorAll('button, [href], [tabindex]'))
            .filter(el => !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden]') && el.getClientRects().length > 0);
    }
    function helpOnTop() {
        const help = document.getElementById('helpModal');
        if (help.style.display !== 'block') return false;
        return !Array.from(document.querySelectorAll('.modal')).some(m => m !== help &&
            !!(help.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) && getComputedStyle(m).display !== 'none');
    }
    document.addEventListener('keydown', function(e) {
        if (!helpOnTop()) return;
        const key = String(e.key).toLowerCase();
        if ((e.ctrlKey || e.metaKey) && (key === 'z' || key === 'y')) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
        }
        if (key === 'escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            closeHelpModal();
            return;
        }
        if (key === 'tab') {
            const list = helpFocusables();
            if (!list.length) return;
            const at = list.indexOf(document.activeElement);
            if (e.shiftKey && at <= 0) {
                e.preventDefault();
                list[list.length - 1].focus();
            } else if (!e.shiftKey && (at === -1 || at === list.length - 1)) {
                e.preventDefault();
                list[0].focus();
            }
            return;
        }
        const onTab = e.target && e.target.getAttribute && e.target.getAttribute('role') === 'tab';
        if (onTab && (key === 'arrowleft' || key === 'arrowright')) {
            e.preventDefault();
            showHelpTab(helpTab === 'work' ? 'qc' : 'work', true);
        }
    }, true);

    async function printAllComponents() {
        if (!currentJobId) {
            if (!openingJobId) alert('No job selected to print!');
            return;
        }

        document.getElementById('printDropdown').classList.remove('open');
        // The latest saved copy first (withLatestCopy).
        await withLatestCopy(async same => {
            const job = shownJob();
            if (!job || !job.components || !job.components.length) return;

            // Fields changed since the last Generate on any piece of the
            // department showing? (summariesReadyToPrint)
            if (!(await summariesThenStillLatest(job, null, same))) return;

            // Build all print pages from saved data upfront (no DOM switching needed)
            const pages = job.components.map(comp => ({
                html: buildPrintHTML(job, comp),
                title: getPrintFilename(job.jobNumber, comp.name)
            }));

            let i = 0;
            function printNext() {
                if (i >= pages.length) return;
                const page = pages[i++];
                printViaIframe(page.html, page.title, printNext);
            }
            printNext();
        });
    }

    async function printAllComponentsCombined() {
        if (!currentJobId) {
            if (!openingJobId) alert('No job selected to print!');
            return;
        }

        document.getElementById('printDropdown').classList.remove('open');
        // The latest saved copy first (withLatestCopy).
        await withLatestCopy(async same => {
            const job = shownJob();
            if (!job || !job.components || !job.components.length) return;

            // The same question as the other two prints (it asked nothing before).
            if (!(await summariesThenStillLatest(job, null, same))) return;

            const pages = job.components.map(comp => buildPrintHTML(job, comp, activeDepartment));
            const bodies = pages.map(html => {
                const m = html.match(/<body>([\s\S]*?)<\/body>/);
                return m ? m[1] : '';
            });
            // No separator: each piece's sheet starts a page of its own (its own
            // page name and break-before), and an empty page-break div between
            // them printed a blank page (PRINT_REFRESH_PLAN.md).
            const combinedBody = bodies.join('');
            // Function replacement, not a string: $& and $' in someone's instructions
            // are replacement patterns to String.replace and would splice the document
            // into itself.
            const combined = pages[0].replace(/<body>[\s\S]*?<\/body>/, () => '<body>' + combinedBody + '</body>');

            const combinedName = job.components.map(c => sanitizeForFilename(c.name)).join('_');
            const filename = getPrintFilename(job.jobNumber, combinedName);

            printViaIframe(combined, filename);
        });
    }

    // Populate components select in New Job modal
    function populateComponentsSelect() {
        const container = document.getElementById('componentsSelect');
        container.innerHTML = '';

        PIECE_FORMAT_OPTIONS.forEach((opt, i) => {
            const label = document.createElement('label');
            label.className = 'component-option';
            // One Tab stop for the whole list, on the first choice each time
            // the box opens; the arrow keys move it (KEYBOARD_PLAN.md 2.7).
            label.tabIndex = i === 0 ? 0 : -1;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = opt;

            const text = document.createTextNode(opt);

            label.appendChild(checkbox);
            label.appendChild(text);

            label.onclick = (e) => {
                e.preventDefault();
                checkbox.checked = !checkbox.checked;
                label.classList.toggle('selected', checkbox.checked);
            };

            container.appendChild(label);
        });
    }

    // Get selected components from New Job modal
    function getSelectedComponents() {
        const checkboxes = document.querySelectorAll('#componentsSelect input[type="checkbox"]:checked');
        return Array.from(checkboxes).map(cb => cb.value);
    }

    // Close dropdowns when clicking outside
    document.addEventListener('click', e => {
        if (!e.target.closest('.print-dropdown')) {
            document.getElementById('printDropdown').classList.remove('open');
        }
        if (!e.target.closest('.more-dropdown')) {
            document.getElementById('moreDropdown').classList.remove('open');
        }
    });

    // ========== AUTO-ACTIVATE TOGGLES ==========
    // ── Manage CSRs & Assignees ─────────────────────────────────────────
    // Both add and deactivate ask for the admin password, and the server
    // re-checks it on every write -- the client is never trusted.

    let _rosterTab = 'csr';
    let _rosterUsage = null;   // distinct names on jobs, per kind, from the server

    async function loadRosterUsage() {
        try {
            const res = await fetch('/api/roster/usage');
            const data = await res.json();
            _rosterUsage = (data && data.usage) ? data.usage : null;
        } catch (e) {
            _rosterUsage = null;
        }
    }

    async function openRosterModal() {
        _rosterTab = 'csr';
        document.getElementById('moreDropdown').classList.remove('open');
        document.getElementById('rosterError').style.display = 'none';
        document.getElementById('rosterNewName').value = '';
        document.getElementById('rosterLinkResult').hidden = true;
        await loadRoster();
        await loadRosterUsage();
        await loadRosterUsers();
        switchRosterTab('csr');
        document.getElementById('rosterModal').style.display = 'flex';
    }

    function closeRosterModal() {
        document.getElementById('rosterModal').style.display = 'none';
        // Pickers read the roster live, so refresh anything already on screen.
        populateCSRDropdowns();
        applyLandingFilters();
    }

    function switchRosterTab(kind) {
        _rosterTab = kind;
        document.querySelectorAll('.roster-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.kind === kind);
        });
        renderRosterList();
        renderRosterCleanup();
    }

    // Every name on the roster for this tab, turned on or off. Someone who has
    // left is still a known person: their old jobs are correct as they stand
    // and must never be listed as an old spelling to be swept onto someone
    // else. Turning a name off is how you retire it, not how you erase it.
    function knownNamesFor(kind) {
        const all = rosterAll(kind).map(p => p.name);
        return new Set((all.length ? all : rosterNames(kind)).map(n => n.trim()));
    }

    // Names that appear on jobs but are on no roster entry for this tab, i.e.
    // the old imported spellings that need merging. Compared exactly, capitals
    // included, because the landing filter treats "stef tarpy" and "Stef Tarpy"
    // as two separate people -- so both have to be fixable from here.
    function messyNamesFor(kind) {
        if (!_rosterUsage || !_rosterUsage[kind]) return [];
        const known = knownNamesFor(kind);
        return _rosterUsage[kind]
            .filter(u => u.name && !known.has(u.name.trim()))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    function renderRosterCleanup() {
        const wrap = document.getElementById('rosterCleanup');
        const list = document.getElementById('rosterCleanupList');
        if (!wrap || !list) return;

        // Only meaningful when the roster is editable and usage loaded.
        const messy = rosterEditable() ? messyNamesFor(_rosterTab) : [];
        if (!messy.length) { wrap.style.display = 'none'; list.innerHTML = ''; return; }
        wrap.style.display = '';

        const targets = rosterNames(_rosterTab);
        const options = ['<option value="">Move to...</option>']
            .concat(targets.map(n => '<option value="' + escHtml(n) + '">' + escHtml(n) + '</option>'))
            .join('');

        list.innerHTML = messy.map(u => {
            const jobs = u.count + (u.count === 1 ? ' job' : ' jobs');
            const enc = escHtml(u.name);
            return '<div class="roster-cleanup-row">' +
                '<span class="roster-cleanup-name">' + enc + '</span>' +
                '<span class="roster-cleanup-count">' + jobs + '</span>' +
                '<select class="roster-cleanup-select" data-from="' + enc + '">' + options + '</select>' +
                '<button class="roster-toggle" onclick="reassignRosterName(this)">Move</button>' +
            '</div>';
        }).join('');
    }

    async function reassignRosterName(btn) {
        showRosterError('');
        const row = btn.closest('.roster-cleanup-row');
        const sel = row.querySelector('.roster-cleanup-select');
        const fromName = sel.dataset.from;
        const toName = sel.value;
        if (!toName) { showRosterError('Pick a name to move "' + fromName + '" onto.'); return; }

        const password = await promptAdminPassword();
        if (!password) return;

        // The server write and the after-refresh are kept separate: only a real
        // failure of the write shows an error. A hiccup while re-rendering the
        // views must not masquerade as "the move failed", because it did not.
        let ok = false;
        try {
            const res = await fetch('/api/roster/reassign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: _rosterTab, fromName: fromName, toName: toName, password: password })
            });
            const data = await res.json();
            if (!res.ok) { showRosterError(data.error || 'Could not move that name.'); return; }
            ok = true;
        } catch (e) {
            showRosterError('Could not reach the server.');
            return;
        }
        if (!ok) return;

        // Reflect the change everywhere: usage list, the job cache the landing
        // filter reads, the cleanup section, and the table.
        try {
            await loadRosterUsage();
            await refreshJobs();
            renderRosterCleanup();
            applyLandingFilters();
        } catch (e) { /* the move succeeded; a refresh glitch is not an error */ }
    }

    function renderRosterList() {
        const list = document.getElementById('rosterList');
        const unavailable = document.getElementById('rosterUnavailable');
        const addRow = document.querySelector('.roster-add');
        if (!list) return;

        // Link matching names: once the roster can hold a user and the list loaded.
        document.getElementById('rosterLinkUsersWrap').hidden =
            !rosterEditable() || !_rosterUsers || !(_roster || []).some(p => 'windowsLogin' in p);
        if (!rosterEditable()) {
            unavailable.style.display = '';
            addRow.style.display = 'none';
            list.innerHTML = rosterNames(_rosterTab)
                .map(n => '<div class="roster-row roster-row--readonly">' + escHtml(n) + '</div>').join('');
            return;
        }
        unavailable.style.display = 'none';
        addRow.style.display = '';

        const rows = rosterAll(_rosterTab);
        if (!rows.length) { list.innerHTML = '<div class="roster-empty">No names yet.</div>'; return; }
        list.innerHTML = rows.map(p =>
            '<div class="roster-row' + (p.active ? '' : ' roster-row--off') + '">' +
                '<span class="roster-name">' + escHtml(p.name) + '</span>' +
                (p.active ? '' : '<span class="roster-tag">off</span>') +
                rosterUserBox(p) +
                rosterEmailSwitch(p) +
                '<button class="roster-toggle" onclick="setRosterActive(' + p.id + ',' + (p.active ? 'false' : 'true') + ')">' +
                    (p.active ? 'Turn off' : 'Turn on') +
                '</button>' +
            '</div>'
        ).join('');
    }

    // The User box on one roster row: which user from the user list this
    // person picks. QC Review knows a person only by the user they picked, and
    // jobs name people by roster name ("Stef Tarpy" may pick Stephanie.Tarpy);
    // this links the two. Shown once the server has the column (its roster
    // reply then carries windowsLogin, which holds the user). The server stores
    // it on every row with the same name, so a person on two lists is linked
    // once. Only users on the list can be chosen.
    // What was chosen and not saved yet, by roster id, so drawing the list again
    // (after a Save, Add, Turn off or a tab switch) keeps it. The list is drawn
    // while the dialog is still hidden only when it opens, which starts afresh.
    let _rosterUserPicked = {};
    let _rosterUsers = null;   // [{ user, display }] from /api/users, null when unavailable

    async function loadRosterUsers() {
        try {
            const res = await fetch('/api/users');
            const data = await res.json();
            _rosterUsers = data && data.available && Array.isArray(data.users) ? data.users : null;
        } catch (e) {
            _rosterUsers = null;
        }
    }

    // The listed user a stored link names (any spelling), or null.
    function listedRosterUser(stored) {
        const key = userKeyOf(stored);
        return key && _rosterUsers ? _rosterUsers.find(u => userKeyOf(u.user) === key) || null : null;
    }

    function rosterUserBox(p) {
        if (!('windowsLogin' in p)) return '';
        const modal = document.getElementById('rosterModal');
        if (modal && modal.style.display === 'none') _rosterUserPicked = {};
        const stored = String(p.windowsLogin || '').trim();
        if (!_rosterUsers) {
            return '<span class="roster-user-off" title="The user list could not be read. Tell IT.">' +
                escHtml(stored ? stored : 'User list unavailable') + '</span>';
        }
        const listed = listedRosterUser(stored);
        const current = listed ? listed.user : stored;
        const chosen = Object.prototype.hasOwnProperty.call(_rosterUserPicked, p.id) ? _rosterUserPicked[p.id] : current;
        const option = (value, text) => '<option value="' + escHtml(value) + '"' + (value === chosen ? ' selected' : '') + '>' + escHtml(text) + '</option>';
        const options = [option('', 'Not linked')];
        if (stored && !listed) options.push(option(stored, stored + ' (not on the user list)'));
        _rosterUsers.forEach(u => options.push(option(u.user, u.user)));
        const html = options.join('');
        return '<select class="roster-user" aria-label="User for ' + escHtml(p.name) + '"' +
                ' title="The user ' + escHtml(p.name) + ' picks when opening the app. QC Review needs it to know who is who."' +
                ' onchange="noteRosterUser(' + p.id + ',this)">' + html + '</select>' +
            '<button class="roster-toggle roster-user-save" onclick="saveRosterUser(' + p.id + ',this.previousElementSibling)">Save</button>';
    }

    function noteRosterUser(id, select) {
        const row = rosterAll(_rosterTab).find(p => p.id === id);
        const listed = row ? listedRosterUser(row.windowsLogin) : null;
        const current = listed ? listed.user : String((row && row.windowsLogin) || '').trim();
        if (row && select.value === current) delete _rosterUserPicked[id];
        else _rosterUserPicked[id] = select.value;
    }

    async function saveRosterUser(id, select) {
        showRosterError('');
        const value = select ? select.value : '';
        const password = await promptAdminPassword();
        if (!password) return;
        let res;
        let data;
        try {
            res = await fetch('/api/roster/' + id + '/login', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ windowsLogin: value, password: password })
            });
        } catch (e) {
            showRosterError('Could not reach the server.');
            return;
        }
        try {
            data = await res.json();
        } catch (e) {
            showRosterError('The server sent back an unexpected answer. Reload the page and try again.');
            return;
        }
        if (!res.ok) { showRosterError(data.error || 'Could not save that user.'); return; }
        // Saved on every row with this name, so none of them keeps a choice.
        const saved = rosterAll(_rosterTab).find(p => p.id === id);
        Object.keys(_rosterUserPicked).forEach(key => {
            const other = (_roster || []).find(p => String(p.id) === key);
            if (String(id) === key || (saved && other && other.name === saved.name)) delete _rosterUserPicked[key];
        });
        try {
            await loadRoster();
            renderRosterList();
        } catch (e) { /* saved; the list shows it on the next draw */ }
    }

    // The Email switch on one roster row (EMAIL_SWITCH_PLAN, David 2026-10-02).
    // Off means this person gets no QC Review email at all; they stay on the
    // list and can still be assigned and work the checklist. Drawn once the
    // server has the column (its roster reply then carries emailOff). The
    // server stores it on every row with the same name, so a person on two
    // lists is switched once. A button, never a checkbox: the page saves the
    // open work order on any checkbox change.
    function rosterEmailSwitch(p) {
        if (!('emailOff' in p)) return '';
        const on = !p.emailOff;
        return '<button type="button" role="switch" aria-checked="' + (on ? 'true' : 'false') + '"' +
                ' class="roster-email' + (on ? ' roster-email--on' : '') + '"' +
                ' aria-label="QC Review email for ' + escHtml(p.name) + '"' +
                ' title="Off: ' + escHtml(p.name) + ' gets no QC Review email. They stay on the list and can still be assigned and work the checklist."' +
                ' onclick="setRosterEmail(' + p.id + ',' + (on ? 'false' : 'true') + ')">' +
                '<span class="roster-email-track" aria-hidden="true"><span class="roster-email-knob"></span></span>' +
                '<span class="roster-email-word">Email ' + (on ? 'on' : 'off') + '</span>' +
            '</button>';
    }

    // Changing it asks for the admin password, like every other change here.
    // Nothing moves on the screen until the server has taken it.
    async function setRosterEmail(id, on) {
        showRosterError('');
        const password = await promptAdminPassword();
        if (!password) return;
        let res;
        let data;
        try {
            res = await fetch('/api/roster/' + id + '/email', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ on: on, password: password })
            });
        } catch (e) {
            showRosterError('Could not reach the server.');
            return;
        }
        try {
            data = await res.json();
        } catch (e) {
            showRosterError('The server sent back an unexpected answer. Reload the page and try again.');
            return;
        }
        if (!res.ok) { showRosterError(data.error || 'Could not change the email switch.'); return; }
        try {
            await loadRoster();
            renderRosterList();
        } catch (e) { /* saved; the list shows it on the next draw */ }
    }

    // "Link matching names": every name not linked yet gets the user with the
    // same words (David Marra and David.Marra). Anything else is left, and
    // named, for an admin to link by hand.
    async function linkMatchingRosterNames() {
        showRosterError('');
        const result = document.getElementById('rosterLinkResult');
        result.hidden = true;
        const password = await promptAdminPassword();
        if (!password) return;
        let data;
        try {
            const res = await fetch('/api/roster/link-users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: password })
            });
            data = await res.json();
            if (!res.ok) { showRosterError(data.error || 'Could not link the names.'); return; }
        } catch (e) {
            showRosterError('Could not reach the server.');
            return;
        }
        const linked = data.linked || [];
        const left = data.left || [];
        result.textContent = 'Linked ' + linked.length + (linked.length === 1 ? ' name.' : ' names.') +
            (left.length ? ' Not linked yet: ' + left.join(', ') + '. Choose their user by hand.' : ' Every name is linked.');
        result.hidden = false;
        // A choice not saved yet stays, except on the names just linked.
        const linkedNames = new Set(linked.map(x => x.name));
        Object.keys(_rosterUserPicked).forEach(key => {
            const row = (_roster || []).find(p => String(p.id) === key);
            if (row && linkedNames.has(row.name)) delete _rosterUserPicked[key];
        });
        try {
            await loadRoster();
            renderRosterList();
        } catch (e) { /* linked; the list shows it on the next draw */ }
    }

    function showRosterError(msg) {
        const el = document.getElementById('rosterError');
        el.textContent = msg;
        el.style.display = msg ? '' : 'none';
    }

    // Collects the admin password once per action and hands it to the server
    // with the write itself.
    async function promptAdminPassword() {
        const ok = await verifyAdminPassword();
        if (!ok) return null;
        return takeAdminPassword();
    }

    async function addRosterName() {
        const input = document.getElementById('rosterNewName');
        const name = input.value.trim();
        showRosterError('');
        if (!name) return;

        const existing = rosterAll(_rosterTab)
            .find(p => p.name.toLowerCase() === name.toLowerCase());
        if (existing && existing.active) { showRosterError('That name is already on the list.'); return; }

        const password = await promptAdminPassword();
        if (!password) return;

        try {
            const res = await fetch('/api/roster/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: _rosterTab, name: name, password: password, addedBy: getUserName() })
            });
            const data = await res.json();
            if (!res.ok) { showRosterError(data.error || 'Could not add that name.'); return; }
            input.value = '';
            await loadRoster();
            renderRosterList();
            renderRosterCleanup();
        } catch (e) {
            showRosterError('Could not reach the server.');
        }
    }

    async function setRosterActive(id, active) {
        showRosterError('');
        const password = await promptAdminPassword();
        if (!password) return;
        try {
            const res = await fetch('/api/roster/' + id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active: active, password: password })
            });
            const data = await res.json();
            if (!res.ok) { showRosterError(data.error || 'Could not update that name.'); return; }
            await loadRoster();
            renderRosterList();
            renderRosterCleanup();
        } catch (e) {
            showRosterError('Could not reach the server.');
        }
    }

    function populateCSRDropdowns() {
        // CSR filter is now a multi-select dropdown populated dynamically from job data
        // CSR quick-pick menus in create/edit modals (sync with CSR_NAMES)
        document.querySelectorAll('#csrName, #editCSRName').forEach(input => {
            const wrapper = input.closest('.quick-pick-wrapper');
            if (!wrapper) return;
            const menu = wrapper.querySelector('.quick-pick-menu');
            if (!menu) return;
            menu.dataset.options = JSON.stringify(getCsrNames());
            delete menu.dataset.populated;
            menu.innerHTML = '';
        });
    }

    function setupAutoActivateToggles() {
        document.querySelectorAll('.field-row').forEach(row => {
            const toggle = row.querySelector('.toggle-switch input');
            if (!toggle) return;
            const inputs = row.querySelectorAll('input[type="text"], textarea');
            inputs.forEach(input => {
                input.addEventListener('input', () => {
                    // A read-only box (a viewed archived job) never moves a switch.
                    if (input.readOnly) return;
                    if (input.value.trim().length > 0 && !toggle.checked) {
                        toggle.checked = true;
                    } else if (input.value.trim().length === 0 && toggle.checked) {
                        toggle.checked = false;
                    }
                });
                input.addEventListener('paste', () => {
                    // Paste still fires on a read-only box, though nothing lands.
                    if (input.readOnly) return;
                    setTimeout(() => {
                        if (input.value.trim().length > 0) toggle.checked = true;
                        if (input.tagName === 'TEXTAREA') autoResizeTextarea(input);
                    }, 10);
                });
            });
        });
    }

    // A path pasted into a path box comes out in its server form: no quotes,
    // and a mapped drive's letter becomes its server (paste-path.js,
    // PASTE_PATH_PLAN.md). Every File Path box on Prepress, Record Counts
    // included (a path to the file of counts, or a count typed in; David,
    // 2026-10-16), and Data file locations on Tech Services. Nothing else on
    // the work order is touched.
    const PASTE_PATH_BOXES = ['fp1n', 'fp2n', 'fp3n', 'fp4n', 'fp5n', 'fp6n', 'fp7n', 'ts_fp10n'];
    function setupPastedPaths() {
        if (!window.PASTE_PATH) return;
        PASTE_PATH_BOXES.forEach(id => {
            const box = document.querySelector('.dept-checklist textarea[data-id="' + id + '"]');
            if (box) box.addEventListener('paste', window.PASTE_PATH.onPaste);
        });
    }

    // ========== RESIZE HANDLE ==========
    (function() {
        const handle = document.getElementById('resizeHandle');
        const sidebar = document.querySelector('.sidebar');
        const container = document.querySelector('.main-content');
        if (!handle || !sidebar || !container) return;

        let dragging = false;
        let startX, startWidth;

        handle.addEventListener('mousedown', (e) => {
            dragging = true;
            startX = e.clientX;
            startWidth = sidebar.offsetWidth;
            handle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const containerWidth = container.offsetWidth;
            const minW = 280;
            const maxW = containerWidth * 0.6;
            const newWidth = Math.min(maxW, Math.max(minW, startWidth + dx));
            sidebar.style.width = newWidth + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        });

        // Touch support
        handle.addEventListener('touchstart', (e) => {
            dragging = true;
            startX = e.touches[0].clientX;
            startWidth = sidebar.offsetWidth;
            handle.classList.add('dragging');
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!dragging) return;
            const dx = e.touches[0].clientX - startX;
            const containerWidth = container.offsetWidth;
            const minW = 280;
            const maxW = containerWidth * 0.6;
            const newWidth = Math.min(maxW, Math.max(minW, startWidth + dx));
            sidebar.style.width = newWidth + 'px';
        }, { passive: true });

        document.addEventListener('touchend', () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
        });
    })();

    // ========== EDIT JOB ==========
    function openEditJobModal() {
        if (!currentJobId) return;
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job) return;

        document.getElementById('editJobNumber').value = job.jobNumber;
        document.getElementById('editJobDescription').value = job.jobDescription || '';
        document.getElementById('editClientName').value = job.clientName;
        document.getElementById('editCSRName').value = job.csrName || '';
        populateAssigneeSelect('editAssignedToPrepress', 'prepress', job.assignedToPrepress);
        populateAssigneeSelect('editAssignedToTechservices', 'techservices', job.assignedToTechservices);
        // What each field showed when opened, read by closeEditorsForView:
        // only a field changed since is named as not saved.
        const form = document.getElementById('editJobForm');
        form._opened = {};
        EDIT_JOB_WORDS.forEach(([id, key]) => { const el = document.getElementById(id); form._opened[key] = el ? String(el.value || '').trim() : ''; });
        rememberBoxOpener('editJobModal');
        document.getElementById('editJobModal').style.display = 'block';

        // Focus job number field (especially important after duplicate)
        focusBoxField('editJobModal', 'editJobNumber');
    }

    function closeEditJobModal() {
        const wasOpen = document.getElementById('editJobModal').style.display === 'block';
        document.getElementById('editJobModal').style.display = 'none';
        document.getElementById('editJobForm').reset();
        giveBackBoxCursor('editJobModal', wasOpen);
    }

    document.getElementById('editJobForm').addEventListener('submit', e => {
        e.preventDefault();
        if (!currentJobId) return;

        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job) return;

        const newNum = document.getElementById('editJobNumber').value.trim();
        // Nothing changed since the box opened (Save, or Enter in Job Number,
        // which has focus when it opens): it closes and writes nothing, as the
        // header's boxes do, so no name goes on the job (the after-rollout
        // batch, item 3). Compared as Save would store it, trimmed.
        const opened = e.target._opened;
        if (opened && newNum === String(job.jobNumber || '').trim() &&
            EDIT_JOB_WORDS.every(([id, key]) => String(document.getElementById(id).value || '').trim() === opened[key])) {
            closeEditJobModal();
            return;
        }
        // Check for duplicate job number (allow keeping the same number)
        if (newNum !== job.jobNumber.trim() && jobs.some(j => j.jobNumber.trim() === newNum)) {
            alert('A job with that number already exists.');
            return;
        }

        job.jobNumber = newNum;
        job.jobDescription = document.getElementById('editJobDescription').value.trim();
        job.clientName = document.getElementById('editClientName').value.trim();
        job.csrName = document.getElementById('editCSRName').value.trim();
        job.assignedToPrepress = document.getElementById('editAssignedToPrepress').value;
        job.assignedToTechservices = document.getElementById('editAssignedToTechservices').value;
        job.headerModified = new Date().toISOString();
        job.headerModifiedBy = getUserName();
        job.lastModified = new Date().toISOString();
        job.lastModifiedBy = getUserName();

        saveActiveJobs(jobs);
        updatePrintHeader(job);
        loadJobs(); // Refresh dropdown list with updated name

        closeEditJobModal();
    });

    // ========== DUPLICATE JOB (Option B+C) ==========
    // Fields to CLEAR on duplicate (all file paths + variable print + previous job#)
    const DUPLICATE_CLEAR_IDS = [
        'sp1',                          // Previous Job#
        'fp1', 'fp2', 'fp3', 'fp4',    // Artwork, SOF, Mockup, Other paths
        'fp5', 'fp6', 'fp7',            // Lives, Record Counts, Seeds & Samp
        'ts_fp10',                       // TS data file locations
        'ps11', 'vp1', 'ps12', 'vp3'    // Variable print fields
    ];

    let _pendingDuplicate = null;

    function duplicateJob() {
        if (!currentJobId) return;
        // A save still owed asks Stay or Leave first; Leave without saving
        // leaves the job, and Duplicate is pressed again from it.
        if (!isViewed(currentJobId)) { leaveJob(duplicateJobNow, { stays: true, stopAfterLeave: true }); return; }
        duplicateJobNow();
    }
    function duplicateJobNow() {
        if (!currentJobId) return;
        const jobs = getActiveJobs();
        const original = jobs.find(j => j.id === currentJobId);
        if (!original) return;

        if (jobs.length >= MAX_ACTIVE_JOBS) {
            alert(`Max ${MAX_ACTIVE_JOBS} active jobs. Archive or delete one first.`);
            return;
        }

        // Save current state before duplicating
        saveComponentState();

        // Deep-copy and clean components
        const components = JSON.parse(JSON.stringify(original.components));
        components.forEach((comp, idx) => {
            comp.id = 'comp_' + Date.now() + '_' + idx;
            comp.instructions_prepress = '';
            comp.instructions_techservices = '';
            comp.instructionsHistory_prepress = '';
            comp.instructionsHistory_techservices = '';
            delete comp.instructions;
            delete comp.instructionsHistory;
            delete comp._instructions_legacy_backup;
            delete comp._instructionsHistory_legacy_backup;

            DUPLICATE_CLEAR_IDS.forEach(f => {
                delete comp.checkboxes[f];
                delete comp.notes[f + 'n'];
            });
            forgetSummaryFingerprints(comp.notes);
        });

        // Stash for createNewJob() to pick up
        _pendingDuplicate = {
            components: components,
            duplicatedFrom: original.jobNumber
        };

        // Pre-fill the New Job modal with the original's metadata
        document.getElementById('jobNumber').value = original.jobNumber + ' (Copy)';
        document.getElementById('jobDescription').value = original.jobDescription || '';
        document.getElementById('clientName').value = original.clientName || '';
        document.getElementById('csrName').value = original.csrName || '';
        populateAssigneeSelect('newAssignedToPrepress', 'prepress');
        populateAssigneeSelect('newAssignedToTechservices', 'techservices');
        document.getElementById('signoffDueDatePrepress').value = '';
        document.getElementById('signoffDueTimePrepress').value = '';
        document.getElementById('signoffDueDateTechservices').value = '';
        document.getElementById('signoffDueTimeTechservices').value = '';

        // Hide component picker (components inherited from original)
        document.getElementById('componentsSelectGroup').style.display = 'none';

        document.querySelector('#newJobModal h2').textContent = 'Duplicate Job';
        rememberBoxOpener('newJobModal');
        document.getElementById('newJobModal').style.display = 'block';
        focusBoxField('newJobModal', 'jobNumber');
    }

    // ========== DUPLICATE COMPONENT ==========
    async function duplicateComponent() {
        if (!currentJobId || !currentComponentId) return;
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components) return;

        if (job.components.length >= MAX_COMPONENTS) {
            alert(`Maximum ${MAX_COMPONENTS} components allowed per job.`);
            return;
        }

        // Save current state first
        saveComponentState();

        const original = job.components.find(c => c.id === currentComponentId);
        if (!original) return;

        const newComp = JSON.parse(JSON.stringify(original)); // deep copy
        newComp.id = 'comp_' + Date.now();
        newComp.name = original.name + ' (Copy)';
        newComp.instructions_prepress = '';
        newComp.instructions_techservices = '';
        newComp.instructionsHistory_prepress = '';
        newComp.instructionsHistory_techservices = '';
        delete newComp.instructions;
        delete newComp.instructionsHistory;
        delete newComp._instructions_legacy_backup;
        delete newComp._instructionsHistory_legacy_backup;
        // Not the original's place: the server puts the copy last, and a save
        // that sends no place leaves it there (R16, the after-rollout batch,
        // item 7). With the original's place the copy's first save tied with
        // it, and the pieces after it slid down on the next open.
        delete newComp.sortOrder;

        // Clear file paths and variable print from the copy
        DUPLICATE_CLEAR_IDS.forEach(f => {
            delete newComp.checkboxes[f];
            delete newComp.notes[f + 'n'];
        });
        forgetSummaryFingerprints(newComp.notes);

        // Create on server
        try {
            if (!await createComponentOnServer(job, newComp)) return;
        } catch (e) {
            showErrorModal("Couldn't duplicate component.", 'Close');
            return;
        }
        pieceAddedAskBoard();

        job.components.push(newComp);
        job.activeComponentId = newComp.id;
        job.lastModified = new Date().toISOString();
        job.lastModifiedBy = getUserName();
        saveActiveJobs(jobs);

        currentComponentId = newComp.id;
        loadComponentData();
        renderComponentTabs();
    }

    function buildRevisionTimeline() {
        const historyEl = document.getElementById('instructionsHistory');
        const timelineEl = document.getElementById('revisionTimeline');
        const countEl = document.getElementById('revisionCount');
        if (!historyEl || !timelineEl) return;

        const timestamps = historyEl.querySelectorAll('.history-timestamp');
        timelineEl.innerHTML = '';

        if (timestamps.length === 0) {
            countEl.textContent = '';
            return;
        }

        countEl.textContent = timestamps.length + ' note' + (timestamps.length !== 1 ? 's' : '');

        // Build segments (newest first in HTML, but R1 = oldest)
        const entries = Array.from(timestamps);
        entries.forEach((ts, idx) => {
            const revNum = entries.length - idx;
            const btn = document.createElement('button');
            btn.className = 'revision-segment';

            // Extract timestamp text for tooltip
            const tsText = ts.textContent.replace(/^\(\d+\)\s*/, '');

            btn.innerHTML =
                '<span class="revision-seg-label">R' + revNum + '</span>' +
                '<span class="revision-tooltip">' + escHtml(tsText) + '</span>';

            // Scroll only. The printed work order carries every revision of the
            // piece it is printing (buildPrintHTML), so a chip no longer decides
            // what prints: it used to, and in a print-all that armed the piece on
            // screen for every other piece's page.
            btn.addEventListener('click', () => {
                // Scroll to revision in history pane
                const divider = ts.previousElementSibling;
                const scrollTarget = divider || ts;
                scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });

                // Flash the timestamp heading
                ts.style.transition = 'color 0.15s';
                ts.style.color = 'var(--accent)';
                setTimeout(() => { ts.style.color = ''; }, 2000);
            });

            timelineEl.appendChild(btn);
        });
    }

    // ========== INLINE HEADER EDITING ==========
    const INLINE_EDIT_MAX = { clientName: 200, componentName: 200 };
    function startInlineEdit(fieldEl) {
        if (!currentJobId) return;
        if (fieldEl.dataset.field === 'assignedTo') return startInlineEditAssignee(fieldEl);
        if (fieldEl.dataset.field === 'signoffDue') return startInlineEditSignoffDue(fieldEl);
        // CSR was the only person field here that was free text, which is how
        // one person ended up in the filter as "Stef", "STEF" and "Stephanie".
        // It picks from the roster now, the same way assignedTo always has.
        if (fieldEl.dataset.field === 'csrName') return startInlineEditCsr(fieldEl);
        if (fieldEl.querySelector('.inline-edit-input')) return; // already editing

        const valueSpan = fieldEl.querySelector('.job-field-value');
        const icon = fieldEl.querySelector('.inline-edit-icon');
        const currentValue = valueSpan.textContent;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-edit-input';
        // The database's limit for the column (Customer, Component): a longer
        // value failed every later save of that row (SAVE_FAILURE_PLAN.md).
        if (INLINE_EDIT_MAX[fieldEl.dataset.field]) input.maxLength = INLINE_EDIT_MAX[fieldEl.dataset.field];
        input.value = currentValue;
        // What it showed when opened. Closing it with that still in it is not
        // a change, and must not put anyone's name on the work order.
        input._opened = input.value.trim();

        valueSpan.style.display = 'none';
        if (icon) icon.style.display = 'none';
        fieldEl.insertBefore(input, valueSpan.nextSibling);
        input.focus();
        input.select();

        // Prevent parent click from restarting edit
        const origOnclick = fieldEl.onclick;
        fieldEl.onclick = null;

        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                input._committed = true;
                finishInlineEdit(fieldEl, input, origOnclick);
            } else if (e.key === 'Escape') {
                input._cancelled = true;
                cancelInlineEdit(fieldEl, input, origOnclick);
            }
        });

        input.addEventListener('blur', function() {
            if (!input._committed && !input._cancelled) {
                finishInlineEdit(fieldEl, input, origOnclick);
            }
        });
    }

    function finishInlineEdit(fieldEl, input, origOnclick) {
        const field = fieldEl.dataset.field;
        const newValue = input.value.trim();
        const valueSpan = fieldEl.querySelector('.job-field-value');
        const icon = fieldEl.querySelector('.inline-edit-icon');

        if (!newValue || newValue === input._opened) {
            cancelInlineEdit(fieldEl, input, origOnclick);
            return;
        }

        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job) { cancelInlineEdit(fieldEl, input, origOnclick); return; }

        let renamed = null;
        if (field === 'componentName') {
            saveComponentState();   // the screen into the piece first, as renameComponent
            renamed = job.components ? job.components.find(c => c.id === currentComponentId) : null;
            if (renamed) renamed.name = newValue;
        } else {
            job[field] = newValue;
        }

        job.headerModified = new Date().toISOString();
        job.headerModifiedBy = getUserName();
        job.lastModified = new Date().toISOString();
        job.lastModifiedBy = getUserName();

        saveActiveJobs(jobs);
        // The job row's save leaves the pieces out (as renameComponent).
        if (renamed) persistComponent(renamed, job);
        valueSpan.textContent = newValue;

        // Cleanup
        input.remove();
        valueSpan.style.display = '';
        if (icon) icon.style.display = '';
        fieldEl.onclick = origOnclick;

        updatePrintHeader(job);
        if (field === 'componentName') renderComponentTabs();
    }

    function cancelInlineEdit(fieldEl, input, origOnclick) {
        const valueSpan = fieldEl.querySelector('.job-field-value');
        const icon = fieldEl.querySelector('.inline-edit-icon');
        input.remove();
        valueSpan.style.display = '';
        if (icon) icon.style.display = '';
        fieldEl.onclick = origOnclick;
    }

    // Inline-edit variant for the "Assigned to" cell — uses a <select> populated
    // from the active department's roster. Saves to the dept-scoped job field.
    function startInlineEditAssignee(fieldEl) {
        if (fieldEl.querySelector('.inline-edit-select')) return; // already editing
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job) return;

        const roster = getAssigneeNames(activeDepartment).slice();
        const deptKey = activeDepartment === 'techservices' ? 'assignedToTechservices' : 'assignedToPrepress';
        const currentValue = job[deptKey] || '';
        // Kept as an option even when it is not on the active roster (someone
        // since deactivated), as the CSR box does: otherwise the box opens
        // blank and closing it writes Unassigned over the name.
        if (currentValue && !roster.includes(currentValue)) roster.unshift(currentValue);

        const valueSpan = fieldEl.querySelector('.job-field-value');
        const icon = fieldEl.querySelector('.inline-edit-icon');

        const sel = document.createElement('select');
        sel.className = 'inline-edit-select';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Unassigned';
        sel.appendChild(blank);
        roster.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
        });
        sel.value = currentValue;
        const opened = sel.value;   // closing it on this is not a change

        valueSpan.style.display = 'none';
        if (icon) icon.style.display = 'none';
        fieldEl.insertBefore(sel, valueSpan.nextSibling);
        sel.focus();

        const origOnclick = fieldEl.onclick;
        fieldEl.onclick = null;

        let finished = false;
        const commit = () => {
            if (finished) return;
            finished = true;
            const newValue = sel.value;
            const jobs2 = getActiveJobs();
            const job2 = jobs2.find(j => j.id === currentJobId);
            if (job2 && newValue !== opened) {
                job2[deptKey] = newValue;
                job2.headerModified = new Date().toISOString();
                job2.headerModifiedBy = getUserName();
                job2.lastModified = new Date().toISOString();
                job2.lastModifiedBy = getUserName();
                saveActiveJobs(jobs2);
                updatePrintHeader(job2);
            }
            sel.remove();
            valueSpan.style.display = '';
            if (icon) icon.style.display = '';
            fieldEl.onclick = origOnclick;
        };
        const cancel = () => {
            if (finished) return;
            finished = true;
            sel.remove();
            valueSpan.style.display = '';
            if (icon) icon.style.display = '';
            fieldEl.onclick = origOnclick;
        };

        sel.addEventListener('change', commit);
        sel.addEventListener('blur', commit);
        sel.addEventListener('keydown', e => {
            if (e.key === 'Escape') cancel();
            else if (e.key === 'Enter') { e.preventDefault(); commit(); }
        });
    }

    // Inline-edit variant for CSR. A <select> off the roster, so the landing
    // filter can never gain another spelling of someone already on it.
    // The job's existing value is kept as an option even when it is not on the
    // roster (old data, or a CSR since deactivated) so opening the editor and
    // pressing Escape never silently rewrites the job.
    function startInlineEditCsr(fieldEl) {
        if (fieldEl.querySelector('.inline-edit-select')) return; // already editing
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job) return;

        const currentValue = (job.csrName || '').trim();
        const names = getCsrNames().slice();
        if (currentValue && !names.includes(currentValue)) names.unshift(currentValue);

        const valueSpan = fieldEl.querySelector('.job-field-value');
        const icon = fieldEl.querySelector('.inline-edit-icon');

        const sel = document.createElement('select');
        sel.className = 'inline-edit-select';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Unassigned';
        sel.appendChild(blank);
        names.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
        });
        sel.value = currentValue;
        // Compared with what it showed when opened, not with the stored name:
        // a name stored with a space at either end reads as changed against
        // the trimmed one it shows, and closing the box stamped the job.
        const opened = sel.value;

        valueSpan.style.display = 'none';
        if (icon) icon.style.display = 'none';
        fieldEl.insertBefore(sel, valueSpan.nextSibling);
        sel.focus();

        const origOnclick = fieldEl.onclick;
        fieldEl.onclick = null;

        let finished = false;
        const restore = () => {
            sel.remove();
            valueSpan.style.display = '';
            if (icon) icon.style.display = '';
            fieldEl.onclick = origOnclick;
        };
        const commit = () => {
            if (finished) return;
            finished = true;
            const newValue = sel.value;
            const jobs2 = getActiveJobs();
            const job2 = jobs2.find(j => j.id === currentJobId);
            if (job2 && newValue !== opened) {
                job2.csrName = newValue;
                job2.headerModified = new Date().toISOString();
                job2.headerModifiedBy = getUserName();
                job2.lastModified = new Date().toISOString();
                job2.lastModifiedBy = getUserName();
                saveActiveJobs(jobs2);
                updatePrintHeader(job2);
                valueSpan.textContent = newValue;
            }
            restore();
        };
        const cancel = () => { if (finished) return; finished = true; restore(); };

        sel.addEventListener('change', commit);
        sel.addEventListener('blur', commit);
        sel.addEventListener('keydown', e => {
            if (e.key === 'Escape') cancel();
            else if (e.key === 'Enter') { e.preventDefault(); commit(); }
        });
    }

    // Inline-edit variant for "Signoff due" — a pair of inputs (<input type="date">
    // + a half-hour <select>) that mirrors the New/Edit Job modal vocabulary.
    // Saves to the dept-scoped signoffDueDate<Dept> / signoffDueTime<Dept> keys.
    // Commit policy: only when focus leaves the entire editor, or on Enter; Escape cancels.
    // (Per-input `change` does not commit, so a user can pick a date and then a time
    // without the editor tearing down after the first selection.)
    function startInlineEditSignoffDue(fieldEl) {
        if (fieldEl.querySelector('.inline-edit-signoff')) return; // already editing
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job) return;

        const dateKey = activeDepartment === 'techservices' ? 'signoffDueDateTechservices' : 'signoffDueDatePrepress';
        const timeKey = activeDepartment === 'techservices' ? 'signoffDueTimeTechservices' : 'signoffDueTimePrepress';
        const currentDate = (job[dateKey] || '').trim();
        const currentTime = (job[timeKey] || '').trim();

        const valueSpan = fieldEl.querySelector('.job-field-value');
        const icon = fieldEl.querySelector('.inline-edit-icon');

        const editor = document.createElement('span');
        editor.className = 'inline-edit-signoff';

        const dateInput = document.createElement('input');
        dateInput.type = 'date';
        dateInput.className = 'inline-edit-date';
        dateInput.value = currentDate;

        const timeSel = document.createElement('select');
        timeSel.className = 'inline-edit-time';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Time…';
        timeSel.appendChild(blank);
        const TIME_OPTIONS = [
            '8:30 AM','9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','11:30 AM',
            '12:00 PM','12:30 PM','1:00 PM','1:30 PM','2:00 PM','2:30 PM','3:00 PM',
            '3:30 PM','4:00 PM','4:30 PM','5:00 PM'
        ];
        TIME_OPTIONS.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            timeSel.appendChild(opt);
        });
        timeSel.value = currentTime;

        editor.appendChild(dateInput);
        editor.appendChild(timeSel);
        // What the two boxes showed when opened. Only a box that differs is
        // written, and nothing at all when neither does, so opening the editor
        // and clicking away puts no name on the work order.
        const openedDate = dateInput.value;
        const openedTime = timeSel.value;
        // Read by closeEditorsForView: was anything changed here.
        editor._opened = { date: openedDate, time: openedTime, dept: activeDepartment };

        valueSpan.style.display = 'none';
        if (icon) icon.style.display = 'none';
        fieldEl.insertBefore(editor, valueSpan.nextSibling);
        dateInput.focus();

        const origOnclick = fieldEl.onclick;
        fieldEl.onclick = null;

        let finished = false;
        const teardown = () => {
            if (_signoffCommit === commit) _signoffCommit = null;
            editor.remove();
            valueSpan.style.display = '';
            if (icon) icon.style.display = '';
            fieldEl.onclick = origOnclick;
        };
        const commit = () => {
            if (finished) return;
            finished = true;
            const jobs2 = getActiveJobs();
            const job2 = jobs2.find(j => j.id === currentJobId);
            const dateChanged = dateInput.value !== openedDate;
            const timeChanged = timeSel.value !== openedTime;
            if (job2 && (dateChanged || timeChanged)) {
                if (dateChanged) job2[dateKey] = dateInput.value;
                if (timeChanged) job2[timeKey] = timeSel.value;
                job2.headerModified = new Date().toISOString();
                job2.headerModifiedBy = getUserName();
                job2.lastModified = new Date().toISOString();
                job2.lastModifiedBy = getUserName();
                saveActiveJobs(jobs2);
                updatePrintHeader(job2);
            }
            teardown();
        };
        const cancel = () => {
            if (finished) return;
            finished = true;
            teardown();
        };
        // Leaving the work order runs this first (sendWaitingSaves): a tap on
        // Home or Lock instructions, or a touchpad tap, reaches its click
        // before the deferred commit below, and the edit was lost.
        _signoffCommit = commit;

        // Only commit when focus leaves the WHOLE editor; the deferred check lets the
        // user tab from the date input into the time select without tearing down.
        const handleBlur = () => setTimeout(() => {
            if (finished) return;
            if (!editor.contains(document.activeElement)) commit();
        }, 0);

        dateInput.addEventListener('blur', handleBlur);
        timeSel.addEventListener('blur', handleBlur);
        dateInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') cancel();
            else if (e.key === 'Enter') { e.preventDefault(); commit(); }
        });
        timeSel.addEventListener('keydown', e => {
            if (e.key === 'Escape') cancel();
            else if (e.key === 'Enter') { e.preventDefault(); commit(); }
        });
    }

    // ========== LANDING PAGE FILTERS (v2) ==========
    function applyLandingFilters() {
        const allJobs = getActiveJobs();
        // Corrections is a board filter: with the QC column gone it would hide
        // nothing while its chip still said it was on.
        if (landingQuickFilter === 'corrections' && !boardOn) landingQuickFilter = 'all';

        renderViewTabs(allJobs);
        renderControlsBlock(allJobs);

        // Keep subtitle job count in sync
        const countEl = document.getElementById('landingJobCount');
        if (countEl) {
            countEl.textContent = 'Connected to SQL Server -- ' + allJobs.length + ' active job' + (allJobs.length !== 1 ? 's' : '');
        }

        const me = getUserName();
        let filtered = (landingViewTab === 'my' && me) ? allJobs.filter(j => isMyJob(j)) : [...allJobs];

        if (landingSearchQuery) {
            filtered = filtered.filter(j => {
                const searchable = (j.jobNumber + ' ' + j.clientName + ' ' + (j.jobDescription || '') + ' ' + (j.csrName || '') + ' ' + (j.assignedToPrepress || '') + ' ' + (j.assignedToTechservices || '')).toLowerCase();
                return searchable.includes(landingSearchQuery);
            });
        }

        // The same test as the Depts dots (deptOnJob).
        if (landingDeptFilter !== 'all') {
            filtered = filtered.filter(j => deptOnJob(j, landingDeptFilter));
        }

        // Status filter
        if (landingStatusFilter !== 'all') {
            filtered = filtered.filter(j => getJobStatusLabel(j).cls === landingStatusFilter);
        }

        if (landingSelectedCSRs.length > 0) {
            filtered = filtered.filter(j => landingSelectedCSRs.includes((j.csrName || '').trim()));
        }

        if (landingSelectedAssignees.length > 0) {
            filtered = filtered.filter(j => {
                return landingSelectedAssignees.includes((j.assignedToPrepress || '').trim()) ||
                       landingSelectedAssignees.includes((j.assignedToTechservices || '').trim());
            });
        }

        if (landingSelectedClients.length > 0) {
            filtered = filtered.filter(j => landingSelectedClients.includes((j.clientName || '').trim()));
        }

        if (landingTimeFilter !== 'all') {
            const now = new Date();
            let cutoff;
            if (landingTimeFilter === 'today') {
                cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            } else if (landingTimeFilter === 'week') {
                cutoff = new Date(now); cutoff.setDate(now.getDate() - 7);
            } else if (landingTimeFilter === 'month') {
                cutoff = new Date(now); cutoff.setMonth(now.getMonth() - 1);
            }
            if (cutoff) {
                filtered = filtered.filter(j => {
                    const d = new Date(j.lastModified || j.dateCreated || 0);
                    return d >= cutoff;
                });
            }
        }

        // Quick filter (Show row)
        if (landingQuickFilter === 'overdue') {
            filtered = filtered.filter(j => isJobOverdue(j));
        } else if (landingQuickFilter === 'soon') {
            filtered = filtered.filter(j => isJobDueSoon(j));
        } else if (landingQuickFilter === 'corrections' && boardOn) {
            filtered = filtered.filter(j => boardChipOf(j) === 'corrections');
        }

        // Sort
        filtered.sort((a, b) => {
            // QC sorts by step, a blank cell last either way, and by Signoff
            // Due within a step.
            if (landingSortColumn === 'qc' && window.REVIEW_BOARD) {
                const ra = REVIEW_BOARD.sortRank(boardChipOf(a));
                const rb = REVIEW_BOARD.sortRank(boardChipOf(b));
                const blank = REVIEW_BOARD.ORDER.length;
                if (ra !== rb) {
                    if (ra === blank || rb === blank) return ra === blank ? 1 : -1;
                    return landingSortDir === 'asc' ? ra - rb : rb - ra;
                }
                return getSortValue(a, 'due') - getSortValue(b, 'due');
            }
            let va = getSortValue(a, landingSortColumn);
            let vb = getSortValue(b, landingSortColumn);
            if (typeof va === 'number' && typeof vb === 'number') {
                return landingSortDir === 'asc' ? va - vb : vb - va;
            }
            va = String(va); vb = String(vb);
            const cmp = va.localeCompare(vb, undefined, { numeric: true });
            return landingSortDir === 'asc' ? cmp : -cmp;
        });

        // Group pre-sort (stable -- contiguous groups, preserving column sort within)
        if (landingGroupBy !== 'none') {
            const statusRank = { 'New': 0, 'In Progress': 1, 'On Hold': 2, 'Complete': 3, 'Cancelled': 4 };
            filtered.sort((a, b) => {
                const ka = groupKeyFor(a), kb = groupKeyFor(b);
                if (landingGroupBy === 'status') {
                    if (statusRank[ka] !== statusRank[kb]) return statusRank[ka] - statusRank[kb];
                } else if (ka !== kb) {
                    return ka.localeCompare(kb);
                }
                return 0;
            });
        }

        const totalFiltered = filtered.length;
        const pageStart = (landingCurrentPage - 1) * landingPageSize;
        const pageSlice = filtered.slice(pageStart, pageStart + landingPageSize);

        renderJobTable(pageSlice);
        renderPagination(totalFiltered);
        renderActiveChips();
    }

    // ── Controls block rendering ──
    function renderControlsBlock(allJobs) {
        // Quick-view counts from ALL active jobs (not filtered)
        const overdueCount = allJobs.filter(j => isJobOverdue(j)).length;
        const soonCount = allJobs.filter(j => isJobDueSoon(j)).length;
        const correctionsCount = boardOn ? allJobs.filter(j => boardChipOf(j) === 'corrections').length : 0;

        // Show segmented control
        const showGroup = document.getElementById('showSegGroup');
        if (showGroup) {
            const showOpts = [
                { key: 'all', label: 'All', count: null },
                { key: 'overdue', label: 'Overdue', count: overdueCount, kind: 'danger' },
                { key: 'soon', label: 'Due Soon', count: soonCount, kind: 'soon' }
            ];
            // Jobs whose QC chip reads CORRECTIONS: an operator owes a fix.
            if (boardOn) showOpts.push({ key: 'corrections', label: 'Corrections', count: correctionsCount, kind: 'danger' });
            showGroup.innerHTML = showOpts.map(o => {
                const isActive = landingQuickFilter === o.key;
                let cls = 'seg-opt';
                if (isActive) {
                    cls += o.kind === 'soon' ? ' active-soon' : ' active';
                } else if (o.kind === 'danger') {
                    cls += ' idle-danger';
                } else if (o.kind === 'soon') {
                    cls += ' idle-soon';
                }
                let countHtml = '';
                if (o.count !== null) {
                    const hasCount = o.count > 0 ? ' has-count' : '';
                    countHtml = '<span class="qv-count' + hasCount + '">' + o.count + '</span>';
                }
                return '<button class="' + cls + '" onclick="setQuickFilter(\'' + o.key + '\')">' + o.label + countHtml + '</button>';
            }).join('');
        }

        // Group segmented control
        const groupGroup = document.getElementById('groupSegGroup');
        if (groupGroup) {
            const groupOpts = [
                { key: 'none', label: 'None' },
                { key: 'status', label: 'Status' },
                { key: 'csr', label: 'CSR' }
            ];
            groupGroup.innerHTML = groupOpts.map(o => {
                const cls = 'seg-opt' + (landingGroupBy === o.key ? ' active' : '');
                return '<button class="' + cls + '" onclick="setGroupBy(\'' + o.key + '\')">' + o.label + '</button>';
            }).join('');
        }

        // Status inline options
        const statusGroup = document.getElementById('statusSegGroup');
        if (statusGroup) {
            const statusOpts = [
                { key: 'all', label: 'All' },
                { key: 'new', label: 'New' },
                { key: 'in-progress', label: 'In Progress' },
                { key: 'on-hold', label: 'On Hold' },
                { key: 'complete', label: 'Complete' },
                { key: 'cancelled', label: 'Cancelled' }
            ];
            statusGroup.innerHTML = statusOpts.map((o, i) => {
                let cls = 'inline-opt';
                if (landingStatusFilter === o.key) {
                    cls += o.key === 'all' ? ' active' : ' active-real';
                }
                const dot = i > 0 ? '<span class="inline-dot">\u00B7</span>' : '';
                return dot + '<button class="' + cls + '" data-label="' + escHtml(o.label) +
                    '" onclick="setStatusFilter(\'' + o.key + '\')"><span>' + escHtml(o.label) + '</span></button>';
            }).join('');
        }

        // Dept inline options
        const deptGroup = document.getElementById('deptSegGroup');
        if (deptGroup) {
            const deptOpts = [
                { key: 'all', label: 'All' },
                { key: 'prepress', label: 'Prepress' },
                { key: 'techservices', label: 'Tech Services' }
            ];
            deptGroup.innerHTML = deptOpts.map((o, i) => {
                let cls = 'inline-opt';
                if (landingDeptFilter === o.key) {
                    if (o.key === 'all') cls += ' active';
                    else if (o.key === 'prepress') cls += ' active-real';
                    else cls += ' active-navy';
                }
                const dot = i > 0 ? '<span class="inline-dot">\u00B7</span>' : '';
                return dot + '<button class="' + cls + '" data-label="' + escHtml(o.label) +
                    '" onclick="setDeptFilter(\'' + o.key + '\')"><span>' + escHtml(o.label) + '</span></button>';
            }).join('');
        }

        // Updated trigger label
        const timeLabels = { all: 'Updated', today: 'Today', week: 'This Week', month: 'This Month' };
        const updatedLabel = document.getElementById('updatedLabel');
        if (updatedLabel) updatedLabel.textContent = timeLabels[landingTimeFilter] || 'Updated';
        const updatedCtrl = document.getElementById('updatedControl');
        if (updatedCtrl) {
            if (landingTimeFilter !== 'all') updatedCtrl.classList.add('has-selection');
            else updatedCtrl.classList.remove('has-selection');
        }

        // Updated dropdown options
        const updatedList = document.getElementById('updatedList');
        if (updatedList) {
            const timeOpts = [
                { key: 'today', label: 'Today' },
                { key: 'week', label: 'This Week' },
                { key: 'month', label: 'This Month' },
                { key: 'all', label: 'All Time' }
            ];
            updatedList.innerHTML = timeOpts.map(o => {
                const checked = landingTimeFilter === o.key;
                return '<label class="filter-dropdown-item"><input type="checkbox"' + (checked ? ' checked' : '') +
                    ' onchange="setTimeFilter(\'' + o.key + '\')"> ' + escHtml(o.label) + '</label>';
            }).join('');
        }

        // Update inline trigger active state (color + weight only, no count)
        ['CSR', 'Assignee', 'Client'].forEach(type => {
            const arr = type === 'CSR' ? landingSelectedCSRs :
                        type === 'Assignee' ? landingSelectedAssignees : landingSelectedClients;
            const btn = document.getElementById('filter' + type + 'Btn');
            if (arr.length > 0) {
                if (btn) btn.classList.add('has-selection');
            } else {
                if (btn) btn.classList.remove('has-selection');
            }
        });
    }

    // ── Active filter chips ──
    function renderActiveChips() {
        const container = document.getElementById('activeChips');
        if (!container) return;

        const chips = [];
        if (landingViewTab === 'my') chips.push({ label: 'My Jobs', remove: "setLandingViewTab('all')" });
        if (landingQuickFilter !== 'all') {
            const ql = { overdue: 'Overdue', soon: 'Due Soon', corrections: 'Corrections' };
            chips.push({ label: ql[landingQuickFilter], remove: "setQuickFilter('all')" });
        }
        if (landingStatusFilter !== 'all') {
            const sl = { 'new': 'New', 'in-progress': 'In Progress', 'on-hold': 'On Hold', 'complete': 'Complete', 'cancelled': 'Cancelled' };
            chips.push({ label: sl[landingStatusFilter], remove: "setStatusFilter('all')" });
        }
        if (landingDeptFilter !== 'all') {
            const dl = landingDeptFilter === 'prepress' ? 'Prepress' : 'Tech Services';
            chips.push({ label: dl, remove: "setDeptFilter('all')" });
        }
        if (landingTimeFilter !== 'all') {
            const tl = { today: 'Today', week: 'This Week', month: 'This Month' };
            chips.push({ label: tl[landingTimeFilter], remove: "setTimeFilter('all')" });
        }
        landingSelectedCSRs.forEach(v => {
            chips.push({ label: 'CSR: ' + v, remove: "removeChipFilter('selectedCSRs','" + escHtml(v).replace(/'/g, "\\'") + "')" });
        });
        landingSelectedAssignees.forEach(v => {
            chips.push({ label: 'Assignee: ' + v, remove: "removeChipFilter('selectedAssignees','" + escHtml(v).replace(/'/g, "\\'") + "')" });
        });
        landingSelectedClients.forEach(v => {
            chips.push({ label: 'Client: ' + v, remove: "removeChipFilter('selectedClients','" + escHtml(v).replace(/'/g, "\\'") + "')" });
        });
        if (landingSearchQuery) {
            chips.push({ label: 'Search: \u201C' + landingSearchQuery + '\u201D', remove: "clearSearchChip()" });
        }

        if (chips.length === 0) {
            container.style.display = 'none';
            return;
        }
        container.style.display = '';
        container.innerHTML =
            '<span class="active-chips-label">Active</span>' +
            '<div class="active-chips-list">' +
            chips.map(c =>
                '<span class="active-chip">' + escHtml(c.label) +
                '<span class="active-chip-x" onclick="' + c.remove + '">&times;</span></span>'
            ).join('') +
            '<button class="clear-all-link" onclick="clearLandingFilters()">Clear all</button>' +
            '</div>';
    }

    function removeChipFilter(type, value) {
        if (type === 'selectedCSRs') {
            landingSelectedCSRs = landingSelectedCSRs.filter(v => v !== value);
        } else if (type === 'selectedAssignees') {
            landingSelectedAssignees = landingSelectedAssignees.filter(v => v !== value);
        } else if (type === 'selectedClients') {
            landingSelectedClients = landingSelectedClients.filter(v => v !== value);
        }
        landingCurrentPage = 1;
        applyLandingFilters();
    }

    function clearSearchChip() {
        landingSearchQuery = '';
        const searchInput = document.getElementById('landingSearchInput');
        if (searchInput) searchInput.value = '';
        landingCurrentPage = 1;
        applyLandingFilters();
    }

    function clearLandingFilters() {
        landingViewTab = 'all';
        landingSelectedCSRs = [];
        landingSelectedAssignees = [];
        landingSelectedClients = [];
        landingDeptFilter = 'all';
        landingTimeFilter = 'all';
        landingStatusFilter = 'all';
        landingQuickFilter = 'all';
        landingSearchQuery = '';
        landingCurrentPage = 1;
        const searchInput = document.getElementById('landingSearchInput');
        if (searchInput) searchInput.value = '';
        // Reset the multi-select dropdown DOM so it can't desync from state.
        ['CSR', 'Assignee', 'Client'].forEach(type => {
            const list = document.getElementById('filter' + type + 'List');
            if (list) list.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
            const btn = document.getElementById('filter' + type + 'Btn');
            if (btn) btn.classList.remove('has-selection');
        });
        const updatedCtrl = document.getElementById('updatedControl');
        if (updatedCtrl) updatedCtrl.classList.remove('has-selection');
        document.querySelectorAll('.filter-dropdown.open').forEach(d => d.classList.remove('open'));
        applyLandingFilters();
    }

    // ========== REQUIRED FIELDS (B+A) ==========

    // Check required fields from stored data for a single component
    function getRequiredStatusForComponent(comp) {
        // Check required fields across all departments
        const missing = [];
        let total = 0;
        Object.values(window.DEPT_REGISTRY || {}).forEach(dept => {
            const fields = dept.getRequiredFields(comp);
            fields.forEach(rf => {
                total++;
                if (!(comp.notes && comp.notes[rf.id] && comp.notes[rf.id].trim())) {
                    missing.push(dept.label + ': ' + rf.label);
                }
            });
        });
        return { filled: total - missing.length, total: total, missing };
    }

    // Check required fields from stored data (for recent jobs list)
    function getRequiredStatusForJob(job) {
        if (!job.components || !job.components.length) return { allComplete: false };
        return { allComplete: job.components.every(c => getRequiredStatusForComponent(c).missing.length === 0) };
    }

    // Mark required field rows with visual indicators
    function updateRequiredIndicators() {
        document.querySelectorAll('.field-required').forEach(el => el.classList.remove('field-required', 'field-required-empty'));
        getActiveRequiredFields().forEach(rf => {
            const el = document.querySelector(`[data-id="${rf.id}"]`);
            if (!el) return;
            const row = el.closest('.field-row');
            if (!row) return;
            row.classList.add('field-required');
            if (!(el.value || '').trim()) row.classList.add('field-required-empty');
        });
    }

    // Close job with soft warning if required fields are missing (checks ALL components)
    // quiet: closing on the way to something else, so the warning would
    // interrupt rather than help. Changing user is the one case: the job is not
    // being abandoned, the page is about to reload, and nothing can be acted on
    // (David, 2026-09-16).
    // then: what the press does once the job is left (Change user's picker).
    // Its filing's own saves are the "once more" of a save owed before: when
    // they still do not land, Stay or Leave is asked (leaveJob), and Stay
    // keeps the job, with the filing on screen and sent again.
    function closeJobWithWarning(quiet, then) {
        // A viewed archived job files nothing and checks nothing: Change user
        // leaves it the way Home does.
        if (currentJobId && !isViewed(currentJobId)) {
            lastFiling = { jobId: currentJobId, press: quiet ? 'Change user' : 'Lock instructions' };
            closeCurrentJob();
            // Before the required check below: it reads the stored notes, so a
            // required box filled in the last moment would be named as missing.
            sendWaitingSaves();
            leaveJob(() => { missingRequiredToast(quiet); showNoJobState(); if (then) then(); });
            return;
        }
        showNoJobState();
        if (then) then();
    }
    function missingRequiredToast(quiet) {
        const job = getActiveJobs().find(j => j.id === currentJobId);
        if (!job || !job.components) return;
        const allMissing = [];
        job.components.forEach(comp => {
            const status = getRequiredStatusForComponent(comp);
            if (status.missing.length > 0) {
                allMissing.push(comp.name + ': ' + status.missing.join(', '));
            }
        });
        if (allMissing.length > 0 && !quiet) {
            const el = document.getElementById('backupToast');
            el.innerHTML = '<strong style="color:#fbbf24;">Missing required:</strong> <strong>' + allMissing.map(s => escHtml(s)).join(' | ') + '</strong>';
            el.classList.add('visible');
            setTimeout(() => { el.classList.remove('visible'); }, 5000);
        }
    }

    // ========== VERSION PICKER ==========

    function populateVersionSelects() {
        const letterSel = document.getElementById('versionLetter');
        const numberSel = document.getElementById('versionNumber');
        if (!letterSel || !numberSel) return;

        // Only populate once
        if (letterSel.options.length <= 1) {
            for (let i = 0; i < 26; i++) {
                const letter = String.fromCharCode(65 + i);
                const opt = document.createElement('option');
                opt.value = letter;
                opt.textContent = letter;
                letterSel.appendChild(opt);
            }
        }
        if (numberSel.options.length <= 1) {
            for (let n = 1; n <= 99; n++) {
                const num = String(n).padStart(2, '0');
                const opt = document.createElement('option');
                opt.value = num;
                opt.textContent = num;
                numberSel.appendChild(opt);
            }
        }
    }

    // ── Status popover (shared: header control + list inline edit) ──

    // opts.byKey: opened with the keys (statusPillKey). The cursor then goes to
    // the current status, the arrows move it, Enter or Space picks, Escape and
    // Tab close, and the cursor goes back to the pill (KEYBOARD_PLAN.md 2.6).
    // A mouse click opens it as before.
    function openStatusPopover(anchorEl, jobId, opts) {
        if (document.body.classList.contains('read-only')) return;
        closeStatusPopover();
        var jobs = getActiveJobs();
        var job = jobs.find(function(j) { return j.id === jobId; });
        if (!job) return;
        var current = getJobStatusLabel(job);
        var byKey = !!(opts && opts.byKey);

        var popover = document.createElement('div');
        popover.className = 'status-popover open';
        STATUS_KEYS.forEach(function(key) {
            var s = STATUS_MAP[key];
            var opt = document.createElement('div');
            opt.className = 'status-popover-option';
            opt.innerHTML =
                '<span class="status-popover-check">' + (current.cls === s.cls ? '&#10003;' : '') + '</span>' +
                '<span class="status-badge ' + s.cls + '">' + s.label + '</span>';
            opt.addEventListener('click', function(e) {
                e.stopPropagation();
                setJobStatus(jobId, key);
                closeStatusPopover();
            });
            popover.appendChild(opt);
        });

        // Position below anchor
        var rect = anchorEl.getBoundingClientRect();
        popover.style.position = 'fixed';
        popover.style.top = (rect.bottom + 4) + 'px';
        popover.style.left = rect.left + 'px';
        document.body.appendChild(popover);

        // Clamp to viewport
        var pRect = popover.getBoundingClientRect();
        if (pRect.right > window.innerWidth - 8) {
            popover.style.left = Math.max(8, window.innerWidth - pRect.width - 8) + 'px';
        }
        if (pRect.bottom > window.innerHeight - 8) {
            popover.style.top = (rect.top - pRect.height - 4) + 'px';
        }

        if (byKey) statusPopoverKeys(popover, anchorEl, jobId, current);

        // Close on outside click (next tick so this click doesn't fire it)
        setTimeout(function() {
            document.addEventListener('click', closeStatusPopoverOnOutside);
        }, 0);
    }

    // The keys of a status list opened with the keys. The list is drawn on the
    // page's body, so a redraw of the job list can replace the pill while it is
    // open: the pill is found again by its job, never kept.
    function statusPopoverKeys(popover, anchorEl, jobId, current) {
        var options = Array.from(popover.querySelectorAll('.status-popover-option'));
        options.forEach(function(o) { o.tabIndex = -1; });
        // Where the pill was on the job list: a pick can move the job off the
        // page showing (its place in the order changes), and the cursor then
        // goes to the row now in that place (giveBackListCursor).
        var origin = listCursor();
        var back = function() {
            if (anchorEl && anchorEl.id === 'headerStatusBadge') { focusQuiet(anchorEl); return; }
            if (!focusQuiet(document.querySelector('#jobTableBody [data-status-job="' + CSS.escape(jobId) + '"]')) && origin) giveBackListCursor(origin);
        };
        popover.addEventListener('keydown', function(e) {
            var at = options.indexOf(document.activeElement);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                var n = options.length;
                focusQuiet(options[((at < 0 ? 0 : at) + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]);
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (e.repeat || at < 0 || boxUp()) return;
                options[at].click();
                back();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                if (e.repeat) return;
                closeStatusPopover();
                back();
            } else if (e.key === 'Tab') {
                // Closed; the Tab then moves on from the pill.
                closeStatusPopover();
                back();
            }
        });
        var on = STATUS_KEYS.findIndex(function(key) { return STATUS_MAP[key].cls === current.cls; });
        focusQuiet(options[on >= 0 ? on : 0]);
    }

    // Enter or Space on a status pill, on the job list or in the work order
    // header: its list, as a click opens it. Stopped here, so a row's own Enter
    // never opens the job under it.
    function statusPillKey(e, jobId) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        // Under a box the key is the box's (the reload box answers Enter from
        // the document whatever has the cursor).
        if (boxUp()) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat || !jobId) return;
        openStatusPopover(e.currentTarget, jobId, { byKey: true });
    }

    function closeStatusPopoverOnOutside(e) {
        var pop = document.querySelector('.status-popover.open');
        if (pop && !pop.contains(e.target)) {
            closeStatusPopover();
        }
    }

    function closeStatusPopover() {
        document.removeEventListener('click', closeStatusPopoverOnOutside);
        var existing = document.querySelector('.status-popover.open');
        if (existing) existing.remove();
    }

    async function setJobStatus(jobId, statusKey) {
        var jobs = getActiveJobs();
        var job = jobs.find(function(j) { return j.id === jobId; });
        if (!job) return;
        var before = job.status;

        // The status it already has saves nothing and puts no name on the job
        // (the after-rollout batch, item 3); Complete still asks "Archive this
        // job?", as it did.
        if (before !== statusKey) {
            job.status = statusKey;

            // Update header badge if this is the currently loaded job
            if (currentJobId === jobId) {
                renderHeaderStatusBadge(job);
            }

            // Re-render landing list
            applyLandingFilters();

            // Saved before anything else is asked: refused (somebody else is
            // editing the job, or a version conflict), the badge goes back to
            // what it was and the archive question is not asked.
            // On the job list (the job not open) a save the server fails is
            // said here, so it is sent quietly (SAVE_FAILURE_PLAN.md).
            var open = currentJobId === jobId && !isViewed(jobId);
            var pressAt = Date.now();
            var ok = await persistJob(job, open ? undefined : { quiet: true });
            if (!ok) {
                // This save failed with a server error (its own mark, not
                // the job's: a status put back to the server's own value
                // fails and yet owes nothing).
                var failedHere = !!(lastSaveFailure && lastSaveFailure.jobId === jobId && lastSaveFailure.at >= pressAt);
                // On the open job it stays on screen: the bar says so and it
                // goes again with the row.
                if (open && failedHere) return;
                // Queued for later while the server is unreachable is not a
                // refusal: the change stays on screen and goes when it is back.
                // Refused by the lock on the open job, the page has turned into
                // the view, whose box names the status as not saved and keeps it
                // on screen until OK draws the latest copy.
                if (!_serverDown && !(currentJobId === jobId && isViewed(jobId))) {
                    job.status = before;
                    if (currentJobId === jobId) renderHeaderStatusBadge(job);
                    applyLandingFilters();
                }
                if (!open && failedHere) statusNotSaved(jobId, false);
                return;
            }
        }

        // Prompt to archive when marking complete. Complete itself changes
        // nothing about QC, so it is not warned about; this press is, because
        // Yes archives the job on the spot (David, 2026-09-20).
        if (statusKey === 'complete') {
            qcWarningLines([jobId]).then(function(lines) {
                var items = lines.length ? [QC_ARCHIVE_LEAD].concat(lines) : [];
                showWarningModal('Archive this job?', items,
                    { type: lines.length ? 'qc' : 'info', okLabel: 'Yes', cancelLabel: 'No', showCancel: true }).then(function(yes) {
                    if (!yes) return;
                    // What is waiting goes first, and the archive waits on the
                    // save queue behind it: an archived job refuses changes
                    // (item 5). This press does not file the instructions.
                    var pressAt = Date.now();
                    var wasOpen = currentJobId === jobId && !isViewed(jobId);
                    if (wasOpen) sendWaitingSaves();
                    var done = function() { if (archivingJobId === jobId) archivingJobId = null; };
                    archiveAfterSaves(jobId, wasOpen, pressAt).then(async function(out) {
                        try {
                            if (!out.res) { tellNotArchived(out); return; }
                            var res = out.res;
                            if (await refusedByLock(res, jobId)) return;
                            if (!res.ok) { showErrorModal("Couldn't archive this job.", 'Refresh'); return; }
                            leaveArchivedJob(jobId);
                            refreshJobs().then(function() { loadJobs(); });
                        } finally { done(); }
                    }).catch(function() { done(); showErrorModal("Couldn't archive this job.", 'Refresh'); });
                });
            });
        }
    }

    function renderHeaderStatusBadge(job) {
        var el = document.getElementById('headerStatusBadge');
        if (!el) return;
        var s = getJobStatusLabel(job);
        el.innerHTML = '<span class="status-badge ' + s.cls + '">' + s.label + '</span>' +
            '<span class="status-header-caret">&#9660;</span>';
    }

    // ── Stale-cache reload modal ──

    function showReloadModal() {
        var modal = document.getElementById('reloadModal');
        if (modal) modal.style.display = 'block';
    }

    function confirmReloadModal() {
        // First, before the refresh: anything still waiting would read the
        // screen as it was into the copy just fetched and send it, over the
        // change that caused this box, with no conflict shown.
        dropWaitingSaves();
        var modal = document.getElementById('reloadModal');
        if (modal) modal.style.display = 'none';
        // The open job archived or deleted since the conflict: said now, while
        // it is still on the list and on screen. Reloaded, it left the list
        // and the page stayed on the old work order, editable, sending nothing
        // until the heartbeat (item 5).
        var openId = (!viewedJob && currentJobId) || null;
        (openId ? fetchJobFresh(openId) : Promise.resolve(null)).then(function(fresh) {
            if (openId && openId === currentJobId && !viewedJob) {
                // No answer: the box again, so Reload job can be pressed once
                // more, rather than a reload that cannot find the job.
                if (!fresh) { showReloadModal(); return; }
                if (fresh.status === 404) { lockGone(openId, { archived: false }); return; }
                if (fresh.job && fresh.job.archivedDate) { lockGone(openId, { archived: true }); return; }
            }
            refreshJobs().then(function() {
                // On the job list (a save sent by Home met a conflict) there is
                // no work order to reload, so the list is drawn again instead.
                // Over a View the conflict was the job left before, not the one
                // on screen: the view stays as it is (ARCHIVE_VIEW_PLAN E).
                if (viewedJob) return;
                if (currentJobId) loadJob(currentJobId);
                else loadJobs();
            });
        });
    }

    // Enter key triggers reload when modal is visible
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            var modal = document.getElementById('reloadModal');
            if (modal && modal.style.display === 'block') {
                e.preventDefault();
                confirmReloadModal();
            }
        }
    });

    function openVersionPicker() {
        if (!currentJobId) return;
        const picker = document.getElementById('versionPicker');
        populateVersionSelects();

        // Pre-select current version
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        const comp = job && job.components ? job.components.find(c => c.id === currentComponentId) : null;
        const ver = comp ? (comp.version || '') : '';

        if (ver && ver.length >= 3) {
            document.getElementById('versionLetter').value = ver.charAt(0);
            document.getElementById('versionNumber').value = ver.slice(1);
        } else {
            document.getElementById('versionLetter').value = '';
            document.getElementById('versionNumber').value = '';
        }

        picker.classList.toggle('open');
    }

    function setVersion() {
        const letter = document.getElementById('versionLetter').value;
        const number = document.getElementById('versionNumber').value;
        if (!letter || !number) return;

        const code = letter + number;
        applyVersion(code);
        document.getElementById('versionPicker').classList.remove('open');
    }

    function clearVersion() {
        applyVersion('');
        document.getElementById('versionPicker').classList.remove('open');
    }

    function incrementVersion() {
        if (!currentJobId) return;
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        const comp = job && job.components ? job.components.find(c => c.id === currentComponentId) : null;
        const ver = comp ? (comp.version || '') : '';

        if (ver && ver.length >= 3) {
            const letter = ver.charAt(0);
            const num = parseInt(ver.slice(1), 10);
            const next = Math.min(num + 1, 99);
            applyVersion(letter + String(next).padStart(2, '0'));
        } else {
            // No version set yet — start at A01
            applyVersion('A01');
        }
    }

    function applyVersion(code) {
        if (!currentJobId || !currentComponentId || isViewed(currentJobId)) return;
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components) return;

        const comp = job.components.find(c => c.id === currentComponentId);
        if (!comp) return;

        // The version it already has (Set on the one shown, Clear with none)
        // writes nothing and puts no name on the job (the after-rollout batch,
        // item 3).
        const changed = (comp.version || '') !== code;
        if (!changed) return;
        saveComponentState();   // the screen into the piece first, as renameComponent
        comp.version = code;
        job.lastModified = new Date().toISOString();
        job.lastModifiedBy = getUserName();
        saveActiveJobs(jobs);
        // The job row's save leaves the pieces out (as renameComponent).
        persistComponent(comp, job);

        updateVersionDisplay(code);
        renderComponentTabs();
    }

    function updateVersionDisplay(code) {
        const el = document.getElementById('printVersion');
        if (el) el.textContent = code || '---';
    }

    // Close version picker on outside click
    document.addEventListener('click', (e) => {
        const picker = document.getElementById('versionPicker');
        if (picker && picker.classList.contains('open') && !e.target.closest('.job-field--version')) {
            picker.classList.remove('open');
        }
    });

    // Live "Max on this sheet: N-up" hint under the Number Up field.
    // Recomputes as the operator types Flat Size, Press Sheet, or focuses Number Up,
    // and on component switch (so a loaded job shows the hint without requiring a keystroke).
    function updateNumberUpHint() {
        const hint = document.getElementById('ps13MaxHint');
        if (!hint) return;
        const flatInput = document.querySelector('[data-id="ps3n"]');
        const sheetInput = document.querySelector('[data-id="ps1n"]');
        const flatDims = flatInput ? parseDims(flatInput.value.trim()) : null;
        const sheetDims = sheetInput ? parseDims(sheetInput.value.trim()) : null;
        if (!flatDims || !sheetDims) {
            hint.textContent = '';
            hint.classList.remove('warn');
            return;
        }
        const max = computeMaxNUp(flatDims, sheetDims);
        if (max === 0) {
            hint.textContent = "Won't fit in either orientation — check sheet size.";
            hint.classList.add('warn');
        } else if (max === null) {
            hint.textContent = '';
            hint.classList.remove('warn');
        } else {
            hint.textContent = 'Max on this sheet: ' + max + '-up';
            hint.classList.remove('warn');
        }
    }
    window.updateNumberUpHint = updateNumberUpHint;

    document.addEventListener('input', (e) => {
        const id = e.target && e.target.dataset ? e.target.dataset.id : null;
        if (id === 'ps3n' || id === 'ps1n' || id === 'ps13n') {
            updateNumberUpHint();
        }
    });
    document.addEventListener('focusin', (e) => {
        const id = e.target && e.target.dataset ? e.target.dataset.id : null;
        if (id === 'ps13n' || id === 'ps3n' || id === 'ps1n') {
            updateNumberUpHint();
        }
    });
    // Initial paint in case a job is already loaded.
    setTimeout(updateNumberUpHint, 300);

    // ========== THE KEYBOARD (KEYBOARD_PLAN.md) ==========
    // For people who prefer the keys; everyone also has a mouse, and the mouse
    // does exactly what it did. Where a key opens something a click also opens,
    // the cursor moves into it only when a key opened it. Every handler here
    // ignores a held key that presses something, cancels the keys it handles
    // (an Enter's keypress would otherwise click what it just focused), and
    // does nothing while a box is up. Events made by code are left alone.

    // The box on top: the last of the app's boxes showing, in page order (a
    // later one paints over an earlier one). The QC Review window is one.
    function topBox() {
        let top = null;
        document.querySelectorAll('.modal').forEach(m => { if (getComputedStyle(m).display !== 'none') top = m; });
        return top;
    }
    function boxUp() { return !!topBox(); }
    function shownEl(el) { return !!el && el.isConnected && el.getClientRects().length > 0; }
    // Focus without scrolling unless asked; true when it took.
    function focusQuiet(el, scroll) {
        if (!shownEl(el)) return false;
        try { el.focus(scroll ? undefined : { preventScroll: true }); } catch (e) { return false; }
        return document.activeElement === el;
    }
    // The Tab stops inside a box: shown, enabled, not taken out of the order.
    function boxStops(box) {
        return Array.from(box.querySelectorAll('a[href], button, input, select, textarea, [tabindex]'))
            .filter(el => el.tabIndex >= 0 && !el.disabled && !el.closest('[hidden]') && shownEl(el) && getComputedStyle(el).visibility !== 'hidden');
    }
    function openForEditing() {
        return !!currentJobId && !isViewed(currentJobId) && !document.body.classList.contains('read-only');
    }

    // ── No key acts on the page behind a box ──
    // Typing, presses and scrolling aimed behind the top box are cancelled.
    // Only the browser's own action is cancelled, never the event: the lock
    // box answers Enter and Escape from its own listener whatever has focus,
    // and holds its cursor on nothing during its grace. Tab behind a box goes
    // to the box's first control, except under the lock box, which places its
    // own. Function keys and Ctrl+C are left alone.
    const KEYS_HELD_BEHIND_BOXES = ['Enter', ' ', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
    window.addEventListener('keydown', e => {
        if (!e.isTrusted) return;
        const top = topBox();
        if (!top || top.contains(e.target)) return;
        const key = String(e.key);
        if (key === 'Tab') {
            e.preventDefault();
            if (top.id !== 'lockModal') focusQuiet(boxStops(top)[0]);
            return;
        }
        // Nothing behind has the cursor: a click in a box that does not take
        // it (Manage CSRs, Export), or the lock box's grace. The keys scroll
        // what was clicked, as they always did.
        if (e.target === document.body || e.target === document.documentElement) return;
        // AltGr (Ctrl and Alt together) types a character on some keyboards.
        const altGr = e.ctrlKey && e.altKey;
        if ((e.ctrlKey || e.metaKey) && !altGr) {
            if (['z', 'y', 'x', 'v'].includes(key.toLowerCase())) e.preventDefault();
            return;
        }
        if (e.altKey && !altGr) return;
        if (key.length === 1 || key === 'Process' || KEYS_HELD_BEHIND_BOXES.includes(key)) e.preventDefault();
    }, true);
    // Chrome keeps one typing history for the whole page. Ctrl+Z in a box with
    // nothing of its own left to take back would take back a note typed in the
    // work order behind it, and the work order would save that.
    document.addEventListener('beforeinput', e => {
        if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return;
        const top = topBox();
        if (top && !top.contains(e.target)) e.preventDefault();
    }, true);

    // ── What had the cursor, to give it back ──
    // A list element is named by its job and kind (row, its checkbox, its
    // status), because a redraw of the job list replaces the elements.
    function listCursor() {
        const el = document.activeElement;
        const body = document.getElementById('jobTableBody');
        if (!el || !body || !body.contains(el)) return null;
        const row = el.closest('tr[data-job-id]');
        if (!row) return null;
        const kind = el === row ? 'row' : el.classList.contains('table-row-check') ? 'check' : el.hasAttribute('data-status-job') ? 'status' : '';
        if (!kind) return null;
        return { jobId: row.getAttribute('data-job-id'), kind, index: Array.from(body.querySelectorAll('tr[data-job-id]')).indexOf(row) };
    }
    function listElement(jobId, kind) {
        if (!jobId) return null;
        const row = document.querySelector('#jobTableBody tr[data-job-id="' + CSS.escape(jobId) + '"]');
        if (!row) return null;
        if (kind === 'check') return row.querySelector('.table-row-check');
        if (kind === 'status') return row.querySelector('[data-status-job]');
        return row;
    }
    function focusJobRow(jobId, kind) { return focusQuiet(listElement(jobId, kind), true); }
    // The same element of the same job; that job gone from the list, the row
    // now in its place, else the last row, else nowhere.
    function giveBackListCursor(c) {
        if (!c) return;
        if (focusQuiet(listElement(c.jobId, c.kind))) return;
        const rows = Array.from(document.querySelectorAll('#jobTableBody tr[data-job-id]'));
        if (rows.length) focusQuiet(rows[Math.min(c.index, rows.length - 1)]);
    }
    // What has the cursor before a box opens (not inside that box, not nothing).
    function rememberCursor(box) {
        const el = document.activeElement;
        if (!el || el === document.body || (box && box.contains(el))) return null;
        return { el, list: listCursor() };
    }
    // Given back when it is still shown and not behind a box; a list element
    // is found again by its job.
    function restoreCursor(c) {
        if (!c) return;
        const top = topBox();
        if (shownEl(c.el) && (!top || top.contains(c.el))) { focusQuiet(c.el); return; }
        if (c.list && !top) giveBackListCursor(c.list);
    }

    // ── The job list: Enter on a row opens the job (2.4) ──
    function jobRowKey(e, jobId) {
        if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
        e.preventDefault();
        if (e.repeat || boxUp()) return;
        loadJob(jobId);
    }

    // ── After a job opens: the top of the work order (2.5) ──
    // Only when the cursor is nowhere, or on something no longer shown (the
    // row, the list's New Work Order button): a redraw of the job somebody is
    // typing in never moves it.
    function settleCursorOnOpen() {
        if (boxUp()) return;
        const el = document.activeElement;
        if (el && el !== document.body && shownEl(el)) return;
        focusQuiet(document.getElementById('workOrderTop'));
    }

    // ── The "..." and Print menus (2.3) ──
    function navMenuItems(menu) {
        return Array.from(menu.querySelectorAll('.more-dropdown-item, .print-dropdown-item')).filter(shownEl);
    }
    ['printDropdown', 'moreDropdown'].forEach(id => {
        const menu = document.getElementById(id);
        const button = menu.parentElement.querySelector('.nav-btn');
        const closeToButton = () => { menu.classList.remove('open'); focusQuiet(button); };
        menu.addEventListener('keydown', e => {
            if (!e.isTrusted || !menu.classList.contains('open') || boxUp()) return;
            const items = navMenuItems(menu);
            const n = items.length;
            const at = items.indexOf(document.activeElement);
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                if (!n) return;
                const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key === 'ArrowDown' ? at + 1 : (at < 0 ? n - 1 : at - 1);
                focusQuiet(items[(next + n) % n]);
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (e.repeat || at < 0) return;
                // The menu closes with the cursor on its button, then the item
                // runs; a box it opens takes the cursor and gives it back there.
                closeToButton();
                items[at].click();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                if (!e.repeat) closeToButton();
            } else if (e.key === 'Tab') {
                // Closed; the Tab moves on from the button.
                closeToButton();
            }
        });
        // A held Enter or Space: its repeats land on the button the cursor
        // just went back to, and would open the menu again.
        button.addEventListener('keydown', e => {
            if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
        });
        // The cursor moved to another element of the page closes it; the
        // window losing focus (Alt+Tab) does not, as a mouse-opened menu never did.
        menu.addEventListener('focusout', e => {
            if (e.relatedTarget && !menu.contains(e.relatedTarget) && e.relatedTarget !== button) menu.classList.remove('open');
        });
    });

    // ── The boxes: New Job, Edit Job, and the question box (2.7) ──
    // While one of them is the top box: Tab goes round its own controls
    // (wrapping only at the two ends, so a date box's day, month and year still
    // take Tab), Left and Right move between the buttons along its bottom, and
    // Escape in New Job and Edit Job works like Cancel, unless a quick-pick
    // list in it is open (its own Escape closes the list first). A box that
    // opens over one of them keeps its own keys.
    const KEY_BOXES = ['newJobModal', 'editJobModal', 'qcWarningModal'];
    document.addEventListener('keydown', e => {
        if (!e.isTrusted) return;
        const top = topBox();
        if (!top || !KEY_BOXES.includes(top.id)) return;
        // A key held from the press that opened the box (Enter on the +, on
        // Complete) must not press inside it: a repeat in Job Number would
        // send the empty form, on No would answer the question.
        const typing = e.target.matches && e.target.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea');
        if (e.repeat && (e.key === 'Enter' || (e.key === ' ' && !typing))) { e.preventDefault(); return; }
        // Left and Right move along the buttons at the bottom of the box,
        // stopping at the ends (David, 2026-10-08, after his hand test). Only
        // on one of those buttons: in a typing box the arrows still move
        // through the words. Cancelled at the ends too: in a narrow window
        // Chrome's own Right on a button scrolls the page behind sideways. A
        // held arrow moves once: its repeats are cancelled, so a key held from
        // before a question box opened cannot carry the cursor from No onto
        // Yes.
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
            const row = e.target.closest && e.target.closest('.modal-buttons');
            if (!row || !top.contains(row) || e.target.tagName !== 'BUTTON') return;
            e.preventDefault();
            if (e.repeat) return;
            const buttons = boxStops(row);
            const at = buttons.indexOf(e.target);
            if (at < 0) return;
            const next = buttons[at + (e.key === 'ArrowRight' ? 1 : -1)];
            if (next) focusQuiet(next);
            return;
        }
        if (e.key === 'Tab') {
            // From behind the box the window's guard has already put the cursor
            // on the box's first control (a Shift+Tab here would carry it on
            // round to the last: Yes).
            if (!top.contains(e.target)) return;
            // A Tab held from before a question box opened would go round its
            // two buttons and stop on either: its repeats are cancelled there.
            if (e.repeat && top.id === 'qcWarningModal') { e.preventDefault(); return; }
            const list = boxStops(top);
            if (!list.length) return;
            const at = list.indexOf(document.activeElement);
            if (e.shiftKey && at <= 0) { e.preventDefault(); list[list.length - 1].focus(); }
            else if (!e.shiftKey && (at === -1 || at === list.length - 1)) { e.preventDefault(); list[0].focus(); }
            return;
        }
        if (e.key === 'Escape' && top.id !== 'qcWarningModal') {
            if (top.querySelector('.quick-pick-menu.open')) return;
            e.preventDefault();
            if (e.repeat) return;
            if (top.id === 'newJobModal') closeNewJobModal();
            else closeEditJobModal();
        }
    }, true);
    const boxOpeners = {};
    function rememberBoxOpener(id) {
        const box = document.getElementById(id);
        if (box.style.display !== 'block') boxOpeners[id] = rememberCursor(box);
    }
    function giveBackBoxCursor(id, wasOpen) {
        const opener = boxOpeners[id];
        boxOpeners[id] = null;
        if (wasOpen) restoreCursor(opener);
    }
    // A box's first field, now and again a moment later (the code that opened
    // it may still move the cursor), unless something in it already has it or
    // a box has opened over it.
    function focusBoxField(boxId, fieldId) {
        const go = () => {
            const box = document.getElementById(boxId);
            if (box.style.display === 'block' && topBox() === box && !box.contains(document.activeElement)) focusQuiet(document.getElementById(fieldId));
        };
        go();
        setTimeout(go, 100);
    }

    // ── New Job's component choices: one Tab stop (2.7) ──
    // The arrows move the cursor and the stop, Home and End go to the ends,
    // Space picks or un-picks exactly as a click does, Tab leaves.
    document.getElementById('componentsSelect').addEventListener('keydown', e => {
        if (!e.isTrusted) return;
        const choices = Array.from(e.currentTarget.querySelectorAll('.component-option'));
        const at = choices.indexOf(document.activeElement);
        if (at < 0) return;
        const n = choices.length;
        let next = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % n;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + n) % n;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = n - 1;
        if (next >= 0) {
            e.preventDefault();
            choices.forEach((c, i) => { c.tabIndex = i === next ? 0 : -1; });
            focusQuiet(choices[next]);
        } else if (e.key === ' ') {
            e.preventDefault();
            if (!e.repeat) choices[at].click();
        }
    });

    // ── The switches (2.8) ──
    // Ctrl+Space in a row's box does exactly what a click on the row's switch
    // does, only when Space is the first key pressed since Ctrl went down: a
    // rolled Ctrl+V then Space would otherwise empty the box just pasted into.
    // Space on a switch that is a Tab stop (the rows with no box) is the
    // browser's own toggle; the undo snapshot a mouse press takes first is
    // taken here.
    let ctrlFresh = false;
    document.addEventListener('keydown', e => {
        if (e.key === 'Control') { if (!e.repeat) ctrlFresh = true; return; }
        if (e.key !== ' ') ctrlFresh = false;
    }, true);
    document.addEventListener('keyup', e => { if (e.key === 'Control') ctrlFresh = false; }, true);
    function switchKeys(e) {
        if (!e.isTrusted || e.key !== ' ' || e.altKey || e.metaKey || e.shiftKey) return;
        const t = e.target;
        if (!e.ctrlKey) {
            if (!t.matches('.toggle-switch input[type="checkbox"]')) return;
            if (e.repeat || t.disabled || !openForEditing() || boxUp()) { e.preventDefault(); return; }
            if (!isUndoRedo) pushToUndo(false);
            return;
        }
        const fresh = ctrlFresh;
        ctrlFresh = false;
        if (!t.matches('.notes')) return;
        const row = t.closest('.field-row');
        const sw = row && row.querySelector('.toggle-switch input[type="checkbox"]');
        if (!sw) return;
        e.preventDefault();
        if (e.repeat || !fresh || t.readOnly || t.disabled || sw.disabled || !openForEditing() || boxUp()) return;
        if (!isUndoRedo) pushToUndo(false);
        sw.click();
        // The cursor never left the box: the next typing must take its undo
        // snapshot from after the flip, as it would after a click.
        focusSnapshot = captureState();
        fieldDirty = false;
    }
    document.querySelectorAll('.dept-checklist').forEach(panel => panel.addEventListener('keydown', switchKeys));
    // The rows whose switch is a Tab stop: nothing else in them turns it on
    // or off by key. Called once the page has started, after every switch was
    // taken out of the Tab order.
    const SWITCH_STOPS = '.field-row--cb-only > .toggle-switch > input[type="checkbox"], .field-row--meeting-required > .toggle-switch > input[type="checkbox"]';
    function setSwitchStops() {
        document.querySelectorAll(SWITCH_STOPS).forEach(el => { el.tabIndex = 0; });
    }
