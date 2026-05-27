
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
    const MAX_ACTIVE_JOBS = 20;
    const MAX_UNDO_HISTORY = 15;
    const MAX_COMPONENTS = 10;

    // Initialize Quill editor (history disabled — app-level undo/redo handles full form state)
    const quill = new Quill('#csrInstructions', {
        theme: 'snow',
        modules: {
            toolbar: '#quill-toolbar',
            history: { maxStack: 0 }
        },
        placeholder: 'Type instructions here...'
    });

    // Strip Word/HTML tables on paste. Quill Snow does not support table-cell
    // editing, so pasted tables leave undeletable cell borders. Convert each
    // row to a plain-text line with pipe separators between cells.
    quill.clipboard.addMatcher('TABLE', function(node) {
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
    const PIECE_FORMAT_OPTIONS = ["6x9.5\u2033 Envelope", "9x12 Envelope", "A7 Envelope", "Booklet", "Buckslip", "Label", "Letter", "No. 9 BRE Envelope", "No. 10 Envelope", "No. 10 Envelope Window", "Postcard", "Remit", "Self-Mailer", "Sticker"];
    const CSR_NAMES = ["Brandi Czjkowski", "Charlene Fitzpatrick", "Claudine Hauret", "Courtney Coyle", "Doug Jowsey", "Gina Burton", "Jamie Coyle", "Lucy Ballester", "Marc Maio", "Rich Owen", "Rosette Jowsey", "Sharon Woodruff", "Stef Tarpy"];
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
    const ENVELOPE_KEYWORDS = ['envelope', 'no. 9', 'no. 10', 'a7', '6x9', '9x12'];

    function isEnvelopeComponent(name) {
        const lower = (name || '').toLowerCase();
        return ENVELOPE_KEYWORDS.some(kw => lower.includes(kw));
    }

    // Press dropdown options — standard vs envelope
    const PRESS_STANDARD = ["Canon (color)", "Titan (b&w)", "MCS", "Outside Print", "N/A"];
    const PRESS_ENVELOPE = ["Kirk-Rudy", "Outside Print", "N/A"];

    function autoCompleteFlatSize() {
        // Delegate to active department
        const dept = window.DEPT_REGISTRY[activeDepartment];
        if (dept && dept.autoCompleteFlatSize) dept.autoCompleteFlatSize();
        if (currentJobId) debouncedSaveJobState();
    }

    // Attach auto-complete on blur and Enter for flat size (both departments)
    document.addEventListener('blur', (e) => {
        if (e.target.matches('[data-id="ps3n"]')) autoCompleteFlatSize();
    }, true);
    document.addEventListener('keydown', (e) => {
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
    let saveDebounceTimer = null;
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

    // ========== INDEXEDDB BACKUP ==========
    const IDB_NAME = 'prepressBackup';
    const IDB_STORE = 'data';
    const IDB_VERSION = 1;

    function openIDB() {
        return new Promise((resolve, reject) => {
            try {
                const req = indexedDB.open(IDB_NAME, IDB_VERSION);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(IDB_STORE)) {
                        db.createObjectStore(IDB_STORE);
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            } catch (e) { reject(e); }
        });
    }

    async function backupToIDB(jobs, archive) {
        try {
            const db = await openIDB();
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            store.put(jobs, 'jobs');
            store.put(archive, 'archive');
            store.put(new Date().toISOString(), 'lastAutoBackup');
            tx.oncomplete = () => db.close();
        } catch (e) { /* IDB unavailable, localStorage still works */ }
    }

    async function restoreFromIDB() {
        try {
            const db = await openIDB();
            return new Promise((resolve) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const store = tx.objectStore(IDB_STORE);
                const jobsReq = store.get('jobs');
                const archiveReq = store.get('archive');
                const tsReq = store.get('lastAutoBackup');
                tx.oncomplete = () => {
                    db.close();
                    resolve({
                        jobs: jobsReq.result || [],
                        archive: archiveReq.result || [],
                        timestamp: tsReq.result || null
                    });
                };
                tx.onerror = () => { db.close(); resolve(null); };
            });
        } catch (e) { return null; }
    }

    async function getBackupTimestamp() {
        try {
            const db = await openIDB();
            return new Promise((resolve) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const store = tx.objectStore(IDB_STORE);
                const req = store.get('lastAutoBackup');
                tx.oncomplete = () => { db.close(); resolve(req.result || null); };
                tx.onerror = () => { db.close(); resolve(null); };
            });
        } catch (e) { return null; }
    }

    function showToast(msg) {
        const el = document.getElementById('backupToast');
        el.textContent = msg;
        el.classList.add('visible');
        setTimeout(() => el.classList.remove('visible'), 4000);
    }

    async function restoreFromBackupUI() {
        const backup = await restoreFromIDB();
        if (!backup || (!backup.jobs.length && !backup.archive.length)) {
            alert('No backup found in IndexedDB.');
            return;
        }
        const ts = backup.timestamp
            ? new Date(backup.timestamp).toLocaleString()
            : 'Unknown';
        const msg = `Restore from backup?\n\nLast backup: ${ts}\nActive jobs: ${backup.jobs.length}\nArchived jobs: ${backup.archive.length}\n\nThis will replace your current data.`;
        if (!confirm(msg)) return;

        localStorage.setItem('prepressJobs', JSON.stringify(backup.jobs));
        localStorage.setItem('prepressJobsArchive', JSON.stringify(backup.archive));
        invalidateJobsCache();
        currentJobId = null;
        currentComponentId = null;
        loadJobs();
        showNoJobState();
        showToast('Data restored from backup');
    }

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

    function getUserName() { return localStorage.getItem('prepressUserName') || ''; }
    function byLabel(name) { return name ? ' by ' + name : ''; }

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
        const name = document.getElementById('profileNameInput').value.trim() || localStorage.getItem('prepressUserName') || '';
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
            const saved = localStorage.getItem('prepressUserName') || '';
            const savedPhotoSrc = localStorage.getItem('prepressUserPhotoSrc');
            document.getElementById('profileNameInput').value = saved;

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

    function saveProfile() {
        const name = document.getElementById('profileNameInput').value.trim();
        if (name) {
            localStorage.setItem('prepressUserName', name);
        } else {
            localStorage.removeItem('prepressUserName');
        }
        // Save cropped photo
        const cropped = cropToDataURL();
        if (cropped) {
            localStorage.setItem('prepressUserPhoto', cropped);
        }
        updateProfileBtn();
        updateLandingGreeting();
        document.getElementById('profilePopover').classList.remove('open');
        if (name) showToast(`Profile saved. Hey, ${name}!`);
    }

    function updateProfileBtn() {
        const btn = document.getElementById('profileBtn');
        const iconEl = document.getElementById('profileBtnIcon');
        const photo = localStorage.getItem('prepressUserPhoto');
        const name = localStorage.getItem('prepressUserName') || '';

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

    function updateLandingGreeting() {
        const el = document.getElementById('landingGreeting');
        if (!el) return;
        const name = localStorage.getItem('prepressUserName');
        if (name) {
            el.textContent = pickGreeting(name);
        } else {
            el.textContent = 'Select or Create a Work Order';
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
    }

    document.addEventListener('DOMContentLoaded', async () => {
        // Init profile
        updateProfileBtn();
        updateLandingGreeting();
        initCropHandlers();

        // Auto-recovery: if localStorage is empty, try restoring from IndexedDB
        const lsJobs = localStorage.getItem('prepressJobs');
        if (!lsJobs || lsJobs === '[]') {
            try {
                const backup = await restoreFromIDB();
                if (backup && backup.jobs && backup.jobs.length > 0) {
                    localStorage.setItem('prepressJobs', JSON.stringify(backup.jobs));
                    invalidateJobsCache();
                    if (backup.archive && backup.archive.length > 0) {
                        localStorage.setItem('prepressJobsArchive', JSON.stringify(backup.archive));
                    }
                    showToast('Job data recovered from backup');
                }
            } catch (e) { /* IDB unavailable, proceed with empty state */ }
        }
        loadJobs(); setupListeners(); updateUndoRedoButtons(); setupAutoActivateToggles(); populateCSRDropdowns();
        initBillboardHeightSync();
        // Suppress browser autocomplete on all quick-pick inputs
        document.querySelectorAll('.quick-pick-wrapper input, .quick-pick-wrapper textarea').forEach(el => el.setAttribute('autocomplete', 'off'));
        // Skip dropdown arrow buttons in tab order — users tab field-to-field only
        document.querySelectorAll('.quick-pick-btn').forEach(el => el.setAttribute('tabindex', '-1'));

        // Tab key skips toggle switches — land in text inputs and dropdowns only
        document.querySelectorAll('.toggle-switch input[type="checkbox"]').forEach(el => el.tabIndex = -1);
        document.querySelectorAll('.group-check').forEach(el => el.tabIndex = -1);

        // Restore last active job if session is still fresh (under 30 min)
        const lastJobId = localStorage.getItem('prepressActiveJob');
        const lastActiveTime = parseInt(localStorage.getItem('prepressActiveJobTime') || '0', 10);
        const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
        const sessionFresh = (Date.now() - lastActiveTime) < SESSION_TIMEOUT;
        if (lastJobId && sessionFresh && getActiveJobs().some(j => j.id === lastJobId)) {
            loadJob(lastJobId);
        } else {
            showNoJobState();
        }
    });

    // Close current job (add timestamp) when browser/tab is closed
    window.addEventListener('beforeunload', () => {
        if (currentJobId) localStorage.setItem('prepressActiveJobTime', Date.now().toString());
        stopLockHeartbeat();
        if (currentJobId) releaseJobLock(currentJobId);
        closeCurrentJob();
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
                // Clear non-file-path note when individual toggle is turned off
                if (!e.target.checked && e.target.closest('.field-row')) {
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

        // Render recent jobs, archive, and templates on landing page
        renderRecentJobs(jobs);
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

    let recentJobsExpanded = false;

    function toggleRecentExpanded() {
        recentJobsExpanded = !recentJobsExpanded;
        applyLandingFilters();
    }

    function renderRecentJobs(jobs, showAll) {
        const container = document.getElementById('recentJobs');
        if (!container) return;
        if (jobs.length === 0) {
            container.innerHTML = showAll ? '<div class="no-jobs-message">No matching jobs</div>' : '';
            return;
        }
        const PAGE = 9;
        const MAX_SHOWN = 18;
        const expanded = showAll || recentJobsExpanded;
        const showCount = expanded ? Math.min(jobs.length, MAX_SHOWN) : PAGE;
        const recent = jobs.slice(0, showCount);
        const remaining = jobs.length - showCount;
        const jobButtons = recent.map(j => {
            const desc = j.jobDescription ? ` - ${j.jobDescription}` : '';
            const label = `${j.jobNumber} - ${j.clientName}${desc}`;
            const reqStatus = getRequiredStatusForJob(j);
            const dotClass = reqStatus.allComplete ? 'dot-complete' : 'dot-incomplete';
            return `<div class="recent-job-row"><button class="recent-job-btn" onclick="loadJob('${j.id}')" title="${escHtml(label)}"><span class="recent-job-dot ${dotClass}"></span>${escHtml(label)}</button><button class="recent-job-delete" onclick="deleteSingleJob('${j.id}')" title="Delete">&times;</button></div>`;
        }).join('');
        let footer = '';
        if (!expanded && jobs.length > PAGE) {
            footer = '<button class="recent-jobs-more" onclick="toggleRecentExpanded()">+' + (jobs.length - PAGE) + ' more</button>';
        } else if (expanded && remaining > 0) {
            footer = '<button class="recent-jobs-more" onclick="toggleRecentExpanded()">Show less</button>' +
                '<span class="recent-jobs-more" style="cursor:default;color:var(--ink-muted);margin-left:8px;">+' + remaining + ' more in Browse Work Orders</span>';
        } else if (expanded && jobs.length > PAGE) {
            footer = '<button class="recent-jobs-more" onclick="toggleRecentExpanded()">Show less</button>';
        }
        container.innerHTML =
            '<div class="recent-jobs-label"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:8px;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="2" y1="10" x2="22" y2="10"/></svg>Recent</div>' +
            '<div class="recent-jobs-list">' + jobButtons + '</div>' +
            footer;
    }

    // ========== JOB SEARCH (landing page) ==========
    (function() {
        const input = document.getElementById('jobSearchInput');
        const results = document.getElementById('jobSearchResults');
        if (!input || !results) return;

        let highlightedIndex = -1;

        input.addEventListener('input', () => {
            const q = input.value.trim().toLowerCase();
            if (!q) {
                results.classList.remove('open');
                results.innerHTML = '';
                highlightedIndex = -1;
                return;
            }

            const jobs = getActiveJobs();
            const matches = jobs.filter(j => {
                const searchable = `${j.jobNumber} ${j.clientName} ${j.jobDescription || ''}`.toLowerCase();
                return searchable.includes(q);
            }).slice(0, 8);

            if (matches.length === 0) {
                results.innerHTML = '<div class="job-search-no-results">No matching jobs</div>';
                results.classList.add('open');
                highlightedIndex = -1;
                return;
            }

            results.innerHTML = matches.map((j, i) => {
                const desc = j.jobDescription ? ` - ${j.jobDescription}` : '';
                const label = `${j.jobNumber} - ${j.clientName}${desc}`;
                return `<div class="job-search-result${i === 0 ? ' highlighted' : ''}" data-job-id="${j.id}">${escHtml(label)}</div>`;
            }).join('');
            highlightedIndex = 0;

            results.querySelectorAll('.job-search-result').forEach(el => {
                el.addEventListener('click', () => {
                    input.value = '';
                    results.classList.remove('open');
                    results.innerHTML = '';
                    loadJob(el.dataset.jobId);
                });
            });

            results.classList.add('open');
        });

        input.addEventListener('keydown', e => {
            const items = results.querySelectorAll('.job-search-result');
            if (!items.length) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (highlightedIndex < items.length - 1) {
                    items.forEach(el => el.classList.remove('highlighted'));
                    highlightedIndex++;
                    items[highlightedIndex].classList.add('highlighted');
                    items[highlightedIndex].scrollIntoView({ block: 'nearest' });
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (highlightedIndex > 0) {
                    items.forEach(el => el.classList.remove('highlighted'));
                    highlightedIndex--;
                    items[highlightedIndex].classList.add('highlighted');
                    items[highlightedIndex].scrollIntoView({ block: 'nearest' });
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const highlighted = results.querySelector('.job-search-result.highlighted');
                if (highlighted) {
                    input.value = '';
                    results.classList.remove('open');
                    results.innerHTML = '';
                    loadJob(highlighted.dataset.jobId);
                }
            } else if (e.key === 'Escape') {
                results.classList.remove('open');
                results.innerHTML = '';
                highlightedIndex = -1;
            }
        });

        // Close results when clicking outside
        document.addEventListener('click', e => {
            if (!e.target.closest('.job-search-wrapper')) {
                results.classList.remove('open');
                highlightedIndex = -1;
            }
        });
    })();

    function getActiveJobs() {
        if (jobsCache) return jobsCache;
        try {
            const j = localStorage.getItem('prepressJobs');
            jobsCache = j ? JSON.parse(j) : [];
        } catch (e) {
            console.error('Failed to parse prepressJobs from localStorage:', e);
            jobsCache = [];
        }
        return jobsCache;
    }

    function saveActiveJobs(jobs) {
        jobsCache = jobs;
        localStorage.setItem('prepressJobs', JSON.stringify(jobs));
        const archive = JSON.parse(localStorage.getItem('prepressJobsArchive') || '[]');
        backupToIDB(jobs, archive);
    }

    function invalidateJobsCache() {
        jobsCache = null;
    }

    function openNewJobModal() {
        if (getActiveJobs().length >= MAX_ACTIVE_JOBS) {
            alert(`Max ${MAX_ACTIVE_JOBS} active jobs. Please archive or delete one first.`);
            return;
        }
        populateComponentsSelect();
        populateAssigneeSelect('newAssignedToPrepress', 'prepress');
        populateAssigneeSelect('newAssignedToTechservices', 'techservices');
        document.getElementById('newJobModal').style.display = 'block';
    }

    // Populate an <select> with a department's assignee roster.
    // Preserves the leading "Unassigned" option, optionally sets a current value.
    function populateAssigneeSelect(selectId, deptId, currentValue) {
        const sel = document.getElementById(selectId);
        if (!sel) return;
        const dept = window.DEPT_REGISTRY[deptId];
        const roster = (dept && dept.ASSIGNEE_OPTIONS) || [];
        sel.innerHTML = '<option value="">Unassigned</option>';
        roster.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
        });
        sel.value = currentValue || '';
    }

    function closeNewJobModal() {
        document.getElementById('newJobModal').style.display = 'none';
        document.getElementById('newJobForm').reset();
        // Clear component selections
        document.querySelectorAll('#componentsSelect .component-option').forEach(opt => {
            opt.classList.remove('selected');
            const cb = opt.querySelector('input[type="checkbox"]');
            if (cb) cb.checked = false;
        });
    }

    function createNewJob() {
        const jobs = getActiveJobs();
        const num = document.getElementById('jobNumber').value.trim();
        if (!num) { alert('Job number is required.'); return; }
        if (jobs.some(j => j.jobNumber.trim() === num)) { alert('Job number exists!'); return; }

        const now = new Date().toISOString();
        const selectedComponents = getSelectedComponents();

        // Create components array - use selected or default to "Main"
        const components = [];
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
            dateCreated: now,
            createdBy: getUserName(),
            lastModified: now,
            lastModifiedBy: getUserName(),
            components: components,
            activeComponentId: components[0].id
        };

        jobs.push(newJob);
        saveActiveJobs(jobs);
        closeNewJobModal();
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

    async function deleteSingleJob(jobId) {
        if (!(await verifyAdminPassword())) return;
        if (!confirm('Permanently delete this job?')) return;

        let jobs = getActiveJobs();
        const idx = jobs.findIndex(j => j.id === jobId);
        if (idx > -1) {
            jobs.splice(idx, 1);
            saveActiveJobs(jobs);

            if (currentJobId === jobId) {
                currentJobId = null;
                showNoJobState();
            }

            loadJobs();

            if (jobs.length === 0) {
                closeJobDropdown();
            }
        }
    }

    async function deleteSelectedJobs() {
        const checkboxes = document.querySelectorAll('#jobListContainer .job-checkbox:checked');
        if (checkboxes.length === 0) {
            alert('No jobs selected!');
            return;
        }

        if (!(await verifyAdminPassword())) return;
        if (!confirm(`Delete ${checkboxes.length} selected job(s)?`)) return;

        const idsToDelete = Array.from(checkboxes).map(cb => cb.getAttribute('data-job-id'));
        let jobs = getActiveJobs();

        // Check if currently loaded job is being deleted
        if (currentJobId && idsToDelete.includes(currentJobId)) {
            currentJobId = null;
            showNoJobState();
        }

        jobs = jobs.filter(j => !idsToDelete.includes(j.id));
        saveActiveJobs(jobs);
        loadJobs();

        if (jobs.length === 0) {
            closeJobDropdown();
        }
    }

    function closeCurrentJob() {
        if (!currentJobId) return;
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
        const DEPTS = ['prepress', 'techservices'];
        job.components.forEach(comp => {
            // Safety: ensure dept-keyed fields exist
            migrateInstructionsToPerDept(comp);

            DEPTS.forEach(deptId => {
                const instrKey = 'instructions_' + deptId;
                const histKey = 'instructionsHistory_' + deptId;

                let instructionsToSave;
                if (comp.id === currentComponentId && deptId === activeDepartment) {
                    // Active component + active tab: take from the live editor
                    instructionsToSave = quill.getText().trim() ? quill.root.innerHTML : '';
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
            });
        });

        // Update UI if we're still viewing this job
        if (currentComponentId) {
            const currentComp = job.components.find(c => c.id === currentComponentId);
            if (currentComp) {
                const history = currentComp['instructionsHistory_' + activeDepartment] || '';
                document.getElementById('instructionsHistory').innerHTML = history;
                document.getElementById('instructionsDisplay').innerHTML = history;
                quill.setContents([]);
            }
        }

        saveActiveJobs(jobs);
    }

    // ========== JOB LOCKING (server scaffolding — no-op until internal server) ==========
    let lockHeartbeatTimer = null;
    const LOCK_HEARTBEAT_MS = 30000; // 30 seconds

    // Attempt to acquire lock. Returns { locked, lockedBy } or null (no server).
    async function checkJobLock(jobId) {
        try {
            const userName = getUserName() || 'Anonymous';
            const res = await fetch('/api/jobs/' + jobId + '/lock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: userName })
            });
            if (!res.ok) return null;
            return await res.json();
        } catch { return null; } // no server = no lock
    }

    async function releaseJobLock(jobId) {
        if (!jobId) return;
        try {
            const userName = getUserName() || 'Anonymous';
            fetch('/api/jobs/' + jobId + '/lock', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: userName }),
                keepalive: true // ensures request completes even on tab close
            });
        } catch { /* no server */ }
    }

    function startLockHeartbeat(jobId) {
        stopLockHeartbeat();
        lockHeartbeatTimer = setInterval(() => {
            const userName = getUserName() || 'Anonymous';
            fetch('/api/jobs/' + jobId + '/lock', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: userName })
            }).catch(() => {});
        }, LOCK_HEARTBEAT_MS);
    }

    function stopLockHeartbeat() {
        if (lockHeartbeatTimer) {
            clearInterval(lockHeartbeatTimer);
            lockHeartbeatTimer = null;
        }
    }

    function showLockBanner(lockedByName) {
        const banner = document.getElementById('lockBanner');
        const userEl = document.getElementById('lockBannerUser');
        if (banner && userEl) {
            userEl.textContent = lockedByName || 'Someone';
            banner.style.display = 'flex';
        }
    }

    function hideLockBanner() {
        const banner = document.getElementById('lockBanner');
        if (banner) banner.style.display = 'none';
    }

    function dismissLockBanner() {
        hideLockBanner();
        setReadOnly(false);
    }

    function setReadOnly(enabled) {
        const badge = document.getElementById('readonlyBadge');
        if (enabled) {
            document.body.classList.add('read-only');
            if (badge) badge.style.display = '';
            quill.disable();
            hideLockBanner();
        } else {
            document.body.classList.remove('read-only');
            if (badge) badge.style.display = 'none';
            quill.enable();
        }
    }

    // Non-blocking lock check — runs after loadJob() renders
    async function checkAndShowLockStatus(jobId) {
        const result = await checkJobLock(jobId);
        if (!result) return; // no server — proceed without locking
        if (result.locked) {
            showLockBanner(result.lockedBy);
        } else {
            hideLockBanner();
            setReadOnly(false);
            startLockHeartbeat(jobId);
        }
    }
    // ========== END JOB LOCKING ==========

    function loadJob(jobId) {
        // Close the previous job first (adds timestamp)
        if (currentJobId && currentJobId !== jobId) {
            closeCurrentJob();
        }

        let jobs = getActiveJobs();
        let job = jobs.find(j => j.id === jobId);
        if (!job) return;

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
        focusSnapshot = null;
        fieldDirty = false;
        updateUndoRedoButtons();

        currentJobId = jobId;
        currentComponentId = job.activeComponentId || job.components[0].id;
        localStorage.setItem('prepressActiveJob', jobId);
        localStorage.setItem('prepressActiveJobTime', Date.now().toString());

        // Stamp access time so recent list reorders on open
        job.lastAccessed = new Date().toISOString();
        saveActiveJobs(jobs);

        updatePrintHeader(job);

        document.getElementById('noJobState').style.display = 'none';
        document.getElementById('printHeader').style.display = 'block';
        document.getElementById('sopContent').style.display = 'block';
        document.getElementById('masterCheckbox').disabled = false;
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

        // Check for lock (non-blocking — no-op if server unavailable)
        hideLockBanner();
        setReadOnly(false);
        checkAndShowLockStatus(jobId);
    }

    function debouncedSaveJobState() {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = setTimeout(() => saveJobState(), 400);
    }

    function saveJobState() {
        clearTimeout(saveDebounceTimer);
        if (!currentJobId || !currentComponentId) return;

        // Clear active-dept redo stack when actual changes are saved (not during undo/redo)
        if (!isUndoRedo && getActiveRedoStack().length > 0) {
            redoStacks[activeDepartment] = [];
            updateUndoRedoButtons();
        }

        const { job, comp } = saveComponentState();
        if (!job || !comp) return;

        // UI updates beyond the data write (active dept only)
        const instructions = comp['instructions_' + activeDepartment] || '';
        const history = comp['instructionsHistory_' + activeDepartment] || '';
        const fullInstructions = instructions + (instructions && history ? '<br><br>' : '') + history;
        document.getElementById('instructionsDisplay').innerHTML = fullInstructions;

        updatePrintHeader(job);
        updateRowVisibility();
        updateCompletion();
        updateRequiredIndicators();
        updateRequiredBadge();
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

    function resetChecklist() {
        if (!currentJobId || !currentComponentId || !confirm('Reset all checkboxes for this component? Notes will be preserved.')) return;
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components) return;

        const comp = job.components.find(c => c.id === currentComponentId);
        if (comp) {
            comp.checkboxes = {};
            job.lastModified = new Date().toISOString();
            job.lastModifiedBy = getUserName();
            saveActiveJobs(jobs);
            loadComponentData();
        }
    }

    function archiveJob() {
        if (!currentJobId || !confirm('Archive this job?')) return;
        closeCurrentJob(); // Add timestamp before archiving
        const active = getActiveJobs();
        const archive = JSON.parse(localStorage.getItem('prepressJobsArchive') || '[]');
        const idx = active.findIndex(j => j.id === currentJobId);
        if (idx > -1) {
            const job = active.splice(idx, 1)[0];
            job.archivedDate = new Date().toISOString();
            archive.push(job);
            saveActiveJobs(active);
            localStorage.setItem('prepressJobsArchive', JSON.stringify(archive));
            backupToIDB(active, archive);
            currentJobId = null;
            loadJobs();
            showNoJobState();
        }
    }

    // ========== ARCHIVE BROWSER ==========

    let archivedJobsExpanded = false;

    function toggleArchivedExpanded() {
        archivedJobsExpanded = !archivedJobsExpanded;
        renderArchivedJobs();
    }

    function renderArchivedJobs() {
        const container = document.getElementById('archivedJobs');
        if (!container) return;
        const archive = JSON.parse(localStorage.getItem('prepressJobsArchive') || '[]');
        if (archive.length === 0) {
            container.innerHTML = '';
            return;
        }
        archive.sort((a, b) => new Date(b.archivedDate || b.lastModified || 0) - new Date(a.archivedDate || a.lastModified || 0));

        const PAGE = 6;
        const showCount = archivedJobsExpanded ? archive.length : Math.min(archive.length, PAGE);
        const visible = archive.slice(0, showCount);

        const items = visible.map(j => {
            const desc = j.jobDescription ? ` - ${j.jobDescription}` : '';
            const label = `${j.jobNumber} - ${j.clientName}${desc}`;
            const archivedDate = j.archivedDate ? new Date(j.archivedDate).toLocaleDateString() : '';
            return `<div class="archived-job-item" title="Archived ${archivedDate}">
                <span class="archived-job-text">${escHtml(label)}</span>
                <button class="archived-job-btn" onclick="unarchiveJob('${j.id}')">Restore</button>
                <button class="archived-job-btn btn-archive-delete" onclick="deleteArchivedJob('${j.id}')" title="Delete permanently">&times;</button>
            </div>`;
        }).join('');

        let footer = '';
        const remaining = archive.length - showCount;
        if (!archivedJobsExpanded && archive.length > PAGE) {
            footer = '<button class="archived-jobs-more" onclick="toggleArchivedExpanded()">+' + (archive.length - PAGE) + ' more</button>';
        } else if (archivedJobsExpanded && archive.length > PAGE) {
            footer = '<button class="archived-jobs-more" onclick="toggleArchivedExpanded()">Show less</button>';
        }

        container.innerHTML =
            '<div class="archived-jobs-label"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:6px;"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>Archived (' + archive.length + ')</div>' +
            '<div class="archived-jobs-list">' + items + '</div>' +
            footer;
    }

    function unarchiveJob(jobId) {
        const archive = JSON.parse(localStorage.getItem('prepressJobsArchive') || '[]');
        const idx = archive.findIndex(j => j.id === jobId);
        if (idx === -1) return;
        const active = getActiveJobs();
        if (active.length >= MAX_ACTIVE_JOBS) {
            alert('Max ' + MAX_ACTIVE_JOBS + ' active jobs. Archive or delete one first.');
            return;
        }
        const job = archive.splice(idx, 1)[0];
        delete job.archivedDate;
        active.push(job);
        // Update archive first so saveActiveJobs' internal backup sees the correct archive
        localStorage.setItem('prepressJobsArchive', JSON.stringify(archive));
        jobsCache = null;
        saveActiveJobs(active);
        loadJobs();
        showNoJobState();
    }

    async function deleteArchivedJob(jobId) {
        if (!(await verifyAdminPassword())) return;
        if (!confirm('Permanently delete this archived job?')) return;
        const archive = JSON.parse(localStorage.getItem('prepressJobsArchive') || '[]');
        const idx = archive.findIndex(j => j.id === jobId);
        if (idx === -1) return;
        archive.splice(idx, 1);
        localStorage.setItem('prepressJobsArchive', JSON.stringify(archive));
        const active = getActiveJobs();
        backupToIDB(active, archive);
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
            notes: { ...comp.notes },
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
        const items = templates.map(t => {
            const date = t.createdDate ? new Date(t.createdDate).toLocaleDateString() : '';
            return '<div class="template-item" title="' + escHtml(t.componentName) + ' - Created ' + date + '">' +
                '<span class="template-item-text">' + escHtml(t.name) + '</span>' +
                '<button class="template-item-btn" onclick="deleteTemplate(\'' + t.id + '\')" title="Delete template">&times;</button>' +
                '</div>';
        }).join('');
        container.innerHTML =
            '<div class="templates-col-label"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:6px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>Templates (' + templates.length + ')</div>' +
            '<div class="templates-list">' + items + '</div>';
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
        comp.notes = { ...tpl.notes };
    }

    // ========== ADMIN PASSWORD ==========
    // Simple obfuscation (btoa) — not cryptographic, just prevents casual reading in localStorage.
    // This is a guard against accidental deletion, not a security system.
    const ADMIN_HASH = 'd6a9066ff92289a82ff3dc163f9476aafadebb336c770278d871b8d8d9848727';

    async function sha256(str) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    let _adminPwResolve = null;

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
        const hash = await sha256(pw);
        if (hash !== ADMIN_HASH) {
            document.getElementById('adminPwError').style.display = '';
            input.select();
            return;
        }
        document.getElementById('adminPasswordModal').style.display = 'none';
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
        if (!currentJobId) return;
        if (!(await verifyAdminPassword())) return;
        if (!confirm('Permanently delete this job?')) return;
        const jobs = getActiveJobs();
        const idx = jobs.findIndex(j => j.id === currentJobId);
        if (idx > -1) {
            jobs.splice(idx, 1);
            saveActiveJobs(jobs);
            currentJobId = null;
            loadJobs();
            showNoJobState();
        }
    }

    function showNoJobState() {
        // Release lock on current job before navigating away
        stopLockHeartbeat();
        if (currentJobId) releaseJobLock(currentJobId);
        hideLockBanner();
        setReadOnly(false);

        localStorage.removeItem('prepressActiveJob');
        localStorage.removeItem('prepressActiveJobTime');
        document.getElementById('noJobState').style.display = 'grid';
        document.getElementById('printHeader').style.display = 'none';
        document.getElementById('sopContent').style.display = 'none';
        document.getElementById('masterCheckbox').disabled = true;
        document.getElementById('masterCheckbox').checked = false;
        const searchEl = document.getElementById('searchInput');
        searchEl.disabled = true;
        searchEl.value = '';
        updateLandingGreeting();
        renderArchivedJobs();
        renderTemplatesCol();
        // Refresh the dropdown list without calling loadJobs (which would recurse back here)
        const jobs = getActiveJobs();
        jobs.sort((a, b) => new Date(b.lastAccessed || b.lastModified || b.dateCreated) - new Date(a.lastAccessed || a.lastModified || a.dateCreated));
        renderRecentJobs(jobs);
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
        if (currentJobId) saveComponentState();

        activeDepartment = deptId;

        // Toggle tab active state
        document.querySelectorAll('.dept-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.dept === deptId);
        });

        // Toggle checklist panel visibility
        const dept = window.DEPT_REGISTRY[deptId];
        document.querySelectorAll('.dept-checklist').forEach(panel => {
            panel.classList.toggle('active', panel.id === dept.panelId);
        });

        // Persist active department on the job
        if (currentJobId) {
            const jobs = getActiveJobs();
            const job = jobs.find(j => j.id === currentJobId);
            if (job) {
                job.activeDepartment = deptId;
                saveActiveJobs(jobs);
            }
        }

        // Swap editor content to the incoming dept's instructions + history.
        // Quill paste uses source 'api' so text-change listeners treat it as
        // programmatic, not a user edit.
        if (currentJobId) {
            const comp = getCurrentComponent();
            if (comp) {
                migrateInstructionsToPerDept(comp);
                const instr = comp['instructions_' + deptId] || '';
                const hist = comp['instructionsHistory_' + deptId] || '';
                // Old plain-text compatibility (same logic as loadComponentData)
                const htmlToLoad = (instr && !instr.includes('<'))
                    ? instr.replace(/\n/g, '<br>')
                    : instr;
                if (htmlToLoad) {
                    quill.clipboard.dangerouslyPasteHTML(htmlToLoad);
                } else {
                    quill.setContents([]);
                }
                document.getElementById('instructionsHistory').innerHTML = hist;
                const fullInstructions = instr + (instr && hist ? '<br><br>' : '') + hist;
                document.getElementById('instructionsDisplay').innerHTML = fullInstructions;
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
        updateRequiredBadge();
        updateRowVisibility();
        updateMasterCheckbox();
        updateGroupCheckboxes();

        // Refresh undo/redo button enabled-state against the incoming dept's stacks
        updateUndoRedoButtons();

        // Refresh billboard assignee (dept-aware)
        if (currentJobId) {
            const jobs2 = getActiveJobs();
            const job2 = jobs2.find(j => j.id === currentJobId);
            if (job2) updatePrintHeader(job2);
        }
    }

    // Update dropdowns using the active department's registry
    function updateDeptDropdowns() {
        const dept = window.DEPT_REGISTRY[activeDepartment];
        if (!dept || !dept.updateDropdowns) return;
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components) return;
        const comp = job.components.find(c => c.id === currentComponentId);
        if (!comp) return;
        dept.updateDropdowns(comp);
    }

    // Get required fields from active department's registry
    function getDeptRequiredFields() {
        const dept = window.DEPT_REGISTRY[activeDepartment];
        if (!dept) return [];
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        const comp = job && job.components ? job.components.find(c => c.id === currentComponentId) : null;
        return dept.getRequiredFields(comp);
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

        // Disable Indicia row for non-envelope components (Prepress only)
        const jobs_rv = getActiveJobs();
        const job_rv = jobs_rv.find(j => j.id === currentJobId);
        const comp_rv = job_rv && job_rv.components ? job_rv.components.find(c => c.id === currentComponentId) : null;
        const indiciaInput = document.querySelector('[data-id="sp7n"]');
        if (indiciaInput) {
            const indiciaRow = indiciaInput.closest('.field-row');
            const indiciaCheckbox = indiciaRow ? indiciaRow.querySelector('.toggle-switch input[type="checkbox"]') : null;
            const indiciaBtn = indiciaRow ? indiciaRow.querySelector('.quick-pick-btn') : null;
            const dept = window.DEPT_REGISTRY.prepress;
            const isEnv = comp_rv && dept && dept.isEnvelopeComponent(comp_rv.name);
            indiciaInput.disabled = !isEnv;
            if (indiciaCheckbox) indiciaCheckbox.disabled = !isEnv;
            if (indiciaBtn) indiciaBtn.disabled = !isEnv;
            if (indiciaRow) indiciaRow.classList.toggle('indicia-disabled', !isEnv);
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
    function buildPrintHTML(job, comp, deptId) {
        const resolvedDeptId = deptId || activeDepartment;
        const dept = window.DEPT_REGISTRY[resolvedDeptId] || window.DEPT_REGISTRY.prepress;
        const accentColor = dept.printAccent || '#CB333B';
        const printTitle = dept.printHeading || 'Instructions';
        const instrLabel = dept.sidebarTitle || 'Instructions';
        const printSections = dept.PRINT_SECTIONS || PRINT_SECTIONS;

        const formatDate = (d) => new Date(d).toLocaleDateString('en-US', {month:'2-digit',day:'2-digit',year:'numeric'});
        const formatDateTime = (d) => new Date(d).toLocaleString('en-US', {month:'2-digit',day:'2-digit',year:'numeric', hour:'numeric', minute:'2-digit', hour12:true});

        // Build sections from saved data (not from the live DOM)
        const checks = comp.checkboxes || {};
        const notes = comp.notes || {};
        const sections = [];
        printSections.forEach(section => {
            const rows = [];
            section.fields.forEach(f => {
                const checked = !!checks[f.cbId];
                const val = (notes[f.noteId] || '').trim();
                // Filepath rows: only print when toggled on (text alone is not enough)
                const isFilepath = f.cbId.startsWith('fp') || f.cbId.startsWith('ts_fp');
                if (isFilepath ? checked : (checked || val)) {
                    rows.push({ label: f.label, val, checked });
                }
            });
            if (rows.length > 0) sections.push({ title: section.title, rows });
        });

        // Build instructions HTML from saved data (strip summary marker lines from print).
        // Collect every registered dept's marker strings so we strip them all — that way
        // a TS component's "── TS Summary ──" lines vanish on print just as cleanly as
        // a prepress component's "── Specs ──" lines, with no per-dept branching here.
        function stripSpecsMarkers(html) {
            const div = document.createElement('div');
            div.innerHTML = html;
            const allMarkers = [];
            Object.values(window.DEPT_REGISTRY || {}).forEach(d => {
                if (d.summaryMarkerStart) allMarkers.push(d.summaryMarkerStart);
                if (d.summaryMarkerEnd)   allMarkers.push(d.summaryMarkerEnd);
            });
            const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
            const toRemove = [];
            while (walker.nextNode()) {
                const text = walker.currentNode.textContent;
                if (allMarkers.some(m => text.includes(m))) {
                    // Remove the closest block-level parent (<p>) or the text node's parent
                    let el = walker.currentNode.parentElement;
                    while (el && el !== div && el.tagName !== 'P') el = el.parentElement;
                    if (el && el !== div) toRemove.push(el);
                }
            }
            toRemove.forEach(el => el.remove());
            return div.innerHTML;
        }
        const instrHTML = stripSpecsMarkers(comp['instructions_' + resolvedDeptId] || '');
        const historyHTML = comp['instructionsHistory_' + resolvedDeptId] || '';
        const hasInstructions = instrHTML.replace(/<[^>]*>/g, '').trim();
        const hasHistory = historyHTML.replace(/<[^>]*>/g, '').trim();

        // Collect selected revisions from the timeline toggles
        let selectedRevisionsHTML = '';
        const timelineEl = document.getElementById('revisionTimeline');
        if (timelineEl) {
            const historyEl = document.getElementById('instructionsHistory');
            const allTimestamps = historyEl ? Array.from(historyEl.querySelectorAll('.history-timestamp')) : [];
            const selectedBtns = timelineEl.querySelectorAll('.revision-segment.rev-print-on');
            selectedBtns.forEach(btn => {
                const revIdx = parseInt(btn.dataset.rev, 10);
                const ts = allTimestamps[revIdx];
                if (!ts) return;
                const content = ts.nextElementSibling;
                selectedRevisionsHTML +=
                    '<div style="border-top:1px solid #ddd;padding-top:6px;margin-top:8px;">' +
                    '<div style="font-size:10px;font-weight:700;color:#6b6b80;margin-bottom:4px;">R' + btn.dataset.revNum + ' - ' + escHtml(ts.textContent) + '</div>' +
                    '<div class="instr-body" style="font-size:10px;line-height:1.5;">' + (content ? content.innerHTML : '') + '</div>' +
                    '</div>';
            });
        }

        let instrSection = '';
        if (hasInstructions || selectedRevisionsHTML) {
            instrSection = `
            <div style="margin-bottom:16px;padding:12px 16px;border:1px solid #ccc;border-radius:6px;">
                <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${accentColor};padding-bottom:3px;margin-bottom:6px;border-bottom:2px solid ${accentColor};">${escHtml(instrLabel)}</div>
                ${hasInstructions ? '<div class="instr-body" style="font-size:11px;line-height:1.6;margin-bottom:8px;">' + instrHTML + '</div>' : ''}
                ${selectedRevisionsHTML}
            </div>`;
        }

        // Build sections HTML
        let sectionsHTML = '';
        sections.forEach(s => {
            let rowsHTML = '';
            s.rows.forEach(r => {
                const check = r.checked ? '\u2611' : '\u2610';
                const checkColor = r.checked ? accentColor : '#999';
                const valDisplay = r.val ? `<div style="margin-left:22px;margin-top:1px;padding:3px 6px;border:1px solid #ddd;border-radius:3px;font-size:10px;white-space:pre-wrap;word-break:break-word;">${escHtml(r.val).replace(/\n/g,'<br>')}</div>` : '';
                rowsHTML += `<div style="margin-bottom:4px;page-break-inside:avoid;">
                    <span style="color:${checkColor};font-size:13px;margin-right:5px;">${check}</span>
                    <span style="font-weight:700;font-size:11px;">${escHtml(r.label)}</span>
                    ${valDisplay}
                </div>`;
            });
            sectionsHTML += `<div style="break-inside:avoid-column;margin-bottom:12px;">
                <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${accentColor};padding-bottom:3px;margin-bottom:6px;border-bottom:2px solid ${accentColor};">${escHtml(s.title)}</div>
                ${rowsHTML}
            </div>`;
        });

        // Always emit a row-2 col-1 cell so Signoff due lands in col 3 (beneath CSR) regardless
        // of whether the job has a Project description. Empty placeholder when no Project.
        const projectRow = job.jobDescription ? `
            <td style="padding:0 14px 8px 0;">
                <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6b6b80;">Project</div>
                <div style="font-size:18px;font-weight:700;color:#1a1a2e;">${escHtml(job.jobDescription)}</div>
            </td>` : `<td style="padding:0 14px 8px 0;"></td>`;

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
        const signoffRow = pfSignoffStr ? `
            <td style="padding:0 14px 8px 0;">
                <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6b6b80;">Signoff due</div>
                <div style="font-size:18px;font-weight:700;color:#1a1a2e;">${escHtml(pfSignoffStr)}</div>
            </td>` : '';

        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>${escHtml(job.jobNumber)} - ${escHtml(sanitizeForFilename(comp.name))}</title>
<style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: Arial, Helvetica, sans-serif; font-size:11px; color:#1a1a2e; padding:0; }
    @page { margin: 0.5in 0.4in; }
    ul, ol { padding-left:20px; margin:4px 0; list-style:disc; }
    ol li, ul li { margin-bottom:2px; }
    .instr-body, .instr-body * { color:#000 !important; }
    mark { background:#fef3a0; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    b, strong { font-weight:700; }
</style>
</head><body>

<div style="padding:6px 12px;border-radius:6px;background:${accentColor};color:white;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:12px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
    ${escHtml(printTitle)}
</div>

<table style="width:100%;border-collapse:collapse;margin-bottom:4px;">
<tr>
    <td style="padding:0 14px 8px 0;">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6b6b80;">Job #</div>
        <div style="font-size:18px;font-weight:700;color:${accentColor};">${escHtml(job.jobNumber)}</div>
    </td>
    <td style="padding:0 14px 8px 0;">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6b6b80;">Client</div>
        <div style="font-size:18px;font-weight:700;color:#1a1a2e;">${escHtml(job.clientName)}</div>
    </td>
    <td style="padding:0 14px 8px 0;">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6b6b80;">CSR</div>
        <div style="font-size:18px;font-weight:700;color:#1a1a2e;">${escHtml(job.csrName)}</div>
    </td>
</tr>
<tr>
    ${projectRow}
    <td style="padding:0 14px 8px 0;">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6b6b80;">Component</div>
        <div style="font-size:18px;font-weight:700;color:#1a1a2e;">${escHtml(comp.name)}</div>
    </td>
    ${signoffRow}
    ${comp.version ? `<td style="padding:0 14px 8px 0;">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6b6b80;">Version</div>
        <div style="font-size:18px;font-weight:700;color:${accentColor};">${escHtml(comp.version)}</div>
    </td>` : ''}
</tr>
</table>
<div style="font-size:11px;color:#6b6b80;margin-bottom:14px;padding-top:4px;border-top:2px solid #1a1a2e;">
    Created: <span style="color:#3d3d56;font-weight:500;">${formatDateTime(job.dateCreated)}${job.createdBy ? ' by ' + escHtml(job.createdBy) : ''}</span>
    &nbsp;&middot;&nbsp;
    Modified: <span style="color:#3d3d56;font-weight:500;">${formatDateTime(job.lastModified)}${job.lastModifiedBy ? ' by ' + escHtml(job.lastModifiedBy) : ''}</span>
    ${job.headerModified ? '&nbsp;&middot;&nbsp; Header edited: <span style="color:#3d3d56;font-weight:500;">' + formatDateTime(job.headerModified) + (job.headerModifiedBy ? ' by ' + escHtml(job.headerModifiedBy) : '') + '</span>' : ''}
    ${job.duplicatedFrom ? '&nbsp;&middot;&nbsp; Duplicated from: <span style="color:' + accentColor + ';font-weight:600;">#' + escHtml(job.duplicatedFrom) + '</span>' : ''}
    &nbsp;&middot;&nbsp; Printed: <span style="color:#3d3d56;font-weight:500;">${formatDateTime(new Date().toISOString())}</span>
</div>

${instrSection}

<div style="column-count:2;column-gap:20px;">
${sectionsHTML}
</div>

</body></html>`;
    }

    function printViaIframe(html, pdfName, onDone) {
        let iframe = document.getElementById('printFrame');
        if (iframe) iframe.remove();
        iframe = document.createElement('iframe');
        iframe.id = 'printFrame';
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

    async function printChecklist() {
        if (!currentJobId) {
            alert('No job selected to print!');
            return;
        }
        document.getElementById('printDropdown').classList.remove('open');
        saveJobState();
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        const comp = job?.components?.find(c => c.id === currentComponentId);
        if (!job || !comp) return;

        // Warn if required fields are missing (override-able)
        const status = getRequiredStatus();
        if (status.missing.length > 0) {
            const nameSpan = '<span class="qc-comp-name">' + escHtml(comp.name) + '</span>';
            const proceed = await showWarningModal('Required fields missing for ' + nameSpan, status.missing, { type: 'required' });
            if (!proceed) return;
        }

        // QC: catch physically impossible spec combinations before printing.
        // Dept-scoped via the registry so TS-only jobs use TS rules (currently []).
        const _activeDeptForPrint = window.DEPT_REGISTRY[activeDepartment] || {};
        const _validateFn = _activeDeptForPrint.validateSummary || function () { return []; };
        const qcWarnings = _validateFn(comp);
        if (qcWarnings.length > 0) {
            const proceed = await showQcWarning(comp.name, qcWarnings);
            if (!proceed) return;
        }

        // Check if a summary block exists but is stale (fields changed since last
        // generate). Dept-scoped: each dept has its own marker string and its own
        // fingerprint field on `comp`, so prepress staleness and TS staleness do
        // not cross-trigger.
        const _markerStart = _activeDeptForPrint.summaryMarkerStart;
        const _fpField     = _activeDeptForPrint.summaryFingerprintField;
        const _fpFn        = _activeDeptForPrint.summaryFingerprint;
        const activeInstr = comp['instructions_' + activeDepartment] || '';
        const hasSpecsBlock = !!_markerStart && (activeInstr.includes(_markerStart) ||
                              quill.getText().includes(_markerStart));
        if (hasSpecsBlock && _fpField && comp[_fpField] && typeof _fpFn === 'function' &&
            comp[_fpField] !== _fpFn(comp)) {
            const nameSpan = '<span class="qc-comp-name">' + escHtml(comp.name) + '</span>';
            const action = await showWarningModal('Summary outdated for ' + nameSpan, ['Fields have changed since the last Generate.'], { type: 'stale', okLabel: 'Update & Print' });
            if (action) {
                generateSummaryBlock();
                // Re-read comp after regeneration
                const freshJobs = getActiveJobs();
                const freshJob = freshJobs.find(j => j.id === currentJobId);
                const freshComp = freshJob?.components?.find(c => c.id === currentComponentId);
                if (freshJob && freshComp) {
                    const html = buildPrintHTML(freshJob, freshComp);
                    printViaIframe(html, getPrintFilename(freshJob.jobNumber, freshComp.name));
                    return;
                }
            }
        }

        const html = buildPrintHTML(job, comp);
        printViaIframe(html, getPrintFilename(job.jobNumber, comp.name));
    }

    // ========== SELECTIVE EXPORT ==========

    function exportJobs() {
        const active = getActiveJobs();
        const archive = JSON.parse(localStorage.getItem('prepressJobsArchive') || '[]');
        const list = document.getElementById('exportJobList');
        let html = '';

        if (active.length > 0) {
            html += '<div class="export-section-label">Active Jobs</div>';
            active.forEach(j => {
                const desc = j.jobDescription ? ` - ${j.jobDescription}` : '';
                const label = `${j.jobNumber} - ${j.clientName}${desc}`;
                html += `<div class="export-job-row"><input type="checkbox" id="exp-${j.id}" data-source="active" data-job-id="${j.id}" onchange="updateExportCount()"><label for="exp-${j.id}">${escHtml(label)}</label></div>`;
            });
        }
        if (archive.length > 0) {
            html += '<div class="export-section-label">Archived Jobs</div>';
            archive.forEach(j => {
                const desc = j.jobDescription ? ` - ${j.jobDescription}` : '';
                const label = `${j.jobNumber} - ${j.clientName}${desc}`;
                html += `<div class="export-job-row"><input type="checkbox" id="exp-${j.id}" data-source="archive" data-job-id="${j.id}" onchange="updateExportCount()"><label for="exp-${j.id}">${escHtml(label)}</label></div>`;
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
        const archive = JSON.parse(localStorage.getItem('prepressJobsArchive') || '[]');
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
                    alert('Invalid file format. Please select a valid export file.');
                    return;
                }
                showImportSummary(data);
            } catch (err) {
                alert('Error reading file: ' + err.message);
            }
        };
        reader.readAsText(file);
    }

    function showImportSummary(data) {
        const existingJobs = getActiveJobs();
        const existingArchive = JSON.parse(localStorage.getItem('prepressJobsArchive') || '[]');
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
            return { job: j, target, status: isNewer ? 'newer' : 'older', existingId: existing.id, importedDate, localDate };
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
            alert('All jobs in the file already exist and are up to date.');
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

    function confirmImport() {
        if (!pendingImportData) return;
        // Build set of checked older/newer items
        const checkedIdxs = new Set();
        document.querySelectorAll('#importJobList .import-check:checked').forEach(cb => {
            checkedIdxs.add(parseInt(cb.dataset.idx));
        });
        const existingJobs = getActiveJobs();
        const existingArchive = JSON.parse(localStorage.getItem('prepressJobsArchive') || '[]');
        let addedCount = 0;
        let updatedCount = 0;

        pendingImportData.forEach((c, idx) => {
            if (c.status === 'skip') return;
            // For newer/older items, only import if checkbox is checked
            if ((c.status === 'newer' || c.status === 'older') && !checkedIdxs.has(idx)) return;
            if (c.target === 'active') {
                if (c.status === 'new') {
                    existingJobs.push(c.job);
                    addedCount++;
                } else {
                    const jdx = existingJobs.findIndex(j => j.id === c.existingId);
                    if (jdx > -1) { existingJobs[jdx] = c.job; updatedCount++; }
                }
            } else {
                if (c.status === 'new') {
                    existingArchive.push(c.job);
                    addedCount++;
                } else {
                    const jdx = existingArchive.findIndex(j => j.id === c.existingId);
                    if (jdx > -1) { existingArchive[jdx] = c.job; updatedCount++; }
                }
            }
        });

        saveActiveJobs(existingJobs);
        localStorage.setItem('prepressJobsArchive', JSON.stringify(existingArchive));
        backupToIDB(existingJobs, existingArchive);
        invalidateJobsCache();
        loadJobs();
        closeImportModal();
        alert('Imported: ' + addedCount + ' added, ' + updatedCount + ' updated.');
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
            instructions: quill.root.innerHTML,
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

        quill.clipboard.dangerouslyPasteHTML(state.instructions);
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
        saveJobStateWithoutHistory();
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
        if (undoStack.length === 0 || !currentJobId) return;
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
        if (redoStack.length === 0 || !currentJobId) return;
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

    function saveJobStateWithoutHistory() {
        const { job, comp } = saveComponentState();
        if (!job || !comp) return;

        const instructions = comp['instructions_' + activeDepartment] || '';
        const history = comp['instructionsHistory_' + activeDepartment] || '';
        const fullInstructions = instructions + (instructions && history ? '<br><br>' : '') + history;
        document.getElementById('instructionsDisplay').innerHTML = fullInstructions;

        updatePrintHeader(job);
        updateRowVisibility();
        updateCompletion();
    }

    // Keyboard shortcuts for undo/redo
    document.addEventListener('keydown', function(e) {
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
        const wrapper = btn.closest('.quick-pick-wrapper');
        const menu = wrapper.querySelector('.quick-pick-menu');

        // Close all other open menus first
        document.querySelectorAll('.quick-pick-menu.open').forEach(m => {
            if (m !== menu) {
                m.classList.remove('open', 'open-up');
            }
        });

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
        return SPEC_FIELDS.map(f => (checks[f] ? '1' : '0') + ':' + (notes[f + 'n'] || '')).join('|');
    }

    // Show styled QC warning modal, returns a Promise<boolean>
    // type: 'qc' (red), 'required' (gold), 'stale' (neutral), 'info' (neutral, OK only)
    function showWarningModal(title, items, opts) {
        const type = (opts && opts.type) || 'qc';
        const okLabel = (opts && opts.okLabel) || 'Print Anyway';
        const showCancel = type !== 'info';
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
            btnCancel.style.display = showCancel ? '' : 'none';

            modal.style.display = 'block';

            function cleanup(result) {
                modal.style.display = 'none';
                btnOk.removeEventListener('click', onOk);
                btnCancel.removeEventListener('click', onCancel);
                resolve(result);
            }
            function onOk() { cleanup(true); }
            function onCancel() { cleanup(false); }
            btnOk.addEventListener('click', onOk);
            if (showCancel) btnCancel.addEventListener('click', onCancel);
        });
    }

    function showQcWarning(compNames, warnings, okLabel) {
        const nameSpan = '<span class="qc-comp-name">' + escHtml(compNames) + '</span>';
        return showWarningModal('QC Warnings for ' + nameSpan, warnings, { type: 'qc', okLabel: okLabel || 'Print Anyway' });
    }

    // Parse dimension string like "8.5″ x 14″" or "8.5x3.5" into [w, h]
    function parseDims(str) {
        if (!str) return null;
        // Strip quote/prime marks and em-spaces, but preserve 'x' for splitting
        const clean = str.replace(/[\u2033\u201d\u2032"'\u2035\u2036\u2037\u2057\u2018\u2019\u201c\u201d\u00b4`\u2103\u2109\u00b0\u2070-\u209f]/g, '')
                        .replace(/\u2003/g, ' ')
                        .trim();
        // Split on 'x' (case-insensitive, with optional surrounding whitespace)
        const parts = clean.split(/\s*x\s*/i);
        if (parts.length !== 2) return null;
        // Now strip alpha from each half (handles "9.5 No. 10 Env" -> "9.5")
        const w = parseFloat(parts[0].replace(/[a-zA-Z]/g, '').trim());
        const h = parseFloat(parts[1].replace(/[a-zA-Z]/g, '').trim());
        if (isNaN(w) || isNaN(h)) return null;
        return [w, h];
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

        // Helper: get value only if checkbox is checked and value is non-empty
        function val(cbId, noteId) {
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

        function val(cbId, noteId) {
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

        // Check: finished size should be smaller than flat size
        if (flatDims && finDims) {
            const flatArea  = flatDims[0] * flatDims[1];
            const finArea   = finDims[0] * finDims[1];
            if (finArea >= flatArea) {
                warnings.push('Finished size (' + finishedSize + ') is not smaller than flat size (' + flatSize + ').');
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

        // Check: Titan is B&W only
        if (press && press.toLowerCase().includes('titan')) {
            const pwLower = (presswork || '').toLowerCase();
            if (pwLower && !pwLower.includes('b&w') && (pwLower.includes('color') || pwLower.includes('4/'))) {
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

        // Check: indicia/address block mismatch (mail-carrier components only)
        const MAIL_CARRIERS = ['envelope', 'postcard', 'self-mailer'];
        const isMailCarrier = MAIL_CARRIERS.some(kw => compName.includes(kw)) && !compName.includes('bre');
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
    // implemented generateSummary yet.
    async function generateSummaryBlock() {
        if (!currentJobId || !currentComponentId) return;

        const dept = window.DEPT_REGISTRY[activeDepartment];
        if (!dept || typeof dept.generateSummary !== 'function') return;

        // Save current state first so we read latest values
        saveComponentState();
        const comp = getCurrentComponent();
        if (!comp) return;

        // Run dept-scoped QC validation (TS returns [] until rules are written)
        const validateFn = dept.validateSummary || function () { return []; };
        const warnings = validateFn(comp);

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

        // Capture undo state before modifying
        pushToUndo(true);

        // Build the full block with dept-scoped markers
        const markerStart = dept.summaryMarkerStart;
        const markerEnd   = dept.summaryMarkerEnd;
        const fullBlock   = markerStart + '\n' + summary + '\n' + markerEnd;

        // Check if THIS dept's markers already exist in the editor (the active
        // dept's instructions are what's currently loaded into Quill).
        const editorText = quill.getText();
        const startIdx   = editorText.indexOf(markerStart);
        const endIdx     = editorText.indexOf(markerEnd);

        let insertAt;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            // Replace existing block
            const deleteLen = (endIdx + markerEnd.length) - startIdx;
            quill.deleteText(startIdx, deleteLen, 'user');
            quill.insertText(startIdx, fullBlock, 'user');
            insertAt = startIdx;
            quill.setSelection(insertAt + fullBlock.length);
        } else {
            // First time: insert at cursor
            const selection = quill.getSelection();
            const index = selection ? selection.index : quill.getLength() - 1;
            const prefix = (index > 0 && editorText.charAt(index - 1) !== '\n') ? '\n' : '';
            const text = prefix + fullBlock + '\n';
            quill.insertText(index, text, 'user');
            insertAt = index + prefix.length;
            quill.setSelection(index + text.length);
        }

        // Style the marker lines: small and gray
        const markerFormat = { size: 'small', color: '#b0b0b0' };
        const freshText = quill.getText();
        const sIdx = freshText.indexOf(markerStart, insertAt > 2 ? insertAt - 2 : 0);
        const eIdx = freshText.indexOf(markerEnd, insertAt > 2 ? insertAt - 2 : 0);
        if (sIdx !== -1) quill.formatText(sIdx, markerStart.length, markerFormat, 'silent');
        if (eIdx !== -1) quill.formatText(eIdx, markerEnd.length, markerFormat, 'silent');

        // Store fingerprint on dept-scoped field so stale-detection knows which
        // dept's summary changed. Prepress: comp.specsFingerprint (back-compat
        // with saved jobs). TS: comp.tsFingerprint.
        if (typeof dept.summaryFingerprint === 'function' && dept.summaryFingerprintField) {
            comp[dept.summaryFingerprintField] = dept.summaryFingerprint(comp);
        }
        if (currentJobId) saveJobState();
    }

    // Back-compat shim: any leftover callers of generateSpecsBlock route through
    // the new dispatcher. Safe to remove once all callsites are migrated.
    async function generateSpecsBlock() { return generateSummaryBlock(); }

    function selectQuickPick(optionEl) {
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
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components) return;

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
            nameSpan.ondblclick = (e) => { e.stopPropagation(); startRenameComponent(comp.id); };

            tab.appendChild(nameSpan);

            // Only show delete button if more than one component
            if (job.components.length > 1) {
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
        if (job.components.length < MAX_COMPONENTS) {
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

        // Save current component state first
        if (currentComponentId) {
            saveComponentState();
        }

        currentComponentId = componentId;

        // Update job's active component
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (job) {
            job.activeComponentId = componentId;
            saveActiveJobs(jobs);
        }

        // Load the new component's data
        loadComponentData();
        renderComponentTabs();
    }

    // Save current component state to storage (shared core for all save operations)
    function saveComponentState() {
        if (!currentJobId || !currentComponentId) return {};
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components) return {};

        const comp = job.components.find(c => c.id === currentComponentId);
        if (!comp) return {};

        // Ensure dept-keyed fields exist (safety net for pre-migration data
        // that slipped through loadJob's migration pass).
        migrateInstructionsToPerDept(comp);

        const instrKey = 'instructions_' + activeDepartment;
        comp[instrKey] = quill.getText().trim() ? quill.root.innerHTML : '';

        document.querySelectorAll('.field-row .toggle-switch input[type="checkbox"]').forEach(cb => {
            const id = cb.getAttribute('data-id');
            if (id) comp.checkboxes[id] = cb.checked;
        });

        document.querySelectorAll('.notes').forEach(inp => {
            const id = inp.getAttribute('data-id');
            if (id) comp.notes[id] = inp.value;
        });

        job.lastModified = new Date().toISOString();
        job.lastModifiedBy = getUserName();
        saveActiveJobs(jobs);
        return { job, comp };
    }

    // Load component data into the UI
    function loadComponentData() {
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
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
        // Handle old plain-text format (no HTML tags) by converting newlines
        const htmlToLoad = (instructions && !instructions.includes('<'))
            ? instructions.replace(/\n/g, '<br>')
            : instructions;
        if (htmlToLoad) {
            quill.clipboard.dangerouslyPasteHTML(htmlToLoad);
        } else {
            quill.setContents([]);
        }
        document.getElementById('instructionsHistory').innerHTML = history;

        // For print display, combine current and history
        const fullInstructions = instructions + (instructions && history ? '<br><br>' : '') + history;
        document.getElementById('instructionsDisplay').innerHTML = fullInstructions;

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
        updateRequiredBadge();
    }

    // Add a new component
    function addComponent(name, templateId) {
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

        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components || job.components.length <= 1) return;

        const comp = job.components.find(c => c.id === componentId);
        if (!comp) return;

        if (!confirm(`Delete component "${comp.name}"? This cannot be undone.`)) return;

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

        const finishRename = () => {
            const newName = input.value.trim() || currentName;
            renameComponent(componentId, newName);
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

        comp.name = newName;
        job.lastModified = new Date().toISOString();
        job.lastModifiedBy = getUserName();
        saveActiveJobs(jobs);
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

    // Dropdown functions
    function togglePrintDropdown() {
        document.getElementById('moreDropdown').classList.remove('open');
        document.getElementById('printDropdown').classList.toggle('open');
    }

    function toggleMoreDropdown() {
        document.getElementById('printDropdown').classList.remove('open');
        document.getElementById('moreDropdown').classList.toggle('open');
    }

    // ========== HELP MODAL ==========
    function openHelpModal() {
        document.getElementById('helpModal').style.display = 'block';
    }
    function closeHelpModal() {
        document.getElementById('helpModal').style.display = 'none';
    }
    function printHelpGuide() {
        const body = document.querySelector('.help-body');
        if (!body) return;
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Work Order Instructions - User Guide</title><style>
body{font-family:'DM Sans',system-ui,sans-serif;font-size:13px;line-height:1.6;color:#1a1a2e;max-width:640px;margin:0 auto;padding:32px 24px;}
h1{font-family:Georgia,serif;font-size:20px;font-weight:700;margin-bottom:24px;border-bottom:2px solid #d8d5cf;padding-bottom:8px;}
h3{font-family:Georgia,serif;font-size:15px;font-weight:700;margin:20px 0 6px;}
h4{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;margin:12px 0 4px;}
p{margin:0 0 8px;}
ul{padding-left:20px;margin:0 0 8px;}
li{margin-bottom:4px;}
table{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0;}
td{padding:4px 8px;border-bottom:1px solid #e8e6e1;vertical-align:top;}
td:first-child{white-space:nowrap;width:100px;font-weight:600;}
.limits{background:#edecea;border-radius:8px;padding:12px 16px;margin-top:16px;}
.limits h3{margin-top:0;}
.limits ul{margin-bottom:0;}
</style></head><body><h1>Work Order Instructions &mdash; User Guide</h1>${body.innerHTML}</body></html>`;
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;left:-9999px;width:0;height:0;';
        document.body.appendChild(iframe);
        iframe.contentDocument.open();
        iframe.contentDocument.write(html);
        iframe.contentDocument.close();
        iframe.contentWindow.onafterprint = () => iframe.remove();
        setTimeout(() => iframe.contentWindow.print(), 200);
    }
    // Close help modal on backdrop click
    document.getElementById('helpModal').addEventListener('click', function(e) {
        if (e.target === this) closeHelpModal();
    });
    // Close help modal on Escape
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && document.getElementById('helpModal').style.display === 'block') {
            closeHelpModal();
        }
    });

    async function printAllComponents() {
        if (!currentJobId) {
            alert('No job selected to print!');
            return;
        }

        document.getElementById('printDropdown').classList.remove('open');
        saveJobState();

        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components || !job.components.length) return;

        // Check required fields across ALL components
        const allMissing = [];
        job.components.forEach(comp => {
            const status = getRequiredStatusForComponent(comp);
            if (status.missing.length > 0) {
                allMissing.push(comp.name + ': ' + status.missing.join(', '));
            }
        });
        if (allMissing.length > 0) {
            const proceed = await showWarningModal('Required fields missing', allMissing, { type: 'required' });
            if (!proceed) return;
        }

        // QC: catch physically impossible spec combinations across all components.
        // Dept-scoped: each dept's validateSummary runs against every component.
        const _printAllDept = window.DEPT_REGISTRY[activeDepartment] || {};
        const _printAllValidate = _printAllDept.validateSummary || function () { return []; };
        const allQcWarnings = [];
        const allQcNames = [];
        job.components.forEach(c => {
            const w = _printAllValidate(c);
            if (w.length > 0) {
                allQcNames.push(c.name);
                w.forEach(warning => allQcWarnings.push(c.name + ': ' + warning));
            }
        });
        if (allQcWarnings.length > 0) {
            const proceed = await showQcWarning(allQcNames.join(', '), allQcWarnings);
            if (!proceed) return;
        }

        // Check for stale summary blocks across all components (active dept only —
        // print-all prints whichever dept tab the user is on, so we check that).
        // Dept-scoped: uses the active dept's marker, fingerprint field, and
        // fingerprint function so prepress staleness and TS staleness do not cross.
        const deptInstrKey   = 'instructions_' + activeDepartment;
        const _markerStartPA = _printAllDept.summaryMarkerStart;
        const _markerEndPA   = _printAllDept.summaryMarkerEnd;
        const _fpFieldPA     = _printAllDept.summaryFingerprintField;
        const _fpFnPA        = _printAllDept.summaryFingerprint;
        const _genFnPA       = _printAllDept.generateSummary;
        const staleComps = (_markerStartPA && _fpFieldPA && typeof _fpFnPA === 'function')
            ? job.components.filter(c => {
                  const hasBlock = (c[deptInstrKey] || '').includes(_markerStartPA);
                  return hasBlock && c[_fpFieldPA] && c[_fpFieldPA] !== _fpFnPA(c);
              })
            : [];
        if (staleComps.length > 0) {
            const names = staleComps.map(c => c.name).join(', ');
            const nameSpan = '<span class="qc-comp-name">' + escHtml(names) + '</span>';
            if (await showWarningModal('Summary outdated for ' + nameSpan, ['Fields have changed since the last Generate.'], { type: 'stale', okLabel: 'Update & Print' })) {
                staleComps.forEach(c => {
                    const summary = (typeof _genFnPA === 'function') ? _genFnPA(c) : '';
                    if (!summary) return;
                    const fullBlock = _markerStartPA + '\n' + summary + '\n' + _markerEndPA;
                    // Replace in stored instructions HTML for the active dept
                    const text = (c[deptInstrKey] || '').replace(/<[^>]*>/g, '');
                    const sIdx = text.indexOf(_markerStartPA);
                    const eIdx = text.indexOf(_markerEndPA);
                    if (sIdx !== -1 && eIdx !== -1) {
                        // Rebuild via DOM to safely replace
                        const div = document.createElement('div');
                        div.innerHTML = c[deptInstrKey];
                        const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
                        const toRemove = [];
                        let inBlock = false;
                        while (walker.nextNode()) {
                            const t = walker.currentNode.textContent;
                            if (t.includes(_markerStartPA)) inBlock = true;
                            if (inBlock) {
                                let el = walker.currentNode.parentElement;
                                while (el && el !== div && el.tagName !== 'P') el = el.parentElement;
                                if (el && el !== div && !toRemove.includes(el)) toRemove.push(el);
                            }
                            if (t.includes(_markerEndPA)) inBlock = false;
                        }
                        toRemove.forEach(el => el.remove());
                        // Insert new block as paragraphs
                        const insertPoint = div.firstChild;
                        fullBlock.split('\n').reverse().forEach(line => {
                            const p = document.createElement('p');
                            p.textContent = line;
                            div.insertBefore(p, insertPoint);
                        });
                        c[deptInstrKey] = div.innerHTML;
                    }
                    c[_fpFieldPA] = _fpFnPA(c);
                });
                saveActiveJobs(jobs);
            }
        }

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
    }

    async function printAllComponentsCombined() {
        if (!currentJobId) {
            alert('No job selected to print!');
            return;
        }

        document.getElementById('printDropdown').classList.remove('open');
        saveJobState();

        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components || !job.components.length) return;

        const allMissing = [];
        job.components.forEach(comp => {
            const status = getRequiredStatusForComponent(comp);
            if (status.missing.length > 0) {
                allMissing.push(comp.name + ': ' + status.missing.join(', '));
            }
        });
        if (allMissing.length > 0) {
            const proceed = await showWarningModal('Required fields missing', allMissing, { type: 'required' });
            if (!proceed) return;
        }

        // Dept-scoped QC for the combined-print path. Mirrors the single-print and
        // print-all paths so TS components run TS rules and prepress runs prepress rules.
        const _combinedDept = window.DEPT_REGISTRY[activeDepartment] || {};
        const _combinedValidate = _combinedDept.validateSummary || function () { return []; };
        const allQcWarnings = [];
        const allQcNames = [];
        job.components.forEach(c => {
            const w = _combinedValidate(c);
            if (w.length > 0) {
                allQcNames.push(c.name);
                w.forEach(warning => allQcWarnings.push(c.name + ': ' + warning));
            }
        });
        if (allQcWarnings.length > 0) {
            const proceed = await showQcWarning(allQcNames.join(', '), allQcWarnings);
            if (!proceed) return;
        }

        const pages = job.components.map(comp => buildPrintHTML(job, comp, activeDepartment));
        const bodies = pages.map(html => {
            const m = html.match(/<body>([\s\S]*?)<\/body>/);
            return m ? m[1] : '';
        });
        const separator = '<div style="page-break-before:always;"></div>';
        const combinedBody = bodies.join(separator);
        const combined = pages[0].replace(/<body>[\s\S]*?<\/body>/, '<body>' + combinedBody + '</body>');

        const combinedName = job.components.map(c => sanitizeForFilename(c.name)).join('_');
        const filename = getPrintFilename(job.jobNumber, combinedName);

        printViaIframe(combined, filename);
    }

    // Populate components select in New Job modal
    function populateComponentsSelect() {
        const container = document.getElementById('componentsSelect');
        container.innerHTML = '';

        PIECE_FORMAT_OPTIONS.forEach(opt => {
            const label = document.createElement('label');
            label.className = 'component-option';

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
    function populateCSRDropdowns() {
        // CSR filter dropdown (landing page)
        const filterCSR = document.getElementById('filterCSR');
        if (filterCSR && filterCSR.options.length <= 1) {
            CSR_NAMES.forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                filterCSR.appendChild(opt);
            });
        }
        // CSR quick-pick menus in create/edit modals (sync with CSR_NAMES)
        document.querySelectorAll('#csrName, #editCSRName').forEach(input => {
            const wrapper = input.closest('.quick-pick-wrapper');
            if (!wrapper) return;
            const menu = wrapper.querySelector('.quick-pick-menu');
            if (!menu) return;
            menu.dataset.options = JSON.stringify(CSR_NAMES);
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
                    if (input.value.trim().length > 0 && !toggle.checked) {
                        toggle.checked = true;
                    } else if (input.value.trim().length === 0 && toggle.checked) {
                        toggle.checked = false;
                    }
                });
                input.addEventListener('paste', () => {
                    setTimeout(() => {
                        if (input.value.trim().length > 0) toggle.checked = true;
                        if (input.tagName === 'TEXTAREA') autoResizeTextarea(input);
                    }, 10);
                });
            });
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
        document.getElementById('editJobModal').style.display = 'block';

        // Focus job number field (especially important after duplicate)
        setTimeout(() => document.getElementById('editJobNumber').focus(), 100);
    }

    function closeEditJobModal() {
        document.getElementById('editJobModal').style.display = 'none';
        document.getElementById('editJobForm').reset();
    }

    document.getElementById('editJobForm').addEventListener('submit', e => {
        e.preventDefault();
        if (!currentJobId) return;

        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job) return;

        const newNum = document.getElementById('editJobNumber').value.trim();
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
    // Fields to CLEAR on duplicate (file paths + variable print + previous job#)
    const DUPLICATE_CLEAR_IDS = ['sp1', 'fp1', 'fp2', 'fp3', 'fp4', 'fp6', 'ps11', 'vp1', 'ps12', 'vp3'];

    function duplicateJob() {
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

        const now = new Date().toISOString();
        const newJob = JSON.parse(JSON.stringify(original)); // deep copy
        newJob.id = Date.now().toString();
        newJob.jobNumber = original.jobNumber + ' (Copy)';
        newJob.dateCreated = now;
        newJob.createdBy = getUserName();
        newJob.lastModified = now;
        newJob.lastModifiedBy = getUserName();
        newJob.duplicatedFrom = original.jobNumber;
        newJob.assignedToPrepress = '';
        newJob.assignedToTechservices = '';
        delete newJob.headerModified;
        delete newJob.headerModifiedBy;

        // Clear dangerous fields from ALL components
        newJob.components.forEach((comp, idx) => {
            comp.id = 'comp_' + Date.now() + '_' + idx;
            comp.instructions_prepress = '';
            comp.instructions_techservices = '';
            comp.instructionsHistory_prepress = '';
            comp.instructionsHistory_techservices = '';
            // Strip legacy fields if they somehow survived
            delete comp.instructions;
            delete comp.instructionsHistory;
            delete comp._instructions_legacy_backup;
            delete comp._instructionsHistory_legacy_backup;

            // Clear file paths, variable print, and previous job# checkboxes + notes
            DUPLICATE_CLEAR_IDS.forEach(f => {
                delete comp.checkboxes[f];
                delete comp.notes[f + 'n'];
            });
        });

        newJob.activeComponentId = newJob.components[0].id;

        jobs.push(newJob);
        saveActiveJobs(jobs);
        loadJobs();
        loadJob(newJob.id);

        // Force open Edit Job modal so CSR must confirm metadata
        openEditJobModal();
    }

    // ========== DUPLICATE COMPONENT ==========
    function duplicateComponent() {
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

        // Clear file paths and variable print from the copy
        DUPLICATE_CLEAR_IDS.forEach(f => {
            delete newComp.checkboxes[f];
            delete newComp.notes[f + 'n'];
        });

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
            btn.dataset.rev = idx;
            btn.dataset.revNum = revNum;

            // Extract timestamp text for tooltip
            const tsText = ts.textContent.replace(/^\(\d+\)\s*/, '');

            btn.innerHTML =
                '<span class="revision-seg-label">R' + revNum + '</span>' +
                '<span class="revision-tooltip">' + escHtml(tsText) + '</span>';

            btn.addEventListener('click', () => {
                // Toggle print inclusion
                btn.classList.toggle('rev-print-on');

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
    function startInlineEdit(fieldEl) {
        if (!currentJobId) return;
        if (fieldEl.dataset.field === 'assignedTo') return startInlineEditAssignee(fieldEl);
        if (fieldEl.dataset.field === 'signoffDue') return startInlineEditSignoffDue(fieldEl);
        if (fieldEl.querySelector('.inline-edit-input')) return; // already editing

        const valueSpan = fieldEl.querySelector('.job-field-value');
        const icon = fieldEl.querySelector('.inline-edit-icon');
        const currentValue = valueSpan.textContent;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'inline-edit-input';
        input.value = currentValue;

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

        if (!newValue) {
            cancelInlineEdit(fieldEl, input, origOnclick);
            return;
        }

        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job) { cancelInlineEdit(fieldEl, input, origOnclick); return; }

        if (field === 'componentName') {
            const comp = job.components ? job.components.find(c => c.id === currentComponentId) : null;
            if (comp) comp.name = newValue;
        } else {
            job[field] = newValue;
        }

        job.headerModified = new Date().toISOString();
        job.headerModifiedBy = getUserName();
        job.lastModified = new Date().toISOString();
        job.lastModifiedBy = getUserName();

        saveActiveJobs(jobs);
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

        const dept = window.DEPT_REGISTRY[activeDepartment] || window.DEPT_REGISTRY.prepress;
        const roster = (dept && dept.ASSIGNEE_OPTIONS) || [];
        const deptKey = activeDepartment === 'techservices' ? 'assignedToTechservices' : 'assignedToPrepress';
        const currentValue = job[deptKey] || '';

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
            if (job2) {
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

        valueSpan.style.display = 'none';
        if (icon) icon.style.display = 'none';
        fieldEl.insertBefore(editor, valueSpan.nextSibling);
        dateInput.focus();

        const origOnclick = fieldEl.onclick;
        fieldEl.onclick = null;

        let finished = false;
        const teardown = () => {
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
            if (job2) {
                job2[dateKey] = dateInput.value;
                job2[timeKey] = timeSel.value;
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

    // ========== LANDING PAGE FILTERS ==========
    function applyLandingFilters() {
        const csrFilter = document.getElementById('filterCSR').value; // exact name or ''
        const clientFilter = (document.getElementById('filterClient').value || '').trim().toLowerCase();
        const dateFrom = document.getElementById('filterDateFrom').value; // YYYY-MM-DD or ''
        const dateTo = document.getElementById('filterDateTo').value;

        const jobs = getActiveJobs();
        jobs.sort((a, b) => new Date(b.lastAccessed || b.lastModified || b.dateCreated) - new Date(a.lastAccessed || a.lastModified || a.dateCreated));

        const hasFilters = csrFilter || clientFilter || dateFrom || dateTo;

        const filtered = jobs.filter(j => {
            if (csrFilter) {
                if ((j.csrName || '').trim() !== csrFilter) return false;
            }
            if (clientFilter) {
                if (!(j.clientName || '').toLowerCase().includes(clientFilter)) return false;
            }
            const jobDate = (j.dateCreated || '').slice(0, 10);
            if (dateFrom && jobDate < dateFrom) return false;
            if (dateTo && jobDate > dateTo) return false;
            return true;
        });

        renderRecentJobs(filtered, hasFilters);
        const countEl = document.getElementById('filterResultCount');
        if (countEl) {
            countEl.textContent = hasFilters ? filtered.length + ' of ' + jobs.length : '';
        }
    }

    function clearLandingFilters() {
        document.getElementById('filterCSR').value = '';
        document.getElementById('filterClient').value = '';
        document.getElementById('filterDateFrom').value = '';
        document.getElementById('filterDateTo').value = '';
        applyLandingFilters();
    }

    // ========== REQUIRED FIELDS (B+A) ==========

    // Check required fields from the DOM (current component on screen)
    function getRequiredStatus() {
        const fields = getActiveRequiredFields();
        let filled = 0;
        const missing = [];
        fields.forEach(rf => {
            const el = document.querySelector(`[data-id="${rf.id}"]`);
            const val = el ? (el.value || '').trim() : '';
            if (val) { filled++; } else { missing.push(rf.label); }
        });
        return { filled, total: fields.length, missing };
    }

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

    // Update the badge in the header billboard
    function updateRequiredBadge() {
        const badge = document.getElementById('requiredBadge');
        if (!badge || !currentJobId) return;
        const status = getRequiredStatus();
        const complete = status.missing.length === 0;
        const pct = status.total ? Math.round((status.filled / status.total) * 100) : 0;
        badge.className = 'required-badge ' + (complete ? 'complete' : 'incomplete');
        badge.innerHTML =
            '<div class="required-badge-track"><div class="required-badge-fill" style="width:' + pct + '%"></div></div>' +
            '<span class="required-badge-label">' + status.filled + '/' + status.total + '</span>';
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
    function closeJobWithWarning() {
        if (currentJobId) {
            closeCurrentJob();
            const jobs = getActiveJobs();
            const job = jobs.find(j => j.id === currentJobId);
            if (job && job.components) {
                const allMissing = [];
                job.components.forEach(comp => {
                    const status = getRequiredStatusForComponent(comp);
                    if (status.missing.length > 0) {
                        allMissing.push(comp.name + ': ' + status.missing.join(', '));
                    }
                });
                if (allMissing.length > 0) {
                    const el = document.getElementById('backupToast');
                    el.innerHTML = '<strong style="color:#fbbf24;">Missing required:</strong> <strong>' + allMissing.map(s => escHtml(s)).join(' | ') + '</strong>';
                    el.classList.add('visible');
                    setTimeout(() => { el.classList.remove('visible'); }, 5000);
                }
            }
        }
        showNoJobState();
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
        if (!currentJobId || !currentComponentId) return;
        const jobs = getActiveJobs();
        const job = jobs.find(j => j.id === currentJobId);
        if (!job || !job.components) return;

        const comp = job.components.find(c => c.id === currentComponentId);
        if (!comp) return;

        comp.version = code;
        job.lastModified = new Date().toISOString();
        job.lastModifiedBy = getUserName();
        saveActiveJobs(jobs);

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
