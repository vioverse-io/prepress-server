require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { getPool, query, healthCheck, sql } = require('./db');
const { createUserList, userKey, displayName, isUser, seenCookieName, UNAVAILABLE_TEXT: USER_LIST_UNAVAILABLE } = require('./user-list');
const reviewMail = require('./review-mail');
const reviewWords = require('./review-words');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Build identity ──
//
// Which build is actually running? On 2026-08-10 nobody could answer that for
// five hours, because an old server.js process kept serving the new static
// files -- express.static reads from disk per request, so the frontend looked
// fully updated while the backend was still the previous build. These two
// values answer it from outside, over HTTP, without logging into the server.
//
// version comes from package.json, so package.json must be swapped ALONGSIDE
// server.js or this reports the version it just replaced.
//
// startedAt is stamped when this process boots, and it is the direct test for
// the stale-process failure above: if it predates the file swap, the service
// did not actually restart, whatever the files on disk say.
let APP_VERSION = 'unknown';
try {
    APP_VERSION = require('./package.json').version || 'unknown';
} catch (e) {
    // Reported as 'unknown' rather than thrown. A missing or unreadable
    // package.json must never stop the app serving work orders.
}
const STARTED_AT = new Date().toISOString();

app.use(express.json({ limit: '5mb' }));

// ── Who is using the app: the user picker (USER_PICKER_PLAN.md) ──
//
// People pick their own name from the user list (user-list.js, USER_LIST_FILE
// in .env). This is an approved honor system, not a sign-in: nothing proves who
// anyone is, and no password is asked for, stored, sent or logged. It replaced
// the Windows sign-in (NTLM) on 2026-09-14, because a mistyped Windows password
// locked people out of Windows itself.
//
// The pick lives in the sts_user cookie, set by POST /api/me and checked on
// every request against the current list. It is the only thing this server
// reads to know who is asking (req.appUser). The page reads it too (no
// HttpOnly), to see a change made in another tab; that changes nothing about
// trust, as nothing here is proven.
//
// How long it counts is a second cookie, one per person (seenCookieName): it
// lasts USER_REMEMBER_MINUTES (default 720, 12 hours) and is renewed by every
// request except the page's own once-a-minute check, so the pick runs out
// after that long without the app being used. Only POST and DELETE /api/me
// ever write sts_user. A renewal that rewrote it would carry the value its
// request was sent with, so a request from one tab answered after another tab
// picked someone else would put the old user back (seen in a browser check).

const userList = createUserList({ file: process.env.USER_LIST_FILE, baseDir: __dirname });
const USER_COOKIE = 'sts_user';
const startupNotes = [];   // logged after the version line

let REMEMBER_MINUTES = 720;
if (String(process.env.USER_REMEMBER_MINUTES || '').trim() !== '') {
    const minutes = Number(String(process.env.USER_REMEMBER_MINUTES).trim());
    if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 525600) REMEMBER_MINUTES = minutes;
    else startupNotes.push('USER_REMEMBER_MINUTES must be a whole number of minutes (1 to 525600); using 720.');
}

const leftoverNtlm = ['NTLM_AUTH', 'NTLM_DOMAINCONTROLLER', 'NTLM_DOMAIN'].filter(name => process.env[name] !== undefined);
if (leftoverNtlm.length) {
    startupNotes.push(leftoverNtlm.join(', ') + ' in .env ' + (leftoverNtlm.length === 1 ? 'is' : 'are') +
        ' no longer used: Windows sign-in was replaced by the user list. ' + (leftoverNtlm.length === 1 ? 'It' : 'They') + ' can be removed.');
}

// ── Pasted paths (PASTE_PATH_PLAN.md, David 2026-10-16) ──
//
// A path pasted into a path box loses the quotes Windows' "Copy as path" puts
// round it, and a drive letter named here becomes its server: the page does it
// (public/js/paste-path.js) from this list. One .env line a drive,
// MAPPED_DRIVE_M=\\server\share, so the shop's server names stay out of the
// code, which is public. Read once at start. A value must be a server and a
// share at least; in double quotes dotenv reads "\n" as a line break, which
// fails that test and is left out with a line in the log.
const MAPPED_DRIVE_VALUE = /^\\\\[^\\/:*?"<>|\x00-\x1f]+(\\[^\\/:*?"<>|\x00-\x1f]+)+$/;
const mappedDrives = {};
Object.keys(process.env).sort().forEach(name => {
    const m = /^MAPPED_DRIVE_([A-Z])$/i.exec(name);
    if (!m) return;
    const letter = m[1].toUpperCase();
    const value = String(process.env[name]).trim().replace(/\\+$/, '');
    if (!value) return;
    if (MAPPED_DRIVE_VALUE.test(value)) mappedDrives[letter] = value;
    else startupNotes.push(name + ' is not a server path like \\\\server\\share, so it was left out: ' + letter + ': keeps its letter when pasted.');
});
startupNotes.push(Object.keys(mappedDrives).length
    ? 'Pasted paths: ' + Object.keys(mappedDrives).map(letter => letter + ': is ' + mappedDrives[letter]).join(', ') + '.'
    : 'Pasted paths: no MAPPED_DRIVE_ lines, so a pasted path only loses its quotes.');

// ── Email (PHASE5_PLAN.md, step 5; OUTLOOK_EMAIL_PLAN.md, 2026-10-26) ──
//
// The app never sends an email. A press that emails builds the email before
// it answers (review-mail.js: who is in To, the subject, the words, the mailto
// link) and puts it in its reply as `emails`; the page hands each one to a
// hidden frame, Outlook opens it on the presser's own screen, and they press
// Send (IT's decision in the 2026-10-26 meeting). On when APP_BASE_URL and
// USER_EMAIL_DOMAIN are set, off with one log line otherwise, and nothing else
// changes with it off. Building can never hold up or refuse a press:
// mailEmails catches everything, answers with no email, and says so in the
// job's activity and the log. The page then tells the server which emails it
// opened (POST .../email-opened), and that is the history row.

const mailSettings = reviewMail.readSettings(process.env);
const mailOn = () => mailSettings.mode === 'on';

// Runs one press's email builder and answers its emails, or none. A failure
// (the roster could not be read, a piece read threw) is one log line a minute
// and one history row, never an error on the press, which is already saved.
let _mailBuildSaid = 0;
async function mailEmails(pool, stamp, run) {
    if (!mailOn()) return [];
    try {
        const out = await run();
        return (Array.isArray(out) ? out : [out]).filter(Boolean);
    } catch (err) {
        const at = Date.now();
        if (at - _mailBuildSaid > 60000) {
            _mailBuildSaid = at;
            console.error('QC REVIEW EMAIL NOT BUILT: ' + (err && err.message ? err.message : String(err)));
        }
        try {
            await mailLogRow(pool, stamp, 'email_not_sent', { detail: 'No email: the people to send it to could not be read.' });
        } catch (e2) {
            // The press itself is saved; the log line above is all that is left to say.
        }
        return [];
    }
}

function readUserCookie(req) {
    return readCookie(req, USER_COOKIE);
}

// sts_user itself is kept for 400 days (the longest a browser keeps a
// cookie); the remember cookie decides whether it still counts.
function userCookie(user) {
    return USER_COOKIE + '=' + encodeURIComponent(user) + '; Path=/; Max-Age=34560000; SameSite=Lax';
}

function seenCookie(user, clear) {
    return seenCookieName(user) + '=' + (clear ? '; Path=/; Max-Age=0' : '1; Path=/; Max-Age=' + REMEMBER_MINUTES * 60) + '; SameSite=Lax';
}

function readCookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
        const at = part.indexOf('=');
        if (at < 0 || part.slice(0, at).trim() !== name) continue;
        try { return decodeURIComponent(part.slice(at + 1).trim()); } catch (e) { return ''; }
    }
    return '';
}

// ── Health Check ──
// Deliberately open and first, so IT can check SQL connectivity and the user
// list even when nothing else works. It carries the build identity for the
// same reason: during a bad deploy this is routinely the only route answering.

app.get('/api/health', async (req, res) => {
    const status = await healthCheck();
    const users = userList.current();
    // reviews reports the last QC Review table check, reviewForms the
    // formVersion of each checklist this process loaded (see "QC Review"
    // below), users the user list ("ok", "stale" after a bad read, or
    // "unavailable") and how many are on it, never where it is, and mail
    // "off" or "on" (the email each press opens in Outlook), never an
    // address. None changes the status code: the browser's save-retry poller
    // waits for a 200 here.
    res.status(status.connected ? 200 : 503).json(
        Object.assign({ version: APP_VERSION, startedAt: STARTED_AT, reviews: reviewsHealth(), reviewForms,
            users: users.status, userCount: users.count, mail: mailOn() ? 'on' : 'off' }, status)
    );
});

// The picked user on every request: the cookie names someone on the list, and
// their remember cookie has not run out.
app.use((req, res, next) => {
    const raw = readUserCookie(req);
    const entry = isUser(raw) ? userList.find(raw) : null;
    if (entry && readCookie(req, seenCookieName(entry.user)) === '1') {
        req.appUser = { user: entry.user, key: entry.key };
        if (!(req.method === 'GET' && req.path === '/api/me')) res.append('Set-Cookie', seenCookie(entry.user));
    }
    next();
});

// GET /api/users -- the list for the picker.
app.get('/api/users', (req, res) => {
    const list = userList.current();
    if (list.status === 'unavailable') return res.json({ available: false, users: [], error: USER_LIST_UNAVAILABLE });
    res.json({ available: true, users: list.users.map(u => ({ user: u.user, display: u.display })) });
});

// GET /api/mapped-drives -- the drives a pasted path is rewritten with, from
// the MAPPED_DRIVE_ lines (above): { drives: { M: '\\\\server\\share' } }.
app.get('/api/mapped-drives', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ drives: mappedDrives });
});

// GET /api/me -- who the cookie names: { user, display }, or { user: null, reason }
// where reason is none, removed (with removedUser) or list-unavailable. The
// page asks on focus and every minute, so this never renews the cookie.
app.get('/api/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (userList.current().status === 'unavailable') return res.json({ user: null, reason: 'list-unavailable' });
    if (req.appUser) return res.json({ user: req.appUser.user, display: displayName(req.appUser.user) });
    const raw = readUserCookie(req);
    // Named, but not on the list any more; a pick that ran out is just none.
    if (isUser(raw) && !userList.find(raw)) return res.json({ user: null, reason: 'removed', removedUser: raw });
    res.json({ user: null, reason: 'none' });
});

// POST /api/me { user } -- picks a user. Only a user on the list, in any
// capitals; the cookie holds the list's spelling.
app.post('/api/me', (req, res) => {
    if (userList.current().status === 'unavailable') return res.status(503).json({ error: USER_LIST_UNAVAILABLE });
    const value = req.body ? req.body.user : undefined;
    const entry = isUser(value) ? userList.find(value) : null;
    if (!entry) return res.status(400).json({ error: 'That name is not on the user list.' });
    res.setHeader('Set-Cookie', [userCookie(entry.user), seenCookie(entry.user)]);
    res.json({ user: entry.user, display: entry.display });
});

// DELETE /api/me -- Change user: forgets the pick.
app.delete('/api/me', (req, res) => {
    const raw = readUserCookie(req);
    const cleared = [USER_COOKIE + '=; Path=/; Max-Age=0; SameSite=Lax'];
    if (isUser(raw)) cleared.push(seenCookie(raw, true));
    res.setHeader('Set-Cookie', cleared);
    res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Admin Password Verification ──

const ADMIN_HASH = 'd6a9066ff92289a82ff3dc163f9476aafadebb336c770278d871b8d8d9848727';

app.post('/api/verify-admin', (req, res) => {
    const { password } = req.body;
    if (!password) return res.json({ verified: false });
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    res.json({ verified: hash === ADMIN_HASH });
});

// ── Roster (CSRs and department assignees) ──
//
// These lists used to be hardcoded in the frontend, so adding a CSR or
// retiring one meant editing app.js and having IT swap the file. They live in
// a table now and are managed from the app.
//
// Every failure path here is deliberately soft. If the table cannot be created
// or read, the routes return an empty roster and the frontend falls back to
// the constants it has always used, so a roster problem can never stop people
// working on jobs.

const ROSTER_KINDS = ['csr', 'prepress', 'techservices'];

// Which job column each list drives. Fixed whitelist -- these three strings are
// the only values ever interpolated into the usage/reassign SQL below, so a
// client cannot steer the column.
const ROSTER_COLUMN = {
    csr:          'csrName',
    prepress:     'assignedToPrepress',
    techservices: 'assignedToTechservices'
};

function isAdmin(password) {
    if (!password) return false;
    return crypto.createHash('sha256').update(password).digest('hex') === ADMIN_HASH;
}

let _rosterReady = false;

// Creates the table on first use and seeds it from the defaults the frontend
// sends. Seeding only happens when the table is empty, so it never resurrects
// a name that was deliberately deactivated.
async function ensureRoster(seed) {
    if (_rosterReady) return true;
    try {
        const pool = await getPool();
        await pool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='roster' AND xtype='U')
            CREATE TABLE roster (
                id        INT IDENTITY(1,1) PRIMARY KEY,
                kind      NVARCHAR(20)  NOT NULL,
                name      NVARCHAR(100) NOT NULL,
                active    BIT           NOT NULL DEFAULT 1,
                addedBy   NVARCHAR(100) DEFAULT '',
                addedDate NVARCHAR(30)  DEFAULT ''
            )
        `);

        if (seed && typeof seed === 'object') {
            const count = await pool.request().query('SELECT COUNT(*) AS n FROM roster');
            if (count.recordset[0].n === 0) {
                const now = new Date().toISOString();
                for (const kind of ROSTER_KINDS) {
                    for (const name of (seed[kind] || [])) {
                        if (!name || !String(name).trim()) continue;
                        await pool.request()
                            .input('kind', kind)
                            .input('name', String(name).trim())
                            .input('addedDate', now)
                            .query(`INSERT INTO roster (kind, name, active, addedBy, addedDate)
                                    VALUES (@kind, @name, 1, 'seed', @addedDate)`);
                    }
                }
                console.log('Roster table seeded from frontend defaults');
            }
        }
        _rosterReady = true;
        return true;
    } catch (err) {
        // Most likely the app's SQL account lacks CREATE TABLE rights. Say so
        // once, plainly, and keep serving. The frontend falls back on its own.
        console.error('Roster table unavailable: ' + err.message);
        console.error('The app still works; the CSR and assignee lists fall back to their built-in values.');
        console.error('To enable editing them in the app, run this once in SSMS against ' + (process.env.SQL_DATABASE || 'STS_WorkOrder') + ':');
        console.error("  CREATE TABLE roster (id INT IDENTITY(1,1) PRIMARY KEY, kind NVARCHAR(20) NOT NULL, name NVARCHAR(100) NOT NULL, active BIT NOT NULL DEFAULT 1, addedBy NVARCHAR(100) DEFAULT '', addedDate NVARCHAR(30) DEFAULT '');");
        console.error('  ...or grant the service account db_ddladmin and restart.');
        return false;
    }
}

// GET /api/roster -- the frontend posts its built-in lists as the seed on the
// first call, so the table starts life matching exactly what shipped.
app.post('/api/roster', async (req, res) => {
    const ok = await ensureRoster(req.body && req.body.seed);
    if (!ok) return res.json({ available: false, people: [] });
    try {
        const pool = await getPool();
        // windowsLogin and emailOff only once sql/create-review-tables.sql has
        // added them. Every page load passes here, so this is also where a
        // re-run of that file is noticed without a restart.
        const col = await pool.request().query(
            `SELECT CASE WHEN COL_LENGTH(N'roster', N'windowsLogin') IS NULL THEN 0 ELSE 1 END AS hasLogin,
                    CASE WHEN COL_LENGTH(N'roster', N'emailOff') IS NULL THEN 0 ELSE 1 END AS hasEmailOff`
        );
        _rosterHasEmailOff = !!col.recordset[0].hasEmailOff;
        const result = await pool.request().query(
            'SELECT id, kind, name, active' + (col.recordset[0].hasLogin ? ", ISNULL(windowsLogin, N'') AS windowsLogin" : '') +
            (col.recordset[0].hasEmailOff ? ', CAST(ISNULL(emailOff, 0) AS BIT) AS emailOff' : '') +
            ' FROM roster ORDER BY kind, name'
        );
        res.json({ available: true, people: result.recordset });
    } catch (err) {
        // The table was reachable at ensureRoster() but the read failed. Clear
        // the ready flag so the next call rebuilds it, instead of latching the
        // roster off until a restart.
        _rosterReady = false;
        res.json({ available: false, people: [], error: err.message });
    }
});

// User links and adds, one at a time. Each reads the roster and then writes
// it, so two at the same moment could both pass the duplicate check and link
// one user to two names (independent review Q4). The app is one process, so a
// queue here is enough.
let _rosterLinkQueue = Promise.resolve();
function oneRosterChangeAtATime(handler) {
    return (req, res) => {
        const run = _rosterLinkQueue.then(() => handler(req, res));
        _rosterLinkQueue = run.catch(() => {});
        return run;
    };
}

// The user already linked to exactly this name (capitals counted, as the link
// route stores it), '' for none, or null when the roster has no windowsLogin
// column yet.
async function rosterLinkedLogin(pool, name) {
    const col = await pool.request().query(
        "SELECT CASE WHEN COL_LENGTH(N'dbo.roster', N'windowsLogin') IS NULL THEN 0 ELSE 1 END AS hasLogin"
    );
    if (!col.recordset[0].hasLogin) return null;
    const r = await pool.request()
        .input('rosterName', name)
        .query(`SELECT windowsLogin FROM dbo.roster
                WHERE name COLLATE Latin1_General_BIN2 = @rosterName COLLATE Latin1_General_BIN2
                  AND LTRIM(RTRIM(ISNULL(windowsLogin, N''))) <> N''`);
    const keys = [...new Set(r.recordset.map(x => loginKey(x.windowsLogin)))];
    return keys.length === 1 ? r.recordset[0].windowsLogin : '';
}

// The Email switch of the person with exactly this name (capitals counted, as
// the switch route stores it): true when it is off on any of their rows, false
// when on, or null when the roster has no emailOff column yet.
async function rosterEmailOff(pool, name) {
    const col = await pool.request().query(
        "SELECT CASE WHEN COL_LENGTH(N'dbo.roster', N'emailOff') IS NULL THEN 0 ELSE 1 END AS hasEmailOff"
    );
    _rosterHasEmailOff = !!col.recordset[0].hasEmailOff;
    if (!_rosterHasEmailOff) return null;
    const r = await pool.request()
        .input('rosterName', name)
        .query(`SELECT COUNT(*) AS n FROM dbo.roster
                WHERE name COLLATE Latin1_General_BIN2 = @rosterName COLLATE Latin1_General_BIN2
                  AND emailOff = 1`);
    return r.recordset[0].n > 0;
}

// Add a name. Admin password is verified here, not trusted from the client.
// Someone already linked to a user keeps it on the new list too, or the review
// locks would not count that list for them. Their Email switch comes with them
// the same way: it belongs to the person, so someone switched off on one list
// is not switched back on by being added to another. A name on no list starts
// with email on.
app.post('/api/roster/add', oneRosterChangeAtATime(async (req, res) => {
    const { kind, name, password, addedBy } = req.body || {};
    if (!isAdmin(password)) return res.status(403).json({ error: 'Admin password required' });
    if (!ROSTER_KINDS.includes(kind)) return res.status(400).json({ error: 'Unknown list' });
    const clean = (name || '').trim();
    if (!clean) return res.status(400).json({ error: 'Name is required' });

    const ok = await ensureRoster(null);
    if (!ok) return res.status(503).json({ error: 'Roster table unavailable' });
    try {
        const pool = await getPool();
        // Case-insensitive duplicate check. If the name is already there but
        // deactivated, reactivate it rather than creating a second row.
        const existing = await pool.request()
            .input('kind', kind).input('name', clean)
            .query('SELECT id, active, name FROM roster WHERE kind = @kind AND name = @name');
        if (existing.recordset.length > 0) {
            const row = existing.recordset[0];
            if (!row.active) {
                const login = await rosterLinkedLogin(pool, row.name);
                await pool.request().input('id', row.id).input('windowsLogin', login || '')
                    .query('UPDATE roster SET active = 1' + (login ? ', windowsLogin = @windowsLogin' : '') + ' WHERE id = @id');
                return res.json({ reactivated: true, id: row.id });
            }
            return res.status(409).json({ error: 'That name is already on the list' });
        }
        const login = await rosterLinkedLogin(pool, clean);
        const emailOff = await rosterEmailOff(pool, clean);
        const ins = await pool.request()
            .input('kind', kind).input('name', clean)
            .input('addedBy', (addedBy || '').trim())
            .input('addedDate', new Date().toISOString())
            .input('windowsLogin', login || '')
            .input('emailOff', emailOff ? 1 : 0)
            .query(`INSERT INTO roster (kind, name, active, addedBy, addedDate${login === null ? '' : ', windowsLogin'}${emailOff === null ? '' : ', emailOff'})
                    OUTPUT INSERTED.id VALUES (@kind, @name, 1, @addedBy, @addedDate${login === null ? '' : ', @windowsLogin'}${emailOff === null ? '' : ', @emailOff'})`);
        res.json({ added: true, id: ins.recordset[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}));

// Activate or deactivate. Never deletes: existing jobs still carry the name,
// and the landing filter still needs to offer it for those jobs.
app.put('/api/roster/:id', async (req, res) => {
    const { active, password } = req.body || {};
    if (!isAdmin(password)) return res.status(403).json({ error: 'Admin password required' });
    const ok = await ensureRoster(null);
    if (!ok) return res.status(503).json({ error: 'Roster table unavailable' });
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('id', parseInt(req.params.id, 10))
            .input('active', active ? 1 : 0)
            .query('UPDATE roster SET active = @active WHERE id = @id');
        if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ updated: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/roster/:id/login -- the user (from the user list) for the person on
// this row. QC Review knows a person only by the user they picked, and jobs
// name people by roster name ("Stef Tarpy" may be the user Stephanie.Tarpy),
// so this link is what lets the review locks tell who anyone is. It is stored
// in the list's spelling on every roster row with exactly this row's name
// (capitals counted, the same BIN2 guard as the merge tool), so someone on two
// lists is linked once. Only a user on the list can be saved. A user already
// linked to a different name is refused, compared by key. An empty value (Not
// linked) clears it. The column keeps its old name, windowsLogin.
app.put('/api/roster/:id/login', oneRosterChangeAtATime(async (req, res) => {
    const { windowsLogin, password } = req.body || {};
    if (!isAdmin(password)) return res.status(403).json({ error: 'Admin password required' });
    const clean = String(windowsLogin == null ? '' : windowsLogin).trim();
    if (clean.length > 100) return res.status(400).json({ error: 'A user is 100 characters at most.' });
    let entry = null;
    if (clean) {
        if (userList.current().status === 'unavailable') return res.status(503).json({ error: USER_LIST_UNAVAILABLE });
        entry = isUser(clean) ? userList.find(clean) : null;
        if (!entry) return res.status(400).json({ error: 'That user is not on the user list.' });
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
    try {
        const pool = await getPool();
        const col = await pool.request().query(
            "SELECT CASE WHEN COL_LENGTH(N'dbo.roster', N'windowsLogin') IS NULL THEN 0 ELSE 1 END AS hasLogin"
        );
        if (!col.recordset[0].hasLogin) {
            return res.status(503).json({ error: 'The roster has no user column yet. Run sql\\create-review-tables.sql (see README.md).' });
        }
        const row = await pool.request().input('rosterId', id).query('SELECT name FROM dbo.roster WHERE id = @rosterId');
        if (!row.recordset.length) return res.status(404).json({ error: 'Not found' });
        const name = row.recordset[0].name;
        if (entry) {
            const others = await pool.request()
                .input('rosterName', name)
                .query(`SELECT name, windowsLogin FROM dbo.roster
                        WHERE LTRIM(RTRIM(ISNULL(windowsLogin, N''))) <> N''
                          AND name COLLATE Latin1_General_BIN2 <> @rosterName COLLATE Latin1_General_BIN2`);
            const taken = others.recordset.find(x => loginKey(x.windowsLogin) === entry.key);
            if (taken) return res.status(409).json({ error: entry.user + ' is already linked to ' + taken.name });
        }
        const stored = entry ? entry.user : '';
        await pool.request()
            .input('rosterName', name)
            .input('windowsLogin', stored)
            .query(`UPDATE dbo.roster SET windowsLogin = @windowsLogin
                    WHERE name COLLATE Latin1_General_BIN2 = @rosterName COLLATE Latin1_General_BIN2`);
        res.json({ updated: true, name, windowsLogin: stored });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}));

// PUT /api/roster/:id/email { on, password } -- the Email switch for the person
// on this row (EMAIL_SWITCH_PLAN, David 2026-10-02). Off means that person gets
// no QC Review email at all: not the ones that go to their department's list
// and not the ones that would be theirs alone (as operator, as whoever sent a
// piece back, as the job's CSR). They stay on the list, can still be assigned
// and can still work the checklist. Like the user link it belongs to the
// person, so it is stored on every roster row with exactly this row's name
// (capitals counted, the same BIN2 guard). The column holds Off, so a name
// nobody has touched is On.
app.put('/api/roster/:id/email', oneRosterChangeAtATime(async (req, res) => {
    const { on, password } = req.body || {};
    if (!isAdmin(password)) return res.status(403).json({ error: 'Admin password required' });
    if (on !== true && on !== false) return res.status(400).json({ error: 'Email is either on or off.' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
    try {
        const pool = await getPool();
        const col = await pool.request().query(
            "SELECT CASE WHEN COL_LENGTH(N'dbo.roster', N'emailOff') IS NULL THEN 0 ELSE 1 END AS hasEmailOff"
        );
        _rosterHasEmailOff = !!col.recordset[0].hasEmailOff;
        if (!_rosterHasEmailOff) {
            return res.status(503).json({ error: 'The roster has no email switch yet. Run sql\\create-review-tables.sql again (see README.md).' });
        }
        const row = await pool.request().input('rosterId', id).query('SELECT name FROM dbo.roster WHERE id = @rosterId');
        if (!row.recordset.length) return res.status(404).json({ error: 'Not found' });
        const name = row.recordset[0].name;
        await pool.request()
            .input('rosterName', name)
            .input('emailOff', on ? 0 : 1)
            .query(`UPDATE dbo.roster SET emailOff = @emailOff
                    WHERE name COLLATE Latin1_General_BIN2 = @rosterName COLLATE Latin1_General_BIN2`);
        res.json({ updated: true, name, emailOn: on });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}));

// POST /api/roster/link-users { password } -- "Link matching names". Every
// roster name that is turned on somewhere and linked nowhere is linked to the
// user whose words are the same ("David Marra" and David.Marra, any capitals).
// Never a guess: a name with no such user, a user already linked to another
// name, and two names matching one user are all left for an admin to link by
// hand. Answers { linked: [{ name, user }], left: [names still not linked] }.
app.post('/api/roster/link-users', oneRosterChangeAtATime(async (req, res) => {
    if (!isAdmin((req.body || {}).password)) return res.status(403).json({ error: 'Admin password required' });
    if (userList.current().status === 'unavailable') return res.status(503).json({ error: USER_LIST_UNAVAILABLE });
    try {
        const pool = await getPool();
        const col = await pool.request().query(
            "SELECT CASE WHEN COL_LENGTH(N'dbo.roster', N'windowsLogin') IS NULL THEN 0 ELSE 1 END AS hasLogin"
        );
        if (!col.recordset[0].hasLogin) {
            return res.status(503).json({ error: 'The roster has no user column yet. Run sql\\create-review-tables.sql (see README.md).' });
        }
        const rows = (await pool.request().query('SELECT name, active, windowsLogin FROM dbo.roster')).recordset;
        const names = new Map();   // exact name -> { active, linked }
        const taken = new Set();   // user keys linked to some name
        rows.forEach(row => {
            const login = String(row.windowsLogin || '').trim();
            const entry = names.get(row.name) || { active: false, linked: false };
            if (row.active) entry.active = true;
            if (login) { entry.linked = true; taken.add(loginKey(login)); }
            names.set(row.name, entry);
        });
        const open = [...names.keys()].filter(name => names.get(name).active && !names.get(name).linked);
        // Each name's user worked out once, from one reading of the list, so
        // a list changed mid-request cannot change the answer halfway. The
        // words joined by dots must themselves be a user: find() alone would
        // also drop a DOMAIN\ in front or an @ part (independent review S4).
        const byKey = new Map(userList.current().users.map(u => [u.key, u]));
        const matches = new Map(); // name -> the listed user with the same words
        const wanted = new Map();  // user key -> names matching it
        open.forEach(name => {
            const words = String(name).trim().split(/\s+/).join('.');
            const entry = isUser(words) ? byKey.get(userKey(words)) : null;
            if (!entry) return;
            matches.set(name, entry);
            wanted.set(entry.key, (wanted.get(entry.key) || []).concat(name));
        });
        const linked = [];
        for (const name of open) {
            const entry = matches.get(name);
            if (!entry || taken.has(entry.key) || wanted.get(entry.key).length !== 1) continue;
            await pool.request()
                .input('rosterName', name)
                .input('windowsLogin', entry.user)
                .query(`UPDATE dbo.roster SET windowsLogin = @windowsLogin
                        WHERE name COLLATE Latin1_General_BIN2 = @rosterName COLLATE Latin1_General_BIN2`);
            taken.add(entry.key);
            linked.push({ name, user: entry.user });
        }
        const done = new Set(linked.map(x => x.name));
        const left = open.filter(name => !done.has(name)).sort((a, b) => a.localeCompare(b));
        res.json({ linked, left });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}));

// GET /api/roster/usage -- every distinct person-name actually stamped on a
// job (active AND archived), per list, with a count. The cleanup UI compares
// this against the roster to show which old imported names still need merging.
//
// COLLATE Latin1_General_BIN2 is the same guard sql/fix-user-names.sql uses and
// it is not optional. This database is case-insensitive, so without it SQL
// Server folds "stef tarpy" and "Stef Tarpy" into a single row and the cleanup
// list reports nothing wrong. The landing filter is browser code and does count
// capitals, so it would show that person twice with their jobs split between
// the two spellings, and nothing here would ever offer to fix it.
app.get('/api/roster/usage', async (req, res) => {
    try {
        const pool = await getPool();
        const usage = {};
        for (const kind of ROSTER_KINDS) {
            const col = ROSTER_COLUMN[kind];
            const r = await pool.request().query(
                `SELECT LTRIM(RTRIM(${col})) COLLATE Latin1_General_BIN2 AS name, COUNT(*) AS count
                 FROM jobs
                 WHERE LTRIM(RTRIM(ISNULL(${col}, ''))) <> ''
                 GROUP BY LTRIM(RTRIM(${col})) COLLATE Latin1_General_BIN2
                 ORDER BY name`
            );
            usage[kind] = r.recordset;
        }
        res.json({ usage });
    } catch (err) {
        res.json({ usage: null, error: err.message });
    }
});

// POST /api/roster/reassign -- move every job whose column matches fromName
// (trimmed, capitals counted) onto toName. This is the bulk merge: one call
// turns all of "Brandy", "Brandi" etc. into "Brandilee Czajkowski". Covers
// archived jobs too, since they share the table.
//
// Both comparisons force Latin1_General_BIN2 for the same reason the usage
// query above does. On the default case-insensitive collation the second test
// reads "already correct" for a name that differs only in capitals, so moving
// "stef tarpy" onto "Stef Tarpy" would silently update nothing.
//
// rowVersion goes up on every job it moves (the overall review's R04,
// 2026-10-01). It used to stay, on the grounds that these are old jobs nobody
// is editing, but a job list loaded before the merge then wrote the old
// spelling back with its next status change, with no warning, and an open
// work order did the same with its next save. Moving the version makes every
// copy older than the merge meet the ordinary reload box, an open work order
// catch up, a view redraw and a print fetch the latest. It stamps nothing:
// lastModified and lastModifiedBy stay as they were.
app.post('/api/roster/reassign', async (req, res) => {
    const { kind, fromName, toName, password } = req.body || {};
    if (!isAdmin(password)) return res.status(403).json({ error: 'Admin password required' });
    const col = ROSTER_COLUMN[kind];
    if (!col) return res.status(400).json({ error: 'Unknown list' });
    const from = (fromName || '').trim();
    const to   = (toName   || '').trim();
    if (!from || !to) return res.status(400).json({ error: 'Both names are required' });
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('from', from)
            .input('to', to)
            .query(`UPDATE jobs SET ${col} = @to, rowVersion = rowVersion + 1
                    WHERE LTRIM(RTRIM(${col})) COLLATE Latin1_General_BIN2 = @from COLLATE Latin1_General_BIN2
                      AND ${col} COLLATE Latin1_General_BIN2 <> @to COLLATE Latin1_General_BIN2`);
        res.json({ moved: result.rowsAffected[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Jobs: List active ──

app.get('/api/jobs', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(
            `SELECT * FROM jobs WHERE archivedDate IS NULL OR archivedDate = '' ORDER BY lastModified DESC`
        );
        // Attach components to each job
        const jobs = result.recordset;
        if (jobs.length > 0) {
            const comps = await pool.request().query(
                `SELECT * FROM components WHERE jobId IN (SELECT id FROM jobs WHERE archivedDate IS NULL OR archivedDate = '') ORDER BY sortOrder, id`
            );
            const compMap = {};
            comps.recordset.forEach(c => {
                if (!compMap[c.jobId]) compMap[c.jobId] = [];
                compMap[c.jobId].push(formatComponent(c));
            });
            jobs.forEach(j => {
                j.components = compMap[j.id] || [];
                j.deletionLog = safeParseJSON(j.deletionLog, []);
            });
        }
        res.json(jobs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Jobs: Single with components ──

app.get('/api/jobs/:id', async (req, res) => {
    try {
        await lastSaveLanded(req.params.id);   // item 6: F5 reads what the closing page sent
        const result = await query`SELECT * FROM jobs WHERE id = ${req.params.id}`;
        if (result.recordset.length === 0) return res.status(404).json({ error: 'Job not found' });
        const job = result.recordset[0];
        const comps = await query`SELECT * FROM components WHERE jobId = ${job.id} ORDER BY sortOrder, id`;
        job.components = comps.recordset.map(formatComponent);
        job.deletionLog = safeParseJSON(job.deletionLog, []);
        res.json(job);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Jobs: Create ──

// Job and piece ids are made by the page (Date.now()): letters, digits, _
// and - only, at most 36 (the columns). The job list draws a job's id inside
// a click handler, so an id with a quote or a < in it was code planted for
// every reader of the list (the overall review's R01, 2026-10-01). A longer
// id used to fail as a 500.
const SAFE_ID = /^[A-Za-z0-9_-]{1,36}$/;
const safeId = value => typeof value === 'string' && SAFE_ID.test(value);
const BAD_ID = 'An id may hold only letters, digits, _ and -, at most 36 of them.';

// The INSERTs of a job row and its pieces, their inputs added to r. A create
// and an import over a job write the same columns this way, so a column added
// to one is added to both. idSql, versionSql and creatorSql are what goes into
// the id, rowVersion and createdBy columns (an input, a variable or a
// number); lastModifiedBy is the value for that column. The two names are the
// caller's to decide, never the job's own fields: the server stamps who made
// and who last changed a job (F4, STAMPS_AND_VERSION_PLAN.md).
function jobInsertSql(r, j, idSql, versionSql, creatorSql, lastModifiedBy) {
    r.input('jobNumber', j.jobNumber);
    r.input('jobDescription', j.jobDescription || '');
    r.input('clientName', j.clientName);
    r.input('csrName', j.csrName || '');
    r.input('assignedToPrepress', j.assignedToPrepress || '');
    r.input('signoffDueDatePrepress', j.signoffDueDatePrepress || '');
    r.input('signoffDueTimePrepress', j.signoffDueTimePrepress || '');
    r.input('assignedToTechservices', j.assignedToTechservices || '');
    r.input('signoffDueDateTechservices', j.signoffDueDateTechservices || '');
    r.input('signoffDueTimeTechservices', j.signoffDueTimeTechservices || '');
    r.input('version', j.version || '');
    r.input('dateCreated', j.dateCreated);
    r.input('lastModified', j.lastModified);
    r.input('lastModifiedBy', String(lastModifiedBy || '').slice(0, 100));
    r.input('activeComponentId', j.activeComponentId || '');
    r.input('activeDepartment', j.activeDepartment || 'prepress');
    r.input('status', j.status || 'new');
    r.input('duplicatedFrom', j.duplicatedFrom || '');
    r.input('deletionLog', JSON.stringify(j.deletionLog || []));
    const pieces = Array.isArray(j.components) ? j.components : [];
    pieces.forEach((c, i) => {
        r.input('c' + i + 'id', c.id);
        r.input('c' + i + 'name', c.name || 'Main');
        r.input('c' + i + 'ip', c.instructions_prepress || '');
        r.input('c' + i + 'its', c.instructions_techservices || '');
        r.input('c' + i + 'hp', c.instructionsHistory_prepress || '');
        r.input('c' + i + 'hts', c.instructionsHistory_techservices || '');
        r.input('c' + i + 'cb', JSON.stringify(c.checkboxes || {}));
        r.input('c' + i + 'notes', JSON.stringify(c.notes || {}));
        r.input('c' + i + 'ver', c.version || '');
        r.input('c' + i + 'sort', i);
    });
    return `INSERT INTO jobs (id, jobNumber, jobDescription, clientName, csrName,
                assignedToPrepress, signoffDueDatePrepress, signoffDueTimePrepress,
                assignedToTechservices, signoffDueDateTechservices, signoffDueTimeTechservices,
                version, dateCreated, createdBy, lastModified, lastModifiedBy,
                activeComponentId, activeDepartment, status, duplicatedFrom, deletionLog, rowVersion)
            VALUES (${idSql}, @jobNumber, @jobDescription, @clientName, @csrName,
                @assignedToPrepress, @signoffDueDatePrepress, @signoffDueTimePrepress,
                @assignedToTechservices, @signoffDueDateTechservices, @signoffDueTimeTechservices,
                @version, @dateCreated, ${creatorSql}, @lastModified, @lastModifiedBy,
                @activeComponentId, @activeDepartment, @status, @duplicatedFrom, @deletionLog, ${versionSql});
            ${pieces.map((c, i) => `INSERT INTO components (id, jobId, name, instructions_prepress, instructions_techservices,
                instructionsHistory_prepress, instructionsHistory_techservices, checkboxes, notes, version, sortOrder)
            VALUES (@c${i}id, ${idSql}, @c${i}name, @c${i}ip, @c${i}its, @c${i}hp, @c${i}hts, @c${i}cb, @c${i}notes, @c${i}ver, @c${i}sort);`).join('\n            ')}`;
}

app.post('/api/jobs', async (req, res) => {
    try {
        const j = req.body || {};
        if (!safeId(j.id) || (Array.isArray(j.components) && !j.components.every(c => c && safeId(c.id)))) {
            return res.status(400).json({ error: BAD_ID });
        }
        const pool = await getPool();
        const jobReq = pool.request();
        jobReq.input('id', j.id);
        // Made by the page's user (writerName), never a name in the body
        // (the independent review's F4; David, 2026-10-12). An import's new
        // job (the page marks it X-STS-Import) is made by the importer too, so
        // it shows under her My Jobs (ee35d50), and keeps the file's "last
        // changed" name with the file's date: the import puts back the file's
        // record, and the importer did not make that change.
        const maker = writerName(req);
        jobReq.input('createdBy', maker);
        // The job and every piece in one batch (R20, the after-rollout batch,
        // item 11): as one statement each, a failure part way (a piece id
        // already on another job, a restart) left a job with some of its
        // pieces, stamped with the file's time, so every later import of that
        // file read "already up to date". Now a failed create writes nothing.
        // The driver rules: SET XACT_ABORT ON with BEGIN/COMMIT TRAN, never
        // sql.Transaction, and success read from the batch's own last SELECT.
        const inserts = jobInsertSql(jobReq, j, '@id', '1', '@createdBy', req.get('X-STS-Import') ? j.lastModifiedBy : maker);
        const made = await jobReq.query(`
            SET XACT_ABORT ON;
            BEGIN TRAN;
            ${inserts}
            COMMIT TRAN;
            SELECT CAST(1 AS BIT) AS ok;`);
        const row = lastRecordset(made)[0];
        if (!row || !row.ok) return res.status(500).json({ error: 'The job was not created.' });

        trackUser(maker, 'created job');
        res.status(201).json({ id: j.id, rowVersion: 1 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Jobs: Import over a job ──
//
// Import "Update existing" replaces a job with the file's copy of it, the job
// and every piece, in one batch: all of the file goes in, or nothing changes
// (David, 2026-10-11; docs/design_handoff_qc_review/IMPORT_RECOVERY_PLAN.md).
// It used to be four requests from the page (a stand-in copy, the old job
// deleted, the job made again, the stand-in deleted), and a failure after the
// delete left only the copy, under a new id, with the job's QC record cut off
// from it. The job keeps its id and the file's piece ids, so its QC record
// (keyed by both) stays with it, and no "deleted" line is written: the job
// never leaves. The version moves on rather than starting again at 1, so a
// page holding an older copy meets the ordinary 409. A job no longer there is
// made again, as a new import of it would be; an archived one comes back
// live, as it always has (the create's columns, archivedDate left out).
app.post('/api/jobs/:id/import', async (req, res) => {
    const jobId = String(req.params.id);
    const j = req.body || {};
    try {
        if (!safeId(jobId) || (Array.isArray(j.components) && !j.components.every(c => c && safeId(c.id)))) {
            return res.status(400).json({ error: BAD_ID });
        }
        // The importer is the page's user, never a name in the file: the
        // lock's gate would otherwise fall back to the file's lastModifiedBy.
        if (!lockKeyOf(headerUser(req))) return res.status(400).json({ error: 'A user is required.' });
        // A job with no pieces cannot be opened (R10), so a file that would
        // leave one is refused and the job stays as it was.
        if (!Array.isArray(j.components) || !j.components.length) {
            return res.status(400).json({ error: 'The job in the file has no pieces.' });
        }
        if (!lockGate(req, res, jobId)) return;
        const pool = await getPool();
        const r = pool.request();
        r.input('id', jobId);
        r.input('stampName', writerName(req));
        // The maker is the one already on the job, read from the row the
        // batch deletes, whatever the page says (R18, now the server's own
        // rule); a job here with no maker takes the file's, as the page's R18
        // always did; a job no longer here is made by the importer, as a new
        // import is. "Last changed" stays the file's, with its date (David,
        // 2026-10-12: the import puts back the file's record). F4,
        // STAMPS_AND_VERSION_PLAN.md.
        r.input('fileCreator', String(j.createdBy || '').slice(0, 100));
        const inserts = jobInsertSql(r, j, '@jid', '@ver', '@creator', j.lastModifiedBy);
        // The id copied into a variable of the column's type before the
        // delete's seek (msnodesqlv8 sends every string as nvarchar(max)).
        // Success is the batch's own last SELECT, after the COMMIT.
        const made = await r.query(`
            SET XACT_ABORT ON;
            DECLARE @jid NVARCHAR(36);
            SET @jid = @id;
            DECLARE @old TABLE (rowVersion INT, createdBy NVARCHAR(100));
            DECLARE @ver INT;
            DECLARE @creator NVARCHAR(100);
            SET @creator = @stampName;
            BEGIN TRAN;
            DELETE FROM jobs OUTPUT DELETED.rowVersion, DELETED.createdBy INTO @old WHERE id = @jid;
            SELECT @ver = ISNULL(MAX(rowVersion), 0) + 1 FROM @old;
            SELECT TOP 1 @creator = CASE WHEN ISNULL(createdBy, N'') = N'' THEN @fileCreator ELSE createdBy END FROM @old;
            ${inserts}
            COMMIT TRAN;
            SELECT CAST(1 AS BIT) AS ok, @ver AS rowVersion, (SELECT COUNT(*) FROM @old) AS replaced;`);
        const row = lastRecordset(made)[0];
        if (!row || !row.ok) throw new Error('The job was not imported.');
        // The job's lock entry goes, as the delete of the old job cleared it.
        // The replace is nobody's own write: a closing page's last save
        // carrying an older version is refused, never promoted onto it.
        lockClear(jobId);
        noteOwnWrite(req, jobId, row.rowVersion, false);
        trackUser(writerName(req), 'imported a job');
        res.json({ id: jobId, rowVersion: row.rowVersion, replaced: row.replaced > 0 });
    } catch (err) {
        // On msnodesqlv8 a piece id already on another job reaches here only
        // as "Associated statement is not prepared", so the clash is looked
        // up and named in the log.
        let clash = '';
        try {
            const pieces = (Array.isArray(j.components) ? j.components : []).filter(c => c && safeId(c.id));
            if (pieces.length && safeId(jobId)) {
                const q = (await getPool()).request();
                q.input('jid', jobId);
                pieces.forEach((c, i) => q.input('p' + i, c.id));
                const found = await q.query('SELECT id, jobId FROM components WHERE jobId <> @jid AND id IN (' +
                    pieces.map((c, i) => '@p' + i).join(', ') + ')');
                if (found.recordset.length) clash = ' (piece ids already on other jobs: ' +
                    found.recordset.map(f => f.id + ' on job ' + f.jobId).join(', ') + ')';
            }
        } catch (e) { /* the message alone */ }
        console.error(new Date().toISOString() + ' IMPORT FAILED job ' + jobId + ': ' +
            String(err && err.message || err).replace(/[\r\n]+/g, ' ') + clash);
        res.status(500).json({ error: err.message });
    }
});

// ── An archived job refuses changes (item 5) ──
//
// Until it is restored, nothing on an archived job changes: the row, a
// piece, a piece added or deleted (David, 2026-09-28;
// docs/design_handoff_qc_review/ARCHIVED_WRITES_PLAN.md). Before this, a
// write reached an archived job whenever nobody held it, which is every
// archived job (the archive clears the lock): the holder's own other window
// in the seconds before it heard, a job list loaded before the archive, a
// replayed save. The test sits inside the statement that writes, never in a
// read before it, so an archive landing in between cannot slip through. 410,
// a status of its own: 409 is the version conflict and 423 the edit lock.
// The name merge (/api/roster/reassign, above) still reaches archived jobs on
// purpose: it fixes a spelling across the whole history and stamps nothing.
const JOB_LIVE = "(archivedDate IS NULL OR archivedDate = N'')";

function refuseArchived(res) {
    return res.status(410).json({ archived: true, error: 'This job is archived. Restore it to change it.' });
}

// The job's archive date: null when there is no such job, '' when it is live.
async function jobArchivedDate(jobId) {
    const pool = await getPool();
    const r = pool.request();
    r.input('id', jobId);
    const result = await r.query('SELECT archivedDate FROM jobs WHERE id = @id');
    if (!result.recordset.length) return null;
    return result.recordset[0].archivedDate || '';
}

// ── Jobs: Update (optimistic locking) ──

// The job row's columns a save writes, besides the stamp (lastModified,
// lastModifiedBy) and the version: one list for PUT /api/jobs/:id and the
// page's last save as it closes (item 6), so the two never write different
// columns. Each input has the column's own name. Header edited's name is the
// server's: the writer's (@stampName, which the caller inputs) when the save
// moves headerModified (the page moves it only when a header field is
// edited), else the name already stored, whatever the body says (F4,
// STAMPS_AND_VERSION_PLAN.md). The right side of a SET reads the row as it
// was, so the CASE compares with the stored date.
function jobRowInputs(r, j) {
    r.input('jobDescription', j.jobDescription || '');
    r.input('clientName', j.clientName || '');
    r.input('csrName', j.csrName || '');
    r.input('assignedToPrepress', j.assignedToPrepress || '');
    r.input('signoffDueDatePrepress', j.signoffDueDatePrepress || '');
    r.input('signoffDueTimePrepress', j.signoffDueTimePrepress || '');
    r.input('assignedToTechservices', j.assignedToTechservices || '');
    r.input('signoffDueDateTechservices', j.signoffDueDateTechservices || '');
    r.input('signoffDueTimeTechservices', j.signoffDueTimeTechservices || '');
    r.input('version', j.version || '');
    r.input('lastAccessed', j.lastAccessed || '');
    r.input('headerModified', j.headerModified || '');
    r.input('activeComponentId', j.activeComponentId || '');
    r.input('activeDepartment', j.activeDepartment || 'prepress');
    r.input('status', j.status || 'new');
    r.input('duplicatedFrom', j.duplicatedFrom || '');
    r.input('deletionLog', JSON.stringify(j.deletionLog || []));
}
const JOB_ROW_SET = `
                jobDescription = @jobDescription,
                clientName = @clientName,
                csrName = @csrName,
                assignedToPrepress = @assignedToPrepress,
                signoffDueDatePrepress = @signoffDueDatePrepress,
                signoffDueTimePrepress = @signoffDueTimePrepress,
                assignedToTechservices = @assignedToTechservices,
                signoffDueDateTechservices = @signoffDueDateTechservices,
                signoffDueTimeTechservices = @signoffDueTimeTechservices,
                version = @version,
                lastAccessed = @lastAccessed,
                headerModifiedBy = CASE WHEN ISNULL(headerModified, N'') = @headerModified THEN headerModifiedBy ELSE @stampName END,
                headerModified = @headerModified,
                activeComponentId = @activeComponentId,
                activeDepartment = @activeDepartment,
                status = @status,
                duplicatedFrom = @duplicatedFrom,
                deletionLog = @deletionLog`;

// Which page made each job's last change, and the version that change
// produced (item 6). A work order page sends its last save as its tab closes,
// carrying the version it last had back; a save of its own still on its way
// may reach the server first and move the version, so for that page, and only
// while nothing else has moved the version since, the version its own change
// produced counts too. Every write that moves a job's version records here,
// from the page's X-STS-Writer header; a write with none (the job list, a
// script) records nobody. Memory only: after a restart the ordinary 409
// stands. A write that tested no version (a piece deleted by a page from
// before the update, the import's replace) records nobody too: it can land on
// top of anyone's change.
const ownWrites = new Map();
function noteOwnWrite(req, jobId, version, versionTested) {
    if (version == null) return;
    const writer = versionTested === false ? null : (lockPageId(req.get('X-STS-Writer')) || null);
    ownWrites.set(jobId, { writer, version: Number(version) });
}

app.put('/api/jobs/:id', async (req, res) => {
    try {
        const j = req.body;
        const expectedVersion = j.rowVersion;
        // A whole number: anything else failed in SQL as a 500 (F4).
        if (!Number.isInteger(expectedVersion)) {
            return res.status(400).json({ error: 'rowVersion is required' });
        }
        if (!lockGate(req, res, req.params.id)) return;

        const pool = await getPool();
        const upd = pool.request();
        upd.input('id', req.params.id);
        upd.input('expectedVersion', expectedVersion);
        jobRowInputs(upd, j);
        upd.input('lastModified', j.lastModified || new Date().toISOString());
        upd.input('stampName', writerName(req));

        // The new version comes back from the UPDATE itself (OUTPUT INTO, the
        // driver-safe rule): read with a SELECT after it, another write
        // landing in between would be taken for this one's (ownWrites,
        // item 6).
        const result = await upd.query(`
            SET XACT_ABORT ON;
            DECLARE @jid NVARCHAR(36);
            SET @jid = @id;
            DECLARE @bumped TABLE (rowVersion INT);
            UPDATE jobs SET${JOB_ROW_SET},
                lastModified = @lastModified,
                lastModifiedBy = @stampName,
                rowVersion = rowVersion + 1
            OUTPUT INSERTED.rowVersion INTO @bumped
            WHERE id = @jid AND rowVersion = @expectedVersion AND ${JOB_LIVE};
            SELECT TOP 1 rowVersion FROM @bumped;`);

        const updated = lastRecordset(result)[0];
        if (!updated) {
            if (await jobArchivedDate(req.params.id)) return refuseArchived(res);
            return res.status(409).json({
                error: 'This job was updated by someone else. Reload to see their changes.'
            });
        }

        lockAfterWrite(req, req.params.id);
        noteOwnWrite(req, req.params.id, updated.rowVersion);
        trackUser(writerName(req), 'saved job');
        res.json({ rowVersion: updated.rowVersion });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Jobs: Delete ──
//
// A job with QC on it writes who deleted it, when, and what it was into its
// QC history in the same step (item 7, DELETED_QC_PLAN.md): the QC record is
// kept, and the job list's Deleted jobs panel lists it from that row. Every
// delete does: Import "Update existing" no longer deletes (it replaces the
// job in one step, above), so the X-STS-Replacing header that let it delete
// without a row is gone (IMPORT_RECOVERY_PLAN.md).

app.delete('/api/jobs/:id', async (req, res) => {
    try {
        if (!lockGate(req, res, req.params.id)) return;
        // A job id is at most 36 characters. A longer one matches no job in
        // the plain delete below, but the batch's typed variable would cut
        // it to a job the lock's gate never asked about.
        if (String(req.params.id).length <= 36 && await reviewTablesReady()) {
            // Refused by the lock after its reads (someone opened the job
            // meanwhile): the 423 has been answered.
            if (!(await deleteJobWithQcRecord(String(req.params.id), req, res))) return;
        } else {
            await query`DELETE FROM jobs WHERE id = ${req.params.id}`;
        }
        lockClear(req.params.id);
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Jobs: Archive ──

app.post('/api/jobs/:id/archive', async (req, res) => {
    try {
        if (!lockGate(req, res, req.params.id)) return;
        const now = new Date().toISOString();
        const pool = await getPool();
        const upd = pool.request();
        upd.input('id', req.params.id);
        upd.input('archivedDate', now);
        // A job already archived keeps its date (a job list loaded before the
        // first archive used to move it) and answers as archived.
        const result = await upd.query(`UPDATE jobs SET archivedDate = @archivedDate WHERE id = @id AND ${JOB_LIVE}`);
        if (result.rowsAffected[0] === 0) {
            const already = await jobArchivedDate(req.params.id);
            if (already === null) return res.status(404).json({ error: 'Job not found' });
            if (!already) return res.status(409).json({ error: 'The job changed while it was being archived. Try again.' });
            lockClear(req.params.id);
            return res.json({ archived: true, archivedDate: already, already: true });
        }
        lockClear(req.params.id);
        res.json({ archived: true, archivedDate: now });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Jobs: Unarchive ──

app.post('/api/jobs/:id/unarchive', async (req, res) => {
    try {
        const pool = await getPool();
        const upd = pool.request();
        upd.input('id', req.params.id);
        await upd.query(`UPDATE jobs SET archivedDate = NULL WHERE id = @id`);
        res.json({ unarchived: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Archive: List ──

app.get('/api/archive', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(
            `SELECT * FROM jobs WHERE archivedDate IS NOT NULL AND archivedDate != '' ORDER BY archivedDate DESC`
        );
        const jobs = result.recordset;
        if (jobs.length > 0) {
            const comps = await pool.request().query(
                `SELECT * FROM components WHERE jobId IN (SELECT id FROM jobs WHERE archivedDate IS NOT NULL AND archivedDate != '') ORDER BY sortOrder, id`
            );
            const compMap = {};
            comps.recordset.forEach(c => {
                if (!compMap[c.jobId]) compMap[c.jobId] = [];
                compMap[c.jobId].push(formatComponent(c));
            });
            jobs.forEach(j => {
                j.components = compMap[j.id] || [];
                j.deletionLog = safeParseJSON(j.deletionLog, []);
            });
        }
        res.json(jobs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Components: Create ──

app.post('/api/jobs/:id/components', async (req, res) => {
    try {
        const c = req.body || {};
        if (!safeId(c.id)) return res.status(400).json({ error: BAD_ID });
        if (!lockGate(req, res, req.params.id)) return;
        const pool = await getPool();

        // The job's version and the new piece in one batch, as the piece save
        // does: as three statements a read between them got the new version
        // with no piece, and an archive landing between the version and the
        // insert left a piece on an archived job (item 5). The optimistic lock
        // and the archived test are the version bump's, detected with OUTPUT
        // INTO; DECLARE then SET (SQL Server 2005-safe).
        const b = pool.request();
        b.input('jobId', req.params.id);
        b.input('expectedVersion', c.rowVersion || 0);
        b.input('lastModified', new Date().toISOString());
        b.input('stampName', writerName(req));
        b.input('id', c.id);
        b.input('name', c.name || 'Main');
        b.input('instructions_prepress', c.instructions_prepress || '');
        b.input('instructions_techservices', c.instructions_techservices || '');
        b.input('instructionsHistory_prepress', c.instructionsHistory_prepress || '');
        b.input('instructionsHistory_techservices', c.instructionsHistory_techservices || '');
        b.input('checkboxes', JSON.stringify(c.checkboxes || {}));
        b.input('notes', JSON.stringify(c.notes || {}));
        b.input('version', c.version || '');
        const result = await b.query(`
            SET XACT_ABORT ON;
            DECLARE @jid NVARCHAR(36);
            SET @jid = @jobId;
            DECLARE @ev INT;
            SET @ev = @expectedVersion;
            DECLARE @bumped TABLE (rowVersion INT);
            BEGIN TRAN;
            UPDATE jobs SET rowVersion = rowVersion + 1, lastModified = @lastModified, lastModifiedBy = @stampName
            OUTPUT INSERTED.rowVersion INTO @bumped
            WHERE id = @jid AND rowVersion = @ev AND ${JOB_LIVE};
            IF EXISTS (SELECT 1 FROM @bumped)
                INSERT INTO components (id, jobId, name, instructions_prepress, instructions_techservices,
                    instructionsHistory_prepress, instructionsHistory_techservices, checkboxes, notes, version, sortOrder)
                SELECT @id, @jid, @name, @instructions_prepress, @instructions_techservices,
                    @instructionsHistory_prepress, @instructionsHistory_techservices, @checkboxes, @notes, @version,
                    (SELECT COUNT(*) FROM components WHERE jobId = @jid);
            SELECT CAST(CASE WHEN EXISTS (SELECT 1 FROM @bumped) THEN 1 ELSE 0 END AS BIT) AS ok,
                   (SELECT TOP 1 rowVersion FROM @bumped) AS rowVersion,
                   CAST(CASE WHEN EXISTS (SELECT 1 FROM jobs WHERE id = @jid AND NOT ${JOB_LIVE}) THEN 1 ELSE 0 END AS BIT) AS archived;
            COMMIT TRAN;`);
        const row = lastRecordset(result)[0];
        if (row && !row.ok && row.archived) return refuseArchived(res);
        if (!row || !row.ok) {
            return res.status(409).json({
                error: 'This job was updated by someone else. Reload to see their changes.'
            });
        }
        lockAfterWrite(req, req.params.id);
        noteOwnWrite(req, req.params.id, row.rowVersion);
        res.status(201).json({ id: c.id, rowVersion: row.rowVersion });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Components: Update ──

app.put('/api/components/:id', async (req, res) => {
    try {
        const c = req.body || {};
        // A piece save names the version it was made at, as a job save does
        // (the independent review's F4; David, 2026-10-12): one with none
        // used to write the piece without testing or moving the job's
        // version, so the page's lock read never saw it and the next save
        // made at the old version wrote over it. Every page sends one (this
        // build's and the one before it); only a script did not.
        if (!Number.isInteger(c.rowVersion)) {
            return res.status(400).json({ error: 'rowVersion is required' });
        }
        const pool = await getPool();

        // Look up parent job
        const parent = await query`SELECT jobId FROM components WHERE id = ${req.params.id}`;
        if (parent.recordset.length === 0) return res.status(404).json({ error: 'Component not found' });
        const jobId = parent.recordset[0].jobId;
        if (!lockGate(req, res, jobId)) return;

        // The job's version and the piece move together, in one batch: as
        // two statements, a read between them got the new version with the
        // old piece, and a page that took that copy (the catch-up with one's
        // own other window, EDIT_LOCK_PLAN 11.4 item 10) could save over the
        // other window's change with no conflict. The optimistic lock on the
        // parent job is the same test as before, detected with OUTPUT INTO
        // (the rules in the review routes' header, below).
        const upd = pool.request();
        upd.input('jobId', jobId);
        upd.input('expectedVersion', c.rowVersion);
        upd.input('lastModified', c.lastModified || new Date().toISOString());
        upd.input('stampName', writerName(req));
        upd.input('id', req.params.id);
        upd.input('name', c.name || '');
        upd.input('instructions_prepress', c.instructions_prepress || '');
        upd.input('instructions_techservices', c.instructions_techservices || '');
        upd.input('instructionsHistory_prepress', c.instructionsHistory_prepress || '');
        upd.input('instructionsHistory_techservices', c.instructionsHistory_techservices || '');
        upd.input('checkboxes', JSON.stringify(c.checkboxes || {}));
        upd.input('notes', JSON.stringify(c.notes || {}));
        upd.input('version', c.version || '');
        // The piece's place is written only when the page sends one (R16, the
        // after-rollout batch, item 7): the page never learns where the server
        // put a piece it added, so its first save used to store 0, a tie with
        // the first piece. Left out of the SQL rather than sent as NULL with a
        // CASE: msnodesqlv8 declares a null input as nvarchar(max).
        const placed = Number.isInteger(c.sortOrder);
        if (placed) upd.input('sortOrder', c.sortOrder);
        // DECLARE then SET, not DECLARE with a value: the work order's own
        // routes stay SQL Server 2005-safe (only QC Review needs 2008). A
        // piece deleted between the lookup above and this batch (her other
        // window) rolls the version back and answers 404, as a piece missing
        // at the lookup does, rather than 200 with nothing saved.
        const result = await upd.query(`
            SET XACT_ABORT ON;
            DECLARE @jid NVARCHAR(36);
            DECLARE @cid NVARCHAR(36);
            SET @jid = @jobId;
            SET @cid = @id;
            DECLARE @bumped TABLE (rowVersion INT);
            DECLARE @written TABLE (id NVARCHAR(36));
            DECLARE @ev INT;
            SET @ev = @expectedVersion;
            BEGIN TRAN;
            UPDATE jobs SET rowVersion = rowVersion + 1, lastModified = @lastModified, lastModifiedBy = @stampName
            OUTPUT INSERTED.rowVersion INTO @bumped
            WHERE id = @jid AND rowVersion = @ev AND ${JOB_LIVE};
            UPDATE components SET
                name = @name,
                instructions_prepress = @instructions_prepress,
                instructions_techservices = @instructions_techservices,
                instructionsHistory_prepress = @instructionsHistory_prepress,
                instructionsHistory_techservices = @instructionsHistory_techservices,
                checkboxes = @checkboxes,
                notes = @notes,
                version = @version${placed ? `,
                sortOrder = @sortOrder` : ''}
            OUTPUT INSERTED.id INTO @written
            WHERE id = @cid AND EXISTS (SELECT 1 FROM @bumped);
            IF EXISTS (SELECT 1 FROM @bumped) AND NOT EXISTS (SELECT 1 FROM @written)
            BEGIN
                ROLLBACK TRAN;
                SELECT CAST(0 AS BIT) AS ok, CAST(1 AS BIT) AS gone, CAST(NULL AS INT) AS rowVersion, CAST(0 AS BIT) AS archived;
            END
            ELSE
            BEGIN
                SELECT CAST(CASE WHEN EXISTS (SELECT 1 FROM @bumped) THEN 1 ELSE 0 END AS BIT) AS ok,
                       CAST(0 AS BIT) AS gone,
                       (SELECT TOP 1 rowVersion FROM @bumped) AS rowVersion,
                       CAST(CASE WHEN EXISTS (SELECT 1 FROM jobs WHERE id = @jid AND NOT ${JOB_LIVE}) THEN 1 ELSE 0 END AS BIT) AS archived;
                COMMIT TRAN;
            END`);
        const row = lastRecordset(result)[0];
        if (row && row.gone) return res.status(404).json({ error: 'Component not found' });
        if (row && !row.ok && row.archived) return refuseArchived(res);
        if (!row || !row.ok) {
            return res.status(409).json({
                error: 'This job was updated by someone else. Reload to see their changes.'
            });
        }
        lockAfterWrite(req, jobId);
        noteOwnWrite(req, jobId, row.rowVersion);
        res.json({ rowVersion: row.rowVersion });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Components: Delete ──

app.delete('/api/components/:id', async (req, res) => {
    try {
        const parent = await query`SELECT jobId FROM components WHERE id = ${req.params.id}`;
        if (parent.recordset.length === 0) return res.status(404).json({ error: 'Component not found' });
        const jobId = parent.recordset[0].jobId;
        if (!lockGate(req, res, jobId)) return;

        // One batch (item 5): the piece goes only while the job is not
        // archived, and the job's version moves only when it went, detected
        // with OUTPUT INTO. The page sends the version it has, and a delete
        // made from a copy older than the job is refused (409), as a save is
        // (David, 2026-10-12; STAMPS_AND_VERSION_PLAN.md): it used to go
        // through and hand that page a version covering changes it had never
        // seen, so its next save wrote over her other window's work. A
        // delete with no version (a page from before the update) goes as
        // before. The version moves first, then the piece goes, the order the
        // piece save takes its locks in; moved and nothing deleted (her other
        // window deleted it a moment before) rolls back and is 404.
        const body = req.body || {};
        const versioned = body.rowVersion != null;
        if (versioned && !Number.isInteger(body.rowVersion)) return res.status(400).json({ error: 'rowVersion must be a whole number' });
        const pool = await getPool();
        const del = pool.request();
        del.input('id', req.params.id);
        del.input('jobId', jobId);
        if (versioned) del.input('expectedVersion', body.rowVersion);
        const result = await del.query(`
            SET XACT_ABORT ON;
            DECLARE @jid NVARCHAR(36);
            DECLARE @cid NVARCHAR(36);
            SET @jid = @jobId;
            SET @cid = @id;
            DECLARE @gone TABLE (id NVARCHAR(36));
            DECLARE @bumped TABLE (rowVersion INT);
            ${versioned ? `DECLARE @ev INT;
            SET @ev = @expectedVersion;` : ''}
            BEGIN TRAN;
            UPDATE jobs SET rowVersion = rowVersion + 1
            OUTPUT INSERTED.rowVersion INTO @bumped
            WHERE id = @jid${versioned ? ' AND rowVersion = @ev' : ''} AND ${JOB_LIVE};
            DELETE FROM components
            OUTPUT DELETED.id INTO @gone
            WHERE id = @cid AND jobId = @jid AND EXISTS (SELECT 1 FROM @bumped);
            IF EXISTS (SELECT 1 FROM @bumped) AND NOT EXISTS (SELECT 1 FROM @gone)
            BEGIN
                ROLLBACK TRAN;
                SELECT CAST(0 AS BIT) AS ok, CAST(1 AS BIT) AS gone, CAST(NULL AS INT) AS rowVersion, CAST(0 AS BIT) AS archived, CAST(1 AS BIT) AS found;
            END
            ELSE
            BEGIN
                SELECT CAST(CASE WHEN EXISTS (SELECT 1 FROM @gone) THEN 1 ELSE 0 END AS BIT) AS ok,
                       CAST(0 AS BIT) AS gone,
                       (SELECT TOP 1 rowVersion FROM @bumped) AS rowVersion,
                       CAST(CASE WHEN EXISTS (SELECT 1 FROM jobs WHERE id = @jid AND NOT ${JOB_LIVE}) THEN 1 ELSE 0 END AS BIT) AS archived,
                       CAST(CASE WHEN EXISTS (SELECT 1 FROM jobs WHERE id = @jid) THEN 1 ELSE 0 END AS BIT) AS found;
                COMMIT TRAN;
            END`);
        const row = lastRecordset(result)[0];
        if (row && row.gone) return res.status(404).json({ error: 'Component not found' });
        if (row && !row.ok && row.archived) return refuseArchived(res);
        if (row && !row.ok && row.found && versioned) {
            return res.status(409).json({
                error: 'This job was updated by someone else. Reload to see their changes.'
            });
        }
        if (!row || !row.ok) return res.status(404).json({ error: 'Component not found' });
        lockAfterWrite(req, jobId);
        noteOwnWrite(req, jobId, row.rowVersion, versioned);
        res.json({ deleted: true, rowVersion: row.rowVersion });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── The page's last save as its tab closes (item 6) ──
//
// As a work order's tab closes (Ctrl+W, the X, F5, the browser closing), the
// page sends everything on its screen the server does not have yet as this
// one request, keepalive; nobody is left to read the answer
// (docs/design_handoff_qc_review/CLOSE_TAB_PLAN.md). Before this the page sent
// the piece and the job row at the same moment with the same version, the
// server kept whichever reached it first and refused the other, and typing or
// an Edit Job change made in the last half second was lost without a word.
//
// One batch: the job row (every column of a job save when `row` is sent, else
// only the stamp, as a piece save stamps it), then each piece's listed fields,
// all only when the version matches and the job is live. The version this
// page's own last change produced counts too (ownWrites), for a save of its
// own still on its way when it closed. Then this page's hold goes, in the same
// request, so no write can land after the release and put a hold back for a
// page that is gone. A refusal is one line in the log: no screen is left to
// say it.
const LAST_SAVE_PIECE_FIELDS = ['name', 'version', 'instructions_prepress', 'instructions_techservices',
    'instructionsHistory_prepress', 'instructionsHistory_techservices', 'checkboxes', 'notes'];

// The batch: the job row (every column of a job save when `row` is sent, else
// only the stamp), then each piece's listed fields, all only when the version
// matches and the job is live. Each piece's id is copied into a variable of
// the column's own type (the driver-safe rule).
async function lastSaveBatch(jobId, expected, body, row, pieces, stampName) {
    const pool = await getPool();
    const r = pool.request();
    r.input('jobId', jobId);
    r.input('expectedVersion', expected);
    r.input('lastModified', body.lastModified || new Date().toISOString());
    r.input('stampName', stampName);
    if (row) jobRowInputs(r, row);
    const pieceSql = [];
    pieces.forEach((p, i) => {
        if (!p || typeof p.id !== 'string' || !p.id) return;
        const cols = LAST_SAVE_PIECE_FIELDS.filter(f => Object.prototype.hasOwnProperty.call(p, f));
        if (!cols.length) return;
        r.input('p' + i + '_id', p.id);
        cols.forEach(f => {
            const v = p[f];
            r.input('p' + i + '_' + f, (f === 'checkboxes' || f === 'notes') ? JSON.stringify(v || {}) : String(v == null ? '' : v));
        });
        pieceSql.push(`
            DECLARE @c${i} NVARCHAR(36);
            SET @c${i} = @p${i}_id;
            UPDATE components SET ${cols.map(f => f + ' = @p' + i + '_' + f).join(', ')}
            WHERE id = @c${i} AND jobId = @jid AND EXISTS (SELECT 1 FROM @bumped);`);
    });
    const result = await r.query(`
            SET XACT_ABORT ON;
            DECLARE @jid NVARCHAR(36);
            SET @jid = @jobId;
            DECLARE @ev INT;
            SET @ev = @expectedVersion;
            DECLARE @bumped TABLE (rowVersion INT);
            BEGIN TRAN;
            UPDATE jobs SET${row ? JOB_ROW_SET + ',' : ''}
                lastModified = @lastModified,
                lastModifiedBy = @stampName,
                rowVersion = rowVersion + 1
            OUTPUT INSERTED.rowVersion INTO @bumped
            WHERE id = @jid AND rowVersion = @ev AND ${JOB_LIVE};${pieceSql.join('')}
            SELECT CAST(CASE WHEN EXISTS (SELECT 1 FROM @bumped) THEN 1 ELSE 0 END AS BIT) AS ok,
                   (SELECT TOP 1 rowVersion FROM @bumped) AS rowVersion,
                   CAST(CASE WHEN EXISTS (SELECT 1 FROM jobs WHERE id = @jid) THEN 1 ELSE 0 END AS BIT) AS found,
                   CAST(CASE WHEN EXISTS (SELECT 1 FROM jobs WHERE id = @jid AND NOT ${JOB_LIVE}) THEN 1 ELSE 0 END AS BIT) AS archived;
            COMMIT TRAN;`);
    return lastRecordset(result)[0] || null;
}

// A last save still being written, per job: a page opening that job waits for
// it (POST .../lock, GET /api/jobs/:id), so F5 draws what was just sent
// rather than the copy before it (at most 3 s).
const lastSavesRunning = new Map();
function lastSaveLanded(jobId) {
    const running = lastSavesRunning.get(jobId);
    return running ? Promise.race([running, new Promise(resolve => setTimeout(resolve, 3000))]) : Promise.resolve();
}

app.post('/api/jobs/:id/last-save', async (req, res) => {
    const jobId = req.params.id;
    const body = req.body || {};
    const actor = writeActorKey(req);
    const pageId = lockPageId(body.page);
    const writer = lockPageId(req.get('X-STS-Writer'));
    const pieces = body.pieces;
    const sent = Number(body.rowVersion);
    const row = body.row && typeof body.row === 'object' ? body.row : null;
    const refused = (status, why) => {
        console.log(new Date().toISOString() + ' LAST SAVE refused ' + status + ' job ' + jobId + ' user ' + (actor || '(none)') + (why ? ' (' + why + ')' : ''));
    };
    // The page is gone whatever happens next: a write of its own still on its
    // way must not put its hold back.
    if (actor && pageId) markPageReleased(jobId, pageId, Date.now());
    let landed;
    const running = new Promise(resolve => { landed = resolve; });
    lastSavesRunning.set(jobId, running);
    let gated = false;
    try {
        if (!actor) { refused(400, 'no user'); return res.status(400).json({ error: 'A user is required.' }); }
        if (!Array.isArray(pieces) || pieces.length > 50 || !Number.isInteger(sent)) {
            refused(400, 'no version or pieces');
            return res.status(400).json({ error: 'rowVersion and a list of pieces are required.' });
        }
        if (!lockGate(req, res, jobId)) { gated = true; refused(423); return; }

        // The version this page's own last change produced counts too, when
        // nothing has moved the version since: its save on its way reached
        // the server first. A save of its own arriving together with this one
        // can still be running when that is asked; this batch then waits
        // behind it and finds the version moved, so it is asked again once
        // that save has answered (three tries at most, 50 ms apart).
        let expected = sent;
        let out = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const own = ownWrites.get(jobId);
            const next = (own && writer && own.writer === writer && own.version > sent) ? own.version : sent;
            if (attempt > 1 && next === expected) {
                await new Promise(resolve => setTimeout(resolve, 50));
                continue;
            }
            expected = next;
            out = await lastSaveBatch(jobId, expected, body, row, pieces, writerName(req));
            if (!out || out.ok || !out.found || out.archived) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!out || !out.found) { refused(404); return res.status(404).json({ error: 'Job not found' }); }
        if (!out.ok && out.archived) { refused(410); return refuseArchived(res); }
        if (!out.ok) {
            refused(409, 'sent version ' + sent + (expected !== sent ? ', its own change ' + expected : ''));
            return res.status(409).json({ error: 'This job was updated by someone else. Reload to see their changes.' });
        }
        noteOwnWrite(req, jobId, out.rowVersion);
        trackUser(writerName(req), 'saved job');
        res.json({ rowVersion: out.rowVersion });
    } catch (err) {
        refused(500, err.message);
        res.status(500).json({ error: err.message });
    } finally {
        // The page is gone whatever happened: its own hold goes (never the
        // whole hold, which her other window may be part of).
        if (!gated && actor && pageId) {
            const held = lockHolder(jobId, Date.now());
            if (held && held.key === actor) lockLetGo(held, jobId, pageId);
        }
        landed();
        if (lastSavesRunning.get(jobId) === running) lastSavesRunning.delete(jobId);
    }
});

// ── QC Review ──
//
// The peer QC sheets (CSR intake, Prepress, Tech Services) live in three tables
// made by sql/create-review-tables.sql, which IT runs by hand in SSMS. This
// server never creates or alters them (roster, above, is the one table it still
// creates itself): the app's SQL login is normally only allowed to read and
// write. It checks that they are there, and until they are, the review routes
// answer 503 and nothing else in the app changes.
//
// Three rules shape everything in this section.
//
// 1. Review writes never touch jobs or components. A reviewer checking items
//    while the operator edits the work order is the normal case, and any write
//    that bumped jobs.rowVersion would hand the operator the "Job updated on
//    the server" pop-up. reviews and review_gates carry their own rowVersion.
//
// 2. The server says who did it and when. The person is the picked user
//    (req.appUser, from the sts_user cookie), never a name sent in the request
//    body, and every time is this server's clock. review_log is permanent, so a
//    wrong name written there could never be corrected. The picker is an honor
//    system: this records who the person said they were.
//
// 3. Queries are written for the production driver, not only the local one.
//    Production talks to SQL Server through mssql/msnodesqlv8 over ODBC; local
//    testing uses tedious. They differ in ways a local run does not show
//    (bf14197 was one):
//      - Input names are camelCase words, never p0/p1. msnodesqlv8 declares
//        every input inside a batch the ODBC driver already numbers @P1, @P2...
//      - A write is ONE batch: SET XACT_ABORT ON, BEGIN TRAN, the statements,
//        COMMIT. Not sql.Transaction, whose commit under msnodesqlv8 reports
//        success even when COMMIT fails.
//      - A version match is detected with OUTPUT ... INTO a table variable and
//        read from the last result set. Never rowsAffected, which the two
//        drivers build differently. No SET NOCOUNT, no PRINT.
//      - Errors are told apart by SQL error number only.

const REVIEW_ITEM_ID = /^[A-Za-z][A-Za-z0-9_]{0,19}$/;
const REVIEW_LIMIT = { itemIds: 200, value: 500, note: 2000, facts: 20000, formVersion: 20, name: 100, logRows: 250, itemLabel: 400, paths: 4000, sections: 20, unitName: 200, naReason: 500, sendNote: 4000 };
const REVIEW_RECHECK_MS = 60000;
// The checklists this server knows, with the job column that names each one's
// person on the work order (only the CSR checklist's is its owner; a
// department's operator is whoever sends it for review), and the departments a
// CSR correction can be sent to.
const REVIEW_OWNER_COLUMN = { csr: 'csrName', prepress: 'assignedToPrepress', techservices: 'assignedToTechservices' };
const REVIEW_DEPTS = ['prepress', 'techservices'];
const REVIEW_NO_CHECKLIST = 'The QC checklists could not be loaded on the server. Tell IT.';

// The checklists (public/js/review-items.js, the same file the browser loads),
// read once at startup. They are the rules: which checklists there are, which
// lines each block has, and when a block may be passed. A missing or broken
// file never stops the app, but QC Review is switched off (every review route
// answers 503) because a review half enforced is worse than none; health says
// reviewForms: false. Everything is worked out here, inside the try, so a file
// that loads but has the wrong shape fails now rather than inside a request (a
// throw in the async health route would stop the whole service). require()
// keeps the copy it read, so a changed checklist needs a service restart.
let reviewItems = null;
let reviewForms = false;
let reviewItemsProblem = '';
try {
    const loaded = require('./public/js/review-items.js');
    if (!loaded || !Array.isArray(loaded.gates) || !loaded.gates.length) throw new Error('it has no checklists');
    const versions = {};
    loaded.gates.forEach(g => {
        if (!REVIEW_OWNER_COLUMN[g.gate]) throw new Error('it has a checklist this server does not know: ' + g.gate);
        versions[g.gate] = loaded.formVersion(g.gate);
        if (!versions[g.gate]) throw new Error('it has no ' + g.gate + ' checklist version');
        loaded.unitSections(g.gate, 'job');
        loaded.findItem(g.gate, '');
        loaded.unitVerdict(g.gate, 'job', {});
        loaded.followingNA(g.gate, '', {});
    });
    Object.keys(REVIEW_OWNER_COLUMN).forEach(gate => {
        if (!versions[gate]) throw new Error('it has no ' + gate + ' checklist');
    });
    reviewItems = loaded;
    reviewForms = versions;
} catch (err) {
    reviewItemsProblem = String(err.message).split('\n')[0];   // logged after the version line at startup
}

// One checklist's entry in the file ({ gate, label, perPiece }), or null.
function reviewGate(gate) {
    return reviewItems ? reviewItems.gates.find(g => g.gate === gate) || null : null;
}

function reviewGateLabel(gate) {
    const g = reviewGate(gate);
    return g ? g.label : '';
}

// The name of the 'job' block: Whole Job on a checklist with a block per
// piece, "<label> Checklist" on a single job-wide one.
function reviewJobUnitName(gate) {
    const g = reviewGate(gate);
    return g && g.perPiece ? 'Whole Job' : reviewGateLabel(gate) + ' Checklist';
}

// The wording of an item for its history row, or '' when there is none.
function reviewItemLabel(gate, itemId) {
    if (!reviewItems || !itemId) return '';
    try {
        const item = reviewItems.findItem(gate, itemId);
        return item && typeof item.label === 'string' ? item.label.slice(0, REVIEW_LIMIT.itemLabel) : '';
    } catch (err) {
        return '';
    }
}

let _reviewsReady = null;      // null until the first check finishes
let _reviewsCheckedAt = 0;
let _reviewsChecking = null;   // the check in flight, shared by every caller
let _reviewsProblem = '';
let _rosterExists = false;     // dbo.roster exists
let _rosterHasLogin = false;   // roster.windowsLogin exists
// roster.emailOff exists. Not required for QC Review: without it everyone is
// emailed, exactly as before the switch, and nobody can be switched off (the
// route answers 503). Also set by the roster routes, because a ready check is
// never asked again and every page load reads the roster.
let _rosterHasEmailOff = false;
let _emailSwitchSaid = false;  // the missing column was logged

function reviewsHealth() {
    return _reviewsReady === null ? 'pending' : _reviewsReady;
}

// Do the tables exist, and can this login read and write them? Logs only when
// the answer changes, so a missing table does not fill the log once a minute.
function checkReviewTables() {
    if (_reviewsChecking) return _reviewsChecking;
    _reviewsChecking = (async () => {
        let problem = '';
        try {
            const pool = await getPool();
            const result = await pool.request().query(`
                SELECT
                    CASE WHEN OBJECT_ID(N'dbo.reviews', N'U') IS NOT NULL
                          AND OBJECT_ID(N'dbo.review_gates', N'U') IS NOT NULL
                          AND OBJECT_ID(N'dbo.review_log', N'U') IS NOT NULL
                          AND COL_LENGTH(N'dbo.review_gates', N'roundNo') IS NOT NULL
                          AND COL_LENGTH(N'dbo.review_gates', N'newJobDate') IS NOT NULL
                          AND COL_LENGTH(N'dbo.roster', N'windowsLogin') IS NOT NULL
                         THEN 1 ELSE 0 END AS tablesExist,
                    CASE WHEN HAS_PERMS_BY_NAME(N'dbo.reviews', N'OBJECT', N'SELECT') = 1
                          AND HAS_PERMS_BY_NAME(N'dbo.reviews', N'OBJECT', N'INSERT') = 1
                          AND HAS_PERMS_BY_NAME(N'dbo.reviews', N'OBJECT', N'UPDATE') = 1
                          AND HAS_PERMS_BY_NAME(N'dbo.review_gates', N'OBJECT', N'SELECT') = 1
                          AND HAS_PERMS_BY_NAME(N'dbo.review_gates', N'OBJECT', N'INSERT') = 1
                          AND HAS_PERMS_BY_NAME(N'dbo.review_gates', N'OBJECT', N'UPDATE') = 1
                          AND HAS_PERMS_BY_NAME(N'dbo.review_log', N'OBJECT', N'SELECT') = 1
                          AND HAS_PERMS_BY_NAME(N'dbo.review_log', N'OBJECT', N'INSERT') = 1
                          AND HAS_PERMS_BY_NAME(N'dbo.roster', N'OBJECT', N'SELECT') = 1
                         THEN 1 ELSE 0 END AS canWrite,
                    CASE WHEN OBJECT_ID(N'dbo.roster', N'U') IS NULL THEN 0 ELSE 1 END AS rosterExists,
                    CASE WHEN COL_LENGTH(N'dbo.roster', N'windowsLogin') IS NULL THEN 0 ELSE 1 END AS rosterHasLogin,
                    CASE WHEN COL_LENGTH(N'dbo.roster', N'emailOff') IS NULL THEN 0 ELSE 1 END AS rosterHasEmailOff,
                    SUSER_SNAME() AS sqlLogin
            `);
            const row = result.recordset[0];
            _rosterExists = !!row.rosterExists;
            _rosterHasLogin = !!row.rosterHasLogin;
            _rosterHasEmailOff = !!row.rosterHasEmailOff;
            if (!row.tablesExist) {
                // roster.windowsLogin is required: without it no lock can
                // tell who anyone is.
                problem = 'the tables or the new columns (on review_gates and roster) do not exist. Run ' +
                    'sql\\create-review-tables.sql in SSMS (see README.md), then restart the service.';
            } else if (!row.canWrite) {
                problem = 'the tables exist, but SQL login ' + row.sqlLogin + ' cannot read and write ' +
                    'all of them (and read roster). It needs db_datareader and db_datawriter on ' +
                    (process.env.SQL_DATABASE || 'STS_WorkOrder') + ' and no DENY on the review tables or roster.';
            }
        } catch (err) {
            // SQL Server could not be reached. That says nothing about the
            // tables, so keep the last answer and check again on the next request
            // instead of reporting "not set up" for a minute after SQL is back.
            if (_reviewsProblem !== 'unreachable') {
                console.error('QC Review table check could not reach SQL Server, will retry: ' + err.message);
            }
            _reviewsProblem = 'unreachable';
            _reviewsCheckedAt = 0;
            return _reviewsReady === true;
        }
        const ready = !problem;
        if (ready && _reviewsReady !== true) console.log('QC Review tables ready');
        if (ready && !_rosterHasEmailOff && !_emailSwitchSaid) {
            _emailSwitchSaid = true;
            console.error('QC REVIEW EMAIL SWITCH UNAVAILABLE: roster.emailOff is missing. Run sql\\create-review-tables.sql ' +
                'again (see README.md). Until then everyone on a list is emailed.');
        }
        if (!ready && problem !== _reviewsProblem) console.error('QC REVIEW TABLES UNAVAILABLE: ' + problem);
        _reviewsReady = ready;
        _reviewsProblem = problem;
        _reviewsCheckedAt = Date.now();
        return ready;
    })().finally(() => { _reviewsChecking = null; });
    return _reviewsChecking;
}

// The same readiness, answered as true or false, for a route that is not a QC
// Review route and goes on either way (the job delete). The checklist file
// does not count here: the record a delete writes needs none of it.
async function reviewTablesReady() {
    if (_reviewsChecking) {
        await _reviewsChecking;
    } else if (_reviewsReady !== true && Date.now() - _reviewsCheckedAt >= REVIEW_RECHECK_MS) {
        await checkReviewTables();
    }
    return _reviewsReady === true;
}

// Route guard. Re-checks at most once a minute while the tables are missing,
// so running the SQL file does not strictly need a restart.
async function reviewsAvailable(res) {
    if (!reviewItems) {
        res.status(503).json({ available: false, error: REVIEW_NO_CHECKLIST });
        return false;
    }
    if (_reviewsChecking) {
        await _reviewsChecking;
    } else if (_reviewsReady !== true && Date.now() - _reviewsCheckedAt >= REVIEW_RECHECK_MS) {
        await checkReviewTables();
    }
    if (_reviewsReady === true) return true;
    res.status(503).json({ available: false, error: 'QC Review is not set up on this server yet.' });
    return false;
}

function reviewError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

// Every SQL error number on a failure, including the one msnodesqlv8 keeps as
// a preceding error. Numbers are the only field both drivers fill the same way.
function sqlErrorNumbers(err) {
    return [err].concat((err && err.precedingErrors) || [])
        .map(e => e && e.number)
        .filter(n => typeof n === 'number' && n > 0);   // msnodesqlv8 reports 0 when it lost the number
}

function sendReviewError(res, err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    const numbers = sqlErrorNumbers(err);
    const has = (...list) => list.some(n => numbers.includes(n));
    if (has(1205, 1222)) return res.status(503).json({ error: 'The database was busy. Try again.' });
    if (has(8152, 2628)) return res.status(400).json({ error: 'A value was too long to save.' });
    if (has(229, 230)) {
        // Permissions changed under us. Say so, and check again on the next request.
        console.error('QC REVIEW TABLES UNAVAILABLE: a write was refused by SQL Server (permission denied): ' + err.message);
        _reviewsProblem = '';
        _reviewsReady = false;
        _reviewsCheckedAt = 0;
        return res.status(503).json({ available: false, error: 'QC Review is not set up on this server yet.' });
    }
    // Under msnodesqlv8 an error in the second statement of a batch loses its
    // number and arrives as "Associated statement is not prepared" (seen with a
    // denied INSERT into review_log). The batch still rolled back, so nothing
    // half-saved, but the cause is hidden. Log it, and re-run the table and
    // permission check straight away so a permission problem still shows up in
    // the log and in /api/health.
    console.error('QC Review write failed: ' + err.message);
    if (!numbers.length) {
        _reviewsCheckedAt = 0;
        checkReviewTables();
    }
    res.status(500).json({ error: err.message });
}

// A person as a key that compares reliably: no DOMAIN\ in front, nothing from
// an @ on, small letters (userKey in user-list.js). Roster links and stamps
// written in any of those spellings ("David.Marra", "david.marra@compu-mail.com")
// are one person.
const loginKey = userKey;

// A QC Review route that records nothing and shows nothing per person (the
// landing states, the history) only needs someone to have picked a name.
function reviewPicked(req, res) {
    if (req.appUser) return true;
    res.status(401).json({ needUser: true, error: 'Choose your name first.' });
    return false;
}

// Who is asking on a QC Review route: the picked user, or null after answering
// the request. The window also names the user its page is showing in the
// X-STS-User header; when that is not the cookie's user, someone picked another
// name in another tab, and the request is refused rather than recorded under
// the wrong person (USER_PICKER_PLAN section 4e).
function reviewActor(req, res) {
    if (!reviewPicked(req, res)) return null;
    const shown = headerUser(req);   // the edit lock reads the same header the same way
    if (shown.toLowerCase() !== req.appUser.key) {
        res.status(409).json({ userChanged: true, error: 'The user was changed in another tab. Reload the page.' });
        return null;
    }
    return { user: req.appUser.user, login: req.appUser.key.slice(0, REVIEW_LIMIT.name), name: '', source: 'picked', kinds: [] };
}

// Look the person up on the roster by their user key: their roster name, and
// which lists (csr / prepress / techservices) they are active on. This needs
// an admin to have linked the user to a name in Manage CSRs & Assignees; until
// then the name stays empty and the key alone says who it was. A roster that
// cannot be read throws: the review locks depend on it, and a person quietly
// shown as "not linked" would send them to an admin for a problem only IT can
// fix (independent review Q2).
async function resolveRosterPerson(pool, person) {
    person.kinds = [];
    if (!_rosterHasLogin || !person.login) return person;
    // Compared here with loginKey, so a link stored in another spelling still
    // matches. The roster is a few dozen rows.
    const r = await pool.request().query(
        `SELECT name, kind, active, windowsLogin FROM dbo.roster
         WHERE LTRIM(RTRIM(ISNULL(windowsLogin, N''))) <> N''`);
    const rows = r.recordset.filter(x => loginKey(x.windowsLogin) === person.login);
    const names = [...new Set(rows.map(x => x.name))];
    // A user linked to two different names says nothing reliable about who
    // this is, so it counts as not linked. The User box in Manage CSRs &
    // Assignees refuses to make one.
    if (names.length === 1) {
        person.name = names[0];
        person.kinds = [...new Set(rows.filter(x => x.active).map(x => x.kind))];
    }
    return person;
}

// Throws when the roster cannot be read, as resolveRosterPerson does: a
// roster that cannot be read is an error, never "not linked".
async function rosterLoginFor(pool, name) {
    if (!_rosterHasLogin || !name) return '';
    const r = await pool.request()
        .input('rosterName', name)
        .query(`SELECT windowsLogin FROM dbo.roster
                WHERE name = @rosterName AND LTRIM(RTRIM(ISNULL(windowsLogin, N''))) <> N''`);
    const keys = [...new Set(r.recordset.map(x => loginKey(x.windowsLogin)).filter(Boolean))];
    return keys.length === 1 ? keys[0] : '';
}

// The gate's owner on this job: the CSR on the CSR checklist. A department
// checklist has none: whoever presses Send for review is its operator, in
// every round, and the person assigned on the work order does not count,
// because a job is often not assigned and whoever opens the email and works on
// it is the operator (David, 2026-09-18). That replaces the assignee as round
// 1's operator (2026-09-17), which let a second person pressing Send for
// review lock out a whole two-person department.
async function reviewGateOwner(pool, job, gate) {
    if (gate !== 'csr' || !job.csrName) return { name: '', login: '' };
    return { name: job.csrName, login: await rosterLoginFor(pool, job.csrName) };
}

// ── Who may do what (PHASE4_PLAN section b) ──

// Linked: the picked user is linked to one roster name.
function reviewLinked(person) {
    return !!person.name;
}

function sameReviewName(a, b) {
    return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// Whether a stamp on a row (sent for review by, started by, returned by) is
// this person: user key to user key, so it needs no name link.
function stampedBy(person, name, login) {
    return !!login && loginKey(login) === person.login;
}

// The lines a CSR's corrections sent to each department, with their notes as
// they stand: { prepress: { x207: 'note' }, ... }. A line whose flag has since
// been taken off, or now sits under N/A (question 3), is not waiting on anyone.
// row needs flags, na (merged marks) and flagDepts.
function reviewDeptLines(row) {
    const out = {};
    const flags = row && isPlainObject(row.flags) ? row.flags : {};
    const flagDepts = row && isPlainObject(row.flagDepts) ? row.flagDepts : {};
    const counted = reviewItems.unitVerdict('csr', 'job', { items: {}, itemValues: {}, flags, na: row && isPlainObject(row.na) ? row.na : {} }).flags;
    Object.keys(flagDepts).forEach(id => {
        if (!Object.prototype.hasOwnProperty.call(counted, id) || !Array.isArray(flagDepts[id])) return;
        flagDepts[id].forEach(dept => {
            if (!REVIEW_DEPTS.includes(dept)) return;
            if (!out[dept]) out[dept] = {};
            out[dept][id] = flags[id];
        });
    });
    return out;
}

function reviewUnlinkedText(person) {
    return person.user + ' is not linked to a name on the lists yet. ' +
        'Everything here is read only until an admin links it in Manage CSRs & Assignees.';
}

// What one person may do on one checklist of one job. The reviews GET returns
// it for every tab and every write asks it again, so the window and the server
// never disagree; the window only draws what this says. The first rule that
// applies wins. units are the checklist's rows whose piece still exists; owner
// is reviewGateOwner's answer; senders are the checklist's sent_back history
// rows (unitId, reviewRound, actorName, actorLogin).
//   role      archived, unlinked, operator, dept, csr_cover, csr or other
//   canEdit   tick, N/A, flag, note, Mark passed, Corrections needed, Reopen
//   canSend   Send for review: only before the round is sent, never once every
//             block has passed (David, 2026-09-18)
//   canReready  Ready for re-review: the operator, or someone in the department
//               doing the work for them; never whoever sent a waiting piece back
//               in its current round, nor whoever is reviewing the round, who
//               checks it again (David, 2026-09-19)
//   canSignBack Sign back in: a CSR, on the CSR tab. Whether anything is passed
//               to sign back in is the write's own test, never this: reviewAccess
//               sees one gate's rows and a sign back in reads all three.
//   canHandoff  Send to CSR: on that department's list, every block of that
//               checklist passed right now (passedNow, worked out by the caller),
//               and the files not already sent this round (sentOn: a Send to CSR
//               in this round, with no block passed again since; David, 2026-09-18)
// Send to Prepress / Send to Tech Services is not here: it is a work order
// button, never a QC Review one, and it needs the history as well as the gate
// row. It has its own rule, reviewCanNewJob, so no review write pays for an
// answer it never reads.
function reviewAccess(person, job, gate, gateRow, units, owner, senders, passedNow, sentOn) {
    const out = {
        role: '', canEdit: false, canSend: false, canReready: false, canSignBack: false, canHandoff: false, reason: '',
        owner: { name: (owner && owner.name) || '', login: (owner && owner.login) || '' }
    };
    if (job.archivedDate) return Object.assign(out, { role: 'archived', reason: REVIEW_ARCHIVED });
    if (!reviewLinked(person)) return Object.assign(out, { role: 'unlinked', reason: reviewUnlinkedText(person) });
    const kinds = person.kinds;
    // Send to CSR is not an operator or reviewer step: anyone on that
    // department's list sends its outputs on, the operator included. Set
    // before the roles below, which return as soon as one applies.
    out.canHandoff = gate !== 'csr' && !!passedNow && kinds.includes(gate) && !sentOn;

    // The CSR checklist: no operator lock, and no way for a department to close
    // it. Only a CSR fills it in, and only a CSR signs the job back in, because
    // on the floor nothing starts in a department without a CSR asking.
    if (gate === 'csr') {
        if (kinds.includes('csr')) return Object.assign(out, { role: 'csr', canEdit: true, canSignBack: true });
        return Object.assign(out, { role: 'other', reason: 'Only CSRs fill in the CSR checklist.' });
    }

    // Every round starts with Send for review: until someone presses it the
    // checklist is closed to everyone, and it is offered only then, never once
    // every block has passed (David, 2026-09-18, ROUNDS_PLAN question 1).
    const sent = !!gateRow && !!(gateRow.sentForReviewByLogin || gateRow.sentForReviewByName);
    const waiting = units.filter(u => u.disposition === 'corrections' && u.holder === 'operator');
    const sentBack = waiting.some(u => sentBackThisRound(person, u, senders));
    const canSend = !sent && !passedNow;
    // Fixed says "I did the work": never the round's reviewer.
    const reviewing = !!gateRow && stampedBy(person, gateRow.startedByName, gateRow.startedByLogin);
    const canReready = waiting.length > 0 && !sentBack && !reviewing;
    const closed = sent ? {} : { reason: REVIEW_NOT_SENT };
    // Whoever pressed Send for review is the operator, in every round; before
    // anyone has, nobody is (David, 2026-09-18).
    if (sent && stampedBy(person, gateRow.sentForReviewByName, gateRow.sentForReviewByLogin)) {
        return Object.assign(out, { role: 'operator', canReready, reason: 'You are the operator on this job, so you cannot review it.' });
    }
    if (kinds.includes(gate)) return Object.assign(out, { role: 'dept', canEdit: sent, canSend, canReready }, closed);
    if (kinds.includes('csr')) return Object.assign(out, { role: 'csr_cover', canEdit: sent }, closed);
    return Object.assign(out, { role: 'other', reason: 'Only ' + reviewGateLabel(gate) + ' can review this.' });
}

// Whether a department has picked this job up: ever sent for review (sentEver,
// read from the history so a sign back in cannot undo it), sent for review or
// started now, signed back in, past its first round, or any block with an
// answer or a disposition (touched). Handing the job over is deliberately not
// on the list: while nobody has picked it up the CSR can send it again (David,
// 2026-09-19, question 7), and once a department has, that is the end of it.
function reviewDeptStarted(gateRow, touched, sentEver) {
    const g = gateRow || {};
    return !!(touched || sentEver || g.sentForReviewByLogin || g.sentForReviewByName ||
        g.startedByLogin || g.startedByName || g.signedBackInDate || (Number(g.roundNo) || 1) > 1);
}

// Whether this person may hand this job to this department from the work
// order: Send to Prepress / Send to Tech Services (START_NEW_JOB_PLAN, David
// 2026-09-19). A rule of its own rather than a field on reviewAccess, because
// this is the one QC Review action that is pressed on the work order, never in
// the window, and because it needs the history, which every review write would
// otherwise have to read for an answer it never uses.
//
// Hers alone: a linked, active CSR, on a department tab, on a live job, while
// that department has not picked the job up. GET /api/jobs/:id/newjob answers
// it for the button, and the press's own SQL batch asks the same questions
// again, which is what decides it.
function reviewCanNewJob(person, job, gate, gateRow, touched, sentEver) {
    if (!job || job.archivedDate) return false;
    if (!reviewLinked(person) || !person.kinds.includes('csr')) return false;
    if (!REVIEW_DEPTS.includes(gate)) return false;
    return !reviewDeptStarted(gateRow, touched, sentEver);
}

// Whether this person may take a hand-over back: "Sent by mistake" (David,
// 2026-09-20). Exactly reviewCanNewJob, plus "and there is one standing to
// take back", so the two can never both be offered and never both be refused.
// It clears the four newJob* stamps and nothing else. Those stamps are read by
// the job list's chip and its hover and by nothing on the server, so clearing
// them can only take a chip off a board: it cannot open a closed door, move a
// round boundary or change who may do what. The record is untouched, because
// review_log is append-only: the new_job row stays and a new_job_taken_back
// row goes under it.
function reviewCanTakeBack(person, job, gate, gateRow, touched, sentEver) {
    if (!reviewCanNewJob(person, job, gate, gateRow, touched, sentEver)) return false;
    return !!(gateRow && String(gateRow.newJobDate || ''));
}

// Whether this person sent this unit back in its current round. Two people
// can send one unit back in the same round and the row keeps only the last,
// so the history says who else did (independent review S3).
function sentBackThisRound(person, unit, senders) {
    return stampedBy(person, unit.returnedByName, unit.returnedByLogin) ||
        (senders || []).some(x => x.unitId === unit.unitId && x.reviewRound === unit.returnCount && stampedBy(person, x.actorName, x.actorLogin));
}

function reviewLocked(res, message) {
    return res.status(403).json({ error: message, locked: true });
}

// What a QC write says when the job is archived, or the block's piece is not
// on the job: the checks before a write's batch and the batch's own test
// (reviewJobGuardSql) give the same words.
const REVIEW_ARCHIVED = 'This job is archived. Restore it before reviewing.';
const REVIEW_NO_PIECE = 'That part is not on this job';
const REVIEW_NOTHING_TO_SEND = 'Every block has passed. There is nothing to send for review.';

// ── The job, asked again inside every QC write (the independent review's F6) ──
//
// reviewWriteContext reads the job, and a block's write its piece, before the
// write's batch, and an archive, a delete, a piece deleted or an edit could
// land in the milliseconds between: a save on a job just archived, a first save
// making a sheet for a job or a piece just deleted, a pass freezing the words
// as they were a moment before (the audit reproduced each on both drivers).
// So every QC write batch starts here, right after BEGIN TRAN: it locks the
// job's row and asks again whether the job is there and not archived, whether
// each block it writes still has its piece on the job, and, for a pass, whether
// the job is still at the version its frozen words were read at.
//
// Every work order write (the job save, a piece added, saved or deleted, the
// last save as a tab closes, archive, delete, import, the name merge) changes
// the job's row first, so while a QC write holds it none of them can land, and
// one comes in after the commit. Taken first in every QC batch, it keeps one
// lock order: the job's row, then review_gates, then reviews, then the pieces
// (read). UPDLOCK, so two QC writes on one job queue here one behind the other
// while anyone reading the job carries on; on a typed variable, because
// msnodesqlv8 declares every string input as nvarchar(max), which would turn
// this seek into a range over other jobs' rows.
//
// opts.units: the input names of the block ids the batch writes ('job' always
// counts as on the job); opts.version: the input name of the job version a
// pass's frozen words were read at. Returns { declare, test }: declare goes
// before BEGIN TRAN, test right after it. A refusal rolls back and answers one
// row, { ok: 0, jobState }, with jobState 'gone', 'archived', 'nopiece' or
// 'moved', which reviewJobRefusal turns into the reads' own answer.
function reviewJobGuardSql(opts) {
    const units = (opts && opts.units) || [];
    const version = opts && opts.version;
    return {
        declare: `
        DECLARE @gJobId NVARCHAR(36);
        DECLARE @gJob NVARCHAR(10) = N'gone';
        DECLARE @gJobVersion INT;
        ${units.map((u, i) => 'DECLARE @gUnit' + i + ' NVARCHAR(36);').join('\n        ')}`,
        test: `
        SET @gJobId = @jobId;
        ${units.map((u, i) => 'SET @gUnit' + i + ' = @' + u + ';').join('\n        ')}
        SELECT @gJob = CASE WHEN ${JOB_LIVE} THEN N'live' ELSE N'archived' END, @gJobVersion = rowVersion
        FROM dbo.jobs WITH (UPDLOCK, HOLDLOCK) WHERE id = @gJobId;
        ${units.length ? `IF @gJob = N'live' AND EXISTS (SELECT 1 FROM (VALUES ${units.map((u, i) => '(@gUnit' + i + ')').join(', ')}) AS u(unitId)
                WHERE u.unitId <> N'job'
                  AND NOT EXISTS (SELECT 1 FROM dbo.components c WHERE c.jobId = @gJobId AND c.id = u.unitId))
            SET @gJob = N'nopiece';` : ''}
        ${version ? `IF @gJob = N'live' AND @gJobVersion <> @${version} SET @gJob = N'moved';` : ''}
        IF @gJob <> N'live'
        BEGIN
            ROLLBACK TRAN;
            SELECT CAST(0 AS BIT) AS ok, @gJob AS jobState;
            RETURN;
        END`
    };
}

// How many times a pass reads the job again when it changed between that read
// and the pass's batch. The window between them is a few milliseconds, so a
// second try almost never meets another change; the last try freezes what it
// read, as every pass did before F6, rather than refuse the press.
const REVIEW_PASS_TRIES = 3;

// The guard's refusal as the error the reads before the batch give for the
// same thing, or null when the guard did not refuse (a 'moved' pass is tried
// again by its caller). pieceText: a sign back in names its blocks its own way.
function reviewJobRefusal(saved, pieceText) {
    const state = saved && saved.jobState;
    if (state === 'archived') return reviewError(409, REVIEW_ARCHIVED);
    if (state === 'gone') return reviewError(404, 'Job not found');
    if (state === 'nopiece') return reviewError(404, pieceText || REVIEW_NO_PIECE);
    return null;
}

async function loadReviewJob(pool, jobId) {
    const r = await pool.request()
        .input('jobId', jobId)
        .query(`SELECT id, jobNumber, clientName, jobDescription, csrName, assignedToPrepress, assignedToTechservices,
                       createdBy, archivedDate, lastModified, lastModifiedBy, rowVersion,
                       signoffDueDatePrepress, signoffDueTimePrepress,
                       signoffDueDateTechservices, signoffDueTimeTechservices
                FROM dbo.jobs WHERE id = @jobId`);
    return r.recordset[0] || null;
}

// The unit's name for the record, or null when that unit does not belong on
// this gate of this job.
async function reviewUnitName(pool, job, gate, unitId) {
    if (unitId === 'job') return reviewJobUnitName(gate);
    const g = reviewGate(gate);
    if (!g || !g.perPiece) return null;
    const r = await pool.request()
        .input('componentId', unitId)
        .input('jobId', job.id)
        .query('SELECT name FROM dbo.components WHERE id = @componentId AND jobId = @jobId');
    return r.recordset.length ? (r.recordset[0].name || '') : null;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Clean an incoming sheet. The browser owns what the checklist means; the
// server makes sure the stored shape is sane and holds the one rule it can
// know without the checklist: a flagged item is never also checked.
function normalizeReviewSheet(body) {
    const src = body || {};
    const ids = obj => isPlainObject(obj) ? Object.keys(obj) : [];
    const badId = ids(src.items).concat(ids(src.itemValues), ids(src.flags), ids(src.na))
        .find(id => !REVIEW_ITEM_ID.test(id));
    if (badId !== undefined) throw reviewError(400, 'Unknown item id: ' + String(badId).slice(0, 40));

    const items = {};
    ids(src.items).forEach(id => { if (src.items[id] === true) items[id] = true; });

    const itemValues = {};
    ids(src.itemValues).forEach(id => {
        const v = src.itemValues[id] == null ? '' : String(src.itemValues[id]);
        if (v.length > REVIEW_LIMIT.value) throw reviewError(400, 'A value is too long (' + REVIEW_LIMIT.value + ' characters at most).');
        if (v.trim()) itemValues[id] = v;
    });

    const flags = {};
    ids(src.flags).forEach(id => {
        const note = src.flags[id] == null ? '' : String(src.flags[id]);
        if (note.length > REVIEW_LIMIT.note) throw reviewError(400, 'A note is too long (' + REVIEW_LIMIT.note + ' characters at most).');
        flags[id] = note;
        delete items[id];
    });

    const naIds = ids(src.na);
    // The words a mark carries (David, 2026-09-23: an optional N/A reason). Only
    // a mark that has its own reason key says anything about them; a mark sent
    // without one leaves them as they are, so an old body, or one that names
    // the ids alone, can never wipe them. The window never sends a mark it
    // made without the key (naOn makes { reason: '' }); a mark it loaded from
    // this server goes back exactly as stored.
    const naReasons = {};
    naIds.forEach(id => {
        const mark = src.na[id];
        if (!isPlainObject(mark) || !Object.prototype.hasOwnProperty.call(mark, 'reason')) return;
        if (typeof mark.reason !== 'string') throw reviewError(400, 'An N/A reason must be text.');
        if (mark.reason.length > REVIEW_LIMIT.naReason) throw reviewError(400, 'A reason is too long (' + REVIEW_LIMIT.naReason + ' characters at most).');
        naReasons[id] = mark.reason.trim() ? mark.reason : '';
    });
    const unitFacts = isPlainObject(src.unitFacts) ? src.unitFacts : {};
    if (JSON.stringify(unitFacts).length > REVIEW_LIMIT.facts) throw reviewError(400, 'unitFacts is too large.');
    const formVersion = String(src.formVersion || '');
    if (formVersion.length > REVIEW_LIMIT.formVersion) throw reviewError(400, 'formVersion is too long.');

    const touched = new Set(Object.keys(items).concat(Object.keys(itemValues), Object.keys(flags), naIds));
    if (touched.size > REVIEW_LIMIT.itemIds) throw reviewError(400, 'Too many items on one sheet.');

    return { items, itemValues, flags, naIds, naReasons, unitFacts, formVersion };
}

// Manual N/A marks keep the name and time of whoever set them. A new mark gets
// this request's person and the server clock; an existing mark keeps who and
// when as they were, whatever the browser sent back. Its reason changes only
// when the body says so (naReasons, from normalizeReviewSheet), and the words
// are then stamped with this request's person and time, never the browser's.
function mergeReviewNA(storedNA, naIds, actor, now, naReasons) {
    const na = {};
    const said = naReasons || {};
    naIds.forEach(id => {
        const mark = isPlainObject(storedNA[id])
            ? Object.assign({}, storedNA[id])
            : { name: actor.name, login: actor.login, at: now };
        if (Object.prototype.hasOwnProperty.call(said, id) && said[id] !== reviewReasonOf(mark)) {
            delete mark.reason;
            delete mark.reasonName;
            delete mark.reasonLogin;
            delete mark.reasonAt;
            if (said[id]) Object.assign(mark, { reason: said[id], reasonName: actor.name, reasonLogin: actor.login, reasonAt: now });
        }
        na[id] = mark;
    });
    return na;
}

// The words an N/A mark carries, or '' for none. Whitespace alone is none.
function reviewReasonOf(mark) {
    const words = isPlainObject(mark) && typeof mark.reason === 'string' ? mark.reason : '';
    return words.trim() ? words : '';
}

// History rows for a Check all press and its take-back.
// A press per section (the window changes David asked for after step 4). The
// window sweeps a section by sending ordinary ticks and naming the sections it
// swept; this counts what really changed and writes one row per section, so the
// history can always tell a swept line from a read one. The count is never
// taken from the request: a body can name a section, not how many lines moved.
// Every line's own check is recorded as well (reviewSheetChanges); these rows
// say it was one press.
function reviewSectionRows(gate, unitId, before, after, body) {
    const rows = [];
    const sections = reviewItems.unitSections(gate, unitId);
    const read = (name, logAction, changed) => {
        const raw = body ? body[name] : undefined;
        if (raw === undefined || raw === null) return;
        if (!Array.isArray(raw)) throw reviewError(400, name + ' must be a list of section numbers.');
        if (raw.length > REVIEW_LIMIT.sections) throw reviewError(400, 'Too many sections in one save.');
        [...new Set(raw.map(v => String(v)))].forEach(id => {
            const section = sections.find(x => String(x.section) === id);
            if (!section) throw reviewError(400, 'Unknown section: ' + id.slice(0, 20));
            const moved = section.items.filter(item => changed(item.id)).length;
            if (moved) rows.push({ logAction, detail: moved + (moved === 1 ? ' line' : ' lines') + ' in ' + section.title });
        });
    };
    const ticked = id => after.items[id] === true && before.items[id] !== true;
    const unticked = id => before.items[id] === true && after.items[id] !== true;
    read('sectionTicks', 'section_ticked', ticked);
    read('sectionUnticks', 'section_unticked', unticked);
    return rows;
}

// History rows for what changed between the stored sheet and the new one.
// Every line checked off or unchecked is recorded, out of sight: the history
// route leaves these rows out of what the window loads, and no screen shows
// them (David, 2026-09-23). They are what a sheet a sign back in wipes can be
// pieced back together from. A check and uncheck that land in one save leave
// no row, because rows are what changed between saves. Value edits are not
// recorded: no line takes a value today.
function reviewSheetChanges(before, after) {
    const rows = [];
    Object.keys(after.na).forEach(id => {
        if (!before.na[id]) rows.push({ logAction: 'na_set', itemId: id, detail: reviewReasonOf(after.na[id]) });
        else if (reviewReasonOf(before.na[id]) !== reviewReasonOf(after.na[id])) {
            rows.push({ logAction: 'na_reason', itemId: id, detail: reviewReasonOf(after.na[id]) });
        }
    });
    Object.keys(before.na).forEach(id => {
        if (!after.na[id]) rows.push({ logAction: 'na_unset', itemId: id });
    });
    // The note of a cleared flag lives on only here, so it is kept verbatim.
    Object.keys(before.flags).forEach(id => {
        if (!(id in after.flags)) {
            rows.push({ logAction: after.items[id] ? 'flag_cleared_by_check' : 'flag_removed', itemId: id, detail: before.flags[id] });
        }
    });
    const ticked = obj => Object.keys(obj || {}).filter(id => obj[id] === true);
    const wasTicked = new Set(ticked(before.items));
    const isTicked = new Set(ticked(after.items));
    isTicked.forEach(id => { if (!wasTicked.has(id)) rows.push({ logAction: 'ticked', itemId: id }); });
    wasTicked.forEach(id => { if (!isTicked.has(id)) rows.push({ logAction: 'unticked', itemId: id }); });
    return rows;
}

// The lines a Check all press (or its take-back) moved in this save, as the
// window names them, so each line's row can say it was swept rather than read.
// Only a label: what moved is always this server's own comparison.
function reviewSweptLines(gate, unitId, body) {
    const lines = new Set();
    reviewItems.unitSections(gate, unitId).forEach(section => section.items.forEach(item => lines.add(item.id)));
    const raw = body ? body.sweptLines : undefined;
    const out = { ticks: new Set(), unticks: new Set() };
    if (raw === undefined || raw === null) return out;
    if (!isPlainObject(raw)) throw reviewError(400, 'sweptLines must name the lines a press moved.');
    ['ticks', 'unticks'].forEach(way => {
        const list = raw[way] === undefined ? [] : raw[way];
        if (!Array.isArray(list) || list.length > REVIEW_LIMIT.itemIds) throw reviewError(400, 'sweptLines must name the lines a press moved.');
        list.forEach(id => {
            if (typeof id !== 'string' || !lines.has(id)) throw reviewError(400, 'That line is not on this checklist.');
            out[way].add(id);
        });
    });
    return out;
}

function parseReviewRow(row) {
    if (!row) return null;
    // flagDepts and deptFixes were dropped when the CSR's Fixed shortcut went
    // (SIGN_BACK_IN_PLAN section e). A database made by an earlier copy of
    // create-review-tables.sql still has the columns, and SELECT * would send
    // them on as raw strings; a fresh one has neither. Drop them either way, so
    // the reply is the same on both.
    delete row.flagDepts;
    delete row.deptFixes;
    return Object.assign({}, row, {
        items: safeParseJSON(row.items, {}),
        itemValues: safeParseJSON(row.itemValues, {}),
        flags: safeParseJSON(row.flags, {}),
        na: safeParseJSON(row.na, {}),
        unitFacts: safeParseJSON(row.unitFacts, {}),
        hasActivity: !!row.hasActivity
    });
}

// JSON with object keys in a fixed order, so two equal objects always compare equal.
function stableJson(value) {
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
}

// Whether a stored row holds the same answers as a cleaned incoming sheet: the
// same ticks, values, flags with their notes, N/A lines with their words, and
// unit facts. Who set an N/A mark and when is not compared. A mark sent without
// words of its own keeps the stored ones (normalizeReviewSheet), so it compares
// with those.
function sameReviewSheet(stored, sheet) {
    const was = stored || { items: {}, itemValues: {}, flags: {}, na: {}, unitFacts: {} };
    const storedNA = was.na || {};
    const said = sheet.naReasons || {};
    const wasNA = Object.keys(storedNA).sort().map(id => [id, reviewReasonOf(storedNA[id])]);
    const nowNA = sheet.naIds.slice().sort().map(id => [id,
        Object.prototype.hasOwnProperty.call(said, id) ? said[id] : reviewReasonOf(storedNA[id])]);
    return stableJson([was.items || {}, was.itemValues || {}, was.flags || {}, wasNA, was.unitFacts || {}]) ===
        stableJson([sheet.items, sheet.itemValues, sheet.flags, nowNA, sheet.unitFacts]);
}

// Ids not on the checklist (PHASE4_PLAN e3). An incoming answer on an id that
// is not a line of this block is accepted only when the stored row already
// holds exactly that answer. So answers saved before a line was retired or
// moved to another block survive (the window sends them back untouched), but
// nothing new is written to them. Taking one off is allowed, and logged.
function checkReviewOffList(gate, unitId, stored, sheet) {
    const lines = new Set();
    reviewItems.unitSections(gate, unitId).forEach(section => section.items.forEach(item => lines.add(item.id)));
    const was = stored || { items: {}, itemValues: {}, flags: {}, na: {} };
    const has = (obj, id) => Object.prototype.hasOwnProperty.call(obj || {}, id);
    const bad = Object.keys(sheet.items).find(id => !lines.has(id) && !(has(was.items, id) && was.items[id] === true))
        || Object.keys(sheet.itemValues).find(id => !lines.has(id) && !(has(was.itemValues, id) && was.itemValues[id] === sheet.itemValues[id]))
        || Object.keys(sheet.flags).find(id => !lines.has(id) && !(has(was.flags, id) && was.flags[id] === sheet.flags[id]))
        || sheet.naIds.find(id => !lines.has(id) && !has(was.na, id))
        || Object.keys(sheet.naReasons || {}).find(id => !lines.has(id) && sheet.naReasons[id] !== reviewReasonOf((was.na || {})[id]));
    if (bad !== undefined) throw reviewError(400, 'That line is not on this checklist.');
}

// The departments the CSR picked for each flag sent (PHASE4_PLAN d): one
// or both for every flag that counts, and nothing else.
function reviewFlagDepts(raw, counted) {
    const problem = 'Pick Prepress, Tech Services or both for each flagged item.';
    if (!isPlainObject(raw) || Object.keys(raw).length !== counted.length) throw reviewError(400, problem);
    const out = {};
    counted.forEach(id => {
        const list = Object.prototype.hasOwnProperty.call(raw, id) ? raw[id] : null;
        if (!Array.isArray(list) || !list.length || new Set(list).size !== list.length ||
            list.some(dept => !REVIEW_DEPTS.includes(dept))) {
            throw reviewError(400, problem);
        }
        out[id] = REVIEW_DEPTS.filter(dept => list.includes(dept));
    });
    return out;
}

// ── The work order as it stood when a sheet was signed off ──
// The QC record outlives the job (no foreign keys, on purpose), so a signed
// sheet has to carry the instructions it was signed against or it says "every
// line ticked" against something nobody can read (David, 2026-09-21).
//
// Two things shape what is stored. The live box is usually empty by review
// time, because the work order's X files it into the revisions and blanks it
// (app.js closeCurrentJob), so the revisions are the real text and the live box
// alone would prove nothing. And the revisions are one cumulative blob that is
// never trimmed, so freezing all of it on every sheet would store it five
// times a round on a job of one piece, and again, longer, every round. Each
// sheet therefore carries the live box plus only the revisions added since this
// piece and department were last frozen, with the revision number it goes up
// to, so a gap can be seen rather than guessed at.
// The revisions blob as entries, newest first, numbered as the work order
// numbered them, and a short fingerprint of one revision (FNV-1a), so the next
// sheet can tell the revision it marked from a different one that ended up
// with the same number. They live in review-words.js, which compares a pass's
// words with today's, so both read the Revisions one way.
const reviewHistoryEntries = reviewWords.historyEntries;
const reviewRevisionMark = reviewWords.revisionMark;

// Which departments a sheet freezes: its own, and both on the CSR checklist,
// because 29 of her 31 lines check what the departments produced.
function reviewWorkOrderDepts(gate) {
    return gate === 'csr' ? REVIEW_DEPTS.slice() : REVIEW_DEPTS.filter(dept => dept === gate);
}

// What this block was last frozen through, per piece and department, read from
// its newest signed sheet. IX_review_log_action (logAction, jobId, gate) is
// keyed for this seek. A sheet from before this existed reports nothing, so the
// next pass freezes the whole history once and later ones carry only what is
// new.
async function reviewFrozenThrough(pool, job, gate, unitId) {
    const through = {};
    const r = await pool.request()
        .input('jobId', job.id)
        .input('gate', gate)
        .input('unitId', unitId)
        .query(`SELECT TOP 1 detail FROM dbo.review_log
                WHERE logAction = N'signoff_snapshot' AND jobId = @jobId AND gate = @gate AND unitId = @unitId
                ORDER BY id DESC`);
    if (!r.recordset.length) return through;
    let prev = null;
    try { prev = JSON.parse(r.recordset[0].detail || 'null'); } catch (err) { prev = null; }
    const pieces = (prev && prev.workOrder && Array.isArray(prev.workOrder.pieces)) ? prev.workOrder.pieces : [];
    pieces.forEach(piece => {
        if (!piece || !piece.id) return;
        const held = {};
        REVIEW_DEPTS.forEach(dept => {
            const part = piece[dept];
            if (part && Number.isFinite(part.throughRevision)) {
                held[dept] = { rev: part.throughRevision, mark: part.throughMark || '' };
            }
        });
        through[piece.id] = held;
    });
    return through;
}

// Read, never written: review code may not write jobs or components, because a
// bumped jobs.rowVersion would hand the operator the "Job updated on the
// server" pop-up. Called only on a pass.
async function reviewWorkOrder(pool, job, gate, unitId, now) {
    const depts = reviewWorkOrderDepts(gate);
    if (!depts.length) return null;
    const onePiece = unitId !== 'job';
    const request = pool.request().input('jobId', job.id);
    if (onePiece) request.input('componentId', unitId);
    const r = await request.query(`SELECT id, name, version,
                   instructions_prepress, instructions_techservices,
                   instructionsHistory_prepress, instructionsHistory_techservices
            FROM dbo.components WHERE jobId = @jobId${onePiece ? ' AND id = @componentId' : ''}
            ORDER BY sortOrder, id`);
    const through = await reviewFrozenThrough(pool, job, gate, unitId);
    const pieces = r.recordset.map(row => {
        const piece = { id: row.id, name: row.name || '', version: row.version || '' };
        depts.forEach(dept => {
            const entries = reviewHistoryEntries(row['instructionsHistory_' + dept]);
            const highest = entries.reduce((max, entry) => (entry.rev > max ? entry.rev : max), 0);
            const last = (through[row.id] || {})[dept] || null;
            const had = last && Number.isFinite(last.rev) ? last.rev : null;
            // Importing over a job keeps its id and its QC records but takes
            // its pieces from the file, so the revisions can be replaced by an
            // older set and even written back up to the same numbers. The mark
            // the last sheet left is only good while the revision it names is
            // still the same revision, which is what its fingerprint says.
            // When it is not, this freezes the whole history again and says
            // so, rather than reporting nothing new about a history that was
            // wholly replaced.
            let seen = had === null ? -1 : had;
            let rewritten = false;
            if (seen > 0) {
                const still = entries.find(entry => entry.rev === seen);
                const marked = last && last.mark;
                if (highest < seen || !still || (marked && reviewRevisionMark(still.html) !== marked)) {
                    seen = -1;
                    rewritten = true;
                }
            }
            const added = entries.filter(entry => entry.rev > seen);
            const top = entries.find(entry => entry.rev === highest);
            piece[dept] = {
                live: row['instructions_' + dept] || '',
                added: added.map(entry => entry.html),
                throughRevision: highest,
                throughMark: top ? reviewRevisionMark(top.html) : ''
            };
            if (rewritten) {
                piece[dept].rewritten = true;
                piece[dept].wasThrough = had;
            }
        });
        return piece;
    });
    // reportedAt and reportedBy are the work order's own account of itself and
    // come from the browser (server.js, the component PUT), so they are named
    // as reported and never as this record's clock. frozenAt is ours.
    return {
        reportedAt: job.lastModified || '',
        reportedBy: job.lastModifiedBy || '',
        frozenAt: now,
        pieces
    };
}

// The signed sheet as it stood, naming every line in the checklist's words at
// that moment, so the record reads the same after the checklist changes or the
// job is deleted (PHASE4_PLAN e6). A following line keeps its reason as it was
// shown, never worked out again later. Version 4 (2026-09-23) adds the words
// of an own N/A mark: reason, and who wrote it and when. On a following line
// reason is the checklist's words, told apart by follows.
function reviewSnapshot(ctx, unitId, unitName, sheet, na, next, verdict, sender) {
    const { gate, job } = ctx;
    const has = (obj, id) => Object.prototype.hasOwnProperty.call(obj, id);
    const onBlock = new Set();
    const sections = reviewItems.unitSections(gate, unitId).map(section => ({
        section: section.section,
        title: section.title,
        lines: section.items.map(item => {
            onBlock.add(item.id);
            const follows = reviewItems.followingNA(gate, item.id, na);
            const mark = has(na, item.id) && isPlainObject(na[item.id]) ? na[item.id] : null;
            const ticked = sheet.items[item.id] === true && !has(sheet.flags, item.id);
            return {
                id: item.id,
                label: item.label,
                answer: follows || mark ? 'na' : ticked ? 'ticked' : 'open',
                na: follows ? { follows: item.naWith, reason: follows }
                    : mark ? reviewSnapshotMark(mark) : null,
                value: has(sheet.itemValues, item.id) ? sheet.itemValues[item.id] : ''
            };
        })
    }));
    const offList = { items: {}, itemValues: {}, flags: {}, na: {} };
    [['items', sheet.items], ['itemValues', sheet.itemValues], ['flags', sheet.flags], ['na', na]].forEach(([field, obj]) => {
        Object.keys(obj).forEach(id => { if (!onBlock.has(id)) offList[field][id] = obj[id]; });
    });
    return {
        snapshot: 4, gate, unitId, unitName,
        workOrder: ctx.workOrder || null,
        jobNumber: job.jobNumber || '', clientName: job.clientName || '', jobDescription: job.jobDescription || '',
        formVersion: reviewForms[gate], returnCount: next.returnCount,
        reviewerName: next.reviewerName, reviewerLogin: next.reviewerLogin, reviewerRole: next.reviewerRole,
        operatorName: next.operatorName, operatorLogin: next.operatorLogin,
        sentForReviewByName: (sender && sender.name) || '', sentForReviewByLogin: (sender && sender.login) || '',
        sections,
        hiddenFlags: verdict.hiddenFlags,
        offList,
        sheet: { items: sheet.items, itemValues: sheet.itemValues, flags: sheet.flags, na, unitFacts: sheet.unitFacts }
    };
}

// An own N/A mark on a signed sheet: who and when, and its words when it has any.
function reviewSnapshotMark(mark) {
    const out = { name: mark.name || '', login: mark.login || '', at: mark.at || '' };
    const words = reviewReasonOf(mark);
    if (words) Object.assign(out, { reason: words, reasonName: mark.reasonName || '', reasonLogin: mark.reasonLogin || '', reasonAt: mark.reasonAt || '' });
    return out;
}

function expectedRowVersion(body) {
    const v = body ? body.rowVersion : undefined;
    if (!Number.isInteger(v) || v < 0) throw reviewError(400, 'rowVersion is required (0 for a new sheet).');
    return v;
}

function lastRecordset(result) {
    const sets = (result && result.recordsets) || [];
    return sets.length ? sets[sets.length - 1] : [];
}

// Adds the INSERT for this batch's history rows. Values every row shares are
// bound once and each row adds only its own few, which keeps even a large
// batch far below SQL Server's 2100-parameter limit. INSERT ... SELECT with
// UNION ALL rather than a multi-row VALUES list, which SQL Server 2005 does not
// accept; ORDER BY seq keeps the ids in the order the rows were listed.
function reviewLogInsertSql(request, shared, rows) {
    if (!rows.length) return '';
    if (rows.length > REVIEW_LIMIT.logRows) throw reviewError(400, 'Too many changes in one save.');
    request.input('logJobId', shared.jobId);
    request.input('logJobNumber', shared.jobNumber || '');
    request.input('logGate', shared.gate);
    request.input('logActorName', shared.actor.name);
    request.input('logActorLogin', shared.actor.login);
    request.input('logActorSource', shared.actor.source);
    request.input('logWhen', shared.now);
    const values = rows.map((row, i) => {
        // A row can name its own checklist (a sign back in writes one row per
        // department in one batch). Rows that do not bind nothing extra, so
        // every other caller's parameter count is exactly what it was.
        const rowGate = row.gate != null ? row.gate : shared.gate;
        let gateParam = '@logGate';
        if (rowGate !== shared.gate) {
            request.input('logGate' + i, rowGate);
            gateParam = '@logGate' + i;
        }
        request.input('logUnitId' + i, row.unitId != null ? row.unitId : shared.unitId);
        // review_log.unitName holds 200, and the value is the piece's version
        // and name joined, which can reach 221 (20 and 200 in create-tables.sql).
        // SQL Server refuses the whole write rather than trimming, so trim here,
        // as every other long value in this record already is.
        const unitNameValue = row.unitName != null ? row.unitName : shared.unitName;
        request.input('logUnitName' + i, typeof unitNameValue === 'string' ? unitNameValue.slice(0, REVIEW_LIMIT.unitName) : unitNameValue);
        request.input('logItemId' + i, row.itemId || '');
        request.input('logItemLabel' + i, reviewItemLabel(rowGate, row.itemId));
        request.input('logRound' + i, row.reviewRound != null ? row.reviewRound : shared.reviewRound);
        request.input('logAction' + i, row.logAction);
        request.input('logDetail' + i, row.detail || '');
        return `SELECT ${i} AS seq, @logJobId AS jobId, @logJobNumber AS jobNumber, ${gateParam} AS gate,
                    @logUnitId${i} AS unitId, @logUnitName${i} AS unitName, @logItemId${i} AS itemId,
                    @logItemLabel${i} AS itemLabel, @logRound${i} AS reviewRound, @logAction${i} AS logAction,
                    @logDetail${i} AS detail, @logActorName AS actorName, @logActorLogin AS actorLogin,
                    @logActorSource AS actorSource, N'' AS recipientName, N'' AS recipientAddress,
                    @logWhen AS whenIso`;
    });
    return `
        INSERT INTO dbo.review_log (jobId, jobNumber, gate, unitId, unitName, itemId, itemLabel,
            reviewRound, logAction, detail, actorName, actorLogin, actorSource,
            recipientName, recipientAddress, whenIso)
        SELECT v.jobId, v.jobNumber, v.gate, v.unitId, v.unitName, v.itemId, v.itemLabel,
            v.reviewRound, v.logAction, v.detail, v.actorName, v.actorLogin, v.actorSource,
            v.recipientName, v.recipientAddress, v.whenIso
        FROM (
            ${values.join('\n            UNION ALL ')}
        ) AS v
        ORDER BY v.seq;`;
}

async function selectReviewUnit(pool, jobId, gate, unitId) {
    const r = await pool.request()
        .input('jobId', jobId)
        .input('gate', gate)
        .input('unitId', unitId)
        .query('SELECT * FROM dbo.reviews WHERE jobId = @jobId AND gate = @gate AND unitId = @unitId');
    return r.recordset[0] || null;
}

async function selectReviewGate(pool, jobId, gate) {
    const r = await pool.request()
        .input('jobId', jobId)
        .input('gate', gate)
        .query('SELECT * FROM dbo.review_gates WHERE jobId = @jobId AND gate = @gate');
    return r.recordset[0] || null;
}

// Who sent back a piece of a job, and in which round, for reviewAccess. Read
// only while something is sent back and waiting, the one time it matters.
async function selectReviewSenders(pool, jobId, gate, units) {
    if (!units.some(u => u.disposition === 'corrections' && u.holder === 'operator')) return [];
    const request = pool.request().input('jobId', jobId);
    if (gate) request.input('gate', gate);
    const r = await request.query(`SELECT gate, unitId, reviewRound, actorName, actorLogin FROM dbo.review_log
        WHERE jobId = @jobId AND logAction = N'sent_back'${gate ? ' AND gate = @gate' : ''}`);
    return r.recordset;
}

// The three facts reviewCanNewJob needs, for every checklist of one job at
// once: each gate row, which checklists have a block with an answer or a
// disposition (a deleted piece's row does not count, as everywhere else), and
// which have ever been sent for review. That last one is read from the
// history, not from the gate row, because a sign back in clears the gate's
// sender and must not bring the button back; one row per checklist at most, on
// IX_review_log_action. Three small seeks, kept apart so each reads plainly.
async function selectNewJobFacts(pool, jobId) {
    const gates = await pool.request().input('jobId', jobId).query(
        `SELECT gate, sentForReviewByName, sentForReviewByLogin, startedByName, startedByLogin,
                signedBackInDate, roundNo, newJobDate
         FROM dbo.review_gates WHERE jobId = @jobId`);
    const touched = await pool.request().input('jobId', jobId).query(
        `SELECT DISTINCT r.gate FROM dbo.reviews r
         WHERE r.jobId = @jobId AND (r.hasActivity = 1 OR r.disposition <> N'')
           AND (r.unitId = N'job' OR EXISTS (SELECT 1 FROM dbo.components c WHERE c.id = r.unitId AND c.jobId = r.jobId))`);
    const sent = await pool.request().input('jobId', jobId).query(
        `SELECT DISTINCT gate FROM dbo.review_log WHERE jobId = @jobId AND logAction = N'sent_for_review'`);
    const byGate = {};
    gates.recordset.forEach(row => { byGate[String(row.gate)] = row; });
    return {
        gates: byGate,
        touched: new Set(touched.recordset.map(x => String(x.gate))),
        sentEver: new Set(sent.recordset.map(x => String(x.gate)))
    };
}

// Why a department checklist is read only before its round starts.
const REVIEW_NOT_SENT = 'Read only until it is sent for review.';

// The flags as sent back in a piece's current round, line id -> note, while it
// is with the operator; {} otherwise. Corrections needed goes again only with
// something new (David, 2026-09-18, ROUNDS_PLAN question 2), and the window
// greys the button from this.
async function reviewSentFlags(pool, row) {
    if (!row || row.disposition !== 'corrections' || row.holder !== 'operator') return {};
    const r = await pool.request()
        .input('jobId', row.jobId).input('gate', row.gate).input('unitId', String(row.unitId)).input('round', Number(row.returnCount) || 0)
        .query(`SELECT itemId, detail FROM dbo.review_log
                WHERE jobId = @jobId AND gate = @gate AND unitId = @unitId AND reviewRound = @round AND logAction = N'flagged'
                ORDER BY id`);
    const out = {};
    r.recordset.forEach(x => { out[x.itemId] = String(x.detail || ''); });
    return out;
}

// A piece the CSR signed back in while its round was going, in the loop it is
// in now: her words, who and when; null otherwise (David, 2026-09-19). It stays
// through a reviewer flagging more on the same loop, and ends when the piece is
// passed or a reviewer sends it back again from re-check (a new loop).
async function reviewSignedBack(pool, row) {
    if (!row || row.disposition !== 'corrections') return null;
    const r = await pool.request()
        .input('jobId', row.jobId).input('gate', row.gate).input('unitId', String(row.unitId)).input('round', Number(row.returnCount) || 0)
        .query(`SELECT TOP 1 detail, actorName, actorLogin, whenIso FROM dbo.review_log
                WHERE jobId = @jobId AND gate = @gate AND unitId = @unitId AND reviewRound = @round AND logAction = N'signed_back'
                ORDER BY id DESC`);
    const x = r.recordset[0];
    return x ? { note: String(x.detail || ''), actorName: x.actorName || '', actorLogin: x.actorLogin || '', whenIso: x.whenIso || '' } : null;
}

// The note typed on the Fixed, ready for re-review that sent this piece back
// to be checked again, while it waits for that check: the newest Fixed row of
// the loop it is in (Fixed does not move the round), and only when it has
// words (OPERATOR_NOTE_PLAN, David 2026-10-01).
async function reviewFixedNote(pool, row) {
    if (!row || row.disposition !== 'corrections' || row.holder !== 'reviewer') return null;
    const r = await pool.request()
        .input('jobId', row.jobId).input('gate', row.gate).input('unitId', String(row.unitId)).input('round', Number(row.returnCount) || 0)
        .query(`SELECT TOP 1 detail, actorName, actorLogin, whenIso FROM dbo.review_log
                WHERE jobId = @jobId AND gate = @gate AND unitId = @unitId AND reviewRound = @round AND logAction = N'ready_for_rereview'
                ORDER BY id DESC`);
    const x = r.recordset[0];
    const note = x ? String(x.detail || '') : '';
    return note ? { note, actorName: x.actorName || '', actorLogin: x.actorLogin || '', whenIso: x.whenIso || '' } : null;
}

// The hand-back marks of one job: for each checklist and piece, the newest
// sent_back or signed_back history row (its id, action and who), keyed
// 'gate|unitId'. One of those two rows is written in the same batch as every
// Corrections needed and every sign back in that sends a piece to the
// operator, and nothing else writes either, so a piece's mark moves exactly
// when something new is sent to the operator. Fixed carries the marks its
// window opened with, and a piece whose mark has moved since stays with the
// operator (STALE_FIXED_PLAN.md). Per gate: 'job' is both Prepress's Whole
// Job and the Tech Services checklist.
async function selectReviewBacks(pool, jobId) {
    const r = await pool.request().input('jobId', jobId).query(`
        SELECT l.gate, l.unitId, l.id, l.logAction, l.actorName, l.actorLogin
        FROM dbo.review_log l
        JOIN (SELECT MAX(id) AS id FROM dbo.review_log
              WHERE logAction IN (N'sent_back', N'signed_back') AND jobId = @jobId
              GROUP BY gate, unitId) newest ON newest.id = l.id`);
    const out = new Map();
    r.recordset.forEach(x => out.set(x.gate + '|' + x.unitId, {
        mark: Number(x.id), by: { action: String(x.logAction), name: x.actorName || '', login: x.actorLogin || '' }
    }));
    return out;
}

// A row with the operator carries its mark (0 when it has none) and who handed
// it back; any other row carries null for both.
function withReviewBack(row, backs) {
    const waiting = row.disposition === 'corrections' && row.holder === 'operator';
    const back = waiting ? backs.get(row.gate + '|' + String(row.unitId)) : null;
    row.backMark = waiting ? (back ? back.mark : 0) : null;
    row.backBy = back ? back.by : null;
    return row;
}

// A unit row as the window gets it: with the flags already sent back, whether
// the CSR signed it back in, and the note on the Fixed it is waiting on.
async function withSentFlags(pool, row) {
    return row ? Object.assign(row, {
        sentFlags: await reviewSentFlags(pool, row),
        signedBack: await reviewSignedBack(pool, row),
        fixedNote: await reviewFixedNote(pool, row)
    }) : row;
}

// Whether the files sent to the CSR from one checklist still stand: sent in
// this round, and no block of it passed again since. handoff is the newest Send
// to CSR once a sign back in has dropped the ones before it.
// Compared by time, the same test as the send's own batch, the window and the
// job list's board, so all four always agree.
function reviewSentOn(handoff, units) {
    if (!handoff || !handoff.passedNow) return false;
    const newest = units.reduce((m, u) => (u.disposition === 'passed' && String(u.completedDate || '') > m ? String(u.completedDate) : m), '');
    return !(newest > String(handoff.whenIso || ''));
}

// Everything reviewAccess needs for one checklist of one job: its gate row,
// its unit rows whose piece still exists, its owner and who sent pieces back.
async function loadReviewGateState(pool, job, gate) {
    const gateRow = await selectReviewGate(pool, job.id, gate);
    const r = await pool.request()
        .input('jobId', job.id)
        .input('gate', gate)
        .query(`SELECT r.* FROM dbo.reviews r
                WHERE r.jobId = @jobId AND r.gate = @gate
                  AND (r.unitId = N'job' OR EXISTS (SELECT 1 FROM dbo.components c WHERE c.id = r.unitId AND c.jobId = r.jobId))`);
    const owner = await reviewGateOwner(pool, job, gate);
    const units = r.recordset.map(parseReviewRow);
    const senders = await selectReviewSenders(pool, job.id, gate, units);
    return { gateRow, units, owner, senders };
}

// ── Who an email can go to, and the nine triggers (PHASE5_PLAN sections b and h) ──
//
// An address is only ever the user linked to a person, at USER_EMAIL_DOMAIN.
// This half reads the roster, the user list and the job; review-mail.js turns
// what it finds into an address, into who is in To, and into the words.
// Everything here runs inside mailEmails, after the action has been saved and
// before it is answered, so a roster read that throws shows in the job's QC
// activity and the service log and never on the press.

const MAIL_LIST_LABEL = { csr: 'CSR', prepress: 'Prepress', techservices: 'Tech Services' };

async function mailRosterRows(pool) {
    if (!_rosterHasLogin) return [];
    const r = await pool.request().query(
        'SELECT name, kind, active, windowsLogin' + (_rosterHasEmailOff ? ', emailOff' : '') + ' FROM dbo.roster');
    return r.recordset;
}

// Whether this person's Email switch is off in Manage CSRs & Assignees. The
// switch belongs to the person, so any roster row of theirs that has it off
// counts: every row linked to their user when the record knows the user (an
// operator is stamped by user, and may be on the list under another spelling),
// and every row carrying their name.
function mailEmailOff(rows, name, key) {
    return rows.some(x => x.emailOff && (
        (key && loginKey(x.windowsLogin) === key) || (name && sameReviewName(x.name, name))
    ));
}

// What the user list says about one user key: its own spelling and display
// name, or empty when that user is no longer on it.
function mailUserOf(key) {
    const entry = key ? userList.find(key) : null;
    return { listed: entry ? entry.user : '', display: entry ? entry.display : '' };
}

// The one user linked to a roster name, in the spelling the roster holds
// (rosterLoginFor's rule: none, or more than one, counts as not linked).
function mailLinkOf(rows, name) {
    const mine = rows.filter(x => sameReviewName(x.name, name) && String(x.windowsLogin || '').trim());
    const keys = [...new Set(mine.map(x => loginKey(x.windowsLogin)))];
    return keys.length === 1 ? String(mine[0].windowsLogin).trim() : '';
}

// A name the job or a list gives us: the job's CSR, or someone on a
// department list. Judged by the list the job names them on (section h).
function mailNamed(rows, kind, name) {
    const spelling = mailLinkOf(rows, name);
    return Object.assign({
        name: String(name || ''),
        listLabel: MAIL_LIST_LABEL[kind] || kind,
        onList: rows.some(x => x.kind === kind && sameReviewName(x.name, name)),
        active: rows.some(x => x.kind === kind && sameReviewName(x.name, name) && x.active),
        spelling,
        key: loginKey(spelling),
        emailOff: mailEmailOff(rows, name, loginKey(spelling)),
        domain: mailSettings.domain
    }, mailUserOf(loginKey(spelling)));
}

// Someone the record stamped by user: whoever pressed Send for review (the
// operator), sent a piece back, or sent CSR corrections. The lists do not come
// into it, because the record already says who it was. The roster rows are
// read only for that person's Email switch.
function mailStamped(rows, name, login) {
    const spelling = String(login || '').trim();
    const key = loginKey(spelling);
    return Object.assign({
        name: String(name || ''), listLabel: '', onList: null, active: true,
        spelling, key, emailOff: mailEmailOff(rows, name, key), domain: mailSettings.domain
    }, mailUserOf(key));
}

// Everyone active on one list.
function mailListOf(rows, kind) {
    const names = [...new Set(rows.filter(x => x.kind === kind && x.active && x.name).map(x => x.name))];
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return names.map(name => mailNamed(rows, kind, name));
}

// The checklist's operator on this job: whoever pressed Send for review, the
// same rule as reviewAccess, so the email goes to whoever the locks call the
// operator. Nobody before it is sent.
function mailOperators(rows, gateRow) {
    if (!gateRow || !(gateRow.sentForReviewByLogin || gateRow.sentForReviewByName)) return [];
    return [mailStamped(rows, gateRow.sentForReviewByName, gateRow.sentForReviewByLogin)];
}

// Everyone who sent this block back in this round, read from the history
// before the action's batch. The row keeps only the last sender, and after the
// batch nothing is waiting, so a fresh read would find none.
function mailSendersOf(rows, state, gate, unitId, round) {
    return (state.senders || [])
        .filter(x => (!x.gate || x.gate === gate) && String(x.unitId) === String(unitId) && Number(x.reviewRound) === Number(round))
        .map(x => mailStamped(rows, x.actorName, x.actorLogin));
}

function mailActorName(actor) {
    return actor.name || displayName(actor.user) || actor.user || '';
}

// The flagged lines of one block, in checklist order, with their notes.
function mailItems(gate, unitId, flags) {
    const out = [];
    const held = isPlainObject(flags) ? flags : {};
    reviewItems.unitSections(gate, unitId).forEach(section => section.items.forEach(item => {
        if (Object.prototype.hasOwnProperty.call(held, item.id)) out.push({ label: item.label, note: held[item.id] });
    }));
    return out;
}

// A block's name as the window writes it ("V2 Letter", "Whole Job", "Tech
// Services Checklist"). The history keeps the piece's plain name, so this is
// worked out only when an email needs it.
async function mailBlockName(pool, job, gate, unitId) {
    if (unitId === 'job') return reviewJobUnitName(gate);
    const r = await pool.request()
        .input('componentId', unitId)
        .input('jobId', job.id)
        .query('SELECT name, version FROM dbo.components WHERE id = @componentId AND jobId = @jobId');
    const row = r.recordset[0];
    if (!row) return '';
    return [String(row.version || '').trim(), String(row.name || '').trim()].filter(Boolean).join(' ');
}

// Every block of one department checklist, in the window's order, with its
// state in the window's chip words and who passed it. A piece with no row is
// Not started; a deleted piece is not there at all.
async function mailBlocksOf(pool, job, gate) {
    const g = reviewGate(gate);
    const pieces = g && g.perPiece
        ? (await pool.request().input('jobId', job.id)
            .query('SELECT id, name, version FROM dbo.components WHERE jobId = @jobId ORDER BY sortOrder, id')).recordset
        : [];
    const stored = await pool.request().input('jobId', job.id).input('gate', gate)
        .query(`SELECT unitId, disposition, holder, hasActivity, reviewerName, reviewerLogin, completedDate
                FROM dbo.reviews WHERE jobId = @jobId AND gate = @gate`);
    const byUnit = new Map(stored.recordset.map(row => [String(row.unitId), row]));
    const blocks = pieces.map(p => ({
        unitId: String(p.id),
        name: [String(p.version || '').trim(), String(p.name || '').trim()].filter(Boolean).join(' ')
    }));
    blocks.push({ unitId: 'job', name: reviewJobUnitName(gate) });
    return blocks.map(block => {
        const row = byUnit.get(block.unitId) || null;
        return Object.assign(block, {
            state: reviewMail.blockState(row ? { disposition: row.disposition, holder: row.holder, hasActivity: !!row.hasActivity } : null),
            by: row ? (row.reviewerName || row.reviewerLogin || '') : '',
            byLogin: row ? loginKey(row.reviewerLogin || '') : '',
            at: row ? (row.completedDate || '') : ''
        });
    });
}

// Whether every block of a department checklist is passed right now: every
// piece on the job and Whole Job on Prepress, the one checklist on Tech
// Services. A piece with no row counts as not passed. The same rule the Send
// to CSR batch holds in SQL, so the window and the server cannot disagree.
function reviewPassedNow(gate, pieceIds, units) {
    const g = reviewGate(gate);
    if (!g || gate === 'csr') return false;
    const ids = (g.perPiece ? pieceIds.map(String) : []).concat(['job']);
    return ids.every(id => units.some(u => u.gate === gate && String(u.unitId) === id && u.disposition === 'passed'));
}

// The newest Send to CSR for each department checklist, for the CSR tab's
// Outputs and for the amber line when that checklist has changed since.
// The newest row of one action for each department checklist. Named inputs on
// pool.request(), never the db.js query helper, which msnodesqlv8 breaks on two
// or more values.
async function selectNewestByGate(pool, jobId, logAction) {
    const r = await pool.request().input('jobId', jobId).input('logAction', logAction).query(`
        SELECT l.id, l.gate, l.detail, l.actorName, l.actorLogin, l.recipientName, l.whenIso
        FROM dbo.review_log l
        WHERE l.jobId = @jobId AND l.logAction = @logAction
          AND l.id = (SELECT MAX(l2.id) FROM dbo.review_log l2
                      WHERE l2.jobId = l.jobId AND l2.gate = l.gate AND l2.logAction = @logAction)`);
    const out = {};
    r.recordset.forEach(row => { if (REVIEW_DEPTS.includes(row.gate)) out[row.gate] = row; });
    return out;
}

// The note typed on each checklist's Send for review, while that send is still
// the round's: the gate row's sender is stamped by the same batch, with the
// same time. A sign back in clears the sender, so an earlier round's note is
// never handed back, and a later send with nothing typed has none
// (OPERATOR_NOTE_PLAN, David 2026-10-01).
function reviewSendNotes(newest, gateRows) {
    const out = {};
    Object.keys(newest).forEach(gate => {
        const row = newest[gate];
        const g = gateRows.find(x => x.gate === gate);
        const note = String(row.detail || '');
        if (!note || !g || !(g.sentForReviewByLogin || g.sentForReviewByName)) return;
        if (String(g.sentForReviewDate || '') !== String(row.whenIso || '')) return;
        out[gate] = { note, actorName: row.actorName || '', actorLogin: row.actorLogin || '', whenIso: row.whenIso || '' };
    });
    return out;
}

// What the operator typed for the reviewer on Send for review or Fixed, ready
// for re-review: optional, kept as that press's history row detail. Line breaks
// made plain and the ends trimmed, as the Send to CSR paths are.
function reviewSendNote(body) {
    const raw = body && body.note;
    const note = (typeof raw === 'string' ? raw : '').replace(/\r\n?/g, '\n').trim();
    if (note.length > REVIEW_LIMIT.sendNote) throw reviewError(400, 'That is too long to send. Keep it under 4,000 characters.');
    return note;
}

async function selectReviewHandoffs(pool, jobId, passedNow) {
    const rows = await selectNewestByGate(pool, jobId, 'sent_to_csr');
    const out = {};
    Object.keys(rows).forEach(gate => {
        const row = rows[gate];
        out[gate] = {
            gate, actorName: row.actorName, actorLogin: row.actorLogin,
            recipientName: row.recipientName, paths: row.detail, whenIso: row.whenIso,
            passedNow: !!passedNow[gate], id: row.id
        };
    });
    return out;
}

// What the CSR asked for when she last signed this job back in, per checklist:
// her words, the blocks she ticked and the lines she flagged for that
// department. The gate row carries the note too; this is where the flags live,
// because they are kept per round forever rather than in a column that the next
// send overwrites (SIGN_BACK_IN_PLAN section i).
async function selectReviewSignBacks(pool, jobId) {
    const rows = await selectNewestByGate(pool, jobId, 'signed_back_in');
    const out = {};
    Object.keys(rows).forEach(gate => {
        const row = rows[gate];
        const detail = safeParseJSON(row.detail, {});
        out[gate] = {
            gate, actorName: row.actorName, actorLogin: row.actorLogin, whenIso: row.whenIso, id: row.id,
            note: String(detail.note || ''), production: !!detail.production,
            blocks: Array.isArray(detail.blocks) ? detail.blocks : [],
            flags: Array.isArray(detail.flags) ? detail.flags : []
        };
    });
    return out;
}

// The first pass of each block, per checklist, as a history row id. A piece
// with no pass older than a Send to CSR was not on the job when those files
// went: the send is refused while any piece now on the job is not passed (its
// batch counts them), and history rows are never deleted. Named input on
// pool.request(), so it is safe on msnodesqlv8.
async function selectFirstPasses(pool, jobId) {
    const r = await pool.request().input('jobId', jobId).query(`
        SELECT gate, unitId, MIN(id) AS firstPass
        FROM dbo.review_log
        WHERE jobId = @jobId AND logAction = N'passed'
        GROUP BY gate, unitId`);
    const out = new Map();
    r.recordset.forEach(row => out.set(row.gate + '|' + row.unitId, Number(row.firstPass)));
    return out;
}

// The pieces on the job now that were not there when a department's files
// went to the CSR, so the window can name them under those files rather than
// blame the department for a change someone else made (ADDED_PIECE_PLAN, David
// 2026-09-24). A piece stays named after someone starts it and after it
// passes, until the files go again. Only a per-piece checklist has pieces, and
// Whole Job is never one. pieces are the job's components in block order.
function reviewAddedSince(handoff, pieces, firstPasses) {
    const g = reviewGate(handoff.gate);
    if (!g || !g.perPiece) return [];
    return pieces.filter(p => !(firstPasses.get(handoff.gate + '|' + p.id) < Number(handoff.id)))
        .map(p => ({ id: p.id, name: p.name, version: p.version }));
}

// A reviewer asking the operator to send the files (PHASE6_PLAN d). It stands
// until the files actually go, so a newer sent_to_csr row answers it.
async function selectReviewAsks(pool, jobId, handoffs) {
    const rows = await selectNewestByGate(pool, jobId, 'handoff_asked');
    const out = {};
    Object.keys(rows).forEach(gate => {
        const row = rows[gate];
        const sent = handoffs[gate];
        if (sent && sent.id > row.id) return;
        out[gate] = { gate, actorName: row.actorName, actorLogin: row.actorLogin, whenIso: row.whenIso, id: row.id };
    });
    return out;
}

// A sign back in starts a new round on that department's checklist, so the
// files it sent the CSR before, and any request to send them, belong to the
// round that ended: the paths can change, and the old PDFs are overwritten or
// thrown away (David, 2026-09-17). They stay in the history. rows is
// handoffs or asks, changed in place and returned.
function dropSignedBack(rows, signBacks) {
    Object.keys(rows).forEach(gate => {
        const back = signBacks[gate];
        if (back && back.id > rows[gate].id) delete rows[gate];
    });
    return rows;
}

// One history row per email line (who could not be emailed, and the opened
// row the page reports), written on its own, never inside an action's batch:
// reviewLogInsertSql always writes empty recipient columns, and keeping them
// out of that batch keeps its size where it was.
async function mailLogRow(pool, stamp, logAction, extra) {
    const values = Object.assign({
        jobId: stamp.jobId, jobNumber: stamp.jobNumber || '', gate: stamp.gate || '',
        unitId: stamp.unitId || '', unitName: stamp.unitName || '', itemId: '', itemLabel: '',
        reviewRound: Number(stamp.reviewRound) || 0, logAction, detail: '',
        actorName: (stamp.actor && stamp.actor.name) || '', actorLogin: (stamp.actor && stamp.actor.login) || '',
        actorSource: (stamp.actor && stamp.actor.source) || '',
        recipientName: '', recipientAddress: '', whenIso: new Date().toISOString()
    }, extra);
    const request = pool.request();
    Object.keys(values).forEach(name => request.input(name, values[name]));
    await request.query(`
        INSERT INTO dbo.review_log (jobId, jobNumber, gate, unitId, unitName, itemId, itemLabel,
            reviewRound, logAction, detail, actorName, actorLogin, actorSource,
            recipientName, recipientAddress, whenIso)
        VALUES (@jobId, @jobNumber, @gate, @unitId, @unitName, @itemId, @itemLabel,
            @reviewRound, @logAction, @detail, @actorName, @actorLogin, @actorSource,
            @recipientName, @recipientAddress, @whenIso)`);
}

// One press, end to end: who is in To, the one email, and a history row for
// everyone who could not be emailed. Answers the email the page opens in
// Outlook (null when nobody is in To): its mailto link, the names in To for
// the activity, and the press it belongs to (record), which the page sends
// back once Outlook has it (POST .../email-opened). stamp carries the press
// that caused it, so the record says whose press it was.
async function mailBuild(pool, stamp, kind, facts, build) {
    const audience = reviewMail.audienceFor(kind, facts);
    for (const line of audience.notSent) {
        await mailLogRow(pool, stamp, 'email_not_sent', { recipientName: line.name, detail: line.reason });
    }
    for (const line of audience.groups) {
        await mailLogRow(pool, stamp, 'email_not_sent', { detail: line.text });
    }
    if (audience.nobody) {
        await mailLogRow(pool, stamp, 'email_not_sent', { detail: audience.nobody });
    }
    if (!audience.to.length) return null;
    // toNames and why come from the audience, never from the builder: who the
    // email is for, and why they are getting it, are that decision's.
    const group = audience.to.some(p => p.group);
    const email = reviewMail.emailFor(kind, Object.assign(build(audience), {
        toNames: group ? [] : audience.to.map(p => p.name),
        why: audience.why
    }));
    if (!email) return null;
    return {
        href: reviewMail.mailtoFor({ to: audience.to.map(p => p.address), subject: email.subject, text: email.text }),
        names: audience.to.map(p => (p.group ? p.name + ' group' : p.name)),
        description: email.description,
        record: {
            gate: stamp.gate || '', unitId: String(stamp.unitId || ''), unitName: String(stamp.unitName || ''),
            reviewRound: Number(stamp.reviewRound) || 0
        }
    };
}

function mailLink(job, tab, piece) {
    return reviewMail.linkUrl(mailSettings.baseUrl, job.id, tab, piece || '');
}

// 1. Send for review: everyone active on that department's list, except
// whoever pressed it, who is now the operator.
async function mailSendForReview(pool, job, gate, actor, now, note) {
    const rows = await mailRosterRows(pool);
    const label = reviewGateLabel(gate);
    const link = mailLink(job, gate);
    return mailBuild(pool, { jobId: job.id, jobNumber: job.jobNumber, gate, actor }, 'send_for_review', {
        actorKey: actor.login, gateLabel: label, jobNumber: job.jobNumber, gate,
        groupAddress: mailDeptAddress(gate),
        list: mailListOf(rows, gate), operators: []
    }, () => ({ job, gate, gateLabel: label, actor: { name: mailActorName(actor), at: now }, note: note || '', link }));
}

// The department's own address, when one is set. Empty means the people on that
// department's list are emailed one by one, as they always were.
function mailDeptAddress(gate) {
    return (mailSettings.deptEmails && mailSettings.deptEmails[gate]) || '';
}

// The job's pieces by name, in the work order's order, as one line: what is in
// the package. Only the new job email shows it, because a department seeing a
// job for the first time has nothing else to go on.
async function mailPieceNames(pool, job) {
    const r = await pool.request().input('jobId', job.id)
        .query('SELECT name, version FROM dbo.components WHERE jobId = @jobId ORDER BY sortOrder, id');
    return r.recordset
        .map(p => [String(p.version || '').trim(), String(p.name || '').trim()].filter(Boolean).join(' '))
        .filter(Boolean).join(', ');
}

// 10. A new job: the CSR hands it to a department from the work order
// (START_NEW_JOB_PLAN). It is the email she writes in Outlook today. It goes to
// that department's own address, else to its list one by one, exactly as a sign
// back in does: nobody is the operator yet, and whoever picks it up becomes one.
async function mailNewJob(pool, job, gate, actor, note, now) {
    const rows = await mailRosterRows(pool);
    const label = reviewGateLabel(gate);
    const pieces = await mailPieceNames(pool, job);
    const stamp = { jobId: job.id, jobNumber: job.jobNumber, gate, actor };
    return mailBuild(pool, stamp, 'new_job', {
        actorKey: actor.login, gateLabel: label, jobNumber: job.jobNumber, gate,
        groupAddress: mailDeptAddress(gate),
        list: mailListOf(rows, gate)
    }, () => ({
        job, gate, gateLabel: label, dept: gate, deptLabel: label, note, pieces,
        actor: { name: mailActorName(actor), at: now },
        link: mailLink(job, gate),
        // The second link: the work order, where the instructions, the specs
        // and the artwork paths are. A sign back in is the only other email
        // with one, and for the same reason (David, 2026-09-17).
        workOrderLink: reviewMail.workOrderUrl(mailSettings.baseUrl, job.id)
    }));
}

// 11. The CSR took that new job back: the same people are told to ignore it
// (David, 2026-09-20). Nobody is the operator yet, so it goes exactly where
// the new job went, to the department address if there is one and to the list
// one by one if there is not. No pieces, no due date and no note: nothing
// about the job has changed, and the fewest words do the job.
async function mailTakeBack(pool, job, gate, actor, now) {
    const rows = await mailRosterRows(pool);
    const label = reviewGateLabel(gate);
    const stamp = { jobId: job.id, jobNumber: job.jobNumber, gate, actor };
    return mailBuild(pool, stamp, 'new_job_taken_back', {
        actorKey: actor.login, gateLabel: label, jobNumber: job.jobNumber, gate,
        groupAddress: mailDeptAddress(gate),
        list: mailListOf(rows, gate)
    }, () => ({
        job, gate, gateLabel: label, dept: gate, deptLabel: label,
        actor: { name: mailActorName(actor), at: now },
        link: mailLink(job, gate)
    }));
}

// 2. Corrections needed on a department checklist: that checklist's operators.
async function mailSentBack(pool, job, gate, actor, gateRow, block, now) {
    const rows = await mailRosterRows(pool);
    const label = reviewGateLabel(gate);
    const link = mailLink(job, gate, block.unitId === 'job' ? '' : block.unitId);
    const stamp = { jobId: job.id, jobNumber: job.jobNumber, gate, unitId: block.unitId, unitName: block.logName, reviewRound: block.round, actor };
    return mailBuild(pool, stamp, 'sent_back', {
        actorKey: actor.login, gateLabel: label, jobNumber: job.jobNumber,
        operators: mailOperators(rows, gateRow), list: mailListOf(rows, gate)
    }, () => ({
        job, gate, gateLabel: label, unitName: block.name, round: block.round,
        actor: { name: mailActorName(actor), at: now }, items: block.items, link
    }));
}

// 3. Fixed, ready for re-review: for each piece that moved, everyone who sent
// that piece back in its current round, one email per piece (so a Fixed on two
// pieces opens two Outlook messages, one after the other). A piece the CSR
// signed back in while the round was going has nobody in the department who
// sent it back: it goes to whoever is reviewing the round, else the list.
async function mailRereview(pool, job, gate, actor, state, moved, now, note) {
    const label = reviewGateLabel(gate);
    const rows = await mailRosterRows(pool);
    const gateRow = state.gateRow || {};
    const reviewers = gateRow.startedByLogin || gateRow.startedByName ? [mailStamped(rows, gateRow.startedByName, gateRow.startedByLogin)] : [];
    const out = [];
    for (const block of moved) {
        const stamp = { jobId: job.id, jobNumber: job.jobNumber, gate, unitId: block.unitId, unitName: block.logName, reviewRound: block.round, actor };
        out.push(await mailBuild(pool, stamp, 'rereview', {
            actorKey: actor.login, gateLabel: label, jobNumber: job.jobNumber,
            senders: mailSendersOf(rows, state, gate, block.unitId, block.round), fromCsr: !!block.fromCsr,
            reviewers, operators: mailOperators(rows, state.gateRow), list: mailListOf(rows, gate)
        }, () => ({
            job, gate, gateLabel: label, unitName: block.name, round: block.round, fromCsr: !!block.fromCsr,
            actor: { name: mailActorName(actor), at: now }, items: block.items, note: note || '',
            link: mailLink(job, gate, block.unitId === 'job' ? '' : block.unitId)
        })));
    }
    return out;
}

// 4. Signed back in: the job is back from the CSR and the whole QC runs again
// for what she ticked. One email per department (both ticked: two Outlook
// messages, one after the other), to that department's own address, because
// weeks may have gone by and whoever is free picks it up (SIGN_BACK_IN_PLAN
// decision 7). With no department address set it names that list.
async function mailSignedBackIn(pool, job, actor, depts, note, production, now) {
    const rows = await mailRosterRows(pool);
    const link = mailLink(job, 'csr');
    // A change that joined a round already going went straight back to that
    // round's operator: the email names them.
    const senders = {};
    if (depts.some(d => d.joined)) {
        const g = await pool.request().input('jobId', job.id)
            .query('SELECT gate, sentForReviewByName, sentForReviewByLogin FROM dbo.review_gates WHERE jobId = @jobId');
        g.recordset.forEach(x => { senders[x.gate] = String(x.sentForReviewByName || x.sentForReviewByLogin || '').trim(); });
    }
    const out = [];
    for (const dept of depts) {
        const deptLabel = reviewGateLabel(dept.gate);
        const stamp = {
            jobId: job.id, jobNumber: job.jobNumber, gate: dept.gate, unitId: '', unitName: '',
            reviewRound: 0, actor
        };
        out.push(await mailBuild(pool, stamp, 'signed_back_in', {
            actorKey: actor.login, gateLabel: deptLabel, jobNumber: job.jobNumber, gate: dept.gate,
            groupAddress: mailDeptAddress(dept.gate),
            list: mailListOf(rows, dept.gate)
        }, () => ({
            job, gate: dept.gate, gateLabel: deptLabel, dept: dept.gate, deptLabel,
            note, production, blocks: dept.blocks, items: dept.items,
            backWith: dept.joined ? senders[dept.gate] || '' : '',
            actor: { name: mailActorName(actor), at: now },
            link: mailLink(job, dept.gate) || link,
            // The second link: the work order, where the round's real
            // instructions are (David, 2026-09-17). Only this email has one.
            workOrderLink: reviewMail.workOrderUrl(mailSettings.baseUrl, job.id)
        })));
    }
    return out;
}

// 6. Send to CSR: the job's CSR alone, with the paths as pasted.
// 9. A reviewer asking the operator to send the files to the CSR instead of
// sending them themselves (PHASE6_PLAN d). It goes to that checklist's
// operators, the same people a send-back goes to.
async function mailHandoffAsked(pool, job, gate, actor, gateRow, now) {
    const rows = await mailRosterRows(pool);
    const label = reviewGateLabel(gate);
    const stamp = { jobId: job.id, jobNumber: job.jobNumber, gate, actor };
    return mailBuild(pool, stamp, 'handoff_asked', {
        actorKey: actor.login, gateLabel: label, jobNumber: job.jobNumber,
        operators: mailOperators(rows, gateRow), list: mailListOf(rows, gate)
    }, () => ({
        job, gate, gateLabel: label, csrName: String(job.csrName || '').trim(),
        actor: { name: mailActorName(actor), at: now }, link: mailLink(job, gate)
    }));
}

async function mailHandoff(pool, job, gate, actor, paths, previousAt, now) {
    const rows = await mailRosterRows(pool);
    const label = reviewGateLabel(gate);
    const blocks = await mailBlocksOf(pool, job, gate);
    const lastPass = blocks.filter(b => b.state === 'Passed' && b.by)
        .sort((a, b) => (String(a.at) < String(b.at) ? -1 : String(a.at) > String(b.at) ? 1 : 0)).slice(-1)[0] || null;
    const stamp = { jobId: job.id, jobNumber: job.jobNumber, gate, actor };
    return mailBuild(pool, stamp, 'handoff', {
        actorKey: actor.login, gateLabel: label, jobNumber: job.jobNumber,
        csr: job.csrName ? mailNamed(rows, 'csr', job.csrName) : null
    }, () => ({
        job, gate, gateLabel: label, paths, previousAt,
        actor: { name: mailActorName(actor), login: loginKey(actor.login || ''), at: now },
        passedBy: lastPass ? { name: lastPass.by, login: lastPass.byLogin, at: lastPass.at } : null,
        link: mailLink(job, 'csr')
    }));
}

// 7. The last block of a department checklist passed: that checklist's
// operators, with who passed each block and where to go next.
async function mailPassed(pool, job, gate, actor, gateRow, unitId, round, now) {
    const rows = await mailRosterRows(pool);
    const label = reviewGateLabel(gate);
    const blocks = await mailBlocksOf(pool, job, gate);
    const passedBlock = blocks.find(b => b.unitId === String(unitId));
    // The email is the "whole checklist passed" one only when every block is
    // passed AND this pass was the last of them. The queue runs after the
    // reply, so two passes in a row would otherwise both read "all passed" and
    // both say the checklist is done, with neither saying what it passed.
    const order = b => String(b.at || '') + '|' + String(blocks.indexOf(b)).padStart(4, '0');
    const newest = blocks.filter(b => b.state === 'Passed')
        .reduce((best, b) => (best === null || order(b) > order(best) ? b : best), null);
    const lastBlock = blocks.every(b => b.state === 'Passed') && !!passedBlock && newest === passedBlock;
    // One piece passing is not worth an email: the operator cannot act on it
    // and the window already shows block by block progress. Only the pass that
    // finishes the whole checklist is sent (David, 2026-09-16). On a five piece
    // job this is four emails saved, not one.
    if (!lastBlock) return null;
    const stamp = {
        jobId: job.id, jobNumber: job.jobNumber, gate, unitId: String(unitId),
        unitName: passedBlock ? passedBlock.name : '', reviewRound: round, actor
    };
    return mailBuild(pool, stamp, 'passed', {
        actorKey: actor.login, gateLabel: label, jobNumber: job.jobNumber,
        operators: mailOperators(rows, gateRow), list: mailListOf(rows, gate)
    }, () => ({
        job, gate, gateLabel: label,
        unitName: passedBlock ? passedBlock.name : '',
        actor: { name: mailActorName(actor), at: now },
        passes: blocks.map(b => ({ name: b.name, by: b.by })),
        link: mailLink(job, gate)
    }));
}

// The shared checks at the top of every review write. Returns the context, with
// what this person may do on this checklist, or null after answering the request.
async function reviewWriteContext(req, res) {
    if (!(await reviewsAvailable(res))) return null;
    const gate = req.params.gate;
    if (!reviewGate(gate)) {
        res.status(400).json({ error: 'Unknown review gate' });
        return null;
    }
    const actor = reviewActor(req, res);
    if (!actor) return null;
    const pool = await getPool();
    const job = await loadReviewJob(pool, req.params.id);
    if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return null;
    }
    if (job.archivedDate) {
        res.status(409).json({ error: REVIEW_ARCHIVED });
        return null;
    }
    await resolveRosterPerson(pool, actor);
    const state = await loadReviewGateState(pool, job, gate);
    const access = reviewAccess(actor, job, gate, state.gateRow, state.units, state.owner, state.senders);
    return { pool, gate, actor, job, state, access, now: new Date().toISOString() };
}

// Autosave (mode 'save') and sign-off (mode 'pass' or 'corrections') share one
// path. A sign-off carries the final sheet, so the browser can drop an autosave
// it has not sent yet. It must still wait for one already sent and use the
// rowVersion that save returns, or the sign-off is refused as a conflict.
// 'reopen' moves the loop only and never reads a sheet from the body.
// 'signback' reads the CSR's sheet but writes every checklist, so it has its own.
// attempt: how many times a pass has already found the job changed under its
// frozen words (REVIEW_PASS_TRIES).
async function writeReviewUnit(req, res, mode, attempt) {
    attempt = attempt || 0;
    try {
        const ctx = await reviewWriteContext(req, res);
        if (!ctx) return;
        if (mode === 'reopen') return await reopenReviewUnit(req, res, ctx);
        if (mode === 'signback') return await reviewSignBack(req, res, ctx);
        const { pool, gate, actor, job, now, state, access } = ctx;
        if (!access.canEdit) return reviewLocked(res, access.reason);
        // Her flags do not go back on their own: they sign the job back in,
        // and the whole checklist is done again (David, 2026-09-17).
        if (mode === 'corrections' && gate === 'csr') {
            throw reviewError(400, 'The CSR checklist signs the job back in instead.');
        }
        const unitId = String(req.params.unitId || '');
        const expected = expectedRowVersion(req.body);
        // The browser's copy of the checklist must be the one this server
        // enforces, because a sheet's ids mean what that copy says. The reply
        // carries the server's version, so the browser can tell "reload the
        // page" from "the server needs a restart".
        if (String(req.body.formVersion || '') !== reviewForms[gate]) {
            return res.status(409).json({ error: 'The checklist was updated. Reload the page.', formVersion: reviewForms[gate] });
        }
        const sheet = normalizeReviewSheet(req.body);

        const unitName = unitId.length <= 36 ? await reviewUnitName(pool, job, gate, unitId) : null;
        if (unitName === null) return res.status(404).json({ error: REVIEW_NO_PIECE });

        const stored = parseReviewRow(await selectReviewUnit(pool, job.id, gate, unitId));
        // A pass sent again by the same person with the same sheet, after its
        // reply was lost: it already happened, so answer with the row.
        if (mode === 'pass' && stored && stored.disposition === 'passed' &&
            stampedBy(actor, stored.reviewerName, stored.reviewerLogin) && sameReviewSheet(stored, sheet)) {
            return res.json({ review: stored, started: false });
        }
        await withSentFlags(pool, stored);
        if (stored ? stored.rowVersion !== expected : expected !== 0) {
            return res.status(409).json({ error: 'This sheet was changed by someone else.', review: stored });
        }
        // A passed checklist is locked until someone reopens it (question 6).
        if (stored && stored.disposition === 'passed') {
            return res.status(409).json({ error: 'This checklist is passed. Reopen it first.', review: stored });
        }
        // Back with the operator: nobody passes it until they press Fixed
        // (David, 2026-09-18).
        const outWithOperator = !!stored && stored.disposition === 'corrections' && stored.holder === 'operator';
        if (mode === 'pass' && outWithOperator) {
            throw reviewError(400, 'It is back with the operator. Pass it once they press Fixed.');
        }
        // The CSR's change, with the operator: nothing on it is checked until
        // they press Fixed, the same rule the window draws (David, 2026-09-22).
        // withSentFlags above has already looked up her signed_back row.
        if (outWithOperator && stored.signedBack) {
            throw reviewError(400, "It is back with the operator for the CSR's change. Check it once they press Fixed.");
        }
        checkReviewOffList(gate, unitId, stored, sheet);

        // Only on a pass: an ordinary awaited read, like the piece's name
        // above, long before the batch request is built.
        if (mode === 'pass') ctx.workOrder = await reviewWorkOrder(pool, job, gate, unitId, now);

        const before = stored || { items: {}, itemValues: {}, flags: {}, na: {}, unitFacts: {} };
        const na = mergeReviewNA(before.na, sheet.naIds, actor, now, sheet.naReasons);
        const verdict = reviewItems.unitVerdict(gate, unitId, { items: sheet.items, itemValues: sheet.itemValues, flags: sheet.flags, na });
        const counted = Object.keys(verdict.flags);
        // Changes on the sheet itself belong to the round it was in before this
        // request. Only the send-back rows added below carry the new count.
        const priorRound = stored ? stored.returnCount : 0;
        const swept = reviewSweptLines(gate, unitId, req.body);
        const logRows = reviewSheetChanges(before, { items: sheet.items, flags: sheet.flags, na })
            .concat(reviewSectionRows(gate, unitId, before, sheet, req.body))
            .map(row => Object.assign(row, { reviewRound: priorRound }));
        logRows.forEach(row => {
            if (row.logAction === 'ticked' && swept.ticks.has(row.itemId)) row.detail = 'check all';
            if (row.logAction === 'unticked' && swept.unticks.has(row.itemId)) row.detail = 'check all taken back';
        });

        // Everything the row will hold. Fields a mode does not change carry the
        // stored value; the version check below makes that safe.
        const next = {
            disposition: stored ? stored.disposition : '',
            holder: stored ? stored.holder : '',
            returnCount: stored ? stored.returnCount : 0,
            reviewerName: stored ? stored.reviewerName : '',
            reviewerLogin: stored ? stored.reviewerLogin : '',
            reviewerSource: stored ? stored.reviewerSource : '',
            reviewerRole: stored ? stored.reviewerRole : '',
            operatorName: stored ? stored.operatorName : '',
            operatorLogin: stored ? stored.operatorLogin : '',
            returnedByName: stored ? stored.returnedByName : '',
            returnedByLogin: stored ? stored.returnedByLogin : '',
            returnedDate: stored ? stored.returnedDate : '',
            completedDate: stored ? stored.completedDate : ''
        };

        if (mode === 'corrections') {
            // Only flags on lines in play go out. A flag under N/A stays stored,
            // and shows again if the N/A comes off (question 3).
            if (!counted.length) throw reviewError(400, 'Flag at least one item before sending it back.');
            // Already with the operator: only a new flag, or a changed note,
            // goes again, so the same send-back never mails twice.
            if (outWithOperator && counted.every(id => Object.prototype.hasOwnProperty.call(stored.sentFlags, id) &&
                stored.sentFlags[id] === String(sheet.flags[id] == null ? '' : sheet.flags[id]))) {
                throw reviewError(400, 'Already sent back. Flag something new to send it again.');
            }
            // Sent back again before the fix came back: the same round, and the
            // new flags join the list. From Open, or once the fix came back,
            // the round goes up (question 5).
            const stillOut = !!stored && stored.disposition === 'corrections' && stored.holder === 'operator';
            next.disposition = 'corrections';
            next.holder = 'operator';
            if (!stillOut) next.returnCount += 1;
            next.returnedByName = actor.name;
            next.returnedByLogin = actor.login;
            next.returnedDate = now;
            const detail = counted.length + (counted.length === 1 ? ' item flagged' : ' items flagged');
            counted.forEach(id => logRows.push({ logAction: 'flagged', itemId: id, detail: sheet.flags[id] }));
            logRows.push({ logAction: 'sent_back', detail });
        } else if (mode === 'pass') {
            // The one pass rule, shared with the window's Mark passed button.
            if (!verdict.canPass) {
                throw reviewError(400, counted.length ? 'Clear every flag before marking this passed.'
                    : verdict.missingValue ? 'Fill in every number before marking this passed.'
                    : 'Answer every line before marking this passed.');
            }
            next.disposition = 'passed';
            next.holder = '';
            next.completedDate = now;
            next.reviewerName = actor.name;
            next.reviewerLogin = actor.login;
            next.reviewerSource = actor.source;
            next.reviewerRole = access.role;
            // The operator at that moment: on a department checklist whoever
            // sent it for review; on the CSR checklist, the job's CSR.
            const gateRow = state.gateRow || {};
            const sender = { name: gateRow.sentForReviewByName || '', login: gateRow.sentForReviewByLogin || '' };
            const operator = gate === 'csr' ? state.owner : sender;
            next.operatorName = operator.name;
            next.operatorLogin = operator.login;
            logRows.push({ logAction: 'passed' });
            logRows.push({ logAction: 'signoff_snapshot', detail: JSON.stringify(reviewSnapshot(ctx, unitId, unitName, sheet, na, next, verdict, sender)) });
        }

        const hasActivity = Object.keys(sheet.items).length || Object.keys(sheet.itemValues).length ||
            Object.keys(sheet.flags).length || Object.keys(na).length ? 1 : 0;

        // The first reviewer to change a sheet on this checklist is recorded as
        // the one who started it, in this same write (PHASE4_PLAN e7). The
        // claim is guarded in SQL, so two first saves at the same moment both
        // save and exactly one of them is the starter; a unique-key error here
        // would roll back the save and report a false conflict.
        const startedAlready = !!state.gateRow && !!(state.gateRow.startedByLogin || state.gateRow.startedByName);
        const claimStart = !startedAlready && (mode !== 'save' || !sameReviewSheet(stored, sheet));

        const request = pool.request();
        request.input('jobId', job.id);
        request.input('gate', gate);
        request.input('unitId', unitId);
        request.input('expectedVersion', expected);
        request.input('items', JSON.stringify(sheet.items));
        request.input('itemValues', JSON.stringify(sheet.itemValues));
        request.input('flags', JSON.stringify(sheet.flags));
        request.input('na', JSON.stringify(na));
        request.input('unitFacts', JSON.stringify(sheet.unitFacts));
        // The server's own version, never the browser's: it names the checklist enforced.
        request.input('formVersion', reviewForms[gate]);
        request.input('hasActivity', hasActivity);
        request.input('now', now);
        request.input('actorName', actor.name);
        request.input('actorLogin', actor.login);
        Object.keys(next).forEach(key => request.input(key, isPlainObject(next[key]) ? JSON.stringify(next[key]) : next[key]));

        const logSql = reviewLogInsertSql(request, {
            jobId: job.id, jobNumber: job.jobNumber, gate, unitId, unitName,
            reviewRound: next.returnCount, actor, now
        }, logRows);

        let claimLockSql = '';
        let claimSql = '';
        if (claimStart) {
            request.input('claimJobNumber', job.jobNumber || '');
            request.input('claimActorSource', actor.source);
            // The gate row (or the place it would go) is locked first, before
            // the sheet is touched, so two first saves on this checklist queue
            // here one behind the other. Taking it after the save let each hold
            // what the other needed next: a deadlock, seen in the API check.
            // The job id and gate are copied into variables of the columns'
            // own types first. msnodesqlv8 declares every string input as
            // nvarchar(max), which turns this seek into a range, and HOLDLOCK
            // then held that range across other jobs' rows: first saves on two
            // different jobs deadlocked (seen in a stress run on that driver).
            claimLockSql = `
                SET @claimJobId = @jobId;
                SET @claimGate = @gate;
                SELECT @gateRows = COUNT(*) FROM dbo.review_gates WITH (UPDLOCK, HOLDLOCK)
                WHERE jobId = @claimJobId AND gate = @claimGate;`;
            claimSql = `
                UPDATE dbo.review_gates SET
                    startedByName = @actorName, startedByLogin = @actorLogin, startedDate = @now,
                    lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
                    rowVersion = rowVersion + 1
                OUTPUT INSERTED.id INTO @claimed
                WHERE jobId = @claimJobId AND gate = @claimGate AND startedByLogin = N'' AND startedByName = N'';
                IF @gateRows = 0
                    INSERT INTO dbo.review_gates (jobId, gate, startedByName, startedByLogin, startedDate,
                        rowVersion, lastModified, lastModifiedByName, lastModifiedByLogin)
                    OUTPUT INSERTED.id INTO @claimed
                    VALUES (@jobId, @gate, @actorName, @actorLogin, @now, 1, @now, @actorName, @actorLogin);
                INSERT INTO dbo.review_log (jobId, jobNumber, gate, unitId, unitName, itemId, itemLabel,
                    reviewRound, logAction, detail, actorName, actorLogin, actorSource,
                    recipientName, recipientAddress, whenIso)
                SELECT @jobId, @claimJobNumber, @gate, N'', N'', N'', N'', 0, N'started', N'',
                    @actorName, @actorLogin, @claimActorSource, N'', N'', @now
                FROM @claimed;`;
        }

        const writeSql = stored ? `
            UPDATE dbo.reviews SET
                items = @items, itemValues = @itemValues, flags = @flags, na = @na,
                unitFacts = @unitFacts, formVersion = @formVersion, hasActivity = @hasActivity,
                disposition = @disposition, holder = @holder, returnCount = @returnCount,
                reviewerName = @reviewerName, reviewerLogin = @reviewerLogin,
                reviewerSource = @reviewerSource, reviewerRole = @reviewerRole,
                operatorName = @operatorName, operatorLogin = @operatorLogin,
                returnedByName = @returnedByName, returnedByLogin = @returnedByLogin,
                returnedDate = @returnedDate, completedDate = @completedDate,
                lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
                rowVersion = rowVersion + 1
            OUTPUT INSERTED.id INTO @changed
            WHERE jobId = @jobId AND gate = @gate AND unitId = @unitId AND rowVersion = @expectedVersion;`
            : `
            -- Another first save of this sheet may have landed since it was
            -- read (two people, or a press sent twice). Asked here, under the
            -- job's lock (F6), rather than left to the duplicate key, whose
            -- error number msnodesqlv8 can lose when a later statement of a
            -- batch fails (CLAUDE.md, driver-safe SQL).
            IF EXISTS (SELECT 1 FROM dbo.reviews WHERE jobId = @gJobId AND gate = @gate AND unitId = @gUnit0)
            BEGIN
                ROLLBACK TRAN;
                SELECT CAST(0 AS BIT) AS ok;
                RETURN;
            END
            INSERT INTO dbo.reviews (jobId, gate, unitId, items, itemValues, flags, na, unitFacts,
                formVersion, hasActivity, disposition, holder, returnCount,
                reviewerName, reviewerLogin, reviewerSource, reviewerRole, operatorName, operatorLogin,
                returnedByName, returnedByLogin, returnedDate, completedDate,
                rowVersion, lastModified, lastModifiedByName, lastModifiedByLogin)
            OUTPUT INSERTED.id INTO @changed
            VALUES (@jobId, @gate, @unitId, @items, @itemValues, @flags, @na, @unitFacts,
                @formVersion, @hasActivity, @disposition, @holder, @returnCount,
                @reviewerName, @reviewerLogin, @reviewerSource, @reviewerRole, @operatorName, @operatorLogin,
                @returnedByName, @returnedByLogin, @returnedDate, @completedDate,
                1, @now, @actorName, @actorLogin);`;

        // The job and the piece asked again first (F6). A pass also asks that
        // the job is still at the version its frozen words were read at (the
        // context's read, made before reviewWorkOrder's): an edit that landed
        // in between has the pass read everything again and freeze what is
        // there now, stamped after it, as an edit a moment before the press
        // always was. Its last try freezes what it read, as before this.
        const testVersion = mode === 'pass' && attempt < REVIEW_PASS_TRIES - 1 && Number.isInteger(job.rowVersion);
        if (testVersion) request.input('readVersion', job.rowVersion);
        const guard = reviewJobGuardSql({ units: ['unitId'], version: testVersion ? 'readVersion' : '' });

        let result;
        try {
            result = await request.query(`
                SET XACT_ABORT ON;
                DECLARE @changed TABLE (id INT);
                DECLARE @claimed TABLE (id INT);
                DECLARE @gateRows INT;
                DECLARE @claimJobId NVARCHAR(36);
                DECLARE @claimGate NVARCHAR(20);
                ${guard.declare}
                BEGIN TRAN;
                ${guard.test}
                ${claimLockSql}
                ${writeSql}
                IF NOT EXISTS (SELECT 1 FROM @changed)
                BEGIN
                    ROLLBACK TRAN;
                    SELECT CAST(0 AS BIT) AS ok;
                    RETURN;
                END
                ${claimSql}
                ${logSql}
                SELECT CAST(1 AS BIT) AS ok, (SELECT COUNT(*) FROM @claimed) AS claimedStart, r.*
                FROM dbo.reviews r WHERE r.id = (SELECT TOP 1 id FROM @changed);
                COMMIT TRAN;`);
        } catch (err) {
            // Two people creating the same sheet at once: the second one loses.
            if (sqlErrorNumbers(err).some(n => n === 2627 || n === 2601)) {
                const current = await withSentFlags(pool, parseReviewRow(await selectReviewUnit(pool, job.id, gate, unitId)));
                return res.status(409).json({ error: 'This sheet was changed by someone else.', review: current });
            }
            throw err;
        }

        const saved = lastRecordset(result)[0];
        const gone = reviewJobRefusal(saved);
        if (gone) throw gone;
        if (saved && saved.jobState === 'moved') return await writeReviewUnit(req, res, mode, attempt + 1);
        if (!saved || !saved.ok) {
            const current = await withSentFlags(pool, parseReviewRow(await selectReviewUnit(pool, job.id, gate, unitId)));
            return res.status(409).json({ error: 'This sheet was changed by someone else.', review: current });
        }
        const started = !!saved.claimedStart;
        delete saved.ok;
        delete saved.claimedStart;
        trackUser(actor.login || actor.name, 'reviewing');
        // Read after the commit, so a failed read must not turn a saved write
        // into an error: the email below would never go. The window then only
        // offers Corrections needed again, and the server still refuses a repeat.
        const reply = parseReviewRow(saved);
        try {
            await withSentFlags(pool, reply);
        } catch (err) {
            console.error('QC Review: saved, but the flags sent back could not be read: ' + err.message);
            reply.sentFlags = {};
        }
        // The email, built before the reply and only for a write that really
        // happened (step 5, section b; OUTLOOK_EMAIL_PLAN): Corrections needed
        // to the operator, and the pass that finishes the checklist to the
        // operator. mailEmails catches everything, so the reply never fails
        // for it. The CSR checklist emails nobody.
        let emails = [];
        const stamp = { jobId: job.id, jobNumber: job.jobNumber, gate, unitId: String(unitId), unitName, reviewRound: next.returnCount, actor };
        if (mode === 'corrections' && gate !== 'csr') {
            emails = await mailEmails(pool, stamp, async () => {
                const block = {
                    unitId, round: next.returnCount, logName: unitName,
                    items: mailItems(gate, unitId, verdict.flags),
                    name: (await mailBlockName(pool, job, gate, unitId)) || unitName
                };
                return mailSentBack(pool, job, gate, actor, state.gateRow, block, now);
            });
        } else if (mode === 'pass' && gate !== 'csr') {
            emails = await mailEmails(pool, stamp, () => mailPassed(pool, job, gate, actor, state.gateRow, unitId, next.returnCount, now));
        }
        res.json({ review: reply, started, emails });
    } catch (err) {
        sendReviewError(res, err);
    }
}

// One version-checked change to a unit row's loop fields, with its history
// rows, as one batch. Column names come from this file only, never the request.
// Returns the new row, or null when the version no longer matched; throws the
// job's own refusal when it was archived or deleted, or the piece deleted (F6).
async function updateReviewUnit(ctx, stored, unitName, fields, logRows) {
    const { pool, gate, actor, job, now } = ctx;
    const request = pool.request();
    request.input('jobId', job.id);
    request.input('gate', gate);
    request.input('rowId', stored.id);
    request.input('expectedVersion', stored.rowVersion);
    request.input('now', now);
    request.input('actorName', actor.name);
    request.input('actorLogin', actor.login);
    const sets = Object.keys(fields).map(column => {
        const name = 'set' + column.charAt(0).toUpperCase() + column.slice(1);
        request.input(name, fields[column]);
        return column + ' = @' + name;
    });
    const logSql = reviewLogInsertSql(request, {
        jobId: job.id, jobNumber: job.jobNumber, gate, unitId: stored.unitId, unitName,
        reviewRound: stored.returnCount, actor, now
    }, logRows);
    // The job and the block's piece asked again first (F6).
    request.input('guardUnit', stored.unitId);
    const guard = reviewJobGuardSql({ units: ['guardUnit'] });
    // The checklist's rows are locked next, the lock Send to CSR and the ask
    // take before testing that every block is passed: a Reopen through the
    // primary key alone never waited for it, so one could land between that
    // test and the send's write. Typed variables, as there (msnodesqlv8).
    const result = await request.query(`
        SET XACT_ABORT ON;
        DECLARE @changed TABLE (id INT);
        DECLARE @uJobId NVARCHAR(36);
        DECLARE @uGate NVARCHAR(20);
        DECLARE @held INT;
        ${guard.declare}
        BEGIN TRAN;
        ${guard.test}
        SET @uJobId = @jobId;
        SET @uGate = @gate;
        SELECT @held = COUNT(*) FROM dbo.reviews WITH (UPDLOCK, HOLDLOCK) WHERE jobId = @uJobId AND gate = @uGate;
        UPDATE dbo.reviews SET ${sets.join(', ')},
            lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
            rowVersion = rowVersion + 1
        OUTPUT INSERTED.id INTO @changed
        WHERE id = @rowId AND rowVersion = @expectedVersion;
        IF NOT EXISTS (SELECT 1 FROM @changed)
        BEGIN
            ROLLBACK TRAN;
            SELECT CAST(0 AS BIT) AS ok;
            RETURN;
        END
        ${logSql}
        SELECT CAST(1 AS BIT) AS ok, r.* FROM dbo.reviews r WHERE r.id = (SELECT TOP 1 id FROM @changed);
        COMMIT TRAN;`);
    const saved = lastRecordset(result)[0];
    const gone = reviewJobRefusal(saved);
    if (gone) throw gone;
    if (!saved || !saved.ok) return null;
    delete saved.ok;
    return parseReviewRow(saved);
}

// The department blocks she ticked, checked against what is really on the job
// and put back into checklist order. Her own CSR checklist is never in this
// list: the server always adds it, so her signature can never be older than
// the files (SIGN_BACK_IN_PLAN decision 6).
// Every department block on the job, in checklist order: each piece, then
// Whole Job, on Prepress; the one checklist on Tech Services. The version and
// the name together, the way the window and Send to CSR already name a block,
// so the email and the history read the same.
async function signBackOrder(pool, job) {
    const pieces = await pool.request().input('jobId', job.id)
        .query(`SELECT id, LTRIM(RTRIM(ISNULL(version, N'') + N' ' + ISNULL(name, N''))) AS name
                FROM dbo.components WHERE jobId = @jobId ORDER BY sortOrder, id`);
    const order = [];
    REVIEW_DEPTS.forEach(dept => {
        if (reviewGate(dept).perPiece) {
            pieces.recordset.forEach(c => order.push({ gate: dept, unitId: String(c.id), name: String(c.name || '') }));
        }
        order.push({ gate: dept, unitId: 'job', name: reviewJobUnitName(dept) });
    });
    return order;
}

const REVIEW_SIGNBACK_GONE = 'Something on that list is not on this job any more. Close the window and open it again.';

async function signBackBlocks(pool, job, raw) {
    if (!Array.isArray(raw) || !raw.length) throw reviewError(400, 'Check off what has to be done again.');
    if (raw.length > REVIEW_LIMIT.itemIds) throw reviewError(400, 'That is too much for one sign back in.');
    const order = await signBackOrder(pool, job);
    const want = new Set();
    raw.forEach(u => {
        const g = u && String(u.gate || '');
        if (!REVIEW_DEPTS.includes(g)) throw reviewError(400, 'Only Prepress and Tech Services blocks are signed back in.');
        want.add(g + '|' + (u && String(u.unitId || '')));
    });
    const picked = order.filter(b => want.has(b.gate + '|' + b.unitId));
    if (picked.length !== want.size) {
        throw reviewError(404, REVIEW_SIGNBACK_GONE);
    }
    return picked;
}

// { action: 'signback', note, production, units, flagDepts } plus the CSR's own
// sheet, on the CSR checklist. The job comes back and the whole QC runs again
// for whatever she ticks (SIGN_BACK_IN_PLAN). Only a CSR presses it, because on
// the floor nothing starts in a department without a CSR asking for it. A job is
// never finished: this works on one that has been signed into production and
// printed, and on the same job five or ten times.
async function reviewSignBack(req, res, ctx) {
    const { pool, gate, actor, job, now, access } = ctx;
    if (gate !== 'csr' || String(req.params.unitId || '') !== 'job') {
        throw reviewError(400, 'A job is signed back in from the CSR checklist.');
    }
    if (access.role === 'unlinked') return reviewLocked(res, access.reason);
    if (!access.canSignBack) return reviewLocked(res, 'Only CSRs sign a job back in.');

    const note = String((req.body && req.body.note) || '').replace(/\r\n?/g, '\n').trim();
    if (!note) throw reviewError(400, 'Say what is being asked for before signing it back in.');
    if (note.length > REVIEW_LIMIT.note) throw reviewError(400, 'That is too long. Keep it under 2,000 characters.');
    const production = (req.body && req.body.production) ? 1 : 0;

    // Her sheet comes with it, exactly as a sign-off does, so a flag she has
    // just typed is not lost to an autosave still in flight.
    if (String(req.body.formVersion || '') !== reviewForms.csr) {
        return res.status(409).json({ error: 'The checklist was updated. Reload the page.', formVersion: reviewForms.csr });
    }
    const sheet = normalizeReviewSheet(req.body);
    const expected = expectedRowVersion(req.body);
    const stored = parseReviewRow(await selectReviewUnit(pool, job.id, 'csr', 'job'));
    if (stored ? stored.rowVersion !== expected : expected !== 0) {
        return res.status(409).json({ error: 'This sheet was changed by someone else.', review: stored });
    }
    checkReviewOffList('csr', 'job', stored, sheet);
    const before = stored || { items: {}, itemValues: {}, flags: {}, na: {} };
    const na = mergeReviewNA(before.na, sheet.naIds, actor, now, sheet.naReasons);
    const verdict = reviewItems.unitVerdict('csr', 'job', { items: sheet.items, itemValues: sheet.itemValues, flags: sheet.flags, na });
    const counted = Object.keys(verdict.flags);
    const flagDepts = counted.length ? reviewFlagDepts(req.body.flagDepts, counted) : {};
    const deptLines = reviewDeptLines({ flags: sheet.flags, na, flagDepts });

    const blocks = await signBackBlocks(pool, job, req.body.units);
    const gates = REVIEW_DEPTS.filter(dept => blocks.some(b => b.gate === dept));
    // Her own checklist comes back with every round, because 29 of its 31 items
    // check what the departments produced. The one exception is a production
    // round: she passed those items on the sign-offs, electronic and printed,
    // and that pass is what made her ask Prepress for the live files. So it
    // stands, and she is not handed 31 questions about a proof she signed off
    // (David, 2026-09-17). Reopen is still there if she wants it anyway.
    const clearHers = !production;
    const roundGates = (clearHers ? ['csr'] : []).concat(gates);
    // A flag aimed at a department that is not coming back would go nowhere, so
    // say so rather than send it into a checklist nobody is redoing.
    const stranded = REVIEW_DEPTS.filter(dept => deptLines[dept] && !gates.includes(dept));
    if (stranded.length) {
        throw reviewError(400, 'Check off what ' + stranded.map(reviewGateLabel).join(' and ') + ' has to do again, or take the flag off.');
    }

    const request = pool.request();
    request.input('jobId', job.id);
    request.input('expectedVersion', expected);
    request.input('note', note);
    request.input('production', production);
    request.input('now', now);
    request.input('actorName', actor.name);
    request.input('actorLogin', actor.login);
    request.input('actorSource', actor.source);
    blocks.forEach((b, i) => {
        request.input('bGate' + i, b.gate);
        request.input('bUnit' + i, b.unitId);
    });
    // The ticked blocks of one department, as a WHERE on unitId.
    const unitWhere = g => blocks.map((b, i) => (b.gate === g ? 'unitId = @bUnit' + i : '')).filter(Boolean).join(' OR ');
    const unitValues = g => blocks.map((b, i) => (b.gate === g ? '(@bUnit' + i + ')' : '')).filter(Boolean).join(', ');
    gates.forEach((g, i) => request.input('dGate' + i, g));
    request.input('sJobNumber', job.jobNumber || '');
    request.input('wholePrepress', reviewJobUnitName('prepress'));
    request.input('wholeTs', reviewJobUnitName('techservices'));

    // Her own checklist's round goes up with every round it comes back in.
    const csrRoundSql = clearHers ? `
        SELECT @gateRows = COUNT(*) FROM dbo.review_gates WHERE jobId = @sJobId AND gate = N'csr';
        IF @gateRows = 0
            INSERT INTO dbo.review_gates (jobId, gate, roundNo, roundNote, roundProduction,
                signedBackInByName, signedBackInByLogin, signedBackInBySource, signedBackInDate,
                rowVersion, lastModified, lastModifiedByName, lastModifiedByLogin)
            VALUES (@jobId, N'csr', 2, @note, @production, @actorName, @actorLogin, @actorSource, @now,
                1, @now, @actorName, @actorLogin);
        ELSE
            UPDATE dbo.review_gates SET
                sentForReviewByName = N'', sentForReviewByLogin = N'', sentForReviewDate = N'',
                startedByName = N'', startedByLogin = N'', startedDate = N'',
                roundNo = roundNo + 1, roundNote = @note, roundProduction = @production,
                signedBackInByName = @actorName, signedBackInByLogin = @actorLogin,
                signedBackInBySource = @actorSource, signedBackInDate = @now,
                lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
                rowVersion = rowVersion + 1
            WHERE jobId = @sJobId AND gate = N'csr';` : '';

    const CLEARED = `
            items = N'{}', itemValues = N'{}', flags = N'{}', na = N'{}', unitFacts = N'{}',
            formVersion = N'', hasActivity = 0, disposition = N'', holder = N'',
            reviewerName = N'', reviewerLogin = N'', reviewerSource = N'', reviewerRole = N'',
            operatorName = N'', operatorLogin = N'',
            returnedByName = N'', returnedByLogin = N'', returnedDate = N'', completedDate = N'',
            returnCount = returnCount + 1,
            lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
            rowVersion = rowVersion + 1`;
    // A block that joins the round already going: its ticks cleared, because
    // what was checked was the old proof, and back with the operator for the
    // change, as if she had sent it back (David, 2026-09-19). A reviewer's
    // flags stay, sent or not: a flag is a finding, and it may still be true of
    // the new proof (David, testing 50308).
    const TO_OPERATOR = `
            items = N'{}', itemValues = N'{}', na = N'{}', unitFacts = N'{}',
            formVersion = N'', hasActivity = CASE WHEN flags = N'{}' THEN 0 ELSE 1 END,
            disposition = N'corrections', holder = N'operator',
            reviewerName = N'', reviewerLogin = N'', reviewerSource = N'', reviewerRole = N'',
            operatorName = N'', operatorLogin = N'', completedDate = N'',
            returnedByName = @actorName, returnedByLogin = @actorLogin, returnedDate = @now,
            returnCount = returnCount + 1,
            lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
            rowVersion = rowVersion + 1`;

    // Per department she sends work to. Nobody part way through it: a new
    // round, which starts with Send for review; a passed block she ticked is
    // cleared, one nobody has touched is left as it is. Somebody part way
    // through it: the change joins the round already going, so the operator
    // and the reviewer carry on, and every block she ticked goes back to the
    // operator (David, 2026-09-19, choice 1). A deleted piece does not count.
    // Every block of one department: each piece now on the job plus Whole Job
    // on Prepress, the one checklist on Tech Services.
    const blocksSql = g => (reviewGate(g).perPiece
        ? "SELECT c.id AS unitId FROM dbo.components c WHERE c.jobId = @sJobId UNION ALL SELECT N'job' AS unitId"
        : "SELECT N'job' AS unitId");
    const deptSql = gates.map((g, i) => `
        -- The round is going: sent for review and not every block passed yet.
        SET @busy${i} = 0;
        IF EXISTS (SELECT 1 FROM dbo.review_gates WHERE jobId = @sJobId AND gate = @dGate${i}
                     AND (sentForReviewByLogin <> N'' OR sentForReviewByName <> N''))
           AND EXISTS (SELECT 1 FROM (${blocksSql(g)}) AS b
                       LEFT JOIN dbo.reviews r ON r.jobId = @sJobId AND r.gate = @dGate${i} AND r.unitId = b.unitId
                       WHERE r.id IS NULL OR r.disposition <> N'passed')
            SET @busy${i} = 1;
        IF @busy${i} = 1
        BEGIN
            -- Already sent back by a reviewer, or waiting to be re-checked: the
            -- reviewer's flags and that loop stay, only what was checked on
            -- the old proof goes, and it is back with the operator.
            UPDATE dbo.reviews SET
                items = N'{}', itemValues = N'{}', na = N'{}', unitFacts = N'{}',
                hasActivity = CASE WHEN flags = N'{}' THEN 0 ELSE 1 END, holder = N'operator',
                lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
                rowVersion = rowVersion + 1
            OUTPUT INSERTED.gate, INSERTED.unitId, INSERTED.returnCount INTO @joinedUnits
            WHERE jobId = @sJobId AND gate = @dGate${i} AND disposition = N'corrections' AND (${unitWhere(g)});
            UPDATE dbo.reviews SET ${TO_OPERATOR}
            OUTPUT INSERTED.gate, INSERTED.unitId, INSERTED.returnCount INTO @joinedUnits
            WHERE jobId = @sJobId AND gate = @dGate${i} AND disposition <> N'corrections' AND (${unitWhere(g)});
            INSERT INTO dbo.reviews (jobId, gate, unitId, disposition, holder, returnCount,
                returnedByName, returnedByLogin, returnedDate, rowVersion,
                lastModified, lastModifiedByName, lastModifiedByLogin)
            OUTPUT INSERTED.gate, INSERTED.unitId, INSERTED.returnCount INTO @joinedUnits
            SELECT @jobId, @dGate${i}, v.unitId, N'corrections', N'operator', 1,
                @actorName, @actorLogin, @now, 1, @now, @actorName, @actorLogin
            FROM (VALUES ${unitValues(g)}) AS v(unitId)
            WHERE NOT EXISTS (SELECT 1 FROM dbo.reviews r WHERE r.jobId = @sJobId AND r.gate = @dGate${i} AND r.unitId = v.unitId);
            UPDATE dbo.review_gates SET
                roundNote = @note, roundProduction = @production,
                signedBackInByName = @actorName, signedBackInByLogin = @actorLogin,
                signedBackInBySource = @actorSource, signedBackInDate = @now,
                lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
                rowVersion = rowVersion + 1
            WHERE jobId = @sJobId AND gate = @dGate${i};
        END
        ELSE
        BEGIN
            UPDATE dbo.reviews SET ${CLEARED}
            WHERE jobId = @sJobId AND gate = @dGate${i} AND disposition = N'passed' AND (${unitWhere(g)});
            SELECT @gateRows = COUNT(*) FROM dbo.review_gates WHERE jobId = @sJobId AND gate = @dGate${i};
            IF @gateRows = 0
                INSERT INTO dbo.review_gates (jobId, gate, roundNo, roundNote, roundProduction,
                    signedBackInByName, signedBackInByLogin, signedBackInBySource, signedBackInDate,
                    rowVersion, lastModified, lastModifiedByName, lastModifiedByLogin)
                VALUES (@jobId, @dGate${i}, 2, @note, @production, @actorName, @actorLogin, @actorSource, @now,
                    1, @now, @actorName, @actorLogin);
            ELSE
                UPDATE dbo.review_gates SET
                    sentForReviewByName = N'', sentForReviewByLogin = N'', sentForReviewDate = N'',
                    startedByName = N'', startedByLogin = N'', startedDate = N'',
                    roundNo = roundNo + 1, roundNote = @note, roundProduction = @production,
                    signedBackInByName = @actorName, signedBackInByLogin = @actorLogin,
                    signedBackInBySource = @actorSource, signedBackInDate = @now,
                    lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
                    rowVersion = rowVersion + 1
                WHERE jobId = @sJobId AND gate = @dGate${i};
        END`).join('');

    const logRows = counted.map(id => ({
        gate: 'csr', unitId: 'job', unitName: reviewJobUnitName('csr'),
        itemId: id, logAction: 'flagged', detail: sheet.flags[id], reviewRound: before.returnCount || 0
    }));
    roundGates.forEach(g => {
        const mine = g === 'csr' ? [reviewJobUnitName('csr')] : blocks.filter(b => b.gate === g).map(b => b.name);
        const flags = g === 'csr' ? [] : Object.keys(deptLines[g] || {}).map(id => ({
            itemId: id, label: reviewItemLabel('csr', id), note: deptLines[g][id]
        }));
        logRows.push({
            gate: g, unitId: '', unitName: '', reviewRound: 0, logAction: 'signed_back_in',
            detail: JSON.stringify({ note, production: !!production, blocks: mine, flags })
        });
    });
    const logSql = reviewLogInsertSql(request, {
        jobId: job.id, jobNumber: job.jobNumber, gate: 'csr', unitId: 'job',
        unitName: reviewJobUnitName('csr'), reviewRound: 0, actor, now
    }, logRows);

    // The job and every piece she ticked asked again first (F6): a piece
    // deleted since signBackBlocks read them would otherwise get a sheet.
    // Then review_gates is locked before reviews, the order writeReviewUnit's
    // start claim already takes, so the two can never deadlock. Both ranges
    // are keyed on a variable of the column's own type: msnodesqlv8 declares
    // every string input as nvarchar(max), which turns the seek into a range
    // and would hold other jobs' rows.
    const guard = reviewJobGuardSql({ units: blocks.map((b, i) => 'bUnit' + i) });
    const batch = `
        SET XACT_ABORT ON;
        DECLARE @sJobId NVARCHAR(36);
        DECLARE @held INT;
        DECLARE @gateRows INT;
        DECLARE @joinedUnits TABLE (gate NVARCHAR(20), unitId NVARCHAR(36), returnCount INT);
        ${gates.map((g, i) => 'DECLARE @busy' + i + ' INT;').join('\n        ')}
        ${guard.declare}
        BEGIN TRAN;
        ${guard.test}
        SET @sJobId = @jobId;
        SELECT @held = COUNT(*) FROM dbo.review_gates WITH (UPDLOCK, HOLDLOCK) WHERE jobId = @sJobId;
        SELECT @held = COUNT(*) FROM dbo.reviews WITH (UPDLOCK, HOLDLOCK) WHERE jobId = @sJobId;
        ${deptSql}

        -- Her row always exists afterwards, so the reply can carry it whether or
        -- not this round cleared it. A row created here holds nothing: that is
        -- what "her checklist has not been started" already looks like.
        -- Her row is version checked on every round, a production round too,
        -- where it is left as it is: a second press from an older window, or
        -- another CSR's, would otherwise sign the job back in a second time,
        -- raise the rounds again and wipe the Send for review since.
        -- Two first sign back ins at once both read no row before the lock
        -- above: the second finds the first's row here and is a conflict, not
        -- a duplicate key (whose number the production driver can lose).
        IF @expectedVersion = 0 AND EXISTS (SELECT 1 FROM dbo.reviews WHERE jobId = @sJobId AND gate = N'csr' AND unitId = N'job')
        BEGIN
            ROLLBACK TRAN;
            SELECT CAST(0 AS BIT) AS ok, N'changed' AS why;
            RETURN;
        END
        IF @expectedVersion = 0
            INSERT INTO dbo.reviews (jobId, gate, unitId, returnCount, rowVersion,
                lastModified, lastModifiedByName, lastModifiedByLogin)
            VALUES (@jobId, N'csr', N'job', ${clearHers ? 1 : 0}, 1, @now, @actorName, @actorLogin);
        ELSE
        BEGIN
            UPDATE dbo.reviews SET ${clearHers ? CLEARED : `
                lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
                rowVersion = rowVersion + 1`}
            WHERE jobId = @sJobId AND gate = N'csr' AND unitId = N'job' AND rowVersion = @expectedVersion;
            IF @@ROWCOUNT = 0
            BEGIN
                ROLLBACK TRAN;
                SELECT CAST(0 AS BIT) AS ok, N'changed' AS why;
                RETURN;
            END
        END
        ${csrRoundSql}
        ${logSql}
        -- One row per block the change joined, at the loop it starts or joins,
        -- with her words: the window and the Fixed email read it to say the
        -- piece came back from the CSR and is checked in full again.
        INSERT INTO dbo.review_log (jobId, jobNumber, gate, unitId, unitName, itemId, itemLabel,
            reviewRound, logAction, detail, actorName, actorLogin, actorSource,
            recipientName, recipientAddress, whenIso)
        SELECT @jobId, @sJobNumber, j.gate, j.unitId,
               CASE WHEN j.unitId = N'job' THEN (CASE j.gate WHEN N'prepress' THEN @wholePrepress ELSE @wholeTs END)
                    ELSE ISNULL(c.name, N'') END,
               N'', N'', j.returnCount, N'signed_back', @note, @actorName, @actorLogin, @actorSource, N'', N'', @now
        FROM @joinedUnits j
        LEFT JOIN dbo.components c ON c.id = j.unitId AND c.jobId = @sJobId;
        SELECT CAST(1 AS BIT) AS ok, ${gates.map((g, i) => '@busy' + i + ' AS busy' + i).join(', ')}, r.* FROM dbo.reviews r
        WHERE r.jobId = @sJobId AND r.gate = N'csr' AND r.unitId = N'job';
        COMMIT TRAN;`;
    let result;
    try {
        result = await request.query(batch);
    } catch (err) {
        // Two first sign back ins at once both create her row: the second loses.
        if (!sqlErrorNumbers(err).some(n => n === 2627 || n === 2601)) throw err;
        result = { recordsets: [[{ ok: false, why: 'changed' }]] };
    }

    const saved = lastRecordset(result)[0];
    const gone = reviewJobRefusal(saved, REVIEW_SIGNBACK_GONE);
    if (gone) throw gone;
    if (!saved || !saved.ok) {
        const current = parseReviewRow(await selectReviewUnit(pool, job.id, 'csr', 'job'));
        return res.status(409).json({
            error: 'Someone changed this checklist while you were filling this in. Check it and try again.',
            review: current
        });
    }
    delete saved.ok;
    // Which departments the change joined, part way through their round.
    const joined = gates.filter((g, i) => Number(saved['busy' + i]) === 1);
    gates.forEach((g, i) => { delete saved['busy' + i]; });
    trackUser(actor.login || actor.name, 'reviewing');
    // One email per department, built before the reply (OUTLOOK_EMAIL_PLAN).
    const emails = await mailEmails(pool, { jobId: job.id, jobNumber: job.jobNumber, gate: 'csr', actor }, () =>
        mailSignedBackIn(pool, job, actor, gates.map(g => ({
            gate: g, joined: joined.includes(g),
            blocks: blocks.filter(b => b.gate === g).map(b => b.name),
            items: mailItems('csr', 'job', deptLines[g] || {})
        })), note, !!production, now));
    res.json({ review: parseReviewRow(saved), signedBack: { gates, blocks, keptCsrPass: !clearHers, joined }, emails });
}

// { action: 'newjob', note } on a department checklist: the CSR hands a brand
// new job over from the work order (START_NEW_JOB_PLAN section f). Today she
// finishes the work order, prints the PDF into Midnight and writes an email in
// Outlook to Prepress or Tech Services; this is that email, as one press.
//
// The press sends the email AND starts that department's QC record, so the job
// reads NEW JOB on the job list from that moment (David, 2026-09-19, answer 1).
// The department comes from the tab she is on, so a job that needs both is one
// press on each (answer 2). It writes one review_gates row and one review_log
// row, and never touches jobs or components: the work order is the audit
// record.
//
// What it deliberately does NOT do:
//   - stamp sentForReviewBy*, which would make her the round's operator and
//     lock the department out of its own round (ROUNDS_PLAN, the operator rule)
//   - raise roundNo or stamp signedBackInDate, which is what makes a job read
//     CAME BACK, Round 2
//   - use the signed_back_in log action, which four other readers take as the
//     round boundary
//
// Pressed again while nobody has picked the job up, it sends the same email
// again and adds another line to the activity (answer 7). Once that department
// has sent the round for review it is refused for good.
async function reviewNewJob(req, res, ctx) {
    const { pool, gate, actor, job, now, access } = ctx;
    const label = reviewGateLabel(gate);
    if (access.role === 'unlinked') return reviewLocked(res, access.reason);
    // The same person canSignBack means: a linked, active CSR. Nothing starts
    // in a department without a CSR asking.
    if (!actor.kinds.includes('csr')) return reviewLocked(res, 'Only CSRs send a new job to a department.');

    const note = String((req.body && req.body.note) || '').replace(/\r\n?/g, '\n').trim();
    if (!note) throw reviewError(400, 'Say what ' + label + ' needs to know before sending it.');
    if (note.length > REVIEW_LIMIT.note) throw reviewError(400, 'That is too long. Keep it under 2,000 characters.');

    const request = pool.request();
    request.input('jobId', job.id);
    request.input('gate', gate);
    request.input('now', now);
    request.input('actorName', actor.name);
    request.input('actorLogin', actor.login);
    request.input('actorSource', actor.source);
    const logSql = reviewLogInsertSql(request, {
        jobId: job.id, jobNumber: job.jobNumber, gate, unitId: '', unitName: '', reviewRound: 0, actor, now
    }, [{ logAction: 'new_job', detail: note }]);

    // Built on the send action's skeleton: the gate row (or where it would go)
    // is locked first, with the job id and gate in variables of the columns'
    // own types, because msnodesqlv8 declares every string input as
    // nvarchar(max) and would turn the seek into a range across other jobs.
    //
    // "Has the department picked it up" is tested inside the lock, three ways:
    // the gate row's own stamps, any block with an answer or a disposition,
    // and a Send for review anywhere in the history. The last one is what makes
    // it final: a sign back in clears the gate's sender, and the button must
    // never come back once a department has had the job.
    // The job asked again first (F6): the work order she pressed it on may
    // have been archived or deleted a moment before.
    const guard = reviewJobGuardSql();
    let result;
    try {
        result = await request.query(`
            SET XACT_ABORT ON;
            DECLARE @changed TABLE (id INT);
            DECLARE @gateRows INT;
            DECLARE @njJobId NVARCHAR(36);
            DECLARE @njGate NVARCHAR(20);
            DECLARE @started INT = 0;
            ${guard.declare}
            BEGIN TRAN;
            ${guard.test}
            SET @njJobId = @jobId;
            SET @njGate = @gate;
            SELECT @gateRows = COUNT(*) FROM dbo.review_gates WITH (UPDLOCK, HOLDLOCK)
            WHERE jobId = @njJobId AND gate = @njGate;
            -- The same three questions reviewCanNewJob asks, in the same order,
            -- including leaving out a deleted piece's row.
            IF EXISTS (SELECT 1 FROM dbo.review_gates WHERE jobId = @njJobId AND gate = @njGate
                         AND (sentForReviewByLogin <> N'' OR sentForReviewByName <> N''
                              OR startedByLogin <> N'' OR startedByName <> N''
                              OR signedBackInDate <> N'' OR roundNo > 1))
                SET @started = 1;
            ELSE IF EXISTS (SELECT 1 FROM dbo.reviews r WHERE r.jobId = @njJobId AND r.gate = @njGate
                              AND (r.hasActivity = 1 OR r.disposition <> N'')
                              AND (r.unitId = N'job' OR EXISTS (SELECT 1 FROM dbo.components c
                                                                WHERE c.id = r.unitId AND c.jobId = @njJobId)))
                SET @started = 1;
            ELSE IF EXISTS (SELECT 1 FROM dbo.review_log WHERE jobId = @njJobId AND gate = @njGate
                              AND logAction = N'sent_for_review')
                SET @started = 1;
            IF @started = 0
            BEGIN
                UPDATE dbo.review_gates SET
                    newJobByName = @actorName, newJobByLogin = @actorLogin,
                    newJobBySource = @actorSource, newJobDate = @now,
                    lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
                    rowVersion = rowVersion + 1
                OUTPUT INSERTED.id INTO @changed
                WHERE jobId = @njJobId AND gate = @njGate;
                IF @gateRows = 0
                    INSERT INTO dbo.review_gates (jobId, gate,
                        newJobByName, newJobByLogin, newJobBySource, newJobDate,
                        rowVersion, lastModified, lastModifiedByName, lastModifiedByLogin)
                    OUTPUT INSERTED.id INTO @changed
                    VALUES (@jobId, @gate, @actorName, @actorLogin, @actorSource, @now,
                        1, @now, @actorName, @actorLogin);
            END
            IF NOT EXISTS (SELECT 1 FROM @changed)
            BEGIN
                ROLLBACK TRAN;
                SELECT CAST(0 AS BIT) AS ok;
                RETURN;
            END
            ${logSql}
            SELECT CAST(1 AS BIT) AS ok, g.* FROM dbo.review_gates g WHERE g.id = (SELECT TOP 1 id FROM @changed);
            COMMIT TRAN;`);
    } catch (err) {
        // Two presses at once: both read no row before the lock, the second
        // loses on the unique key. The range lock above makes that very hard to
        // reach. Known limit, shared with the send action: msnodesqlv8 can lose
        // the number when a later statement of a batch fails, and then this
        // reads as an ordinary error rather than "sent a moment ago". Nothing
        // is half written either way: the batch rolls itself back.
        if (!sqlErrorNumbers(err).some(n => n === 2627 || n === 2601)) throw err;
        const current = await selectReviewGate(pool, job.id, gate);
        return res.status(409).json({ error: 'This was sent a moment ago.', gate: current });
    }
    const saved = lastRecordset(result)[0];
    const gone = reviewJobRefusal(saved);
    if (gone) throw gone;
    if (!saved || !saved.ok) {
        const current = await selectReviewGate(pool, job.id, gate);
        return res.status(409).json({ error: label + ' has already started on this job.', gate: current });
    }
    delete saved.ok;
    trackUser(actor.login || actor.name, 'reviewing');
    const emails = await mailEmails(pool, { jobId: job.id, jobNumber: job.jobNumber, gate, actor }, () => mailNewJob(pool, job, gate, actor, note, now));
    res.json({ gate: saved, newJob: { gate, actorName: actor.name, actorLogin: actor.login, whenIso: now }, emails });
}

// "Sent by mistake": the CSR takes a hand-over back (David, 2026-09-20). She
// sends a job to Prepress, means Tech Services, and Prepress never touches it;
// without this the job list reads NEW JOB for ever, because the chip shows the
// step furthest behind and nothing else ever clears the stamp.
//
// It clears the four newJob* columns and writes one history row. That is all.
// Nothing else on the server reads those columns -- reviewDeptStarted leaves
// them out on purpose -- so the only thing that can change is the job list's
// chip and its hover, which go back to blank. The new_job row stays where it
// is, because review_log is append-only and the record of what she did must
// outlive the correction.
//
// What it deliberately does NOT do:
//   - unsend the email. One attempt, no retry, and the mailer cannot reach
//     anybody's mailbox. The tenth email says "ignore that" to the same people
//     instead, and it is sent the same way: after the answer, inside the queue.
//   - touch jobs or components, so her name never lands on the work order.
//   - work once the department has picked the job up. The same three questions
//     the send asks, in the same order, so the two buttons can never disagree.
async function reviewTakeBack(req, res, ctx) {
    const { pool, gate, actor, job, now, access } = ctx;
    const label = reviewGateLabel(gate);
    if (access.role === 'unlinked') return reviewLocked(res, access.reason);
    if (!actor.kinds.includes('csr')) return reviewLocked(res, 'Only CSRs take a new job back.');

    const request = pool.request();
    request.input('jobId', job.id);
    request.input('gate', gate);
    request.input('now', now);
    request.input('actorName', actor.name);
    request.input('actorLogin', actor.login);
    request.input('actorSource', actor.source);
    const logSql = reviewLogInsertSql(request, {
        jobId: job.id, jobNumber: job.jobNumber, gate, unitId: '', unitName: '', reviewRound: 0, actor, now
    }, [{ logAction: 'new_job_taken_back', detail: '' }]);

    // The send's batch, with the update turned around and one more test. The
    // gate row is locked first on typed variables, for the same reason:
    // msnodesqlv8 declares every string input as nvarchar(max) and would turn
    // the seek into a range across other jobs. There is no INSERT branch: with
    // no gate row there is nothing to take back.
    // The job asked again first (F6).
    const guard = reviewJobGuardSql();
    const result = await request.query(`
        SET XACT_ABORT ON;
        DECLARE @changed TABLE (id INT);
        DECLARE @tbJobId NVARCHAR(36);
        DECLARE @tbGate NVARCHAR(20);
        DECLARE @started INT = 0;
        DECLARE @standing INT = 0;
        ${guard.declare}
        BEGIN TRAN;
        ${guard.test}
        SET @tbJobId = @jobId;
        SET @tbGate = @gate;
        SELECT @standing = COUNT(*) FROM dbo.review_gates WITH (UPDLOCK, HOLDLOCK)
        WHERE jobId = @tbJobId AND gate = @tbGate AND newJobDate <> N'';
        -- The same three questions reviewCanNewJob asks, in the same order,
        -- including leaving out a deleted piece's row.
        IF EXISTS (SELECT 1 FROM dbo.review_gates WHERE jobId = @tbJobId AND gate = @tbGate
                     AND (sentForReviewByLogin <> N'' OR sentForReviewByName <> N''
                          OR startedByLogin <> N'' OR startedByName <> N''
                          OR signedBackInDate <> N'' OR roundNo > 1))
            SET @started = 1;
        ELSE IF EXISTS (SELECT 1 FROM dbo.reviews r WHERE r.jobId = @tbJobId AND r.gate = @tbGate
                          AND (r.hasActivity = 1 OR r.disposition <> N'')
                          AND (r.unitId = N'job' OR EXISTS (SELECT 1 FROM dbo.components c
                                                            WHERE c.id = r.unitId AND c.jobId = @tbJobId)))
            SET @started = 1;
        ELSE IF EXISTS (SELECT 1 FROM dbo.review_log WHERE jobId = @tbJobId AND gate = @tbGate
                          AND logAction = N'sent_for_review')
            SET @started = 1;
        IF @started = 0 AND @standing > 0
            UPDATE dbo.review_gates SET
                newJobByName = N'', newJobByLogin = N'', newJobBySource = N'', newJobDate = N'',
                lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
                rowVersion = rowVersion + 1
            OUTPUT INSERTED.id INTO @changed
            WHERE jobId = @tbJobId AND gate = @tbGate;
        IF NOT EXISTS (SELECT 1 FROM @changed)
        BEGIN
            ROLLBACK TRAN;
            SELECT CAST(0 AS BIT) AS ok, @started AS started, @standing AS standing;
            RETURN;
        END
        ${logSql}
        SELECT CAST(1 AS BIT) AS ok, g.* FROM dbo.review_gates g WHERE g.id = (SELECT TOP 1 id FROM @changed);
        COMMIT TRAN;`);

    const saved = lastRecordset(result)[0];
    const gone = reviewJobRefusal(saved);
    if (gone) throw gone;
    if (!saved || !saved.ok) {
        const current = await selectReviewGate(pool, job.id, gate);
        return res.status(409).json({
            error: saved && saved.started ? label + ' has already started on this job.'
                : 'This job was not sent to ' + label + '.',
            gate: current
        });
    }
    delete saved.ok;
    trackUser(actor.login || actor.name, 'reviewing');
    const emails = await mailEmails(pool, { jobId: job.id, jobNumber: job.jobNumber, gate, actor }, () => mailTakeBack(pool, job, gate, actor, now));
    res.json({ gate: saved, takeBack: { gate, actorName: actor.name, actorLogin: actor.login, whenIso: now }, emails });
}

// { action: 'handoff', paths } on a department checklist: Send to CSR
// (PHASE5_PLAN section p). Once every block of that checklist is passed,
// anyone active on that department's list pastes where the files are and sends
// them to the job's CSR.
//
// The send is a review_log row, not a column: review writes never touch jobs or
// components, detail is NVARCHAR(MAX), and every send is kept. The "every block
// passed" test lives inside the batch, behind an UPDLOCK, HOLDLOCK taken as its
// first statement, so a Reopen cannot slip between the test and the write. The
// job id and gate are copied into variables of the columns' own types first:
// msnodesqlv8 declares every string input as nvarchar(max), which would turn
// that seek into a range and hold a lock across other jobs' rows.
// Ask the operator to send the files instead of sending them yourself
// (PHASE6_PLAN d). It records the request and emails. Whoever asked cannot
// send while the ask stands (David, 2026-09-19); the operator and everyone
// else on that department's list still can.
async function reviewAskHandoff(req, res, ctx) {
    const { pool, gate, actor, job, now, access, state } = ctx;
    const label = reviewGateLabel(gate);
    if (access.role === 'unlinked') return reviewLocked(res, access.reason);
    if (!actor.kinds.includes(gate)) return reviewLocked(res, 'Only ' + label + ' can ask for the outputs to be sent.');
    // The operator asking themselves would only lock their own Send to CSR.
    if (access.role === 'operator') return reviewLocked(res, 'You are the operator: press Send to CSR.');
    // access.canHandoff is only worked out on the reviews GET, so the tests are
    // done here, in one batch behind the same lock the send takes: every block
    // passed, the files not already sent this round, and no ask already
    // standing (it stands until the files go or the job comes back). Two asks
    // at the same moment queue on the lock, so only one is recorded and only
    // one emails (David, 2026-09-18).
    const blocksSql = reviewGate(gate).perPiece
        ? "SELECT c.id AS unitId FROM dbo.components c WHERE c.jobId = @aJobId UNION ALL SELECT N'job' AS unitId"
        : "SELECT N'job' AS unitId";
    const request = pool.request();
    request.input('jobId', job.id);
    request.input('gate', gate);
    request.input('jobNumber', job.jobNumber || '');
    request.input('actorName', actor.name);
    request.input('actorLogin', actor.login);
    request.input('actorSource', actor.source);
    request.input('now', now);
    // The job asked again first (F6).
    const guard = reviewJobGuardSql();
    const result = await request.query(`
        SET XACT_ABORT ON;
        DECLARE @asked TABLE (id INT);
        DECLARE @aJobId NVARCHAR(36);
        DECLARE @aGate NVARCHAR(20);
        DECLARE @held INT;
        DECLARE @open INT;
        DECLARE @lastSend INT;
        DECLARE @lastBack INT;
        DECLARE @lastAsk INT;
        DECLARE @sendAt NVARCHAR(40);
        DECLARE @newestPass NVARCHAR(40);
        DECLARE @why NVARCHAR(20) = N'';
        ${guard.declare}
        BEGIN TRAN;
        ${guard.test}
        SET @aJobId = @jobId;
        SET @aGate = @gate;
        SELECT @held = COUNT(*) FROM dbo.reviews WITH (UPDLOCK, HOLDLOCK)
        WHERE jobId = @aJobId AND gate = @aGate;
        SELECT @open = COUNT(*)
        FROM (${blocksSql}) AS b
        LEFT JOIN dbo.reviews r ON r.jobId = @aJobId AND r.gate = @aGate AND r.unitId = b.unitId
        WHERE r.id IS NULL OR r.disposition <> N'passed';
        SELECT @lastSend = MAX(id) FROM dbo.review_log WHERE jobId = @aJobId AND gate = @aGate AND logAction = N'sent_to_csr';
        SELECT @lastBack = MAX(id) FROM dbo.review_log WHERE jobId = @aJobId AND gate = @aGate AND logAction = N'signed_back_in';
        SELECT @lastAsk = MAX(id) FROM dbo.review_log WHERE jobId = @aJobId AND gate = @aGate AND logAction = N'handoff_asked';
        SELECT @sendAt = whenIso FROM dbo.review_log WHERE id = @lastSend;
        -- A deleted piece's pass does not count, as the job list and the
        -- window leave it out.
        SELECT @newestPass = MAX(r.completedDate) FROM dbo.reviews r
        WHERE r.jobId = @aJobId AND r.gate = @aGate AND r.disposition = N'passed'
          AND (r.unitId = N'job' OR EXISTS (SELECT 1 FROM dbo.components c WHERE c.id = r.unitId AND c.jobId = @aJobId));
        IF @open > 0 SET @why = N'open';
        ELSE IF @lastSend IS NOT NULL AND (@lastBack IS NULL OR @lastBack < @lastSend) AND NOT (@newestPass > @sendAt) SET @why = N'sent';
        ELSE IF @lastAsk IS NOT NULL AND (@lastSend IS NULL OR @lastSend < @lastAsk) AND (@lastBack IS NULL OR @lastBack < @lastAsk) SET @why = N'asked';
        IF @why = N''
            INSERT INTO dbo.review_log (jobId, jobNumber, gate, unitId, unitName, itemId, itemLabel,
                reviewRound, logAction, detail, actorName, actorLogin, actorSource,
                recipientName, recipientAddress, whenIso)
            OUTPUT INSERTED.id INTO @asked
            VALUES (@jobId, @jobNumber, @gate, N'', N'', N'', N'', 0, N'handoff_asked', N'',
                @actorName, @actorLogin, @actorSource, N'', N'', @now);
        IF NOT EXISTS (SELECT 1 FROM @asked)
        BEGIN
            ROLLBACK TRAN;
            SELECT CAST(0 AS BIT) AS ok, @why AS why;
            RETURN;
        END
        SELECT CAST(1 AS BIT) AS ok;
        COMMIT TRAN;`);
    const saved = lastRecordset(result)[0];
    const gone = reviewJobRefusal(saved);
    if (gone) throw gone;
    if (!saved || !saved.ok) {
        const why = saved ? saved.why : '';
        throw reviewError(409, why === 'sent' ? 'The files have already been sent.'
            : why === 'asked' ? 'The operator has already been asked.'
            : 'Not every ' + label + ' checklist is passed now.');
    }
    const emails = await mailEmails(pool, { jobId: job.id, jobNumber: job.jobNumber, gate, actor }, () => mailHandoffAsked(pool, job, gate, actor, state.gateRow, now));
    res.json({ asked: { gate, actorName: actor.name, actorLogin: actor.login, whenIso: now }, emails });
}

async function reviewHandoff(req, res, ctx) {
    const { pool, gate, actor, job, now, access } = ctx;
    const label = reviewGateLabel(gate);
    if (access.role === 'unlinked') return reviewLocked(res, access.reason);
    if (!actor.kinds.includes(gate)) return reviewLocked(res, 'Only ' + label + ' can send the outputs to the CSR.');

    const paths = String((req.body && req.body.paths) || '').replace(/\r\n?/g, '\n').trim();
    if (!paths) throw reviewError(400, 'Paste where the files are before sending.');
    if (paths.length > REVIEW_LIMIT.paths) {
        throw reviewError(400, 'That is too long to send. Keep it under 4,000 characters.');
    }

    // "This replaces the paths sent ..." only within one round: the first send
    // after a sign back in replaces nothing that is still current.
    const previous = dropSignedBack(await selectReviewHandoffs(pool, job.id, {}), await selectReviewSignBacks(pool, job.id));
    const previousAt = previous[gate] ? previous[gate].whenIso : '';

    // Every block of this checklist: each piece now on the job plus Whole Job
    // on Prepress, the one checklist on Tech Services. A piece with no row is
    // not passed, which a LEFT JOIN says for us.
    const blocksSql = reviewGate(gate).perPiece
        ? "SELECT c.id AS unitId FROM dbo.components c WHERE c.jobId = @hJobId UNION ALL SELECT N'job' AS unitId"
        : "SELECT N'job' AS unitId";

    const request = pool.request();
    request.input('jobId', job.id);
    request.input('gate', gate);
    request.input('jobNumber', job.jobNumber || '');
    request.input('paths', paths);
    request.input('csrName', String(job.csrName || '').slice(0, REVIEW_LIMIT.name));
    request.input('actorName', actor.name);
    request.input('actorLogin', actor.login);
    request.input('actorSource', actor.source);
    request.input('now', now);

    // The job asked again first (F6): without it, a job deleted a moment
    // before left only Whole Job to count, and a passed Whole Job sent the files.
    const guard = reviewJobGuardSql();
    const result = await request.query(`
        SET XACT_ABORT ON;
        DECLARE @sent TABLE (id INT);
        DECLARE @hJobId NVARCHAR(36);
        DECLARE @hGate NVARCHAR(20);
        DECLARE @held INT;
        DECLARE @open INT;
        DECLARE @lastSend INT;
        DECLARE @lastBack INT;
        DECLARE @lastAsk INT;
        DECLARE @askLogin NVARCHAR(200);
        DECLARE @sendAt NVARCHAR(40);
        DECLARE @newestPass NVARCHAR(40);
        DECLARE @standing INT = 0;
        DECLARE @askedByYou INT = 0;
        ${guard.declare}
        BEGIN TRAN;
        ${guard.test}
        SET @hJobId = @jobId;
        SET @hGate = @gate;
        SELECT @held = COUNT(*) FROM dbo.reviews WITH (UPDLOCK, HOLDLOCK)
        WHERE jobId = @hJobId AND gate = @hGate;
        SELECT @open = COUNT(*)
        FROM (${blocksSql}) AS b
        LEFT JOIN dbo.reviews r ON r.jobId = @hJobId AND r.gate = @hGate AND r.unitId = b.unitId
        WHERE r.id IS NULL OR r.disposition <> N'passed';
        -- Once per round: files sent since the last sign back in, with no
        -- block passed again since, still stand (David, 2026-09-18). By time,
        -- as the window and the job list decide it: a send and a pass racing
        -- can at worst allow one more send, never leave nobody able to send.
        SELECT @lastSend = MAX(id) FROM dbo.review_log WHERE jobId = @hJobId AND gate = @hGate AND logAction = N'sent_to_csr';
        SELECT @lastBack = MAX(id) FROM dbo.review_log WHERE jobId = @hJobId AND gate = @hGate AND logAction = N'signed_back_in';
        SELECT @sendAt = whenIso FROM dbo.review_log WHERE id = @lastSend;
        -- A deleted piece's pass does not count, as the job list and the
        -- window leave it out.
        SELECT @newestPass = MAX(r.completedDate) FROM dbo.reviews r
        WHERE r.jobId = @hJobId AND r.gate = @hGate AND r.disposition = N'passed'
          AND (r.unitId = N'job' OR EXISTS (SELECT 1 FROM dbo.components c WHERE c.id = r.unitId AND c.jobId = @hJobId));
        IF @lastSend IS NOT NULL AND (@lastBack IS NULL OR @lastBack < @lastSend) AND NOT (@newestPass > @sendAt)
            SET @standing = 1;
        -- Whoever asked the operator to send them has chosen that, while the
        -- ask stands: no send and no sign back in since (David, 2026-09-19).
        SELECT @lastAsk = MAX(id) FROM dbo.review_log WHERE jobId = @hJobId AND gate = @hGate AND logAction = N'handoff_asked';
        SELECT @askLogin = actorLogin FROM dbo.review_log WHERE id = @lastAsk;
        IF @lastAsk IS NOT NULL AND (@lastSend IS NULL OR @lastSend < @lastAsk) AND (@lastBack IS NULL OR @lastBack < @lastAsk)
            AND @askLogin = @actorLogin
            SET @askedByYou = 1;
        IF @open = 0 AND @standing = 0 AND @askedByYou = 0
            INSERT INTO dbo.review_log (jobId, jobNumber, gate, unitId, unitName, itemId, itemLabel,
                reviewRound, logAction, detail, actorName, actorLogin, actorSource,
                recipientName, recipientAddress, whenIso)
            OUTPUT INSERTED.id INTO @sent
            VALUES (@jobId, @jobNumber, @gate, N'', N'', N'', N'', 0, N'sent_to_csr', @paths,
                @actorName, @actorLogin, @actorSource, @csrName, N'', @now);
        IF NOT EXISTS (SELECT 1 FROM @sent)
        BEGIN
            ROLLBACK TRAN;
            SELECT CAST(0 AS BIT) AS ok, @open AS openBlocks, @standing AS standing, @askedByYou AS askedByYou;
            RETURN;
        END
        SELECT CAST(1 AS BIT) AS ok, l.* FROM dbo.review_log l WHERE l.id = (SELECT TOP 1 id FROM @sent);
        COMMIT TRAN;`);

    const saved = lastRecordset(result)[0];
    const gone = reviewJobRefusal(saved);
    if (gone) throw gone;
    if (!saved || !saved.ok) {
        return res.status(409).json({ error: !saved || saved.openBlocks > 0 ? 'Not every ' + label + ' checklist is passed now.'
            : saved.standing ? 'The files have already been sent.'
            : saved.askedByYou ? 'You asked the operator to send the files.'
            : 'Not every ' + label + ' checklist is passed now.' });
    }
    delete saved.ok;
    trackUser(actor.login || actor.name, 'reviewing');
    const emails = await mailEmails(pool, { jobId: job.id, jobNumber: job.jobNumber, gate, actor }, () => mailHandoff(pool, job, gate, actor, paths, previousAt, now));
    res.json({ handoff: saved, emails });
}

// { action: 'reopen', rowVersion }: takes the pass off a passed checklist so it
// can be changed (question 6). Anyone who may review it can. The sheet stays
// exactly as it was signed.
async function reopenReviewUnit(req, res, ctx) {
    const { pool, gate, actor, job, access } = ctx;
    if (!access.canEdit) return reviewLocked(res, access.reason);
    const unitId = String(req.params.unitId || '');
    const expected = expectedRowVersion(req.body);
    const unitName = unitId.length <= 36 ? await reviewUnitName(pool, job, gate, unitId) : null;
    if (unitName === null) return res.status(404).json({ error: REVIEW_NO_PIECE });
    const stored = parseReviewRow(await selectReviewUnit(pool, job.id, gate, unitId));
    if (!stored || stored.rowVersion !== expected) {
        return res.status(409).json({ error: 'This sheet was changed by someone else.', review: stored });
    }
    if (stored.disposition !== 'passed') {
        return res.status(409).json({ error: 'This checklist is not passed.', review: stored });
    }
    const saved = await updateReviewUnit(ctx, stored, unitName, {
        disposition: '', holder: '', completedDate: '',
        reviewerName: '', reviewerLogin: '', reviewerSource: '', reviewerRole: ''
    }, [{ logAction: 'reopened' }]);
    if (!saved) {
        const current = parseReviewRow(await selectReviewUnit(pool, job.id, gate, unitId));
        return res.status(409).json({ error: 'This sheet was changed by someone else.', review: current });
    }
    trackUser(actor.login || actor.name, 'reviewing');
    res.json({ review: saved });
}

// ── Instructions changed after the pass (CHANGED_AFTER_PASS_PLAN.md) ──
//
// A passed Prepress or Tech Services block names the pieces whose words in its
// department changed after it passed, on the job list's hover and in the QC
// window (David, 2026-10-08; never the CSR's checklist, his answer 8). The
// rule is review-words.js; these read the rows and the signed sheets for it.
// Nothing here writes, and a failure here names nothing rather than failing
// the reply it rides on: the QC column and the window go on as before.
//
// Environment overrides are for the dev checks only (dev/README.md): the
// defaults are what ships.
const REVIEW_WORDS_SHEET_BATCH = Math.round(lockEnvNumber('REVIEW_WORDS_BATCH', 100));
const REVIEW_WORDS_JOB_BATCH = Math.round(lockEnvNumber('REVIEW_WORDS_BATCH', 50));
const reviewWordsCache = reviewWords.createCache({
    maxAgeMs: lockEnvNumber('REVIEW_WORDS_MAX_AGE_MS', 60 * 60 * 1000),
    jitterMs: process.env.REVIEW_WORDS_MAX_AGE_MS ? 0 : 10 * 60 * 1000
});
if (['REVIEW_WORDS_BATCH', 'REVIEW_WORDS_MAX_AGE_MS'].some(n => process.env[n] != null && String(process.env[n]).trim() !== '')) {
    startupNotes.push('QC changed words from the environment: batches of ' + REVIEW_WORDS_SHEET_BATCH + ' sheets and ' +
        REVIEW_WORDS_JOB_BATCH + ' jobs, words kept at most ' + lockEnvNumber('REVIEW_WORDS_MAX_AGE_MS', 60 * 60 * 1000) + ' ms');
}

// Logged once for each place and message, so a sheet that cannot be read is
// one line, not one a refresh.
const reviewWordsLogged = new Set();
function reviewWordsTrouble(where, err) {
    const text = where + ': ' + (err && err.message ? err.message : String(err));
    if (reviewWordsLogged.has(text)) return;
    if (reviewWordsLogged.size > 500) reviewWordsLogged.clear();
    reviewWordsLogged.add(text);
    console.error('QC REVIEW CHANGED WORDS UNAVAILABLE: ' + text);
}

const reviewWordsYield = () => new Promise(resolve => setImmediate(resolve));

// The checklists with a block per piece, from the checklist file.
function reviewWordsPerPiece() {
    return new Set(reviewItems.gates.filter(g => g.perPiece).map(g => g.gate));
}

// The signed sheets these ids name, as frozen copies (null when one cannot be
// known), read only for the ids the cache does not have. Answers its own Map,
// so a job list read pruning the cache meanwhile takes nothing from the
// caller. The ids are whole numbers from review_log's own key, checked here,
// so they go into the text and the read takes no inputs. A large sheet is
// parsed on the event loop, so it is given back after each one. One that
// cannot be read is logged once (one from before the freeze is only unknown).
async function reviewWordsReadSheets(pool, ids) {
    const wanted = Array.from(new Set(ids)).filter(id => Number.isInteger(id) && id > 0);
    const out = new Map();
    wanted.forEach(id => { if (reviewWordsCache.hasSheet(id)) out.set(id, reviewWordsCache.sheet(id)); });
    const missing = wanted.filter(id => !out.has(id));
    for (let i = 0; i < missing.length; i += REVIEW_WORDS_SHEET_BATCH) {
        const part = missing.slice(i, i + REVIEW_WORDS_SHEET_BATCH);
        const r = await pool.request().query(`SELECT id, detail FROM dbo.review_log
            WHERE logAction = N'signoff_snapshot' AND id IN (${part.join(', ')})`);
        for (const row of r.recordset) {
            let parsed;
            try {
                parsed = JSON.parse(row.detail || '');
            } catch (err) {
                parsed = null;
                reviewWordsTrouble('signed sheet ' + row.id, new Error('it cannot be read'));
            }
            out.set(Number(row.id), reviewWordsCache.putSheet(Number(row.id), parsed));
            await reviewWordsYield();
        }
    }
    return out;
}

// The words of the pieces of these jobs, read 50 jobs at a time by named
// inputs through pool.request() (safe on msnodesqlv8), kept in the cache under
// each job's key. Answers a Map from job id to its pieces in order.
async function reviewWordsReadJobs(pool, jobIds, keyOf, now) {
    const out = new Map();
    for (let i = 0; i < jobIds.length; i += REVIEW_WORDS_JOB_BATCH) {
        const part = jobIds.slice(i, i + REVIEW_WORDS_JOB_BATCH);
        const request = pool.request();
        part.forEach((id, k) => request.input('j' + k, id));
        const r = await request.query(`SELECT id, jobId, sortOrder, instructions_prepress, instructions_techservices,
                   instructionsHistory_prepress, instructionsHistory_techservices
            FROM dbo.components WHERE jobId IN (${part.map((id, k) => '@j' + k).join(', ')})`);
        const rows = new Map(part.map(id => [id, []]));
        for (const row of r.recordset) {
            const list = rows.get(String(row.jobId));
            if (list) list.push({ id: String(row.id), sortOrder: Number(row.sortOrder) || 0, current: reviewWords.currentFrom(row) });
            await reviewWordsYield();
        }
        rows.forEach((list, jobId) => {
            list.sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            const pieces = list.map(p => ({ id: p.id, current: p.current }));
            reviewWordsCache.putJob(jobId, keyOf(jobId), pieces, now);
            out.set(jobId, pieces);
        });
    }
    return out;
}

// The job list's answer: one row per job, department and piece named, sorted,
// so the same answer is the same text (refreshBoard compares the reply's
// text). One fill at a time, shared by the job lists asking meanwhile; only
// this read prunes the cache. A job's key is its rowVersion and lastModified.
async function reviewChangedForList(pool) {
    return reviewWordsCache.shared(async () => {
        const r = await pool.request().query(`
            SELECT r.jobId, r.gate, r.unitId, j.rowVersion, j.lastModified,
                   (SELECT MAX(l.id) FROM dbo.review_log l
                     WHERE l.logAction = N'signoff_snapshot' AND l.jobId = r.jobId
                       AND l.gate = r.gate AND l.unitId = r.unitId) AS sheetId
            FROM dbo.reviews r
            JOIN dbo.jobs j ON j.id = r.jobId
            WHERE (j.archivedDate IS NULL OR j.archivedDate = N'') AND r.disposition = N'passed'
              AND r.gate IN (N'prepress', N'techservices')
              AND (r.unitId = N'job'
                   OR EXISTS (SELECT 1 FROM dbo.components c WHERE c.id = r.unitId AND c.jobId = r.jobId))`);
        const now = Date.now();
        const jobs = new Map();
        const sheetIds = new Set();
        r.recordset.forEach(row => {
            const jobId = String(row.jobId);
            if (!jobs.has(jobId)) jobs.set(jobId, { key: String(row.rowVersion) + '|' + String(row.lastModified || ''), blocks: [] });
            const sheetId = row.sheetId == null ? null : Number(row.sheetId);
            jobs.get(jobId).blocks.push({ gate: String(row.gate), unitId: String(row.unitId), sheetId: Number.isInteger(sheetId) ? sheetId : null });
            if (Number.isInteger(sheetId)) sheetIds.add(sheetId);
        });
        const sheetOf = await reviewWordsReadSheets(pool, Array.from(sheetIds));
        const piecesOf = new Map();
        const need = [];
        jobs.forEach((job, jobId) => {
            const kept = reviewWordsCache.job(jobId, job.key, now);
            if (kept) piecesOf.set(jobId, kept);
            else need.push(jobId);
        });
        (await reviewWordsReadJobs(pool, need, id => jobs.get(id).key, now)).forEach((pieces, jobId) => piecesOf.set(jobId, pieces));
        const perPiece = reviewWordsPerPiece();
        const rows = [];
        jobs.forEach((job, jobId) => {
            try {
                const blocks = job.blocks.map(b => Object.assign({}, b, { frozen: b.sheetId ? sheetOf.get(b.sheetId) || null : null }));
                const named = reviewWords.namesFor(blocks, piecesOf.get(jobId) || [], perPiece);
                const seen = new Set();
                blocks.forEach(b => (named.get(b.gate + '|' + b.unitId) || []).forEach(pieceId => {
                    if (seen.has(b.gate + '|' + pieceId)) return;
                    seen.add(b.gate + '|' + pieceId);
                    rows.push({ jobId, gate: b.gate, unitId: pieceId });
                }));
            } catch (err) {
                reviewWordsTrouble('job ' + jobId, err);
            }
        });
        reviewWordsCache.prune(new Set(jobs.keys()), sheetIds);
        const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
        return rows.sort((a, b) => order(a.jobId, b.jobId) || order(a.gate, b.gate) || order(a.unitId, b.unitId));
    });
}

// The window's answer for one job, worked out fresh from its words (the sheet
// cache only saves reading a sheet twice): each passed Prepress or Tech
// Services row gains changed, the pieces it names as { id, name, version } in
// the job's order. Reads nothing more when the job has no such block.
async function reviewChangedForJob(pool, jobId, rows, pieceRows) {
    const passed = rows.filter(u => REVIEW_DEPTS.includes(u.gate) && u.disposition === 'passed');
    if (!passed.length) return;
    const sheets = await pool.request().input('jobId', jobId)
        .query(`SELECT gate, unitId, MAX(id) AS sheetId FROM dbo.review_log
                WHERE logAction = N'signoff_snapshot' AND jobId = @jobId AND gate IN (N'prepress', N'techservices')
                GROUP BY gate, unitId`);
    const sheetOf = new Map(sheets.recordset.map(s => [String(s.gate) + '|' + String(s.unitId), Number(s.sheetId)]));
    const blocks = passed.map(u => {
        const sheetId = sheetOf.get(u.gate + '|' + String(u.unitId));
        return { gate: u.gate, unitId: String(u.unitId), sheetId: Number.isInteger(sheetId) ? sheetId : null };
    });
    const frozenOf = await reviewWordsReadSheets(pool, blocks.map(b => b.sheetId).filter(Number.isInteger));
    const words = await pool.request().input('jobId', jobId)
        .query(`SELECT id, instructions_prepress, instructions_techservices,
                       instructionsHistory_prepress, instructionsHistory_techservices
                FROM dbo.components WHERE jobId = @jobId`);
    const currentOf = new Map(words.recordset.map(w => [String(w.id), reviewWords.currentFrom(w)]));
    const pieces = pieceRows.filter(p => currentOf.has(p.id)).map(p => ({ id: p.id, current: currentOf.get(p.id) }));
    blocks.forEach(b => { b.frozen = b.sheetId ? frozenOf.get(b.sheetId) || null : null; });
    const named = reviewWords.namesFor(blocks, pieces, reviewWordsPerPiece());
    const byId = new Map(pieceRows.map(p => [p.id, p]));
    passed.forEach(u => {
        u.changed = (named.get(u.gate + '|' + String(u.unitId)) || [])
            .map(id => byId.get(id)).filter(Boolean)
            .map(p => ({ id: p.id, name: p.name, version: p.version }));
    });
}

// GET /api/jobs/:id/reviews -- every gate row and unit row for one job. A unit
// whose component has since been deleted comes back marked orphaned. Also who
// is asking (viewer), what they may do on each checklist (access), and the
// checklist versions this server enforces (formVersions). The viewer is the
// picked user.
app.get('/api/jobs/:id/reviews', async (req, res) => {
    try {
        if (!(await reviewsAvailable(res))) return;
        const viewer = reviewActor(req, res);
        if (!viewer) return;
        const pool = await getPool();
        const job = await loadReviewJob(pool, req.params.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        // Sorted here, not with ORDER BY: sorting these wide rows made SQL
        // Server keep its lock on every row already read until the query
        // ended, so a GET waiting for one row being written held up writes
        // to the others (independent review Q3).
        const byGate = (a, b) => (a.gate < b.gate ? -1 : a.gate > b.gate ? 1 : a.id - b.id);
        // Read before the rows, so a mark is never newer than the row it is
        // sent with (STALE_FIXED_PLAN.md 3.2).
        const backs = await selectReviewBacks(pool, job.id);
        const units = await pool.request()
            .input('jobId', job.id)
            .query(`SELECT r.*, CASE WHEN r.unitId = N'job' OR c.id IS NOT NULL THEN 0 ELSE 1 END AS orphaned
                    FROM dbo.reviews r
                    LEFT JOIN dbo.components c ON c.id = r.unitId AND c.jobId = r.jobId
                    WHERE r.jobId = @jobId`);
        const gates = await pool.request()
            .input('jobId', job.id)
            .query('SELECT * FROM dbo.review_gates WHERE jobId = @jobId');
        gates.recordset.sort(byGate);
        const rows = units.recordset.sort(byGate).map(u => Object.assign(parseReviewRow(u), { orphaned: !!u.orphaned }));
        rows.forEach(u => withReviewBack(u, backs));

        await resolveRosterPerson(pool, viewer);
        const senders = await selectReviewSenders(pool, job.id, '', rows.filter(u => !u.orphaned));
        // Whether each department checklist is passed right now, and the
        // newest Send to CSR for each. A piece with no review row has to count,
        // so the pieces are read rather than taken from the rows above.
        const pieces = await pool.request().input('jobId', job.id)
            .query('SELECT id, name, version, sortOrder FROM dbo.components WHERE jobId = @jobId');
        const pieceRows = pieces.recordset.map(p => ({
            id: String(p.id), name: p.name == null ? '' : String(p.name),
            version: p.version == null ? '' : String(p.version), sortOrder: Number(p.sortOrder) || 0
        })).sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const pieceIds = pieceRows.map(p => p.id);
        const alive = rows.filter(u => !u.orphaned);
        const passedNow = {};
        REVIEW_DEPTS.forEach(dept => { passedNow[dept] = reviewPassedNow(dept, pieceIds, alive); });
        // Asks are read against every send before the sends from an earlier
        // round are dropped, so a request that a send answered stays answered.
        const signBacks = await selectReviewSignBacks(pool, job.id);
        const handoffs = await selectReviewHandoffs(pool, job.id, passedNow);
        const asks = dropSignedBack(await selectReviewAsks(pool, job.id, handoffs), signBacks);
        dropSignedBack(handoffs, signBacks);
        if (Object.keys(handoffs).length) {
            const firstPasses = await selectFirstPasses(pool, job.id);
            Object.keys(handoffs).forEach(g => { handoffs[g].added = reviewAddedSince(handoffs[g], pieceRows, firstPasses); });
        }
        // The pieces whose words changed after each passed department block
        // (CHANGED_AFTER_PASS_PLAN.md). Contained: a failure names nothing.
        rows.forEach(u => { u.changed = []; });
        try {
            await reviewChangedForJob(pool, job.id, alive, pieceRows);
        } catch (err) {
            rows.forEach(u => { u.changed = []; });
            reviewWordsTrouble('job ' + job.id, err);
        }
        for (const row of rows) await withSentFlags(pool, row);
        const sendNotes = reviewSendNotes(await selectNewestByGate(pool, job.id, 'sent_for_review'), gates.recordset);
        const access = {};
        for (const g of reviewItems.gates) {
            const gateRow = gates.recordset.find(x => x.gate === g.gate) || null;
            const live = rows.filter(u => u.gate === g.gate && !u.orphaned);
            access[g.gate] = reviewAccess(viewer, job, g.gate, gateRow, live,
                await reviewGateOwner(pool, job, g.gate), senders.filter(x => x.gate === g.gate), passedNow[g.gate],
                reviewSentOn(handoffs[g.gate], live));
            // Whoever asked the operator for the files has made their choice:
            // their Send to CSR is off while that ask stands (David, 2026-09-19).
            const ask = asks[g.gate];
            if (ask && stampedBy(viewer, ask.actorName, ask.actorLogin)) access[g.gate].canHandoff = false;
        }
        res.json({
            available: true,
            gates: gates.recordset,
            units: rows,
            viewer: { login: viewer.login, name: viewer.name, source: viewer.source, kinds: viewer.kinds, user: viewer.user },
            access,
            passedNow,
            handoffs,
            asks,
            signBacks,
            sendNotes,
            formVersions: reviewForms
        });
    } catch (err) {
        sendReviewError(res, err);
    }
});

// GET /api/jobs/:id/newjob -- may this person hand this job to Prepress or to
// Tech Services from the work order? Both departments at once, as a plain
// { available, gates: { prepress, techservices } }.
//
// A route of its own on purpose. The button is drawn whenever anybody opens
// any work order, and most of them can never press it; answering from the
// reviews GET would run the heaviest read in the app (every sheet, every
// sender, every sign back in and ask) on a path that has nothing to do with
// the QC Review window. This reads the job, the roster and three small seeks.
app.get('/api/jobs/:id/newjob', async (req, res) => {
    try {
        if (!(await reviewsAvailable(res))) return;
        const viewer = reviewActor(req, res);
        if (!viewer) return;
        const pool = await getPool();
        const job = await loadReviewJob(pool, req.params.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        await resolveRosterPerson(pool, viewer);
        // Asked for every checklist through the one rule, never worked out
        // here: the press's own batch asks the same questions again in SQL.
        const facts = await selectNewJobFacts(pool, job.id);
        const gates = {};
        const takeBack = {};
        REVIEW_DEPTS.forEach(gate => {
            const row = facts.gates[gate] || null;
            const touched = facts.touched.has(gate);
            const sentEver = facts.sentEver.has(gate);
            gates[gate] = reviewCanNewJob(viewer, job, gate, row, touched, sentEver);
            takeBack[gate] = reviewCanTakeBack(viewer, job, gate, row, touched, sentEver);
        });
        res.json({ available: true, gates, takeBack });
    } catch (err) {
        sendReviewError(res, err);
    }
});

// GET /api/reviews/states -- the small version of every active job's reviews,
// without the sheets, for the landing table's QC column. Units whose component
// was deleted are left out.
app.get('/api/reviews/states', async (req, res) => {
    try {
        if (!(await reviewsAvailable(res))) return;
        if (!reviewPicked(req, res)) return;
        const pool = await getPool();
        const units = await pool.request().query(`
            SELECT r.jobId, r.gate, r.unitId, r.disposition, r.hasActivity, r.holder, r.returnCount,
                   r.reviewerName, r.reviewerLogin, r.returnedByName, r.returnedByLogin,
                   r.completedDate, r.lastModified, r.rowVersion,
                   CASE WHEN r.disposition = N'corrections' AND EXISTS (
                        SELECT 1 FROM dbo.review_log l WHERE l.jobId = r.jobId AND l.gate = r.gate AND l.unitId = r.unitId
                          AND l.reviewRound = r.returnCount AND l.logAction = N'signed_back') THEN 1 ELSE 0 END AS fromCsr
            FROM dbo.reviews r
            JOIN dbo.jobs j ON j.id = r.jobId
            WHERE (j.archivedDate IS NULL OR j.archivedDate = N'')
              AND (r.unitId = N'job'
                   OR EXISTS (SELECT 1 FROM dbo.components c WHERE c.id = r.unitId AND c.jobId = r.jobId))`);
        const gates = await pool.request().query(`
            SELECT g.jobId, g.gate, g.sentForReviewByName, g.sentForReviewByLogin, g.sentForReviewDate,
                   g.startedByName, g.startedByLogin, g.startedDate,
                   g.roundNo, g.roundProduction, g.signedBackInByName, g.signedBackInDate,
                   g.newJobByName, g.newJobByLogin, g.newJobDate, g.rowVersion
            FROM dbo.review_gates g
            JOIN dbo.jobs j ON j.id = g.jobId
            WHERE (j.archivedDate IS NULL OR j.archivedDate = N'')`);
        // This round's newest Send to CSR per job and department, so the board
        // can tell files sent since the newest pass (WITH CSR) from files that
        // are not (SEND TO CSR). A send older than a sign back in of that
        // department belongs to the round that ended and is left out, in the
        // history's own order, as the window leaves it out of Outputs
        // (dropSignedBack) and the send's own batch stops counting it: even
        // when the piece she signed back in is then deleted and the rest is
        // still passed, Prepress sends the paths again (the independent
        // review's F7, David 2026-10-13). Every stamp is toISOString, so MAX on
        // the strings is the newest. No inputs, so it is safe on msnodesqlv8.
        const sends = await pool.request().query(`
            SELECT l.jobId, l.gate, MAX(l.whenIso) AS sentToCsrDate
            FROM dbo.review_log l
            JOIN dbo.jobs j ON j.id = l.jobId
            WHERE l.logAction = N'sent_to_csr' AND (j.archivedDate IS NULL OR j.archivedDate = N'')
              AND NOT EXISTS (SELECT 1 FROM dbo.review_log b
                              WHERE b.logAction = N'signed_back_in' AND b.jobId = l.jobId
                                AND b.gate = l.gate AND b.id > l.id)
            GROUP BY l.jobId, l.gate`);
        // The pieces with no review row (nobody has ticked, marked N/A or
        // flagged anything on them; looking writes nothing) that were added
        // after this round's files went to the CSR, for the hover to name ("Buckslip added, not
        // reviewed yet", ADDED_PIECE_PLAN, David 2026-09-24). The files cannot
        // go while any piece on the job is not passed, and rows are never
        // deleted, so a piece with no row at all under this round's send came
        // after it. No row at all, not "nothing ticked": a reopened piece with
        // every line taken off has neither and was there all along. This round
        // is the history's own order, as the window reads it: no sign back in
        // newer than the send. Worked out here from the pieces on the job now,
        // because the job list's copy of them can be older than these rows.
        // The gate names are the checklist file's own. No inputs, so it is
        // safe on msnodesqlv8.
        const pieceGates = reviewItems.gates.filter(g => g.perPiece && REVIEW_DEPTS.includes(g.gate) && /^[a-z]+$/.test(g.gate));
        const unreviewed = pieceGates.length ? await pool.request().query(pieceGates.map(g => `
            SELECT c.jobId, N'${g.gate}' AS gate, c.id AS unitId
            FROM dbo.components c
            JOIN dbo.jobs j ON j.id = c.jobId
            WHERE (j.archivedDate IS NULL OR j.archivedDate = N'')
              AND NOT EXISTS (SELECT 1 FROM dbo.reviews r
                              WHERE r.jobId = c.jobId AND r.gate = N'${g.gate}' AND r.unitId = c.id)
              AND EXISTS (SELECT 1 FROM dbo.review_log s
                          WHERE s.logAction = N'sent_to_csr' AND s.jobId = c.jobId AND s.gate = N'${g.gate}'
                            AND NOT EXISTS (SELECT 1 FROM dbo.review_log b
                                            WHERE b.logAction = N'signed_back_in' AND b.jobId = s.jobId
                                              AND b.gate = s.gate AND b.id > s.id))`).join('\n            UNION ALL')) : { recordset: [] };
        // The pieces whose words changed after a passed Prepress or Tech
        // Services block, for the hover to name (CHANGED_AFTER_PASS_PLAN.md).
        // Contained: a failure here leaves the rest of the reply as it was.
        let changed = [];
        try {
            changed = await reviewChangedForList(pool);
        } catch (err) {
            reviewWordsTrouble('the job list', err);
        }
        res.json({
            available: true,
            units: units.recordset.map(u => Object.assign(u, { hasActivity: !!u.hasActivity, fromCsr: !!u.fromCsr })),
            gates: gates.recordset.map(g => Object.assign(g, { roundProduction: !!g.roundProduction })),
            sends: sends.recordset,
            unreviewed: unreviewed.recordset,
            changed
        });
    } catch (err) {
        sendReviewError(res, err);
    }
});

// PUT /api/jobs/:id/reviews/:gate/:unitId -- autosave one sheet.
// Body: { rowVersion, items, itemValues, flags, na, unitFacts, formVersion }.
// rowVersion 0 creates the sheet.
// Reply: { review, started } where started says this save recorded who started
// the checklist.
app.put('/api/jobs/:id/reviews/:gate/:unitId', (req, res) => writeReviewUnit(req, res, 'save'));

// POST /api/jobs/:id/reviews/:gate/:unitId/disposition -- one unit's loop.
//   pass         the PUT body plus action
//   corrections  the PUT body plus action; department checklists only
//   signback     the PUT body plus action, note, production, units and (when
//                anything is flagged) flagDepts, itemId -> ['prepress'] /
//                ['techservices'] / both. CSR checklist only.
//   reopen       { action, rowVersion }
app.post('/api/jobs/:id/reviews/:gate/:unitId/disposition', (req, res) => {
    const action = req.body && req.body.action;
    if (!['pass', 'corrections', 'signback', 'reopen'].includes(action)) {
        return res.status(400).json({ error: "action must be 'pass', 'corrections', 'signback' or 'reopen'" });
    }
    writeReviewUnit(req, res, action);
});

// POST /api/jobs/:id/reviews/:gate/action -- a step for the whole checklist.
//   send     Send for review, once a round; whoever sends it is the operator  { action, rowVersion, note }
//   start    first person to start is the reviewer                         { action, rowVersion }
//   reready  fixes done: the pieces the window named go to the reviewers  { action, units, seen, note }
//            seen is each named piece's hand-back mark as the window opened
//            with it; a piece handed back since stays (STALE_FIXED_PLAN.md)
// note is optional on send and reready: what the operator typed for the
// reviewer (OPERATOR_NOTE_PLAN), kept as the press's history row detail.
//   newjob   the CSR hands a brand new job to this department              { action, note }
// send, reready and newjob are for the department checklists only. rowVersion
// is the gate row's (0 when there is none yet); only start compares it.
app.post('/api/jobs/:id/reviews/:gate/action', async (req, res) => {
    try {
        const action = req.body && req.body.action;
        if (!['send', 'start', 'reready', 'handoff', 'askhandoff', 'newjob', 'takeback'].includes(action)) {
            return res.status(400).json({ error: "action must be 'send', 'start', 'reready', 'handoff', 'askhandoff', 'newjob' or 'takeback'" });
        }
        const ctx = await reviewWriteContext(req, res);
        if (!ctx) return;
        const { pool, gate, actor, job, now, state, access } = ctx;
        const label = reviewGateLabel(gate);
        if (gate === 'csr' && action !== 'start') {
            throw reviewError(400, action === 'send' ? 'The CSR checklist is not sent for review.'
                : (action === 'handoff' || action === 'askhandoff') ? 'Only Prepress and Tech Services send outputs to the CSR.'
                : action === 'newjob' ? 'A new job is sent to Prepress or to Tech Services.'
                : action === 'takeback' ? 'A new job is sent to Prepress or to Tech Services.'
                : 'On the CSR checklist each department presses Fixed instead.');
        }
        // Send to CSR before the canEdit refusal and before the rowVersion
        // read: it carries paths, not a version, and anyone on that
        // department's list may press it, reviewer or not.
        if (action === 'handoff') return await reviewHandoff(req, res, ctx);
        if (action === 'askhandoff') return await reviewAskHandoff(req, res, ctx);
        // The same: it carries her line, not a version, and only a CSR presses it.
        if (action === 'newjob') return await reviewNewJob(req, res, ctx);
        // And the same again: it carries nothing at all, and takes back the press above.
        if (action === 'takeback') return await reviewTakeBack(req, res, ctx);
        const deptPerson = access.role === 'operator' || access.role === 'dept';
        // What the operator typed for the reviewer on Send for review (the
        // Fixed note is read in its own branch below).
        let sendNote = '';
        const request = pool.request();
        request.input('jobId', job.id);
        request.input('gate', gate);
        request.input('now', now);
        request.input('actorName', actor.name);
        request.input('actorLogin', actor.login);
        request.input('actorSource', actor.source);

        if (action === 'reready') {
            // The operator, or anyone in the department except whoever sent a
            // piece back that is still waiting (PHASE4_PLAN section l, question
            // 9) and whoever is reviewing the round (David, 2026-09-19).
            if (!deptPerson) {
                return reviewLocked(res, access.role === 'unlinked' ? access.reason : 'Only the operator or ' + label + ' can press Fixed, ready for re-review.');
            }
            if (!access.canReready && state.units.some(u => u.disposition === 'corrections' && u.holder === 'operator')) {
                const sentBack = state.units.some(u => u.disposition === 'corrections' && u.holder === 'operator' &&
                    sentBackThisRound(actor, u, state.senders));
                return reviewLocked(res, sentBack ? 'You sent this back, so someone else presses Fixed, ready for re-review.'
                    : 'You are reviewing this, so the operator presses Fixed, ready for re-review.');
            }
            // Only the pieces the window's box named, each with the hand-back
            // mark the window opened with: a piece sent back again, or signed
            // back in, since then stays with the operator, who has not seen it
            // (STALE_FIXED_PLAN.md, David 2026-10-11). Both are required: no
            // window sends Fixed without them.
            const body = req.body || {};
            if (!Array.isArray(body.units) || !isPlainObject(body.seen)) {
                throw reviewError(400, 'Reload the page, then press Fixed again.');
            }
            const named = [...new Set(body.units.map(String).filter(u => u && u.length <= 36))].slice(0, REVIEW_LIMIT.itemIds);
            const note = reviewSendNote(body);
            request.input('rrNote', note);
            request.input('jobNumber', job.jobNumber || '');
            request.input('wholeJobName', reviewJobUnitName(gate));
            named.forEach((u, i) => {
                const seen = body.seen[u];
                request.input('rrUnit' + i, u);
                request.input('rrSeen' + i, sql.Int, Number.isInteger(seen) && seen >= 0 && seen <= 2147483647 ? seen : null);
            });
            const wantSql = named.length
                ? 'INSERT INTO @want (unitId, seen) ' + named.map((u, i) => 'SELECT @rrUnit' + i + ', @rrSeen' + i).join(' UNION ALL ') + ';'
                : '';
            const blockName = `CASE WHEN r.unitId = N'job' THEN @wholeJobName
                            ELSE LTRIM(RTRIM(ISNULL(c.version, N'') + N' ' + ISNULL(c.name, N''))) END`;
            // The checklist's sheet rows are locked first. MAX(rowVersion)
            // reads a column the unique index does not hold, so SQL Server
            // locks the rows themselves: the lock then waits for a Corrections
            // needed already writing (it updates through the primary key),
            // which the COUNT(*) form answered from the index alone did not
            // (the plan review). The index hint keeps it a seek on this job and
            // checklist: on a small table SQL Server would scan the whole table
            // instead and hold every job's rows (the build review). Every
            // hand-back writes its sheet row and its history row in one
            // transaction, so the marks read after this lock are complete.
            // Typed variables, as the other locks (msnodesqlv8).
            // The job asked again first (F6). A piece deleted meanwhile is
            // already left out below, as it always was.
            const guard = reviewJobGuardSql();
            const result = await request.query(`
                SET XACT_ABORT ON;
                DECLARE @rrJobId NVARCHAR(36);
                DECLARE @rrGate NVARCHAR(20);
                DECLARE @held INT;
                DECLARE @want TABLE (unitId NVARCHAR(36) PRIMARY KEY, seen INT NULL);
                DECLARE @marks TABLE (unitId NVARCHAR(36) PRIMARY KEY, mark INT NOT NULL);
                DECLARE @changed TABLE (id INT, unitId NVARCHAR(36), returnCount INT);
                ${guard.declare}
                BEGIN TRAN;
                ${guard.test}
                SET @rrJobId = @jobId;
                SET @rrGate = @gate;
                SELECT @held = MAX(rowVersion) FROM dbo.reviews WITH (UPDLOCK, HOLDLOCK, INDEX(UQ_reviews_job_gate_unit)) WHERE jobId = @rrJobId AND gate = @rrGate;
                ${wantSql}
                INSERT INTO @marks (unitId, mark)
                SELECT w.unitId, ISNULL((SELECT MAX(l.id) FROM dbo.review_log l
                    WHERE l.logAction IN (N'sent_back', N'signed_back') AND l.jobId = @rrJobId AND l.gate = @rrGate
                      AND l.unitId = w.unitId), 0)
                FROM @want w;
                UPDATE r SET
                    holder = N'reviewer',
                    lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
                    rowVersion = r.rowVersion + 1
                OUTPUT INSERTED.id, INSERTED.unitId, INSERTED.returnCount INTO @changed
                FROM dbo.reviews r
                JOIN @want w ON w.unitId = r.unitId
                JOIN @marks m ON m.unitId = r.unitId
                WHERE r.jobId = @rrJobId AND r.gate = @rrGate AND r.disposition = N'corrections' AND r.holder = N'operator'
                  AND m.mark = ISNULL(w.seen, -1)
                  AND (r.unitId = N'job' OR EXISTS (SELECT 1 FROM dbo.components c WHERE c.id = r.unitId AND c.jobId = @rrJobId));
                INSERT INTO dbo.review_log (jobId, jobNumber, gate, unitId, unitName, itemId, itemLabel,
                    reviewRound, logAction, detail, actorName, actorLogin, actorSource,
                    recipientName, recipientAddress, whenIso)
                SELECT @jobId, @jobNumber, @gate, ch.unitId,
                       CASE WHEN ch.unitId = N'job' THEN @wholeJobName ELSE ISNULL(c.name, N'') END,
                       N'', N'', ch.returnCount, N'ready_for_rereview', @rrNote,
                       @actorName, @actorLogin, @actorSource, N'', N'', @now
                FROM @changed ch
                LEFT JOIN dbo.components c ON c.id = ch.unitId AND c.jobId = @rrJobId;
                -- What moved, and what stayed: named, still with the operator,
                -- still on the job, with the hand-back that kept it.
                SELECT N'moved' AS kind, ch.unitId, ch.returnCount, ${blockName.replace(/r\.unitId/g, 'ch.unitId')} AS blockName,
                       ISNULL(c.name, N'') AS pieceName, 0 AS mark, N'' AS backAction, N'' AS backName, N'' AS backLogin
                FROM @changed ch
                LEFT JOIN dbo.components c ON c.id = ch.unitId AND c.jobId = @rrJobId
                UNION ALL
                SELECT N'stayed', r.unitId, r.returnCount, ${blockName}, ISNULL(c.name, N''), m.mark,
                       ISNULL(l.logAction, N''), ISNULL(l.actorName, N''), ISNULL(l.actorLogin, N'')
                FROM dbo.reviews r
                JOIN @marks m ON m.unitId = r.unitId
                LEFT JOIN dbo.review_log l ON l.id = m.mark
                LEFT JOIN dbo.components c ON c.id = r.unitId AND c.jobId = @rrJobId
                WHERE r.jobId = @rrJobId AND r.gate = @rrGate AND r.disposition = N'corrections' AND r.holder = N'operator'
                  AND (r.unitId = N'job' OR c.id IS NOT NULL);
                COMMIT TRAN;`);
            // One row per piece that moved, so email 3 can go to whoever sent
            // each one back, and one per piece that stayed. The window names
            // both: what went above its red line, what stayed in it. Only what
            // moved is counted, recorded and emailed.
            const rows = lastRecordset(result);
            const gone = reviewJobRefusal(rows[0]);
            if (gone) throw gone;
            const moved = rows.filter(r => r.kind === 'moved');
            const stayed = rows.filter(r => r.kind === 'stayed').map(r => ({
                unitId: String(r.unitId), name: String(r.blockName || ''), mark: Number(r.mark) || 0,
                by: { action: String(r.backAction || ''), name: r.backName || '', login: r.backLogin || '' }
            }));
            if (!moved.length) {
                if (stayed.length) {
                    return res.status(409).json({ error: 'Not sent: something new came in on it after you opened this window. Press Fixed again.', stayed });
                }
                return res.status(409).json({ error: 'Nothing on this gate is waiting for re-review.' });
            }
            trackUser(actor.login || actor.name, 'reviewing');
            const emails = await mailEmails(pool, { jobId: job.id, jobNumber: job.jobNumber, gate, actor }, async () => {
                const blocks = [];
                for (const row of moved) {
                    const movedId = String(row.unitId);
                    const stored = state.units.find(u => String(u.unitId) === movedId) || null;
                    blocks.push({
                        unitId: movedId,
                        round: Number(row.returnCount) || 0,
                        name: String(row.blockName || '') || reviewJobUnitName(gate),
                        logName: movedId === 'job' ? reviewJobUnitName(gate) : String(row.pieceName || ''),
                        // What went back in this round, as the window's return
                        // box lists it: a line the reviewer has ticked off since
                        // still went, and is still to be re-checked.
                        items: stored ? mailItems(gate, movedId, await reviewSentFlags(pool, stored)) : [],
                        fromCsr: !!(stored && await reviewSignedBack(pool, stored))
                    });
                }
                return mailRereview(pool, job, gate, actor, state, blocks, now, note);
            });
            res.json({ units: moved.length, moved: moved.map(r => String(r.unitId)), stayed, emails });
            return;
        }

        if (action === 'send') {
            // Someone in the department (the operator included) sends it once,
            // at the start of the round: nobody can start before it is sent.
            // A covering CSR does not.
            if (!deptPerson) {
                return reviewLocked(res, access.role === 'unlinked' ? access.reason : 'Only ' + label + ' can send this for review.');
            }
            const sentRow = state.gateRow;
            if (sentRow && (sentRow.sentForReviewByLogin || sentRow.sentForReviewByName)) {
                return res.status(409).json({ error: 'This was already sent for review.', gate: sentRow });
            }
            const pieceRows = await pool.request().input('jobId', job.id).query('SELECT id FROM dbo.components WHERE jobId = @jobId');
            if (reviewPassedNow(gate, pieceRows.recordset.map(p => String(p.id)), state.units)) {
                return res.status(409).json({ error: REVIEW_NOTHING_TO_SEND });
            }
            sendNote = reviewSendNote(req.body);
        } else if (!access.canEdit) {
            return reviewLocked(res, access.reason);
        }

        const expected = expectedRowVersion(req.body);
        const stored = await selectReviewGate(pool, job.id, gate);
        // Starting is claimed once. A repeat by the same person (a double click,
        // a lost response) gets the gate as it is, whatever version it sent;
        // anyone else is refused.
        if (action === 'start' && stored && (stored.startedByLogin || stored.startedByName)) {
            if (!stampedBy(actor, stored.startedByName, stored.startedByLogin)) {
                return res.status(409).json({ error: 'Someone else already started this review.', gate: stored });
            }
            return res.json({ gate: stored });
        }
        // Send for review is not version checked: the gate row changes for
        // other reasons (a sign back in, a start claim on an older row), and
        // the SQL below sends only if nobody has, which is the test that
        // matters (independent review Q1).
        if (action === 'start' && (stored ? stored.rowVersion !== expected : expected !== 0)) {
            return res.status(409).json({ error: 'This review was changed by someone else.', gate: stored });
        }

        let setSql;
        let logAction;
        if (action === 'send') {
            setSql = { sentForReviewByName: '@actorName', sentForReviewByLogin: '@actorLogin', sentForReviewDate: '@now' };
            logAction = 'sent_for_review';
        } else {
            setSql = { startedByName: '@actorName', startedByLogin: '@actorLogin', startedDate: '@now' };
            logAction = 'started';
        }

        request.input('expectedVersion', expected);
        const logSql = reviewLogInsertSql(request, {
            jobId: job.id, jobNumber: job.jobNumber, gate, unitId: '', unitName: '', reviewRound: 0, actor, now
        }, [{ logAction, detail: sendNote }]);
        const columns = Object.keys(setSql);
        // Send: the gate row (or where it would go) is locked first, with the
        // job id and gate in variables of the columns' own types, as the
        // starter claim in writeReviewUnit does and for the same reasons.
        // Send: "every block has passed" is asked again here, under the job's
        // lock, where no piece can come or go and no block be passed (F6): a
        // piece deleted after the test above could leave nothing to review.
        // Every block of the checklist: each piece now on the job plus Whole
        // Job on Prepress, the one checklist on Tech Services, as
        // reviewPassedNow counts them.
        const sendBlocksSql = reviewGate(gate).perPiece
            ? "SELECT c.id AS unitId FROM dbo.components c WHERE c.jobId = @sendJobId UNION ALL SELECT N'job' AS unitId"
            : "SELECT N'job' AS unitId";
        const writeSql = action === 'send' ? `
            SET @sendJobId = @jobId;
            SET @sendGate = @gate;
            SELECT @gateRows = COUNT(*) FROM dbo.review_gates WITH (UPDLOCK, HOLDLOCK)
            WHERE jobId = @sendJobId AND gate = @sendGate;
            IF NOT EXISTS (SELECT 1 FROM (${sendBlocksSql}) AS b
                           LEFT JOIN dbo.reviews r ON r.jobId = @sendJobId AND r.gate = @sendGate AND r.unitId = b.unitId
                           WHERE r.id IS NULL OR r.disposition <> N'passed')
            BEGIN
                ROLLBACK TRAN;
                SELECT CAST(0 AS BIT) AS ok, N'passed' AS why;
                RETURN;
            END
            UPDATE dbo.review_gates SET
                ${columns.map(c => c + ' = ' + setSql[c]).join(', ')},
                lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
                rowVersion = rowVersion + 1
            OUTPUT INSERTED.id INTO @changed
            WHERE jobId = @sendJobId AND gate = @sendGate AND sentForReviewByLogin = N'' AND sentForReviewByName = N'';
            IF @gateRows = 0
                INSERT INTO dbo.review_gates (jobId, gate, ${columns.join(', ')},
                    rowVersion, lastModified, lastModifiedByName, lastModifiedByLogin)
                OUTPUT INSERTED.id INTO @changed
                VALUES (@jobId, @gate, ${columns.map(c => setSql[c]).join(', ')}, 1, @now, @actorName, @actorLogin);`
            : stored ? `
            UPDATE dbo.review_gates SET
                ${columns.map(c => c + ' = ' + setSql[c]).join(', ')},
                lastModified = @now, lastModifiedByName = @actorName, lastModifiedByLogin = @actorLogin,
                rowVersion = rowVersion + 1
            OUTPUT INSERTED.id INTO @changed
            WHERE jobId = @jobId AND gate = @gate AND rowVersion = @expectedVersion;`
            : `
            INSERT INTO dbo.review_gates (jobId, gate, ${columns.join(', ')},
                rowVersion, lastModified, lastModifiedByName, lastModifiedByLogin)
            OUTPUT INSERTED.id INTO @changed
            VALUES (@jobId, @gate, ${columns.map(c => setSql[c]).join(', ')}, 1, @now, @actorName, @actorLogin);`;

        // The job asked again first (F6), before the gate row's lock.
        const guard = reviewJobGuardSql();
        let result;
        try {
            result = await request.query(`
                SET XACT_ABORT ON;
                DECLARE @changed TABLE (id INT);
                DECLARE @gateRows INT;
                DECLARE @sendJobId NVARCHAR(36);
                DECLARE @sendGate NVARCHAR(20);
                ${guard.declare}
                BEGIN TRAN;
                ${guard.test}
                ${writeSql}
                IF NOT EXISTS (SELECT 1 FROM @changed)
                BEGIN
                    ROLLBACK TRAN;
                    SELECT CAST(0 AS BIT) AS ok;
                    RETURN;
                END
                ${logSql}
                SELECT CAST(1 AS BIT) AS ok, g.* FROM dbo.review_gates g WHERE g.id = (SELECT TOP 1 id FROM @changed);
                COMMIT TRAN;`);
        } catch (err) {
            if (sqlErrorNumbers(err).some(n => n === 2627 || n === 2601)) {
                const current = await selectReviewGate(pool, job.id, gate);
                return res.status(409).json({ error: 'This review was changed by someone else.', gate: current });
            }
            throw err;
        }
        const saved = lastRecordset(result)[0];
        const gone = reviewJobRefusal(saved);
        if (gone) throw gone;
        if (saved && saved.why === 'passed') {
            return res.status(409).json({ error: REVIEW_NOTHING_TO_SEND });
        }
        if (!saved || !saved.ok) {
            const current = await selectReviewGate(pool, job.id, gate);
            return res.status(409).json({ error: action === 'send' ? 'This was already sent for review.' : 'This review was changed by someone else.', gate: current });
        }
        delete saved.ok;
        trackUser(actor.login || actor.name, 'reviewing');
        // Send for review: the email to the rest of the department, built
        // before the reply. The start claim emails nobody (the "review taken"
        // heads-up went with the Outlook change, David 2026-10-26).
        const emails = action === 'send'
            ? await mailEmails(pool, { jobId: job.id, jobNumber: job.jobNumber, gate, actor }, () => mailSendForReview(pool, job, gate, actor, now, sendNote))
            : [];
        res.json({ gate: saved, emails });
    } catch (err) {
        sendReviewError(res, err);
    }
});

// GET /api/jobs/:id/review-log -- the history for one job, newest first.
// Optional ?gate=csr|prepress|techservices. Still answers after the job is
// deleted: the history outlives it.
// The page says which email it handed to Outlook (OUTLOOK_EMAIL_PLAN, David's
// answer 1): the history row "Email opened in Outlook for Sue Foster and Don
// Marcotte." is written here, once the page has it, never when the server
// hands the email over, so a page closed before the reply writes nothing,
// which is the truth. record is what mailBuild gave the page, sent back as it
// was; names are the roster names in To. Nothing else is read or changed.
app.post('/api/jobs/:id/reviews/:gate/email-opened', async (req, res) => {
    try {
        if (!(await reviewsAvailable(res))) return;
        const actor = reviewActor(req, res);
        if (!actor) return;
        const gate = req.params.gate;
        if (!reviewGate(gate)) return res.status(400).json({ error: 'Unknown review gate' });
        const b = isPlainObject(req.body) ? req.body : {};
        const names = (Array.isArray(b.names) ? b.names : [])
            .map(n => String(n == null ? '' : n).replace(/[\r\n\t]+/g, ' ').trim().slice(0, REVIEW_LIMIT.name))
            .filter(Boolean).slice(0, 50);
        if (!names.length) return res.status(400).json({ error: 'names is required' });
        const record = isPlainObject(b.record) ? b.record : {};
        const unitId = String(record.unitId == null ? '' : record.unitId).slice(0, 36);
        const unitName = String(record.unitName == null ? '' : record.unitName).slice(0, 200);
        const reviewRound = Number.isInteger(record.reviewRound) && record.reviewRound >= 0 ? record.reviewRound : 0;
        const pool = await getPool();
        const job = await loadReviewJob(pool, req.params.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        await resolveRosterPerson(pool, actor);
        await mailLogRow(pool, { jobId: job.id, jobNumber: job.jobNumber, gate, unitId, unitName, reviewRound, actor }, 'email_opened', {
            recipientName: names.join(', ').slice(0, 100),
            detail: 'Email opened in Outlook for ' + reviewMail.joinAnd(names) + '.'
        });
        res.json({ recorded: true });
    } catch (err) {
        sendReviewError(res, err);
    }
});

app.get('/api/jobs/:id/review-log', async (req, res) => {
    try {
        if (!(await reviewsAvailable(res))) return;
        if (!reviewPicked(req, res)) return;
        const gate = req.query.gate;
        if (gate !== undefined && !reviewGate(gate)) {
            return res.status(400).json({ error: 'Unknown review gate' });
        }
        // One signed sheet, asked for by its row id. A frozen sheet carries the
        // work order it was signed against, so it is fetched one at a time
        // rather than with the list: the window reloads the list when it opens,
        // on every refresh and again after every sign-off, and shipping every
        // frozen sheet each time would send the same instructions over and over
        // for a list that then throws them away.
        const wanted = req.query.snapshot;
        if (wanted !== undefined) {
            if (!/^[0-9]{1,18}$/.test(String(wanted))) {
                return res.status(400).json({ error: 'Unknown sheet' });
            }
            const one = await (await getPool()).request()
                .input('jobId', req.params.id)
                .input('logId', Number(wanted))
                .query(`SELECT id, jobId, jobNumber, gate, unitId, unitName, reviewRound,
                               logAction, detail, actorName, actorLogin, actorSource, whenIso
                        FROM dbo.review_log
                        WHERE jobId = @jobId AND id = @logId AND logAction = N'signoff_snapshot'`);
            if (!one.recordset.length) return res.status(404).json({ error: 'Unknown sheet' });
            return res.json({ available: true, entry: one.recordset[0] });
        }
        // Every line checked off or unchecked is recorded, and none of it is
        // sent here (David, 2026-09-23): kept for an audit, out of the activity
        // list and out of what the window loads on every open and refresh.
        const pool = await getPool();
        const request = pool.request().input('jobId', req.params.id);
        if (gate) request.input('gate', gate);
        const result = await request.query(`
            SELECT id, jobId, jobNumber, gate, unitId, unitName, itemId, itemLabel, reviewRound,
                   logAction,
                   CASE WHEN logAction = N'signoff_snapshot' THEN N'' ELSE detail END AS detail,
                   actorName, actorLogin, actorSource, recipientName, recipientAddress, whenIso
            FROM dbo.review_log
            WHERE jobId = @jobId${gate ? ' AND gate = @gate' : ''}
                AND logAction NOT IN (N'ticked', N'unticked')
            ORDER BY id DESC`);
        res.json({ available: true, entries: result.recordset });
    } catch (err) {
        sendReviewError(res, err);
    }
});

// ── A deleted job's QC record (item 7, DELETED_QC_PLAN.md) ──
//
// Deleting a job leaves its QC records on purpose (no foreign keys to jobs).
// The delete adds one history row, job_deleted: who, when, and what the job
// was, since the job row and its pieces go and only a signed sheet would
// otherwise name the client (David, 2026-09-29). The job list's Deleted jobs
// panel lists the jobs from those rows, and the QC Review window shows a
// deleted job's history and signed sheets read only.

// Who is deleting: the user the page shows (X-STS-User), who pressed Delete in
// that page, else the picked user, else nobody. `picked` when the two agree
// or only the cookie names someone; `page` when only the page does or it
// names someone other than the cookie (another tab picked a new name). Named
// as the roster names them when linked, else as the user list spells the
// user, so the line always reads as a name. A roster that cannot be read does
// not stop a delete: the user list's name is used.
async function deleteActor(pool, req) {
    const shown = headerUser(req);
    const user = shown || (req.appUser ? req.appUser.user : '');
    const login = loginKey(user);
    const person = { login, name: '', kinds: [] };
    if (login) {
        try { await resolveRosterPerson(pool, person); } catch (e) { person.name = ''; }
    }
    const name = person.name || (user ? displayName(user) || user : '');
    const picked = !!req.appUser && req.appUser.key === login;
    return {
        name: String(name).slice(0, REVIEW_LIMIT.name),
        login: String(login || '').slice(0, REVIEW_LIMIT.name),
        source: !login ? '' : picked ? 'picked' : 'page'
    };
}

// The delete, with the row, as one batch. The job goes first, and the row is
// written only by the batch that took it (OUTPUT INTO), from the number it
// took, and only when the job has any QC record: so a job already gone writes
// nothing and two deletes at once write one row, whatever the database's
// isolation. When the batch fails the delete fails with it: the record and
// the delete are one fact. Answers false, having answered 423, when the lock
// was taken while the reads below ran.
async function deleteJobWithQcRecord(jobId, req, res) {
    const pool = await getPool();
    const found = await pool.request().input('id', jobId)
        .query('SELECT clientName, jobDescription, csrName FROM dbo.jobs WHERE id = @id');
    const job = found.recordset[0];
    const pieces = job ? (await pool.request().input('id', jobId)
        .query('SELECT name, version FROM dbo.components WHERE jobId = @id ORDER BY sortOrder, id')).recordset : [];
    const actor = await deleteActor(pool, req);
    const text = v => (v == null ? '' : String(v));
    const detail = JSON.stringify({
        clientName: text(job && job.clientName),
        jobDescription: text(job && job.jobDescription),
        csrName: text(job && job.csrName),
        pieces: pieces.map(p => ({ name: text(p.name), version: text(p.version) }))
    });
    // The reads above took time: the lock is asked again, with nothing
    // between this and the batch going out.
    if (!lockGate(req, res, jobId)) return false;
    try {
        await pool.request()
            .input('jobId', jobId)
            .input('detail', detail)
            .input('actorName', actor.name)
            .input('actorLogin', actor.login)
            .input('actorSource', actor.source)
            .input('when', new Date().toISOString())
            .query(`
                SET XACT_ABORT ON;
                DECLARE @jid NVARCHAR(36);
                SET @jid = @jobId;
                DECLARE @gone TABLE (jobNumber NVARCHAR(50));
                DECLARE @hasQc BIT;
                SET @hasQc = 0;
                BEGIN TRAN;
                DELETE FROM dbo.jobs OUTPUT DELETED.jobNumber INTO @gone WHERE id = @jid;
                -- Read after the delete, under its lock on the job's row: every
                -- QC write takes that row first (reviewJobGuardSql, F6), so a
                -- QC write either committed before this delete and is seen
                -- here, or waits and is then refused because the job is gone.
                -- Read before the delete, a job's first QC write could commit
                -- in between and leave a record that Deleted jobs never lists.
                -- No deadlock: no QC write holds a QC row without that lock.
                IF EXISTS (SELECT 1 FROM dbo.review_log WHERE jobId = @jid)
                   OR EXISTS (SELECT 1 FROM dbo.reviews WHERE jobId = @jid)
                   OR EXISTS (SELECT 1 FROM dbo.review_gates WHERE jobId = @jid)
                    SET @hasQc = 1;
                IF @hasQc = 1 AND EXISTS (SELECT 1 FROM @gone)
                    INSERT INTO dbo.review_log (jobId, jobNumber, gate, unitId, unitName, itemId, itemLabel,
                        reviewRound, logAction, detail, actorName, actorLogin, actorSource,
                        recipientName, recipientAddress, whenIso)
                    SELECT @jid, g.jobNumber, N'', N'', N'', N'', N'', 0, N'job_deleted', @detail,
                        @actorName, @actorLogin, @actorSource, N'', N'', @when
                    FROM @gone g;
                COMMIT TRAN;`);
    } catch (err) {
        console.error('JOB DELETE FAILED (QC record) job ' + jobId + ': ' + err.message);
        // A permission error, or one that lost its number: the tables and
        // permissions are checked again at once, so when the history cannot
        // be written the next delete goes through as a plain one. Checked, not
        // assumed: the error may have come from the delete on jobs itself.
        const numbers = sqlErrorNumbers(err);
        if (numbers.includes(229) || numbers.includes(230) || !numbers.length) {
            _reviewsCheckedAt = 0;
            checkReviewTables();
        }
        throw err;
    }
    return true;
}

// GET /api/reviews/deleted?q=&offset=&limit= -- the deleted jobs that left a
// QC record, newest delete first, for the Deleted jobs panel. Only jobs whose
// delete wrote its row are listed (every delete from this build on); a job
// put back since (an import of its export keeps its id) is not. One SELECT
// with no inputs, on IX_review_log_action, so it is safe on msnodesqlv8; the
// search and the page are worked out here, because the job list asks on
// every Home and a local database gains thousands of these from the checks.
// The search matches what a row shows: the job number, client and project.
app.get('/api/reviews/deleted', async (req, res) => {
    try {
        if (!(await reviewsAvailable(res))) return;
        if (!reviewPicked(req, res)) return;
        const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
        const whole = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : NaN; };
        const offset = Math.max(0, whole(req.query.offset) || 0);
        const limit = Math.min(50, Math.max(1, whole(req.query.limit) || 10));
        const result = await (await getPool()).request().query(`
            SELECT d.id, d.jobId, d.jobNumber, d.detail, d.actorName, d.actorLogin, d.whenIso
            FROM dbo.review_log d
            WHERE d.logAction = N'job_deleted'
              AND NOT EXISTS (SELECT 1 FROM dbo.jobs j WHERE j.id = d.jobId)
              AND NOT EXISTS (SELECT 1 FROM dbo.review_log n
                              WHERE n.logAction = N'job_deleted' AND n.jobId = d.jobId AND n.id > d.id)`);
        const text = v => (v == null ? '' : String(v));
        const all = result.recordset.map(row => {
            let d = {};
            try { d = JSON.parse(text(row.detail) || '{}') || {}; } catch (e) { d = {}; }
            return {
                id: row.id,
                jobId: text(row.jobId),
                jobNumber: text(row.jobNumber),
                clientName: text(d.clientName),
                jobDescription: text(d.jobDescription),
                deletedAt: text(row.whenIso),
                deletedBy: text(row.actorName || row.actorLogin)
            };
        }).sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : b.id - a.id));
        const matching = q
            ? all.filter(j => (j.jobNumber + ' ' + j.clientName + ' ' + j.jobDescription).toLowerCase().includes(q))
            : all;
        res.json({
            available: true,
            total: all.length,
            matching: matching.length,
            offset,
            limit,
            jobs: matching.slice(offset, offset + limit).map(j => { const o = Object.assign({}, j); delete o.id; return o; })
        });
    } catch (err) {
        sendReviewError(res, err);
    }
});

// ── Active Users (in-memory) ──
// Tracks the last time each user made a write or heartbeat request.
// Joe can check GET /api/active-users before rebooting the server.

const activeUsers = new Map(); // username -> { lastSeen (ms), action }
const ACTIVE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function trackUser(username, action) {
    if (!username) return;
    activeUsers.set(username.toLowerCase(), { lastSeen: Date.now(), action });
}

app.get('/api/active-users', (req, res) => {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    const users = [];
    for (const [name, info] of activeUsers) {
        if (info.lastSeen >= cutoff) {
            const ago = Math.round((Date.now() - info.lastSeen) / 1000);
            users.push({ user: name, lastAction: info.action, secondsAgo: ago });
        }
    }
    users.sort((a, b) => a.secondsAgo - b.secondsAgo);
    res.json({ activeInLast10Min: users.length, users });
});

// ── The edit lock: a gate, not a warning (EDIT_LOCK_PLAN.md, 2026-09-28) ──
//
// One job is held by one person at a time, by name, so one person's tabs and
// browsers are one holder and can never lock her out of her own job. A page
// that opens a job somebody else holds gets the read-only view; every change
// to a job from anyone but its holder is refused here with 423, so a page
// opened before the lock was taken, a page that slept, and a stale page cannot
// write either (David, 2026-09-28: "the refusal has to be on the server as well
// as on the page"). Nothing about the QC Review routes changes: the window
// takes no lock on purpose.
//
// The lock is still this process's memory. Each entry is one person with the
// pages (tabs) she holds it from, each with the time it was last seen: a page
// lets go of its own hold only (Home, the idle release, closing the tab), and
// the entry goes when no page has been seen within the timeout. So Home in one
// tab never uncovers the tab she is typing in, and a late release from a page
// that reloaded removes only its own id. A heartbeat takes a free lock and
// says whether it refreshed or took ("took" tells the page its hold had
// lapsed, so its copy may be stale); it refuses to take a job that is archived
// or gone. A write from a page that believes it holds the job puts the entry
// back after a restart. A takeover moves the entry at once; the old holder's
// next heartbeat or write tells her page. The numbers travel with every reply
// so the page and the checks use the server's.
//
// Environment overrides are for the dev checks only (dev/README.md): the
// defaults are what ships.

function lockEnvNumber(name, fallback) {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
const LOCK_TIMING = {
    heartbeatMs: Math.round(lockEnvNumber('LOCK_HEARTBEAT_MS', 30000)),
    timeoutMs: Math.round(lockEnvNumber('LOCK_TIMEOUT_MS', 180000)),
    pollMs: Math.round(lockEnvNumber('LOCK_VIEW_POLL_MS', 15000)),
    idleMs: Math.round(lockEnvNumber('LOCK_IDLE_MINUTES', 20) * 60000)
};
if (LOCK_TIMING.timeoutMs < 3 * LOCK_TIMING.heartbeatMs) {
    // A hidden tab can be throttled to about one timer wake-up a minute, so a
    // timeout under three heartbeats would read a live page as gone.
    startupNotes.push('LOCK_TIMEOUT_MS ' + LOCK_TIMING.timeoutMs + ' is under three heartbeats; using ' + (3 * LOCK_TIMING.heartbeatMs));
    LOCK_TIMING.timeoutMs = 3 * LOCK_TIMING.heartbeatMs;
}
if (['LOCK_HEARTBEAT_MS', 'LOCK_TIMEOUT_MS', 'LOCK_VIEW_POLL_MS', 'LOCK_IDLE_MINUTES'].some(n => process.env[n] != null && String(process.env[n]).trim() !== '')) {
    startupNotes.push('Edit lock timing from the environment: heartbeat ' + LOCK_TIMING.heartbeatMs + ' ms, timeout ' +
        LOCK_TIMING.timeoutMs + ' ms, view poll ' + LOCK_TIMING.pollMs + ' ms, idle ' + LOCK_TIMING.idleMs + ' ms');
}

// jobId -> { user, key, display, since, lastWrite, takenFrom, takenFromKey, takenAt, pages: Map<pageId, lastSeen> }
const locks = new Map();

// The user as a key ('' when there is none): the list's spelling lowercased,
// as My Jobs and the roster compare. 'Anonymous' was the old fallback for a
// request with no name and is nobody.
function lockKeyOf(raw) {
    if (typeof raw !== 'string') return '';
    const key = userKey(raw);
    return key && key !== 'anonymous' ? key : '';
}

// The page's user from the X-STS-User header, percent-encoded by the page
// (review.js does the same), decoded here. '' when absent or unreadable.
function headerUser(req) {
    let shown = String(req.get('X-STS-User') || '');
    try { shown = decodeURIComponent(shown); } catch (e) { shown = ''; }
    return shown.trim();
}

// Who is making a change to a work order: one name a write, the name the
// lock's gate checks and the name the server stamps (the independent review's
// F4; David, 2026-10-12; STAMPS_AND_VERSION_PLAN.md). The page's user from
// X-STS-User, which every write of this build's page carries: the tab's name
// wins over the browser's pick (a Change user in another tab, in the minute
// before this tab notices), and a tab whose pick ran out still saves under
// it. A request with no header (a page from before the update, a script) is
// the user picked in that browser, else nobody, as the delete's QC record
// already names its deleter (deleteActor). Never a name in the body. At most
// 100 characters, the stamp columns' size, with no control characters.
function writerName(req) {
    const shown = headerUser(req).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
    if (shown) return shown;
    return req.appUser ? req.appUser.user : '';
}

function lockPageId(raw) {
    return String(raw == null ? '' : raw).trim().slice(0, 64);
}

// The fresh entry for a job, or null; pages not seen within the timeout are
// dropped, and an entry with no page left goes.
function lockHolder(jobId, now) {
    const entry = locks.get(jobId);
    if (!entry) return null;
    for (const [pageId, seen] of entry.pages) {
        if (now - seen >= LOCK_TIMING.timeoutMs) entry.pages.delete(pageId);
    }
    if (!entry.pages.size) { locks.delete(jobId); return null; }
    return entry;
}

function lockLastSeen(entry) {
    let seen = 0;
    for (const t of entry.pages.values()) if (t > seen) seen = t;
    return seen;
}

// What a reply says about a held job. Never the pages' ids.
function lockFacts(entry, now) {
    if (!entry) return { held: false, now, timing: LOCK_TIMING };
    return {
        held: true,
        by: entry.user,
        byKey: entry.key,
        byDisplay: entry.display || entry.user,
        since: entry.since,
        lastSeen: lockLastSeen(entry),
        lastWrite: entry.lastWrite,
        takenFrom: entry.takenFrom || '',
        takenFromKey: entry.takenFromKey || '',
        takenAt: entry.takenAt || null,
        pages: entry.pages.size,
        now,
        timing: LOCK_TIMING
    };
}

function lockNewEntry(user, key, display, pageId, now) {
    // The display the page sent, else the name the list's spelling makes
    // ("Susan.Foster" reads "Susan Foster" until her page's next heartbeat).
    const entry = { user, key, display: display || displayName(user) || user, since: now, lastWrite: null, takenFrom: '', takenFromKey: '', takenAt: null, pages: new Map() };
    if (pageId) entry.pages.set(pageId, now);
    return entry;
}

// The job's row for the lock routes: null when there is no such job.
async function lockJobRow(jobId) {
    const pool = await getPool();
    const r = pool.request();
    r.input('id', jobId);
    const result = await r.query('SELECT rowVersion, lastModified, lastModifiedBy, archivedDate FROM jobs WHERE id = @id');
    if (!result.recordset.length) return null;
    const row = result.recordset[0];
    return { rowVersion: row.rowVersion, lastModified: row.lastModified || '', lastModifiedBy: row.lastModifiedBy || '', archived: !!row.archivedDate };
}

// Who is writing, for the gate: the writer's name (writerName: the page's
// header, else the browser's pick; never the body), so the name the gate
// checks is the name the server stamps. A nameless request is never the
// holder.
function writeActorKey(req) {
    return lockKeyOf(writerName(req));
}

// A page loaded before this build (the 2.8.0 work order with the Windows
// sign-in) sends no X-STS header at all; every page of this build sends the
// user and its page marker on each write. Such a page shows nothing for a 423
// and keeps the words on screen, so a refused save was lost without a word
// (the overall review's R02, 2026-10-01). It does show its own "Job updated on
// the server" box for a 409, so it gets that, and one log line a job a minute
// names who still has an old page open.
const OUTDATED_TEXT = 'This page is out of date. Close the browser and open the app again.';
const outdatedLogged = new Map();
function fromOutdatedPage(req) {
    return !req.get('X-STS-Writer') && !req.get('X-STS-User');
}
function outdatedPage(req, res, jobId) {
    const now = Date.now();
    const key = String(jobId);
    if (!outdatedLogged.has(key) || now - outdatedLogged.get(key) > 60000) {
        outdatedLogged.set(key, now);
        if (outdatedLogged.size > 500) outdatedLogged.clear();
        const body = req.body || {};
        const who = String(body.lastModifiedBy || body.user || '').replace(/[\r\n]/g, ' ').slice(0, 100);
        const picked = writerName(req);
        console.error(new Date(now).toISOString() + ' OLD PAGE: a page loaded before the update tried to change job ' + key +
            (who ? ' as "' + who + '"' : '') + (picked ? ' (picked in that browser: "' + picked + '")' : '') + '. It was told to close the browser and open the app again.');
    }
    res.status(409).json({ outdated: true, error: OUTDATED_TEXT });
    return false;
}

// The gate on every change to a job. Answers the 423 itself and returns false
// when someone else holds the job; refreshes the holder's page when it is hers;
// puts the entry back for a page that holds the job when the entry is gone (a
// restart). A write from the job list, the bulk bar, the import or a script
// carries no page and never takes a lock: a free job stays free (fail open).
function lockGate(req, res, jobId) {
    const now = Date.now();
    const actor = writeActorKey(req);
    const pageId = lockPageId(req.get('X-STS-Page'));
    const held = lockHolder(jobId, now);
    if (held && held.key !== actor) {
        if (fromOutdatedPage(req)) return outdatedPage(req, res, jobId);
        const facts = lockFacts(held, now);
        res.status(423).json(Object.assign({ locked: true, error: facts.byDisplay + ' is editing this job.', lockedBy: facts.by, lockedByDisplay: facts.byDisplay }, facts));
        return false;
    }
    if (held && pageId && !pageReleased(jobId, pageId, now)) held.pages.set(pageId, now);
    return true;
}

// After a change landed in SQL: the holder's last write, and, for a page that
// holds the job when the entry is gone (a restart), the entry put back. Only
// once the change landed: a write SQL refused (a stale version, a deleted
// job) makes nobody the holder, so the page's next heartbeat still finds its
// hold lapsed and checks its copy. A write on a free job from the list, with
// no page, stamps and takes nothing.
function lockAfterWrite(req, jobId) {
    const now = Date.now();
    const actor = writeActorKey(req);
    const pageId = lockPageId(req.get('X-STS-Page'));
    const held = lockHolder(jobId, now);
    if (held && held.key === actor) {
        held.lastWrite = now;
        if (pageId && !pageReleased(jobId, pageId, now)) held.pages.set(pageId, now);
    } else if (!held && actor && pageId && !pageReleased(jobId, pageId, now)) {
        // Rare (a restart, a lapse), so the one SELECT is affordable: never
        // for a job archived or deleted meanwhile (the holder's own archive
        // clears the entry, and her last piece saves can land after it).
        lockJobRow(jobId).then(row => {
            if (!row || row.archived || lockHolder(jobId, Date.now())) return;
            const entry = lockNewEntry(writerName(req), actor, '', pageId, now);
            entry.lastWrite = now;
            locks.set(jobId, entry);
        }).catch(() => { /* the next heartbeat takes it */ });
    }
}

// After an archive or a delete landed: the job is nobody's.
function lockClear(jobId) {
    locks.delete(jobId);
}

// Open: take the lock, or learn who holds it. { takeOver: true } moves it.
app.post('/api/jobs/:id/lock', async (req, res) => {
    try {
        const jobId = req.params.id;
        const body = req.body || {};
        // Every page of this build sends its page id; one from before the
        // update does not, and must not hold a job under its old name (R02).
        if (!lockPageId(body.page)) return outdatedPage(req, res, jobId);
        const key = lockKeyOf(body.user);
        if (!key) return res.status(400).json({ error: 'A user is required.' });
        const user = String(body.user).trim();
        const display = String(body.display || '').trim().slice(0, 120);
        const pageId = lockPageId(body.page);
        // A page's last save as its tab closed lands first, so a page opening
        // the job straight after (F5) reads it (item 6).
        await lastSaveLanded(jobId);
        const now = Date.now();
        const row = await lockJobRow(jobId);
        if (!row) return res.status(404).json({ error: 'Job not found', timing: LOCK_TIMING });
        if (row.archived) return res.json({ locked: false, archived: true, now, timing: LOCK_TIMING });
        if (pageId) pageReopened(jobId, pageId);
        const held = lockHolder(jobId, now);
        if (held && held.key !== key) {
            if (!body.takeOver) {
                return res.json(Object.assign({ locked: true, lockedBy: held.user, lockedByDisplay: held.display || held.user }, lockFacts(held, now)));
            }
            const entry = lockNewEntry(user, key, display, pageId, now);
            entry.takenFrom = held.user;
            entry.takenFromKey = held.key;
            entry.takenAt = now;
            locks.set(jobId, entry);
            console.log(new Date(now).toISOString() + ' LOCK takeover job ' + jobId + ': ' + held.key + ' -> ' + key);
            trackUser(user, 'editing');
            return res.json({ locked: false, tookOver: true, from: held.user, fromDisplay: held.display || held.user, now, timing: LOCK_TIMING });
        }
        if (held) {
            held.pages.set(pageId, now);
            if (display) held.display = display;
        } else {
            locks.set(jobId, lockNewEntry(user, key, display, pageId, now));
        }
        trackUser(user, 'editing');
        res.json({ locked: false, now, timing: LOCK_TIMING });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Heartbeat: refresh this page's hold, or take a free lock and say so.
app.put('/api/jobs/:id/lock', async (req, res) => {
    try {
        const jobId = req.params.id;
        const body = req.body || {};
        // A page from before the update sends no page id: it is told to
        // reload rather than keep a job under its old name (R02).
        if (!lockPageId(body.page)) return outdatedPage(req, res, jobId);
        const key = lockKeyOf(body.user);
        if (!key) return res.status(400).json({ error: 'A user is required.' });
        const user = String(body.user).trim();
        const display = String(body.display || '').trim().slice(0, 120);
        const pageId = lockPageId(body.page);
        const now = Date.now();
        const row = await lockJobRow(jobId);
        const held = lockHolder(jobId, now);
        if (!row || row.archived) {
            // Never re-taken: the job is archived or gone. A hold of hers goes.
            if (held && held.key === key) { held.pages.delete(pageId); if (!held.pages.size) locks.delete(jobId); }
            return res.json({ ok: true, held: false, gone: true, archived: !!(row && row.archived), now, timing: LOCK_TIMING });
        }
        if (held && held.key !== key) {
            return res.json(Object.assign({ ok: true }, lockFacts(held, now), { mine: false }));
        }
        let took;
        if (held) {
            took = !held.pages.has(pageId);
            held.pages.set(pageId, now);
            if (display) held.display = display;
        } else {
            took = true;
            locks.set(jobId, lockNewEntry(user, key, display, pageId, now));
        }
        trackUser(user, 'editing');
        res.json({ ok: true, held: true, mine: true, took, now, timing: LOCK_TIMING });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Release this page's hold. The reply says what the job is now: free, still
// hers from another page, or somebody else's.
app.delete('/api/jobs/:id/lock', (req, res) => {
    const jobId = req.params.id;
    const body = req.body || {};
    const key = lockKeyOf(body.user);
    const pageId = lockPageId(body.page);
    const now = Date.now();
    const held = lockHolder(jobId, now);
    if (key && pageId) markPageReleased(jobId, pageId, now);
    if (held && held.key === key) {
        lockLetGo(held, jobId, pageId);
        const left = lockHolder(jobId, now);
        return res.json(Object.assign({ ok: true }, lockFacts(left, now), { mine: !!left }));
    }
    res.json(Object.assign({ ok: true }, lockFacts(held, now), { mine: false }));
});

// One page lets its hold go (the release above, and the page's last save as
// it closes); an old page with no id lets the whole hold go, as before.
function lockLetGo(held, jobId, pageId) {
    if (pageId) held.pages.delete(pageId);
    else held.pages.clear();
    if (!held.pages.size) locks.delete(jobId);
}

// Pages that let their hold go (item 6). A write of theirs still on its way
// (a closing tab's job-row save, a piece delete) lands after the release, and
// lockGate and lockAfterWrite would put the hold back for a page that is gone,
// which someone opening the job then met as "is editing this job" for the
// lock timeout. Kept that long; a page opening the job again is taken off
// (POST .../lock). The heartbeat is left alone: a live page's heartbeat after
// a release it sent itself is the "Home and straight back" race, which the
// heartbeat must still heal.
const releasedPages = new Map();   // jobId -> Map(pageId -> time)
function markPageReleased(jobId, pageId, now) {
    // Entries past the timeout go as new ones come, or the map would grow
    // with every close until a restart (item 6's build review).
    releasedPages.forEach((pages, id) => {
        pages.forEach((at, page) => { if (now - at >= LOCK_TIMING.timeoutMs) pages.delete(page); });
        if (!pages.size) releasedPages.delete(id);
    });
    if (!releasedPages.has(jobId)) releasedPages.set(jobId, new Map());
    releasedPages.get(jobId).set(pageId, now);
}
function pageReleased(jobId, pageId, now) {
    const pages = releasedPages.get(jobId);
    if (!pages || !pages.has(pageId)) return false;
    if (now - pages.get(pageId) < LOCK_TIMING.timeoutMs) return true;
    pages.delete(pageId);
    if (!pages.size) releasedPages.delete(jobId);
    return false;
}
function pageReopened(jobId, pageId) {
    const pages = releasedPages.get(jobId);
    if (!pages) return;
    pages.delete(pageId);
    if (!pages.size) releasedPages.delete(jobId);
}

// Read: who holds the job, and the row's version and stamps, one SELECT.
// Changes nothing and marks nobody as editing.
app.get('/api/jobs/:id/lock', async (req, res) => {
    try {
        const jobId = req.params.id;
        const now = Date.now();
        const row = await lockJobRow(jobId);
        if (!row) return res.status(404).json({ error: 'Job not found', timing: LOCK_TIMING });
        const held = lockHolder(jobId, now);
        const asking = lockKeyOf(headerUser(req));
        // thisPage: the asking page is one of the holder's fresh pages, so its
        // own hold never lapsed (the catch-up with one's own other window
        // asks this; a lapse is the heartbeat's to handle). Read only: it
        // refreshes nothing.
        const askingPage = lockPageId(req.get('X-STS-Page'));
        res.json(Object.assign(lockFacts(held, now), {
            mine: !!(held && asking && held.key === asking),
            thisPage: !!(held && asking && held.key === asking && askingPage && held.pages.has(askingPage)),
            rowVersion: row.rowVersion,
            lastModified: row.lastModified,
            lastModifiedBy: row.lastModifiedBy,
            archived: row.archived
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Helpers ──

function formatComponent(c) {
    return {
        ...c,
        checkboxes: safeParseJSON(c.checkboxes, {}),
        notes: safeParseJSON(c.notes, {})
    };
}

function safeParseJSON(str, fallback) {
    if (!str) return fallback;
    try { return JSON.parse(str); } catch { return fallback; }
}

// ── Start ──

app.listen(PORT, '0.0.0.0', () => {
    // Version first, so the service log records which build this boot was. The
    // daemon log is the one place a restart leaves a permanent trace.
    console.log(`STS Work Order v${APP_VERSION} starting (${STARTED_AT})`);
    // The same line in the error log too: the service writes the two to
    // separate files, and the error file had nothing to mark where each start
    // began, so a problem line from before a fix read as current after it
    // (the overall review's R07, 2026-10-01).
    console.error(`STS Work Order v${APP_VERSION} starting (${STARTED_AT})`);
    console.log(`Prepress WO server running on port ${PORT}`);
    console.log(`http://localhost:${PORT} (also available on LAN via this machine's IP)`);
    startupNotes.forEach(note => console.log(note));
    reviewMail.startupLines(mailSettings).forEach(line => {
        if (/^EMAIL /.test(line)) console.error(line);
        else console.log(line);
    });
    // The user list's state goes in the log now, not only when someone first
    // opens the app: "User list loaded", or the problem to fix.
    userList.current();
    if (reviewItemsProblem) {
        console.error('QC REVIEW CHECKLIST UNAVAILABLE: public/js/review-items.js could not be loaded (' +
            reviewItemsProblem + '). QC Review is switched off until it is fixed and the service restarted.');
    }
    // After listening, never before: a slow or unreachable SQL Server must not
    // keep /api/health from answering. checkReviewTables never rejects.
    checkReviewTables();
});
