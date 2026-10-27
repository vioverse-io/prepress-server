/* ═════════════════════════════════════════════════════════════════
   PASTED PATHS -- a path pasted into a path box comes out in its server form
   (docs/design_handoff_qc_review/PASTE_PATH_PLAN.md, David 2026-10-16).

   Windows' "Copy as path" puts a path in quotes and starts it with the drive
   letter. Pasted into a path box on the work order (app.js) or the Send to
   CSR box (review.js), it loses the quotes, and a letter the server names
   becomes that server: "M:\Art\a.pdf" becomes \\server\share\Art\a.pdf. The
   letters and their servers are the MAPPED_DRIVE_<letter> lines of the
   server's .env, read once from GET /api/mapped-drives, so the shop's server
   names are never in this file (it is public). Every PC at the shop maps the
   same letters (David, 2026-10-16). A letter not named (G:, C:) keeps it.

   Only a paste is looked at, a line at a time, never what is already in the
   box or what is typed. A paste with no path line in it is left to the
   browser exactly as it was. Loaded by index.html before app.js and
   review.js, and by dev/paste-path-check.js with require().
   ═════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

// { M: '\\\\server\\share' }: empty until the server answers, and while it is
// a pasted path only loses its quotes.
let drives = {};
let loaded = false;

// The two shapes the Send to CSR email makes a link of (review-mail.js
// PATH_LINE): a drive letter, a colon and a backslash, or two backslashes, a
// server name and a backslash.
const DRIVE_PATH = /^[A-Za-z]:\\/;
const SERVER_PATH = /^\\\\[^\\/:*?"<>|]+\\/;

// One pasted line in its server form, or null when it is not a path. The
// spaces round it go, then a straight quote at either end, each on its own: a
// path copied out of an email can come with only one of the pair (David's
// test, 2026-10-17), and Windows never allows a quote in a name. A quote left
// inside means it was something else ("Art is at "M:\a.pdf"").
function serverLine(line, map) {
    let path = String(line).trim();
    if (path[0] === '"') path = path.slice(1);
    if (path[path.length - 1] === '"') path = path.slice(0, -1);
    if (path.includes('"')) return null;
    if (SERVER_PATH.test(path)) return path;
    if (!DRIVE_PATH.test(path)) return null;
    const server = (map || {})[path[0].toUpperCase()];
    return server ? server + path.slice(2) : path;
}

// The whole paste in its server form, or null when no line of it is a path.
// Every other line stays exactly as it was; the lines are joined by plain
// line breaks, which a box makes of Windows' \r\n anyway.
function serverForm(text, map) {
    let any = false;
    const lines = String(text).split(/\r\n|\r|\n/).map(line => {
        const path = serverLine(line, map);
        if (path === null) return line;
        any = true;
        return path;
    });
    return any ? lines.join('\n') : null;
}

// The list of drives, once. A failed read is tried again at the next paste.
function load() {
    loaded = true;
    fetch('/api/mapped-drives', { cache: 'no-store' })
        .then(res => (res.ok ? res.json() : null))
        .then(data => {
            if (data && data.drives && typeof data.drives === 'object') drives = data.drives;
            else loaded = false;
        })
        .catch(() => { loaded = false; });
}

// A paste into a box. When something in it is a path, the browser's own paste
// is stopped and the server form put in with insertText: the box's own Ctrl+Z
// takes it back in one step, a maxlength still cuts it, and its input event
// saves the box and turns its switch on as typing does. A read-only box (a
// viewed job) is left alone, as is a box insertText cannot reach.
function onPaste(e) {
    const box = e.target;
    if (!loaded) load();
    if (e.defaultPrevented || !box || box.readOnly || box.disabled || !e.clipboardData) return;
    if (document.activeElement !== box || !document.queryCommandEnabled('insertText')) return;
    const text = e.clipboardData.getData('text/plain');
    const out = text ? serverForm(text, drives) : null;
    if (out === null || out === text) return;
    e.preventDefault();
    document.execCommand('insertText', false, out);
}

const api = { serverLine, serverForm, onPaste };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else {
    window.PASTE_PATH = api;
    load();
}

})();
