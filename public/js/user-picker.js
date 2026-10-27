/* ═════════════════════════════════════════════════════════════════
   USER PICKER -- who is using the app (USER_PICKER_PLAN.md)
   An approved honor-system user picker, not a sign-in: people choose their
   own name from the user list and nothing proves who they are. No password
   is asked for here.

   - Before anything else loads, GET /api/me says whether this browser has
     picked a name that is still on the list. If not, #userPickerModal asks:
     search, pick, confirm, and POST /api/me sets the cookie. app.js waits for
     userPicker.ready() before it loads the roster, the jobs or a work order.
   - The page keeps the user it started with (userPicker.user(), read by
     getUserName() in app.js). A different name means a different page: after
     Change user, or picking another name when the page was covered, the page
     reloads once the saves on their way have finished.
   - On focus, when the tab comes back into view and once a minute, the page
     asks /api/me again (check). Another name picked in another tab: a notice
     to reload. Taken off the list, or not remembered any more: the picker
     covers the page. The page's user picked again (here or in another tab):
     the cover comes off, and the QC Review window is told (sts-user-back).
   - While the picker shows, nothing behind it can be reached: focus, keys
     and the browser's own undo are kept inside it.
   Code prefix userPicker*. The QC Review window keeps review*.
   ═════════════════════════════════════════════════════════════════ */

