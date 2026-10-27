/*
 * The user list: the names people pick from when they open the app.
 *
 * This is an honor-system user picker, not a sign-in. People choose their own
 * name from this list and nothing proves who they are (USER_PICKER_PLAN.md).
 *
 * The list is a CSV file named by USER_LIST_FILE in .env (an absolute path, or
 * a path relative to the app folder). It needs a column headed User, one name
 * per row in Firstname.Lastname form, for example David.Marra. Other columns
 * are ignored, so an admin can keep notes beside the names.
 *
 * Changes need no restart. When the list is used, the file's size and modified
 * time are checked at most every 5 seconds, and the file is read again when
 * either changed. A read that fails after a good one keeps the last good list
 * ("stale"), because saving from Excel or a file briefly locked must not throw
 * everyone out, and a fresh visitor still picks from that list (David,
 * 2026-09-14). Only when no good list was read since the app started is the
 * list "unavailable", and then nobody can pick a name.
 *
 * Problems go to the service log, once per change. The file's path is written
 * only there: nothing this module gives a screen or /api/health names it.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHECK_MS = 5000;
const MAX_BYTES = 1024 * 1024;
const MAX_USERS = 5000;
const MAX_LENGTH = 100;
const UNAVAILABLE_TEXT = 'The user list is unavailable. An administrator or IT must fix the settings or the file.';

// Letters (any alphabet), digits, apostrophes and hyphens, in two or more
// parts joined by single dots: David.Marra, Mary-Kate.O'Brien, John.Paul.Smith.
const USER_FORM = /^[\p{L}\p{N}'-]+(?:\.[\p{L}\p{N}'-]+)+$/u;

// A person as a key that compares reliably: no DOMAIN\ in front, nothing from
// an @ on, small letters. The same rule as loginKey in server.js, so a job
// stamped "david.marra@compu-mail.com" and the user "David.Marra" are one person.
function userKey(raw) {
    return String(raw == null ? '' : raw).split('\\').pop().split('@')[0].trim().toLowerCase();
}

// The name of one person's remember cookie (server.js): sts_seen_ and a short
// fingerprint of their key, so every spelling of one person gets the same
// cookie and any user, accents included, makes a valid cookie name.
function seenCookieName(user) {
    return 'sts_seen_' + crypto.createHash('sha1').update(userKey(user), 'utf8').digest('hex').slice(0, 16);
}

function isUser(value) {
    return typeof value === 'string' && value.length <= MAX_LENGTH && USER_FORM.test(value);
}

function displayName(user) {
    return String(user).split('.').join(' ');
}

// Every record of a CSV text as a list of fields. A quote at the start of a
// field opens a quoted value, which may hold commas, line breaks and doubled
// quotes, as Excel writes them. A quote anywhere else is an ordinary
// character, so a note typed in Notepad as 8.5x11" does not swallow the rows
// after it (independent review S1).
function csvRecords(text) {
    const records = [];
    let record = [];
    let field = '';
    let quoted = false;
    let atStart = true;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') quoted = false;
            else field += c;
            continue;
        }
        const starting = atStart;
        atStart = false;
        if (c === '"' && starting) {
            quoted = true;
        } else if (c === ',') {
            record.push(field);
            field = '';
            atStart = true;
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            record.push(field);
            records.push(record);
            record = [];
            field = '';
            atStart = true;
        } else {
            field += c;
        }
    }
    if (field !== '' || record.length) {
        record.push(field);
        records.push(record);
    }
    return records;
}

function shortValue(value) {
    return value.length > 60 ? value.slice(0, 60) + '...' : value;
}

// The users in a file's text, and what was wrong with it. problem is '' when
// the list can be used; notes are the log lines for skipped and repeated rows.
function parseUserList(text) {
    const records = csvRecords(String(text).replace(/^\uFEFF/, ''));
    const blank = record => record.every(f => f.trim() === '');
    const headerAt = records.findIndex(r => !blank(r));
    if (headerAt < 0) return { users: [], notes: [], problem: 'no-users' };
    const column = records[headerAt].findIndex(f => f.trim().toLowerCase() === 'user');
    if (column < 0) return { users: [], notes: [], problem: 'no-column' };

    const users = [];
    const notes = [];
    const seen = new Map();   // key -> { user, count }
    for (let i = headerAt + 1; i < records.length; i++) {
        const value = String(records[i][column] == null ? '' : records[i][column]).trim();
        if (!value) continue;
        const row = i + 1;   // the row number Excel shows
        if (value.length > MAX_LENGTH) {
            notes.push("User list: skipped row " + row + " ('" + shortValue(value) + "'): longer than " + MAX_LENGTH + ' characters.');
            continue;
        }
        if (!USER_FORM.test(value)) {
            notes.push("User list: skipped row " + row + " ('" + shortValue(value) + "'): not in Firstname.Lastname form.");
            continue;
        }
        const key = userKey(value);
        const already = seen.get(key);
        if (already) {
            already.count++;
            continue;
        }
        seen.set(key, { user: value, count: 1 });
        users.push({ user: value, display: displayName(value), key });
    }
    seen.forEach((entry, key) => {
        if (entry.count > 1) {
            notes.push("User list: '" + key + "' appears " + (entry.count === 2 ? 'twice' : entry.count + ' times') + "; kept '" + entry.user + "'.");
        }
    });
    if (!users.length) return { users: [], notes, problem: 'no-users' };
    if (users.length > MAX_USERS) return { users: [], notes: [], problem: 'too-many' };
    return { users, notes, problem: '' };
}

// The file's text. Excel's "CSV UTF-8" is UTF-8; its plain "CSV (Comma
// delimited)" is the Windows code page, which is read as such rather than
// turning an accented name into a replacement character (independent review S6).
function decodeList(bytes) {
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), ansi: false };
    } catch (err) {
        return { text: new TextDecoder('windows-1252').decode(bytes), ansi: true };
    }
}

function readProblem(err) {
    if (err.code === 'EISDIR') return 'it is a folder, not a file';
    if (err.code === 'EACCES' || err.code === 'EPERM') return 'permission denied';
    if (err.code === 'EBUSY') return 'the file is in use';
    return err.code || String(err.message).split('\n')[0];
}

// options: file (the USER_LIST_FILE setting), baseDir (the app folder), and
// for the dev check only: now (a clock), log ({ info, error }), checkMs.
function createUserList(options) {
    const opts = options || {};
    const setting = String(opts.file == null ? '' : opts.file).trim();
    const filePath = setting ? path.resolve(opts.baseDir || process.cwd(), setting) : '';
    const now = opts.now || Date.now;
    const log = opts.log || { info: msg => console.log(msg), error: msg => console.error(msg) };
    const checkMs = opts.checkMs == null ? CHECK_MS : opts.checkMs;

    let good = null;          // { users, byKey } from the last good read
    let lastGood = false;     // whether the latest check was good
    let lastStat = '';        // the file's identity at the last good read
    let checkedAt = null;
    let lastProblem = '';     // the last problem logged, with its skipped rows, so each is said once

    function problemText(kind, detail) {
        if (kind === 'not-set') return 'USER LIST NOT SET: add USER_LIST_FILE=<path> to .env and restart.';
        if (kind === 'not-found') return 'USER LIST NOT FOUND: ' + filePath;
        if (kind === 'unreadable') return 'USER LIST CANNOT BE READ: ' + filePath + ' (' + detail + ')';
        if (kind === 'too-large') return 'USER LIST IS TOO LARGE: ' + filePath + ' (over 1 MB)';
        if (kind === 'no-column') return "USER LIST HAS NO 'User' COLUMN: " + filePath;
        if (kind === 'too-many') return 'USER LIST HAS TOO MANY USERS: ' + filePath + ' (over 5,000)';
        return 'USER LIST HAS NO USERS: ' + filePath;
    }

    // notes: the skipped-row lines of a file that could not be used, said
    // with its problem and only then, so a broken file is not reported again
    // on every check.
    function fail(text, notes) {
        lastGood = false;
        const said = [text].concat(notes || []).join('\n');
        if (said === lastProblem) return;
        lastProblem = said;
        (notes || []).forEach(note => log.info(note));
        if (good) log.error('USER LIST COULD NOT BE RELOADED: ' + text + '; keeping the last good list (' + good.users.length + ' users).');
        else log.error(text);
    }

    function check() {
        if (!filePath) return fail(problemText('not-set'));
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (err) {
            return fail(err.code === 'ENOENT' || err.code === 'ENOTDIR' ? problemText('not-found') : problemText('unreadable', readProblem(err)));
        }
        if (stat.isDirectory()) return fail(problemText('unreadable', readProblem({ code: 'EISDIR' })));
        // Size, times and the file's id: a copy dropped over the list can keep
        // its source's modified time, and can even be the same size.
        const identity = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join('|');
        if (lastGood && identity === lastStat) return;
        if (stat.size > MAX_BYTES) return fail(problemText('too-large'));
        let bytes;
        try {
            bytes = fs.readFileSync(filePath);
        } catch (err) {
            return fail(problemText('unreadable', readProblem(err)));
        }
        if (bytes.length > MAX_BYTES) return fail(problemText('too-large'));
        const { text, ansi } = decodeList(bytes);
        const parsed = parseUserList(text);
        if (ansi) parsed.notes.unshift('User list: not saved as UTF-8, read as Windows text instead. In Excel, save it as "CSV UTF-8" so accented names always read right.');
        if (parsed.problem) return fail(problemText(parsed.problem), parsed.notes);
        good = { users: parsed.users, byKey: new Map(parsed.users.map(u => [u.key, u])) };
        lastGood = true;
        lastStat = identity;
        lastProblem = '';
        log.info('User list loaded: ' + parsed.users.length + ' users (' + filePath + ')');
        parsed.notes.forEach(note => log.info(note));
    }

    function refresh() {
        const t = now();
        if (checkedAt !== null && t - checkedAt < checkMs) return;
        checkedAt = t;
        check();
    }

    return {
        filePath,
        // { status: 'ok' | 'stale' | 'unavailable', users: [{ user, display, key }], count }
        current() {
            refresh();
            if (!good) return { status: 'unavailable', users: [], count: 0 };
            return { status: lastGood ? 'ok' : 'stale', users: good.users, count: good.users.length };
        },
        // The listed user for any spelling of one (capitals, DOMAIN\, @domain), or null.
        find(raw) {
            refresh();
            if (!good) return null;
            return good.byKey.get(userKey(raw)) || null;
        }
    };
}

module.exports = { createUserList, parseUserList, userKey, displayName, isUser, seenCookieName, UNAVAILABLE_TEXT, MAX_LENGTH };