(function () {
'use strict';

const CHECK_MS = 60000;
const COOKIE = 'sts_user';
const UNAVAILABLE_TEXT = 'The user list is unavailable. An administrator or IT must fix the settings or the file.';
const UNREACHABLE_TEXT = 'Could not reach the server. Check the connection, then press Try again.';
const ODD_TEXT = 'The app did not answer as expected. Press Try again. If it keeps happening, tell IT: the app\'s service may need a restart.';

const modal = document.getElementById('userPickerModal');
const els = {};
[
    'Choose', 'Title', 'Removed', 'SearchWrap', 'Search', 'List', 'Empty', 'Unavailable', 'Retry',
    'Cancel', 'Next', 'Confirm', 'Choosing', 'ConfirmName', 'ConfirmUser', 'Back', 'Continue',
    'Changed', 'ChangedText', 'Reload', 'Help'
].forEach(name => { els[name] = document.getElementById('userPicker' + name); });

let pageUser = '';       // the user this page started with, '' until one is known
let pageDisplay = '';
let users = [];          // [{ user, display }] from /api/users, sorted by name
let picked = null;       // the entry picked in step 1
let matches = [];        // the entries shown under the search box
let active = -1;         // the highlighted entry
let mode = 'start';      // start (no user yet), change (Change user, with Cancel), cover (the page's user is not picked now), changed (reload), '' (hidden)
let showing = '';        // choose, blocked, confirm or changed
let checking = false;
let committing = false;  // another name is picked and the page is about to reload
let resolveReady = null;
const readyPromise = new Promise(resolve => { resolveReady = resolve; });

function keyOf(value) {
    return String(value || '').trim().toLowerCase();
}

// The user named by this browser's cookie, as the page can read it.
function cookieUser() {
    for (const part of document.cookie.split(';')) {
        const at = part.indexOf('=');
        if (at < 0 || part.slice(0, at).trim() !== COOKIE) continue;
        try { return decodeURIComponent(part.slice(at + 1).trim()); } catch (e) { return ''; }
    }
    return '';
}

// A request to the picker's routes: { ok, status, json, problem } where problem
// is 'unreachable' (no answer), 'odd' (not the route's answer, for example an
// old server.js with no such route) or ''.
async function ask(url, options) {
    let res;
    try {
        res = await fetch(url, Object.assign({ headers: { 'Accept': 'application/json' }, cache: 'no-store' }, options || {}));
    } catch (e) {
        return { ok: false, status: 0, json: {}, problem: 'unreachable' };
    }
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!json || typeof json !== 'object') return { ok: false, status: res.status, json: {}, problem: 'odd' };
    const expected = res.ok || res.status === 400 || res.status === 503;
    return { ok: res.ok, status: res.status, json, problem: expected ? '' : 'odd' };
}

function isShown() {
    return modal.style.display !== 'none';
}

// ── Drawing ──

// The page starts covered by a see-through picker (is-starting in index.html),
// so nothing behind it can be used before the app knows whose page it is.
function show() {
    modal.classList.remove('is-starting');
    modal.style.display = 'block';
}

function hide() {
    modal.classList.remove('is-starting');
    modal.style.display = 'none';
    showing = '';
}

function showOnly(part) {
    showing = part;
    els.Choose.hidden = part !== 'choose' && part !== 'blocked';
    els.Confirm.hidden = part !== 'confirm';
    els.Changed.hidden = part !== 'changed';
    els.Help.hidden = part === 'changed';
}

function drawList() {
    els.List.textContent = '';
    matches.forEach((entry, i) => {
        const option = document.createElement('div');
        option.className = 'user-picker-option' + (i === active ? ' is-active' : '') + (picked && picked.user === entry.user ? ' is-picked' : '');
        option.id = 'userPickerOption' + i;
        option.setAttribute('role', 'option');
        option.setAttribute('data-user', entry.user);
        option.setAttribute('aria-selected', i === active ? 'true' : 'false');
        const name = document.createElement('span');
        name.className = 'user-picker-option-name';
        name.textContent = entry.display;
        const key = document.createElement('span');
        key.className = 'user-picker-option-user';
        key.textContent = entry.user;
        option.appendChild(name);
        option.appendChild(key);
        els.List.appendChild(option);
    });
    const open = matches.length > 0;
    els.List.hidden = !open;
    els.Empty.hidden = open || !els.Search.value.trim();
    els.Search.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (active >= 0) els.Search.setAttribute('aria-activedescendant', 'userPickerOption' + active);
    else els.Search.removeAttribute('aria-activedescendant');
    els.Next.disabled = !picked;
    const current = els.List.querySelector('.is-active');
    if (current) current.scrollIntoView({ block: 'nearest' });
}

// Spaces and dots are the same, capitals do not count: "david m", "david.m"
// and "marra" all find David.Marra.
function words(value) {
    return String(value || '').toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

function filter() {
    const q = words(els.Search.value);
    matches = users.filter(u => !q || words(u.display).indexOf(q) >= 0 || words(u.user).indexOf(q) >= 0);
    active = matches.length && q ? 0 : -1;
    drawList();
}

// Step 1. removedUser names someone taken off the list.
function drawChoose(removedUser) {
    showOnly('choose');
    els.Title.textContent = 'Choose your name';
    els.Removed.hidden = !removedUser;
    els.Removed.textContent = removedUser ? removedUser + ' is no longer on the user list.' : '';
    els.SearchWrap.hidden = false;
    els.Next.hidden = false;
    els.Unavailable.hidden = true;
    els.Retry.hidden = true;
    els.Cancel.hidden = mode !== 'change';
    els.Empty.hidden = true;
    drawList();
    show();
    focusFirst();
}

// No names to choose from: the list is unavailable (no way in; the next check
// looks again), or the server did not answer as it should (Try again).
function drawBlocked(text, retry) {
    showOnly('blocked');
    els.Title.textContent = 'Choose your name';
    els.Removed.hidden = true;
    els.SearchWrap.hidden = true;
    els.Next.hidden = true;
    els.Unavailable.hidden = false;
    els.Unavailable.textContent = text;
    els.Retry.hidden = !retry;
    els.Cancel.hidden = mode !== 'change';
    show();
    focusFirst();
}

function drawConfirm() {
    showOnly('confirm');
    els.Choosing.textContent = 'You are choosing';
    els.ConfirmName.textContent = picked.display;
    els.ConfirmUser.textContent = picked.user;
    els.Continue.disabled = false;
    els.Back.disabled = false;
    show();
    els.Continue.focus({ preventScroll: true });
}

function drawChanged() {
    mode = 'changed';
    showOnly('changed');
    els.ChangedText.textContent = 'The user was changed in another tab. Reload the page.';
    show();
    els.Reload.focus({ preventScroll: true });
}

function focusFirst() {
    const target = showing === 'choose' ? els.Search
        : showing === 'blocked' && !els.Retry.hidden ? els.Retry
        : showing === 'confirm' ? els.Continue
        : showing === 'changed' ? els.Reload
        : modal;
    target.focus({ preventScroll: true });
}

// ── Checking ──

async function openPicker(removedUser) {
    picked = null;
    els.Search.value = '';
    matches = [];
    active = -1;
    const r = await ask('/api/users');
    if (r.problem) {
        drawBlocked(r.problem === 'unreachable' ? UNREACHABLE_TEXT : ODD_TEXT, true);
        return;
    }
    if (!r.json.available || !Array.isArray(r.json.users)) {
        drawBlocked(r.json.error || UNAVAILABLE_TEXT, false);
        return;
    }
    users = r.json.users.slice().sort((a, b) => a.display.localeCompare(b.display));
    filter();
    drawChoose(removedUser);
}

function begin(user, display) {
    pageUser = user;
    pageDisplay = display || String(user).split('.').join(' ');
    mode = '';
    hide();
    drawBar();
    if (resolveReady) {
        resolveReady(pageUser);
        resolveReady = null;
    }
}

function drawBar() {
    const bar = document.getElementById('navUserName');
    if (bar) {
        bar.textContent = pageDisplay;
        bar.title = pageUser;
    }
}

// The page's user is picked again: uncover, and let the QC Review window send
// what it held back for them.
function userBack() {
    if (mode === 'cover') {
        mode = '';
        hide();
    }
    window.dispatchEvent(new Event('sts-user-back'));
}

// Does the server still name this page's user? At start-up, on focus, when the
// tab comes back into view, once a minute, from Try again, and from the QC
// Review window when the server refuses a request for the user. Someone in the
// middle of choosing (a name typed or picked, the confirm step) is left alone.
async function check() {
    if (checking || committing || mode === 'changed') return;
    if (showing === 'confirm' || (showing === 'choose' && (picked || els.Search.value.trim()))) return;
    checking = true;
    try {
        const me = await ask('/api/me');
        if (me.problem || !me.ok) {
            // Covered or starting: say why, with Try again. Uncovered: the
            // app's own banner tells people when the server is away.
            if (mode === 'start' || mode === 'cover') drawBlocked(me.problem === 'unreachable' ? UNREACHABLE_TEXT : ODD_TEXT, true);
            return;
        }
        const json = me.json;
        if (json.user) {
            if (!pageUser) begin(json.user, json.display);
            else if (keyOf(json.user) !== keyOf(pageUser)) drawChanged();
            else if (mode !== 'change') userBack();
            return;
        }
        if (mode === 'change') return;   // choosing already; Continue decides
        mode = pageUser ? 'cover' : 'start';
        if (json.reason === 'list-unavailable') {
            drawBlocked(UNAVAILABLE_TEXT, false);
            return;
        }
        if (showing === 'choose') return;
        await openPicker(json.reason === 'removed' ? json.removedUser : '');
    } finally {
        checking = false;
    }
}

// ── Picking ──

function pick(entry) {
    picked = entry;
    els.Search.value = entry.display;
    matches = [entry];
    active = -1;
    drawList();
    els.List.hidden = true;
}

async function commit() {
    if (!picked || committing) return;
    els.Continue.disabled = true;
    els.Back.disabled = true;
    const r = await ask('/api/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: picked.user }) });
    if (!r.ok || !r.json.user) {
        // Taken off the list while choosing, the list broke, or no answer:
        // back to step 1, which says what it can (one message, not two).
        await openPicker();
        if (showing === 'choose') {
            els.Removed.hidden = false;
            els.Removed.textContent = r.json.error || 'That did not go through. Try again.';
        }
        return;
    }
    if (!pageUser) {
        begin(r.json.user, r.json.display);
        return;
    }
    if (keyOf(r.json.user) === keyOf(pageUser)) {
        // The same person again (the pick had run out): carry on.
        mode = 'cover';
        userBack();
        return;
    }
    // Someone else: this page's work order, lock and QC Review window belong
    // to the person it started with, so it starts again as the new one, once
    // the saves already on their way have finished. Nothing can undo the
    // switch from here: the cookie already names the new person.
    committing = true;
    if (typeof window.appSavesSettled === 'function') await window.appSavesSettled();
    window.location.reload();
}

function onKeyDown(e) {
    // Nothing typed here reaches the work order behind: its page-wide undo,
    // its Enter and Escape handlers.
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(String(e.key).toLowerCase())) {
        e.preventDefault();
        return;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        return;
    }
    if (e.key === 'Tab') {
        const list = Array.from(modal.querySelectorAll('input, button')).filter(x => !x.disabled && x.getClientRects().length && !x.closest('[hidden]'));
        if (!list.length) { e.preventDefault(); return; }
        const i = list.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); list[list.length - 1].focus(); }
        else if (!e.shiftKey && (i === -1 || i === list.length - 1)) { e.preventDefault(); list[0].focus(); }
        return;
    }
    if (e.target !== els.Search) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!matches.length || picked) { picked = null; filter(); }
        if (!matches.length) return;
        active = e.key === 'ArrowDown' ? Math.min(matches.length - 1, active + 1) : Math.max(0, active - 1);
        drawList();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (picked) els.Next.click();
        else if (active >= 0 && matches[active]) pick(matches[active]);
    }
}

modal.addEventListener('keydown', onKeyDown);
['keyup', 'input', 'change', 'focusin', 'mousedown', 'click'].forEach(type => {
    modal.addEventListener(type, e => e.stopPropagation());
});

// While the picker shows, the page behind it cannot be used from the keyboard
// either: focus that lands outside comes back, keys aimed outside are dropped,
// and the browser's own undo (the right-click menu) cannot take back typing in
// the work order, which app.js would then save (independent review B1, B6).
document.addEventListener('focusin', e => {
    if (!isShown() || modal.contains(e.target)) return;
    e.stopPropagation();
    focusFirst();
}, true);
document.addEventListener('keydown', e => {
    if (!isShown() || modal.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    focusFirst();
}, true);
document.addEventListener('beforeinput', e => {
    if (!isShown()) return;
    if (!modal.contains(e.target) || e.inputType === 'historyUndo' || e.inputType === 'historyRedo') e.preventDefault();
}, true);

els.Search.addEventListener('input', () => {
    picked = null;
    filter();
});
els.Search.addEventListener('focus', () => { if (!picked) filter(); });
els.List.addEventListener('mousedown', e => e.preventDefault());   // keep focus in the box
els.List.addEventListener('click', e => {
    const option = e.target.closest('.user-picker-option');
    if (!option) return;
    const entry = matches.find(u => u.user === option.getAttribute('data-user'));
    if (entry) pick(entry);
    els.Search.focus({ preventScroll: true });
});
els.Next.addEventListener('click', () => { if (picked && !committing) drawConfirm(); });
els.Back.addEventListener('click', () => {
    if (committing) return;
    showOnly('choose');
    els.Search.focus({ preventScroll: true });
});
els.Continue.addEventListener('click', commit);
els.Cancel.addEventListener('click', () => {
    if (mode !== 'change' || committing) return;
    mode = '';
    hide();
});
els.Retry.addEventListener('click', () => {
    if (mode === 'change') openPicker();
    else check();
});
els.Reload.addEventListener('click', () => window.location.reload());

// From the start, not only once someone is picked, so a tab still asking
// notices a name picked in another tab.
setInterval(check, CHECK_MS);
window.addEventListener('focus', check);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });

window.userPicker = {
    ready: () => readyPromise,
    user: () => pageUser,
    display: () => pageDisplay,
    cookieUser,
    checkNow: check,
    // Change user from the profile popover. app.js closes an open work order first.
    change() {
        if (!pageUser || isShown()) return;
        mode = 'change';
        openPicker();
    }
};

try { localStorage.removeItem('prepressUserName'); } catch (e) { /* storage blocked */ }
check();
})();
