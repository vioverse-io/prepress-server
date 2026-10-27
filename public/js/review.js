/* ═════════════════════════════════════════════════════════════════
   QC REVIEW WINDOW -- where a reviewer reads, fills in and signs off a checklist
   Opened by the QC Review button in the work order header. The lists come
   from review-items.js (REVIEW_ITEMS); each block saves itself to
   PUT /api/jobs/:id/reviews/:gate/:unitId as the reviewer works.

   It must never disturb the work order open behind it:
   - It never writes the job or its pieces, and never calls the work order's
     save, load, lock or print code. From app.js it reads only getUserName.
   - app.js listens on the whole page: a checkbox change or a typed note saves
     the open work order, and Ctrl+Z / Ctrl+Y rewind it. So #reviewModal stops
     change, input, focusin, mousedown and keydown at its root, uses none of
     the work order's class names, and while it is open three capture
     listeners keep focus, Ctrl+Z / Ctrl+Y and Chrome's own page-wide
     take-back of typing inside it.
   Code prefix review*. The qc* code is the print-time QC warning.

   Who is asking (USER_PICKER_PLAN.md section 4e). The server knows the person
   by the user picked in this browser (the sts_user cookie). Every request here
   also names the user this page is showing in X-STS-User, so a click is never
   recorded under someone picked since in another tab: the server answers 409
   userChanged, or 401 needUser when no listed user is picked, and the user
   picker (js/user-picker.js) then covers the page. Closing the page sends
   nothing once the cookie names someone else.

   Saving (PHASE3_PLAN.md section d). Each block is a unit. base is the last
   row the server accepted; ops are this browser's clicks not yet confirmed;
   the screen shows base with ops replayed, and nothing is read back from the
   screen. One request per unit at a time. When another person has changed
   the unit, their row wins, this window's unsaved lines are named in the
   footer, and nothing is re-applied automatically.

   The review loop (PHASE4_PLAN.md). The server decides who may do what on
   each tab and sends it with the reviews (access); the window only draws it,
   and every write is checked again on the server. Mark passed and Corrections
   needed queue behind a save in flight and carry the whole sheet. Send for
   review, Fixed ready for re-review, Send to CSR, the ask and Reopen are
   plain requests, after which the window reloads the reviews and the
   activity list. The side panel shows who is who, those buttons, and the
   job's QC activity, newest first.
   ═════════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// ── Save rules: no page access, so dev/review-save-check.js can run them in Node ──

function own(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function plain(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function copy(value) {
    return JSON.parse(JSON.stringify(plain(value)));
}

// The words an N/A mark carries, or '' for none, read the way the server
// stores them: whitespace alone is none.
function naWords(mark) {
    const words = plain(mark).reason;
    return typeof words === 'string' && words.trim() ? words : '';
}

// Object keys in a fixed order, so two equal objects always print the same.
function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
}

// A sheet's flags and their notes, read as sameSheet reads them.
function flagsKey(sheet) {
    const flags = plain(plain(sheet).flags);
    return stable(Object.keys(flags).sort().map(id => [id, flags[id] == null ? '' : String(flags[id])]));
}

const saveRules = {
    // The answers held by a row (or by nothing yet), as a fresh copy.
    sheetOf(row) {
        const r = plain(row);
        return { items: copy(r.items), itemValues: copy(r.itemValues), flags: copy(r.flags), na: copy(r.na), unitFacts: copy(r.unitFacts) };
    },

    // One click applied to a sheet. The opposites live here: a tick removes
    // the flag and its note, a flag removes the tick, N/A never clears either.
    // A new N/A carries its words, empty, so the server clears any the line
    // held: N/A off and on again inside one request is a new mark. Its words
    // are always sent as text, never by leaving the key out, which the server
    // reads as "leave them as they are" (David, 2026-09-23).
    applyOp(sheet, op) {
        const id = op.id;
        if (op.type === 'tick') { sheet.items[id] = true; delete sheet.flags[id]; }
        else if (op.type === 'untick') delete sheet.items[id];
        else if (op.type === 'flag') { delete sheet.items[id]; if (!own(sheet.flags, id)) sheet.flags[id] = ''; }
        else if (op.type === 'unflag') delete sheet.flags[id];
        else if (op.type === 'note') { if (own(sheet.flags, id)) sheet.flags[id] = op.text; }
        else if (op.type === 'naOn') { if (!own(sheet.na, id)) sheet.na[id] = { reason: '' }; }
        else if (op.type === 'naOff') delete sheet.na[id];
        else if (op.type === 'naReason') { if (own(sheet.na, id)) sheet.na[id] = Object.assign({}, plain(sheet.na[id]), { reason: String(op.text == null ? '' : op.text) }); }
        return sheet;
    },

    replay(row, ops) {
        const sheet = saveRules.sheetOf(row);
        ops.forEach(op => saveRules.applyOp(sheet, op));
        return sheet;
    },

    // Two sheets hold the same answers: the same lines, values and N/A marks
    // with their words, read the way the server stores them. Who set an N/A
    // mark and when, and formVersion, are not compared.
    sameSheet(a, b) {
        const key = sheet => {
            const s = plain(sheet);
            const flags = plain(s.flags);
            const items = plain(s.items);
            const values = plain(s.itemValues);
            return stable([
                Object.keys(items).filter(id => items[id] === true && !own(flags, id)).sort(),
                Object.keys(values).filter(id => values[id] != null && String(values[id]).trim() !== '').sort()
                    .map(id => [id, String(values[id])]),
                Object.keys(flags).sort().map(id => [id, flags[id] == null ? '' : String(flags[id])]),
                Object.keys(plain(s.na)).sort().map(id => [id, naWords(plain(s.na)[id])]),
                plain(s.unitFacts)
            ]);
        };
        return key(a) === key(b);
    },

    // The same disposition and round. Who has the ball (holder) and the stamps
    // of Fixed, ready for re-review are not compared: those never change a
    // sheet or what a click meant.
    sameRound(a, b) {
        const round = row => {
            const r = plain(row);
            return (r.disposition || '') + '|' + (Number(r.returnCount) || 0);
        };
        return round(a) === round(b);
    },

    // The same person, by user key when both have one, else by name.
    samePerson(name, login, by) {
        const b = plain(by);
        if (login && b.login) return String(login).toLowerCase() === String(b.login).toLowerCase();
        return !!name && !!b.name && String(name).trim().toLowerCase() === String(b.name).trim().toLowerCase();
    },

    // A sign-off whose answer never came did land: the row holds the sheet it
    // carried, with the disposition it asked for, by the person who asked.
    // A second Corrections needed by the same person counts only with a newer
    // send-back stamp than the row it was asked from. base is the row this
    // window held when it asked.
    signoffLanded(request, row, base) {
        const s = request.signoff;
        const r = plain(row);
        if (!s || !row) return false;
        // A Sign back in never keeps the sheet it carried: a changes round
        // clears it (its round up, its checklist version empty), a production
        // round leaves hers as it was. So it landed when this person changed
        // the row last, and the row shows what that round does (decision 5).
        if (s.action === 'signback') {
            if (!saveRules.samePerson(r.lastModifiedByName, r.lastModifiedByLogin, s.by) || !(Number(r.rowVersion) > Number(request.rowVersion))) return false;
            if (s.production) return saveRules.sameRound(row, base) && saveRules.sameSheet(saveRules.sheetOf(row), saveRules.sheetOf(base));
            return String(r.formVersion || '') === '' && !r.disposition && Number(r.returnCount) === (base ? Number(plain(base).returnCount) || 0 : 0) + 1;
        }
        // A Corrections needed that landed before a CSR's change joined the
        // piece: her change cleared the checks it carried and kept its flags,
        // round and send-back stamps.
        if (s.action === 'corrections' && saveRules.herChange(row, base) && r.disposition === 'corrections' &&
            saveRules.samePerson(r.returnedByName, r.returnedByLogin, s.by) &&
            !!r.returnedDate && String(r.returnedDate) !== String(request.baseReturned || '') &&
            flagsKey(request.sheet) === flagsKey(row)) return true;
        if (!saveRules.sameSheet(request.sheet, saveRules.sheetOf(row))) return false;
        if (s.action === 'pass') return r.disposition === 'passed' && saveRules.samePerson(r.reviewerName, r.reviewerLogin, s.by);
        if (s.action === 'corrections') return r.disposition === 'corrections' && saveRules.samePerson(r.returnedByName, r.returnedByLogin, s.by) &&
            !!r.returnedDate && String(r.returnedDate) !== String(request.baseReturned || '');
        return false;
    },

    // Only the ball moved: the row changed (someone pressed Fixed, ready for
    // re-review) but its answers, disposition and round are as this window last
    // had them. Clicks made meanwhile still mean what they meant. A sign-off
    // waiting to go also meant the last send-back it saw, so another
    // Corrections needed in the same round (other departments, say) is more
    // than the ball.
    ballMoved(row, base, pendingSignoff) {
        if (!row || !base || Number(plain(row).rowVersion) === Number(plain(base).rowVersion) ||
            !saveRules.sameRound(row, base) || !saveRules.sameSheet(saveRules.sheetOf(row), saveRules.sheetOf(base))) return false;
        // The CSR's change joining a piece already in corrections keeps its
        // round and, with nothing checked on it, its sheet, but it is more than
        // the ball: what was waiting was done on the old proof, so it is named
        // and dropped, never sent again (David, 2026-09-22). Whatever the
        // holder: Fixed may already have been pressed (decision 5).
        if (saveRules.herChange(row, base)) return false;
        if (!pendingSignoff) return true;
        // A sign back in meant the job as this window last saw it. A production
        // one leaves her sheet and round as they were, so another CSR's (or an
        // older tab's) would look like only the ball moving, and this one would
        // go again on top of it: the job signed back in twice.
        if (pendingSignoff.action === 'signback') return false;
        const sentBack = x => {
            const r = plain(x);
            return stable([String(r.returnedDate || ''), String(r.returnedByName || ''), String(r.returnedByLogin || '')]);
        };
        return sentBack(row) === sentBack(base);
    },

    // The who and when of a CSR's sign back in on a row, '' when it has none.
    signedBackKey(row) {
        const s = plain(row).signedBack;
        return s && typeof s === 'object' ? stable([String(s.whenIso || ''), String(s.actorName || ''), String(s.actorLogin || '')]) : '';
    },

    // The row carries a sign back in the base had not seen: a CSR signed the
    // block back in since this window last had it. Any difference counts, so
    // the same CSR twice (only the time differs) does too. A base not in
    // corrections has seen none. Nor has a base whose sign back in is newer
    // than the base itself: the reviews GET reads the rows before it looks up
    // the sign back in, and her change stamps both with one time. A base in
    // corrections without the field (a reply whose follow-up read failed) is
    // unknown: then only the row being with the operator counts, as before.
    herChange(row, base) {
        const key = saveRules.signedBackKey(row);
        if (!key) return false;
        const b = plain(base);
        if (!base || b.disposition !== 'corrections') return true;
        if (!own(b, 'signedBack')) return plain(row).holder === 'operator';
        if (saveRules.signedBackKey(base) && String(plain(b.signedBack).whenIso || '') > String(b.lastModified || '')) return true;
        return key !== saveRules.signedBackKey(base);
    },

    // The CSR's change, with the operator: nothing on the block is checked
    // until they press Fixed (David, 2026-09-22).
    herChangeWaiting(row) {
        const r = plain(row);
        return !!row && r.disposition === 'corrections' && r.holder === 'operator' && !!saveRules.signedBackKey(row);
    },

    // On the CSR checklist, who signed the job back in is worked out when the
    // line is drawn (conflictCause in the window), from the checklists' own
    // "signed back in" stamps newer than since: the time on the row the clicks
    // or the Sign back in sheet were made against. Every sign back in stamps
    // each checklist it touches, the CSR checklist too unless it is for
    // production, with the time it gives her row. Here: whether the checklist
    // was cleared by one (its round went up, which nothing else does), and a
    // first guess at who for the moment before the window has reloaded (a
    // cleared row nobody has saved on since: its checklist version is still
    // empty, which no save or pass ever leaves).
    csrCause(row, base, since) {
        const r = plain(row);
        if (!row || r.gate !== 'csr') return null;
        const b = plain(base);
        const round = Number(r.returnCount) || 0;
        const rounds = round - (base ? Number(b.returnCount) || 0 : 0);
        const writes = (Number(r.rowVersion) || 0) - (base ? Number(b.rowVersion) || 0 : 0);
        const roundUp = rounds > 0;
        // Only when every write since the base was a clearing sign back in
        // (each raises the round and the version by one): a production one
        // after it moves the last name but not the round.
        const guess = roundUp && rounds === writes && String(r.formVersion || '') === ''
            ? { name: String(r.lastModifiedByName || ''), login: String(r.lastModifiedByLogin || '') } : null;
        // until: the refusing row's time. A sign back in stamps her row with the
        // time it stamps the checklists, so one after it did not refuse this.
        return { since: String(since || ''), until: String(r.lastModified || ''), roundUp, guess };
    },

    // Who signed a department block back in, when that made this row refuse a
    // window's clicks: { name, login } from the row's own sign back in, or null.
    herCause(row, base) {
        if (!saveRules.herChange(row, base)) return null;
        const s = plain(plain(row).signedBack);
        return { name: String(s.actorName || ''), login: String(s.actorLogin || '') };
    },

    // Everything still waiting on a unit is dropped and named, because someone
    // else changed it. cause: who signed a department block back in; csr: what
    // names a CSR's sign back in on the CSR checklist (csrCause). The newest
    // conflict on a block decides them, so a later ordinary one takes a name
    // off, except that a Sign back in refused earlier and still named keeps
    // what named it when a later conflict drops only lines: its line must never
    // turn into "press Sign back in again".
    dropForConflict(unit, cause, signedOff, csr) {
        const dropped = saveRules.opIds(unit.ops);
        const signoff = unit.signoff;
        const droppedSignoff = signoff ? signoff.action : '';
        unit.ops = [];
        unit.signoff = null;
        const old = unit.conflict;
        const keepBack = !droppedSignoff && !!old && old.signoff === 'signback';
        const by = cause || (keepBack ? old.signedBackBy || null : null);
        const onCsr = keepBack ? old.csr || csr || null : csr || null;
        if (dropped.length || droppedSignoff) {
            const ids = old ? old.ids : [];
            dropped.forEach(id => { if (!ids.includes(id)) ids.push(id); });
            unit.conflict = { ids, signoff: droppedSignoff || (old ? old.signoff : ''), signedBackBy: by, csr: onCsr };
        }
        return { outcome: 'conflict', dropped, droppedSignoff, signoff, signedBackBy: by, csr: onCsr, signedOff: signedOff || '' };
    },

    // The lines a list of clicks touched, first touch first.
    opIds(ops) {
        const ids = [];
        ops.forEach(op => { if (!ids.includes(op.id)) ids.push(op.id); });
        return ids;
    },

    newUnit(row) {
        return {
            base: row || null,   // the last row the server accepted
            ops: [],             // clicks not yet confirmed, in order
            signoff: null,       // Mark passed, Corrections needed or Sign back in waiting to go: { action, by, ... }
            inflight: null,      // the request whose answer is awaited
            sent: [],            // requests whose answer never came (they may have saved)
            wait: '',            // 'retry': a timer will try again; 'failed': the next change tries again
            readonly: '',        // the server's reason this unit cannot be saved
            problem: null,       // { kind: 'retry' | 'failed', text } for the footer
            conflict: null,      // { ids, signoff } lines (and a sign-off) dropped because someone else changed the unit
            lostSignoff: '',     // 'pass' or 'corrections' dropped because the unit went read only, named in the footer
            refused: ''          // the server's words for the last sign-off it refused
        };
    },

    sheet(unit) {
        return saveRules.replay(unit.base, unit.ops);
    },

    addOp(unit, op) {
        unit.ops.push(op);
        if (unit.wait === 'failed') unit.wait = '';
    },

    // Mark passed or Corrections needed. It goes as the next request, after
    // any save already in flight, carrying the sheet with every click replayed
    // (the server contract: a sign-off must use the version that save returns).
    addSignoff(unit, signoff) {
        unit.signoff = signoff;
        unit.refused = '';
        unit.lostSignoff = '';
        if (unit.wait === 'failed') unit.wait = '';
    },

    // The request to send now, or null. force is used by Close and page unload,
    // which try again without waiting for the timer or the next change.
    nextRequest(unit, force) {
        if (unit.inflight || unit.readonly || (!unit.ops.length && !unit.signoff)) return null;
        if (unit.wait && !force) return null;
        const sheet = saveRules.sheet(unit);
        // Clicks that cancel out (tick, then untick) need no request, unless an
        // earlier request may have saved something else in the meantime.
        if (!unit.signoff && !unit.sent.length && saveRules.sameSheet(sheet, saveRules.sheetOf(unit.base))) {
            unit.ops = [];
            unit.wait = '';
            unit.problem = null;
            return null;
        }
        // A Sign back in sheet whose block was changed under it (her own save
        // refused) goes with the version it was filled in against, so the
        // server refuses it and says why, never lets it through on the newer
        // row (decision 5).
        const pinned = unit.signoff && unit.signoff.against != null ? Number(unit.signoff.against) : null;
        return { sheet, opCount: unit.ops.length, rowVersion: pinned != null ? pinned : unit.base ? unit.base.rowVersion : 0, signoff: unit.signoff,
            baseReturned: unit.base ? String(plain(unit.base).returnedDate || '') : '',
            sections: saveRules.sweptSections(unit.ops), lines: saveRules.sweptLines(unit.ops) };
    },

    // The lines a press swept (or took back), so each line's record can say it
    // was checked at once rather than read. Only a label: the server counts
    // what really moved. A line's last check or uncheck in the request decides,
    // so one checked by hand after a press and its take-back is not swept.
    sweptLines(ops) {
        const last = new Map();
        (ops || []).forEach(op => { if (op.type === 'tick' || op.type === 'untick') last.set(op.id, op); });
        const ticks = [];
        const unticks = [];
        last.forEach((op, id) => {
            if (op.section) (op.type === 'tick' ? ticks : unticks).push(id);
        });
        return { ticks, unticks };
    },

    // The sections a press swept in this request, so the record can say a line
    // was ticked at once rather than read. The server counts what really
    // changed; this only names where.
    sweptSections(ops) {
        const ticks = [];
        const unticks = [];
        (ops || []).forEach(op => {
            if (!op.section) return;
            const list = op.type === 'tick' ? ticks : op.type === 'untick' ? unticks : null;
            if (list && !list.includes(op.section)) list.push(op.section);
        });
        return { ticks, unticks };
    },

    // Clicks the server now holds: a line named after a conflict is off the
    // list once it has been done again, and a dropped sign-off once one lands.
    confirm(unit, confirmed, signedOff) {
        if (!unit.conflict) return;
        const redone = saveRules.opIds(confirmed);
        unit.conflict.ids = unit.conflict.ids.filter(id => !redone.includes(id));
        if (signedOff) unit.conflict.signoff = '';
        if (!unit.conflict.ids.length && !unit.conflict.signoff) unit.conflict = null;
    },

    // A sign-off that will not go because the unit went read only. It is kept
    // by name, so the footer can say it did not happen.
    dropSignoff(unit) {
        const action = unit.signoff ? unit.signoff.action : '';
        if (action) unit.lostSignoff = action;
        unit.signoff = null;
        return action;
    },

    begin(unit, request) {
        unit.inflight = request;
        unit.wait = '';
        if (unit.problem && unit.problem.kind === 'failed') unit.problem = null;
    },

    // What an answer means. answer is { network: true }, or { status, json }
    // with json undefined when the body was not JSON. Returns the outcome:
    //   saved      the server holds this request; send again if clicks are left
    //   caught-up  an earlier request had saved after all; send again if clicks are left
    //   rebased    only the ball moved (Fixed, ready for re-review); send the clicks again
    //   conflict   someone else changed the unit; unit.conflict names the lines dropped
    //   signoff-refused  the server would not sign it off (its words in text); send the clicks
    //   retry      nothing is known to have failed for good; try again in a few seconds
    //   failed     not saved; the next change (or Close) tries again
    //   readonly   the checklist, the job or the part cannot be saved; readonlyScope
    //              ('gate', 'window' or 'unit') says which, locked marks a 403 from the
    //              review locks, formVersion a checklist change, droppedSignoff a sign-off
    //              that will not go (kept in unit.lostSignoff to be named)
    // signedOff names the sign-off the answer confirmed, if any.
    settle(unit, request, answer) {
        unit.inflight = null;
        const json = answer && answer.json && typeof answer.json === 'object' ? answer.json : null;
        const status = answer ? answer.status : 0;
        const serverText = json && typeof json.error === 'string' ? json.error : '';
        const carried = request.signoff && unit.signoff === request.signoff ? request.signoff : null;

        if (!answer || answer.network) {
            unit.sent.push(request);
            unit.wait = 'retry';
            unit.problem = { kind: 'retry', text: '' };
            return { outcome: 'retry' };
        }

        if (status === 200 && json && json.review && typeof json.review === 'object') {
            saveRules.confirm(unit, unit.ops.splice(0, request.opCount), !!carried);
            if (carried) unit.signoff = null;
            unit.base = json.review;
            unit.sent = [];
            unit.problem = null;
            // from: the version this request was made on.
            return { outcome: 'saved', signedOff: carried ? carried.action : '', from: Number(request.rowVersion) || 0 };
        }

        if (json && ((status === 401 && json.needUser) || (status === 409 && json.userChanged))) {
            // Nobody picked, or another name was picked in another tab. The
            // clicks and a sign-off stay, for this page's own user: they go
            // out when the picker says that user is back (userBlocked), or
            // when the page closes under that user. Never under anyone else.
            unit.wait = 'failed';
            unit.userBlocked = true;
            // The server's sentence carries on after a colon, so its capital goes.
            const said = serverText ? serverText.charAt(0).toLowerCase() + serverText.slice(1) : 'choose your name first.';
            unit.problem = { kind: 'failed', text: 'Not saved: ' + said };
            return { outcome: 'failed' };
        }

        if (status === 409 && json && own(json, 'review')) {
            const row = json.review && typeof json.review === 'object' ? json.review : null;
            const oldBase = unit.base;
            const current = saveRules.sheetOf(row);
            const earlier = unit.sent.find(s => s.signoff ? saveRules.signoffLanded(s, row, oldBase)
                : saveRules.sameSheet(s.sheet, current) && saveRules.sameRound(row, oldBase));
            // A request whose answer never came, and not found on the row, may
            // have landed and been undone by someone since: not only the ball.
            const moved = !earlier && !unit.sent.length && saveRules.ballMoved(row, oldBase, unit.signoff);
            // A CSR signing back in made this row, unless it was this window's
            // own Sign back in, landed with its answer lost.
            const ownSignBack = !!earlier && !!earlier.signoff && earlier.signoff.action === 'signback';
            const pendingBack = unit.signoff && unit.signoff.action === 'signback' ? unit.signoff : null;
            const since = pendingBack && pendingBack.since != null ? String(pendingBack.since) : oldBase ? String(plain(oldBase).lastModified || '') : '';
            const cause = ownSignBack ? null : saveRules.herCause(row, oldBase);
            const csr = ownSignBack ? null : saveRules.csrCause(row, oldBase, since);
            const baseVersion = oldBase ? Number(plain(oldBase).rowVersion) || 0 : 0;
            unit.base = row;
            unit.sent = [];
            unit.problem = null;
            if (earlier) {
                // That earlier request did save; only its answer was lost.
                const landed = earlier.signoff && unit.signoff === earlier.signoff ? earlier.signoff : null;
                saveRules.confirm(unit, unit.ops.splice(0, earlier.opCount), !!landed);
                if (landed) unit.signoff = null;
                const signedOff = landed ? landed.action : '';
                // A CSR signed it back in after that request landed: whatever
                // is still waiting was done on what was there before, so it is
                // named, never sent onto the new proof. And a Sign back in
                // still waiting is never sent over a change someone made after
                // it: every request waiting went with the old version, so at
                // most one landed, leaving the row exactly one on (decision 5).
                // (A clearing sign back in on the CSR checklist raises its
                // round, so a lost save is never found on a row it cleared.)
                // A row with the old answers one on could as well be a
                // production sign back in, so that is not taken as hers.
                const stale = !!cause ||
                    (!!unit.signoff && unit.signoff.action === 'signback' && (Number(plain(row).rowVersion) !== baseVersion + 1 ||
                        !saveRules.samePerson(plain(row).lastModifiedByName, plain(row).lastModifiedByLogin, unit.signoff.by) ||
                        saveRules.sameSheet(current, saveRules.sheetOf(oldBase))));
                if (stale) return Object.assign(saveRules.dropForConflict(unit, cause, signedOff, csr), { baseVersion });
                return { outcome: 'caught-up', signedOff };
            }
            if (moved) return { outcome: 'rebased' };
            return Object.assign(saveRules.dropForConflict(unit, cause, '', csr), { baseVersion });
        }

        if (status === 400 && saveRules.herChangeWaiting(unit.base)) {
            // The block is the CSR's change, with the operator: the server
            // checks nothing on it until Fixed. What was waiting is named with
            // her as the cause and never sent again, and the block is left idle
            // so a refresh can bring in Fixed (decision 5).
            unit.sent = [];
            unit.problem = null;
            unit.wait = '';
            return saveRules.dropForConflict(unit, saveRules.herCause(unit.base, null), '', null);
        }

        if (status === 400 && carried) {
            // The server would not sign it off (an incomplete sheet, say). The
            // sign-off is dropped with its words; the clicks it carried still
            // need saving, so the caller sends them as a plain save.
            unit.signoff = null;
            unit.refused = serverText || 'The server did not accept that.';
            return { outcome: 'signoff-refused', text: unit.refused, signoff: carried };
        }

        if (status === 403 && json && json.locked) {
            // The review locks say this person may not change this checklist.
            // They work per checklist, so the other tabs are not touched.
            unit.readonly = serverText || 'You cannot change this checklist.';
            const droppedSignoff = saveRules.dropSignoff(unit);
            unit.problem = null;
            return { outcome: 'readonly', readonlyScope: 'gate', text: unit.readonly, locked: true, droppedSignoff };
        }

        if (status === 409 && json && typeof json.formVersion === 'string') {
            // This page's checklist is not the one the server enforces.
            unit.readonly = serverText || 'The checklist was updated. Reload the page.';
            const droppedSignoff = saveRules.dropSignoff(unit);
            unit.problem = null;
            return { outcome: 'readonly', readonlyScope: 'window', text: unit.readonly, formVersion: json.formVersion, droppedSignoff };
        }

        if (status === 409 || status === 404 || (status === 503 && json && json.available === false)) {
            const droppedSignoff = saveRules.dropSignoff(unit);
            const scope = status === 404 && serverText !== 'Job not found' ? 'unit' : 'window';
            unit.readonly = serverText || (status === 404 ? 'This part is not on the job any more.' : 'This job cannot be reviewed right now.');
            unit.problem = null;
            return { outcome: 'readonly', readonlyScope: scope, text: unit.readonly, droppedSignoff };
        }

        if (status === 503 && json) {
            // The database was busy and the write rolled back.
            unit.wait = 'retry';
            unit.problem = { kind: 'retry', text: '' };
            return { outcome: 'retry' };
        }

        if (status >= 500 || status === 200) {
            // It may have saved before the error, so remember what it carried.
            unit.sent.push(request);
            unit.wait = 'failed';
            unit.problem = { kind: 'failed', text: 'Not saved: the server had a problem. Your next change tries again.' };
            return { outcome: 'failed' };
        }

        unit.wait = 'failed';
        unit.problem = { kind: 'failed', text: 'Not saved: ' + (serverText || 'the server did not accept this change.') };
        return { outcome: 'failed' };
    }
};

if (typeof document === 'undefined') {
    // Loaded by a dev check, not a page.
    if (typeof window !== 'undefined') window.reviewSaveRules = saveRules;
    return;
}


// ── A link from an email (PHASE5_PLAN section d) ──
//
// <APP_BASE_URL>/?review=<job id>&tab=<prepress|techservices|csr>&piece=<piece id>
// app.js asks for this when the page starts, after the user picker, and shows
// the job list with the QC Review window on top. It is answered here, above
// the checks below, so a link still has an answer when the checklist file did
// not load and the rest of this file stops.

function reviewLinkFromAddress() {
    let values;
    try {
        values = new URLSearchParams(window.location.search);
    } catch (e) {
        return null;
    }
    const jobId = String(values.get('review') || '').trim();
    if (!jobId) return null;
    return {
        jobId,
        tab: String(values.get('tab') || '').trim().toLowerCase(),
        piece: String(values.get('piece') || '').trim()
    };
}

window.reviewLinkFromAddress = reviewLinkFromAddress;


// ── The window ──

const modal = document.getElementById('reviewModal');
const openBtn = document.getElementById('reviewOpenBtn');
if (typeof REVIEW_ITEMS === 'undefined' || !modal || !openBtn) return;

const tabsEl = document.getElementById('reviewTabs');
const bodyEl = document.getElementById('reviewBody');
const sideEl = document.getElementById('reviewSide');
const sheetEl = document.getElementById('reviewSheet');
const jobEl = document.getElementById('reviewJob');
const footEl = document.getElementById('reviewFoot');
const saveLineEl = document.getElementById('reviewSaveLine');

const NOTE_DELAY_MS = 800;
const RETRY_MS = 5000;
const CLOSE_WAIT_MS = 5000;
const SAVE_TIMEOUT_MS = 20000;
const KEEPALIVE_BYTES = 60000;
const NOTE_MAX = 2000;
const REASON_MAX = 500;           // the server's limit for an N/A's words
const REFRESH_MS = 1200;          // after saves, reload who has the ball and the activity once the clicks settle
const ACTIVITY_AGAIN_MS = 6000;   // email lines are written after the reply: one more look a few seconds on
const PATHS_MAX = 4000;           // the server's limit for the Send to CSR box
const SEND_NOTE_MAX = 4000;       // and for the operator's note on Send for review and Fixed
const SVG_NS = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Tabs in the order the work happens (David, 2026-09-13). The checklist file,
// its gate order and every formVersion stay as they are.
const TAB_ORDER = ['prepress', 'techservices', 'csr'];
// The departments a CSR correction can go to.
const DEPTS = ['prepress', 'techservices'];
const MISMATCH_KEY = 'reviewChecklistMismatch';
const PAGE_LOADED = String(Date.now());

// Kept for the life of the page, so an answer that arrives after Close is
// still handled, and opening the same job again carries on where it was.
const units = new Map();          // 'jobId|gate|unitId' -> unit (saveRules.newUnit plus its address)
const drafts = new Map();         // 'jobId|gate|unitId|itemId' -> note text typed, not yet a click
// The same, for an N/A's words. Its own map, because a line can be both flagged
// and N/A, and the note's key is read back by its last '|'.
const whyDrafts = new Map();
let pressHold = null;             // a press held down on a block's top strip or the side panel (onMouseDown)
const HOLD_MAX_MS = 3000;
let activityWords = new Map();    // na_set row id -> the words that N/A was last given
const jobs = new Map();           // jobId -> the job as last loaded (header and pieces)
const readonlyJobs = new Map();   // jobId -> the server's reason no block on it can be saved
const readonlyGates = new Map();  // 'jobId|gate' -> the review locks' reason no block on that checklist can be saved
const retryTimers = new Map();    // unit key -> timer
const states = new Map();         // jobId -> { viewer, access, gates, formVersions } from the last reviews GET
const activity = new Map();       // jobId -> the job's QC history, newest first
// jobId -> the signed sheets on this job, newest first, without their contents.
// A frozen sheet carries the work order it was signed against, so the history
// list leaves it out and one is fetched by its row id when it is opened.
const sheets = new Map();
let sheetOpen = null;             // { logId, loading, error, row, frozen }
let exporting = null;             // the export under way: { frame, logId, title, done }, Export all's with all: true

const win = {
    open: false, opening: false, closing: false, jobId: '', gate: 'prepress', openUnit: null, loadText: '', token: 0,
    confirm: null,   // the one confirm showing: { kind, gate, unitId, flagDepts, note, production, ticked }
    sideNote: '',    // the server's words when a panel button did not go through
    exportNote: '',  // why the last Export all printed nothing, under the Activity heading
    busy: false,     // a panel button or Reopen is on its way
    // Each piece's hand-back mark as this window has shown it: from the read
    // that opened the window, moved on only when the red line names that piece
    // ('gate|unitId' -> mark, null when it was not with the operator).
    // Fixed sends a piece only on that mark (STALE_FIXED_PLAN.md).
    ack: new Map(),
    fixedReading: false,   // Fixed's read of the latest is on its way
    heldOut: [],     // pieces the red line names as kept out of Fixed: [{ unitId, by }]
    sentNote: '',    // the pieces that Fixed just sent, said above the red line while it names others
    gone: new Set(), // 'gate|unitId' of rows whose piece the last reviews read says was deleted
    link: null,      // opened from an email: { tab, piece, inAddress }
    // A deleted job's QC record, read only (item 7): { jobNumber, clientName,
    // jobDescription, deletedAt, deletedBy }, or null for a job that exists.
    record: null
};
// What someone has pasted into the Send to CSR box, per job and checklist, with
// where the caret was. The panel is rebuilt from scratch on every draw, so the
// box's text has to live out here or it would vanish under them.
const pathDrafts = new Map();     // 'jobId|gate' -> { text, start, end, edited }
// What the operator has typed for the reviewer in the Send for review or the
// Fixed, ready for re-review box (OPERATOR_NOTE_PLAN, David 2026-10-01), kept
// out here for the same reason. It starts empty every time: nothing from an
// earlier press is put back in it.
const noteDrafts = new Map();     // 'jobId|gate|send' or 'jobId|gate|reready' -> { text, start, end }
// The last press on each section, so its Undo takes back exactly those lines
// and nothing else. Dropped as soon as one of them is unticked by hand: it
// could no longer take back exactly what the press did.
const sectionPresses = new Map();   // 'jobId|gate|unitId|section' -> [itemId]
let noteTimer = null;
let refreshTimer = null;
let activityTimer = null;
let refreshSeq = 0;               // the newest reviews reload; an older answer is dropped
let activitySeq = 0;              // the same for the activity list
let rendered = null;              // { gate, banners, blocks: Map unitId -> { head, count, chip, alert, top, rows: Map itemId -> row parts } }
let tabDirection = '';

function el(tag, className, text) {
    return elIn(document, tag, className, text);
}

// The same in another document: a signed sheet's export frame.
function elIn(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(className, text, action, attrs) {
    const node = el('button', className, text);
    node.type = 'button';
    node.setAttribute('data-review-action', action);
    Object.keys(attrs || {}).forEach(name => node.setAttribute(name, attrs[name]));
    return node;
}

function svg(className, paths, strokeWidth) {
    const node = document.createElementNS(SVG_NS, 'svg');
    node.setAttribute('class', className);
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', strokeWidth || '2');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('aria-hidden', 'true');
    paths.forEach(d => {
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', d);
        node.appendChild(p);
    });
    return node;
}

const FLAG_PATHS = ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'];

function gateInfo(gate) {
    return REVIEW_ITEMS.gates.find(g => g.gate === gate) || null;
}

function gateLabel(gate) {
    const g = gateInfo(gate);
    return g ? g.label : '';
}

function deptClass(gate) {
    return gate === 'prepress' ? 'dept-prepress' : gate === 'techservices' ? 'dept-techservices' : '';
}

function userName() {
    try {
        return typeof getUserName === 'function' ? String(getUserName() || '') : '';
    } catch (e) {
        return '';
    }
}

// The headers every request here carries: the user this page is showing.
function userHeaders(extra) {
    return Object.assign({ 'X-STS-User': encodeURIComponent(userName()) }, extra || {});
}

// The server did not take a request for the user (not picked, taken off the
// list, or changed in another tab): the user picker finds out which and covers
// the page.
function noticeUserAnswer(status, json) {
    if (!json || !((status === 401 && json.needUser) || (status === 409 && json.userChanged))) return;
    if (window.userPicker) window.userPicker.checkNow();
}

// The picker says this page's user is picked again (the same person, after a
// lapse or a removal, or after another tab changed back): whatever was held
// for them goes out now, and a load refused for them runs again (review Q1).
function onUserBack() {
    if (win.open && !win.opening && win.loadForUser) {
        win.opening = true;
        win.loadText = 'Loading...';
        renderBody();
        renderFooter();
        loadWindow(++win.token);
        return;
    }
    units.forEach(u => {
        if (!u.userBlocked) return;
        u.userBlocked = false;
        if (u.inflight || u.readonly || (!u.ops.length && !u.signoff)) return;
        if (!win.open || win.jobId !== u.jobId) return;   // sent on the next open (resumeSaves)
        clearRetry(u);
        pump(u, true);
    });
}

// Another user was picked in another tab since this page started.
function userChangedElsewhere() {
    if (!window.userPicker) return false;
    return String(window.userPicker.cookieUser() || '').toLowerCase() !== userName().toLowerCase();
}

function storageGet(key) {
    try { return window.sessionStorage.getItem(key) || ''; } catch (e) { return ''; }
}

function storageSet(key, value) {
    try {
        if (value) window.sessionStorage.setItem(key, value);
        else window.sessionStorage.removeItem(key);
    } catch (e) { /* private window: the message just says "Reload" each time */ }
}

function unitKey(jobId, gate, unitId) {
    return jobId + '|' + gate + '|' + unitId;
}

function unitFor(jobId, gate, unitId) {
    const key = unitKey(jobId, gate, unitId);
    let unit = units.get(key);
    if (!unit) {
        unit = Object.assign(saveRules.newUnit(null), { key, jobId, gate, unitId });
        unit.readonly = shutReason(jobId, gate);
        units.set(key, unit);
    }
    return unit;
}

// Why nothing on this checklist can be saved now, or ''.
function shutReason(jobId, gate) {
    return readonlyJobs.get(jobId) || readonlyGates.get(jobId + '|' + gate) || '';
}

function jobUnits(jobId) {
    return Array.from(units.values())
        .filter(u => u.jobId === jobId)
        .sort((a, b) => TAB_ORDER.indexOf(a.gate) - TAB_ORDER.indexOf(b.gate));
}

// The blocks a tab shows, in order: every piece, then Whole Job, on Prepress;
// the one checklist on CSR and Tech Services.
function unitIdsFor(jobId, gate) {
    const g = gateInfo(gate);
    const job = jobs.get(jobId);
    if (!g || !g.perPiece) return ['job'];
    const pieces = job && Array.isArray(job.components) ? job.components.map(c => String(c.id)) : [];
    return pieces.concat(['job']);
}

function pieceOf(jobId, unitId) {
    const job = jobs.get(jobId);
    return job && Array.isArray(job.components) ? job.components.find(c => String(c.id) === unitId) || null : null;
}

function unitName(unit) {
    if (unit.unitId === 'job') {
        const g = gateInfo(unit.gate);
        return g && g.perPiece ? 'Whole Job' : (g ? g.label : '') + ' Checklist';
    }
    const piece = pieceOf(unit.jobId, unit.unitId);
    if (!piece) return 'a part no longer on this job';
    return (piece.version ? piece.version + ' ' : '') + (piece.name || '');
}

// A block's name inside a sentence: "the Whole Job checks", "the CSR Checklist", "V2 Letter".
function unitPhrase(unit) {
    if (unit.unitId !== 'job') return unitName(unit);
    const g = gateInfo(unit.gate);
    return g && g.perPiece ? 'the Whole Job checks' : 'the ' + unitName(unit);
}

// Flat Size and Presswork as picked on the work order, left out when the row
// is switched off, empty, or N/A.
function pieceSubLine(piece) {
    const boxes = plain(piece && piece.checkboxes);
    const notes = plain(piece && piece.notes);
    return [['ps3', 'ps3n'], ['sp2', 'sp2n']]
        .map(([box, note]) => {
            if (boxes[box] !== true) return '';
            const value = String(notes[note] == null ? '' : notes[note]).trim();
            return value && value.toUpperCase() !== 'N/A' ? value : '';
        })
        .filter(Boolean)
        .join(', ');
}

function lineLabel(gate, id) {
    const item = REVIEW_ITEMS.findItem(gate, id);
    return item ? item.label : id;
}

function personText(name, login) {
    return String(name || login || '');
}

function joinAnd(list) {
    return list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

// ── Who may do what, as the server said ──

function stateOf(jobId) {
    return states.get(jobId) || null;
}

// What the viewer may do on a tab. Nothing at all until the server has said.
function accessFor(jobId, gate) {
    const s = stateOf(jobId);
    const a = s && s.access && s.access[gate];
    return a || { role: '', canEdit: false, canSend: false, canReready: false, canSignBack: false, reason: '', owner: {} };
}

function gateRowFor(jobId, gate) {
    const s = stateOf(jobId);
    return s && Array.isArray(s.gates) ? s.gates.find(g => g.gate === gate) || null : null;
}

function viewerOf(jobId) {
    const s = stateOf(jobId);
    return s && s.viewer ? s.viewer : { login: '', name: '', source: '', kinds: [] };
}

// Who is asking, as sign-offs record it: the server's viewer, else the page's
// user (its key is what the server stamps).
function viewerBy(jobId) {
    const v = viewerOf(jobId);
    return { name: v.name || userName(), login: v.login || userName().toLowerCase() };
}

function isViewer(jobId, name, login) {
    return saveRules.samePerson(name, login, viewerBy(jobId));
}

function sentBy(row) {
    return row ? personText(row.sentForReviewByName, row.sentForReviewByLogin) : '';
}

// The operator the sentences name: whoever sent it for review, in every round
// (David, 2026-09-18).
function operatorName(jobId, gate) {
    return sentBy(gateRowFor(jobId, gate));
}


// The tab to open on: the viewer's own department once they are linked; on
// more than one list, the work order's tab if it is one of theirs, otherwise
// the first of theirs in tab order. Not linked: the work order's tab.
function defaultTab(jobId, requested) {
    const s = stateOf(jobId);
    if (!s || !s.access) return requested;
    const linked = Object.keys(s.access).some(g => s.access[g].role !== 'unlinked');
    const kinds = Array.isArray(viewerOf(jobId).kinds) ? viewerOf(jobId).kinds : [];
    const mine = TAB_ORDER.filter(g => gateInfo(g) && kinds.includes(g));
    if (!linked || !mine.length) return requested;
    return mine.includes(requested) ? requested : mine[0];
}

// ── Time ──

function clockText(date) {
    const h = date.getHours();
    return (h % 12 || 12) + ':' + String(date.getMinutes()).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
}

// '' for today, 'Sep 12' this year, 'Sep 12 2025' before.
function dayText(date) {
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return '';
    const day = MONTHS[date.getMonth()] + ' ' + date.getDate();
    return date.getFullYear() === now.getFullYear() ? day : day + ' ' + date.getFullYear();
}

// "Today, 2:33 PM", "Sep 12, 2:33 PM", "Sep 12 2025, 2:33 PM" (browser time).
function reviewWhen(iso) {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return (dayText(date) || 'Today') + ', ' + clockText(date);
}

// The department's signoff due on the work order ("Sep 15, 2:00 PM"), or ''.
function dueText(job, gate) {
    const suffix = gate === 'prepress' ? 'Prepress' : gate === 'techservices' ? 'Techservices' : '';
    const date = suffix ? String(job['signoffDueDate' + suffix] || '').trim() : '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const day = MONTHS[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() === new Date().getFullYear() ? '' : ' ' + d.getFullYear());
    const time = String(job['signoffDueTime' + suffix] || '').trim();
    return day + (time ? ', ' + time : '');
}

// ── Opening and closing ──

async function getJson(url) {
    try {
        const res = await fetch(url, { headers: userHeaders({ 'Accept': 'application/json' }) });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch (e) { json = undefined; }
        noticeUserAnswer(res.status, json);
        return { status: res.status, ok: res.ok, json: json && typeof json === 'object' ? json : null };
    } catch (e) {
        return { status: 0, ok: false, json: null };
    }
}

async function postJson(url, body) {
    try {
        const res = await fetch(url, { method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch (e) { json = undefined; }
        noticeUserAnswer(res.status, json);
        return { status: res.status, ok: res.ok, json: json && typeof json === 'object' ? json : null };
    } catch (e) {
        return { status: 0, ok: false, json: null };
    }
}

function reviewsUrl(jobId) {
    return '/api/jobs/' + encodeURIComponent(jobId) + '/reviews';
}

// ── The email Outlook opens (OUTLOOK_EMAIL_PLAN.md, 2026-10-26) ──
//
// The app never sends an email. A press that emails gets its emails back in
// the reply (`emails`: each a mailto link, the names in To, and the press it
// belongs to), and this hands each one to a hidden frame, so Outlook opens a
// new message on this screen with To, Subject and the body filled in, and the
// person presses Send. A hidden frame, never location.href: a mailto set on
// the page itself fires the page's own beforeunload (probed in Chrome 149),
// which the work order answers with "Leave site?" when a save is owed. Proven
// on David's laptop (2026-10-26): the frame opens Outlook with no prompt, also
// seven seconds after the click, and two addresses in To both show. Several
// emails from one press (a Fixed on two pieces, a sign back in to both
// departments) open one after another, MAIL_OPEN_GAP_MS apart, each in a
// frame of its own: a frame given a second mailto before Outlook has taken
// the first would lose it (inferred). Once a frame has the link the server is
// told (POST .../email-opened), and that is the "Email opened in Outlook for
// ..." row in the activity: a page gone before the reply writes nothing,
// which is the truth (David's answer 1). Nothing else is written or read.
const MAIL_OPEN_GAP_MS = 1500;
let mailFrame = null;
let mailTimer = null;
const mailQueue = [];

function openOutlook(jobId, emails) {
    if (!Array.isArray(emails)) return;
    emails.forEach(email => {
        if (email && typeof email.href === 'string' && /^mailto:/i.test(email.href)) mailQueue.push({ jobId, email });
    });
    if (mailQueue.length && !mailTimer) openNextEmail();
}

function openNextEmail() {
    mailTimer = null;
    const next = mailQueue.shift();
    if (!next) return;
    if (mailFrame && mailFrame.parentNode) mailFrame.parentNode.removeChild(mailFrame);
    mailFrame = document.createElement('iframe');
    mailFrame.className = 'review-mail-frame';
    mailFrame.setAttribute('aria-hidden', 'true');
    mailFrame.tabIndex = -1;
    document.body.appendChild(mailFrame);
    mailFrame.src = next.email.href;
    reportEmailOpened(next.jobId, next.email);
    mailTimer = setTimeout(openNextEmail, MAIL_OPEN_GAP_MS);
}

// The page's word that the frame has the email. The server writes the row;
// the activity list reads it again a moment later (activityAgain).
async function reportEmailOpened(jobId, email) {
    const record = email.record && typeof email.record === 'object' ? email.record : {};
    const gate = String(record.gate || win.gate || '');
    if (!gate) return;
    await postJson('/api/jobs/' + encodeURIComponent(jobId) + '/reviews/' + encodeURIComponent(gate) + '/email-opened',
        { names: Array.isArray(email.names) ? email.names : [], record });
    if (win.open && win.jobId === jobId) activityAgain(jobId);
}

// An app pop-up earlier in the page than the window (Edit Job, New Job, Export,
// Import, Add Component) is showing. The window would paint over it and leave
// it out of reach, so the header button does nothing while one is.
function coveredPopupOpen() {
    return Array.from(document.querySelectorAll('.modal')).some(other => other !== modal &&
        !!(other.compareDocumentPosition(modal) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        getComputedStyle(other).display !== 'none');
}

// options.link is the link this window was opened from (section d): its tab
// and piece win over the viewer's own department, and the address bar is
// cleaned once the window has drawn.
async function openReview(jobId, gate, options) {
    if (win.open || win.opening || !jobId || coveredPopupOpen()) return;
    // The new job box sits over the work order; the window is about to cover
    // both, and a box left open would be out of reach behind it.
    closeNewJobBox();
    const token = ++win.token;
    refreshSeq++;   // a reload from an earlier visit must not land on this one
    win.open = true;
    win.opening = true;
    win.jobId = String(jobId);
    win.gate = gateInfo(gate) ? gate : 'prepress';
    win.link = options && options.link
        ? { tab: String(options.link.tab || ''), piece: String(options.link.piece || ''), inAddress: true }
        : null;
    win.openUnit = null;
    win.loadText = 'Loading...';
    win.confirm = null;
    clearSideNote();
    win.exportNote = '';
    win.busy = false;
    win.ack = new Map();
    win.fixedReading = false;
    win.gone = new Set();
    win.record = null;
    modal.classList.remove('review-modal--record');
    document.addEventListener('focusin', onDocumentFocusIn, true);
    document.addEventListener('beforeinput', onDocumentBeforeInput, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    modal.classList.add('is-open');
    renderHeader();
    renderTabs();
    renderBody();
    renderSide();
    renderFooter();
    modal.focus({ preventScroll: true });
    await loadWindow(token);
}

// The job and its reviews, drawn into the window opened (or reopened) with token.
async function loadWindow(token) {
    const id = encodeURIComponent(win.jobId);
    const [jobRes, reviewRes] = await Promise.all([getJson('/api/jobs/' + id), getJson(reviewsUrl(win.jobId))]);
    if (token !== win.token) return;   // closed while loading
    // Neither is there: a deleted job. Its QC record opens read only when it
    // has one (item 7); asked before the window takes clicks.
    let history = null;
    if (jobRes.status === 404 && reviewRes.status === 404) {
        history = await historyRows(win.jobId);
        if (token !== win.token) return;
    }
    win.opening = false;
    // Refused for the user (not picked yet): loaded again when the picker says the user is back.
    win.loadForUser = reviewRes.status === 401 || (reviewRes.status === 409 && !!reviewRes.json && !!reviewRes.json.userChanged) ||
        (!!history && history.status === 401);

    if (jobRes.ok && jobRes.json) jobs.set(win.jobId, jobRes.json);
    if (history && history.rows && history.rows.length) {
        openRecord(win.jobId, history.rows);
        return;
    }
    if (history && !history.rows) {
        // Gone, but whether it left a record could not be read: never "Job
        // not found" for a job that may have one.
        win.loadText = 'Could not load this job.';
    } else if (reviewRes.status === 503 && reviewRes.json && reviewRes.json.available === false) {
        win.loadText = reviewRes.json.error || 'QC Review is not set up on this server yet.';
    } else if (!jobRes.ok || !jobRes.json || !reviewRes.ok || !reviewRes.json) {
        // The server's words only for a job that is not there; a 500 carries
        // a raw database message nobody on the floor can act on.
        const failed = !jobRes.ok ? jobRes : reviewRes;
        win.loadText = failed.status === 404 && failed.json && typeof failed.json.error === 'string' && failed.json.error
            ? failed.json.error : 'Could not load this job.';
    } else {
        win.loadText = '';
        adoptRows(win.jobId, reviewRes.json.units);
        adoptState(win.jobId, reviewRes.json);
        win.ack = new Map();
        (Array.isArray(reviewRes.json.units) ? reviewRes.json.units : []).forEach(row => {
            if (row && Number.isInteger(row.backMark)) win.ack.set(row.gate + '|' + row.unitId, row.backMark);
        });
        noteGone(win.jobId, reviewRes.json.units);
        // Chosen while clicks are still ignored, so it never fights one. A
        // link's own tab wins over the viewer's department, and is kept through
        // a load that had to run again for the user.
        win.gate = win.link && gateInfo(win.link.tab) ? win.link.tab : defaultTab(win.jobId, win.gate);
        if (win.link && win.link.piece) {
            const g = gateInfo(win.gate);
            // Only Prepress has a block per piece, and only a piece still on
            // the job has one at all.
            if (g && g.perPiece && pieceOf(win.jobId, win.link.piece)) win.openUnit = win.link.piece;
        }
        checkChecklist(win.jobId, reviewRes.json.formVersions);
    }
    renderHeader();
    renderTabs();
    renderBody();
    renderSide();
    renderFooter();
    keepFocusInside();
    if (!win.loadText) {
        resumeSaves(win.jobId);
        loadActivity(win.jobId);
        // Drawn and readable: the link has done its job, so it comes out of the
        // address bar. Until then a reload opens it again, which is what the
        // picker and the checklist message both ask for.
        if (!shutReason(win.jobId, win.gate) && !readonlyJobs.get(win.jobId)) clearReviewLink();
        if (win.openUnit && win.openUnit !== 'closed') scrollUnitIntoView(win.openUnit);
        else scrollToWork();
    }
}

// Takes the link out of the address bar, so a reload, Change user or a
// bookmark does not open the window again.
function clearReviewLink() {
    if (!win.link || !win.link.inAddress) return;
    win.link.inAddress = false;
    try {
        window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    } catch (e) {
        // Nothing to do: the link simply opens again on a reload.
    }
}

// The first open block with work waiting on it, brought on screen. Called after
// the lines are drawn: a block opens with its tab on CSR and Tech Services, so
// there is no click to hang the scroll off.
function scrollToWork() {
    const open = Array.from(bodyEl.querySelectorAll('.review-block.is-open'));
    for (const block of open) {
        const unitId = block.getAttribute('data-review-unit');
        const unit = units.get(unitKey(win.jobId, win.gate, unitId));
        if (unit && firstFlaggedId(unit)) {
            scrollUnitIntoView(unitId);
            return;
        }
    }
}

// Brings a block's head into the window's own visible area, the way clicking
// it does.
function scrollUnitIntoView(unitId) {
    const block = bodyEl.querySelector('[data-review-unit="' + unitId + '"]');
    const head = block ? block.querySelector('.review-block-head') : null;
    if (!head) return;
    // A block that was sent back, or that has just come back, opens at the
    // first line still flagged rather than at the top: that is the work.
    const unit = units.get(unitKey(win.jobId, win.gate, unitId));
    const flagged = unit ? firstFlaggedId(unit) : '';
    const line = flagged ? block.querySelector('[data-review-item="' + flagged + '"]') : null;
    requestAnimationFrame(() => {
        const bodyTop = bodyEl.getBoundingClientRect().top;
        if (!line) {
            const top = head.getBoundingClientRect().top - bodyTop + bodyEl.scrollTop;
            bodyEl.scrollTo({ top: Math.max(0, top - 10), behavior: 'smooth' });
            return;
        }
        // Clear of the head and the sign-off strip, which stay put above it.
        const signoff = block.querySelector('.review-unit-top');
        const frozen = head.getBoundingClientRect().height + (signoff ? signoff.getBoundingClientRect().height : 0);
        const top = line.getBoundingClientRect().top - bodyTop + bodyEl.scrollTop - frozen - 12;
        bodyEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    });
}

// Rows from a fresh open. Clears what was read only on the last visit (it is
// worked out again), then takes the rows as idle blocks do.
function adoptRows(jobId, rows) {
    readonlyJobs.delete(jobId);
    TAB_ORDER.forEach(gate => readonlyGates.delete(jobId + '|' + gate));
    jobUnits(jobId).forEach(u => { u.readonly = ''; u.lostSignoff = ''; });
    adoptIdleRows(jobId, rows);
}

// A unit with clicks, a sign-off, a note being typed or a request still
// pending keeps its own state: the answer to that request settles it, and a
// conflict names what did not save. Taking a newer row under a note being typed
// could drop the note without a word (if that flag was taken off meanwhile).
// Nor does the CSR's block with her Sign back in sheet open take a newer row:
// the sheet was filled in against the one it has, so another CSR's sign back
// in meanwhile refuses her press instead of letting it through a second time
// (decision 5, David's answer 4). Leaving the sheet asks for the rows again.
function adoptIdleRows(jobId, rows) {
    (Array.isArray(rows) ? rows : []).forEach(row => {
        if (!row || row.orphaned || !gateInfo(row.gate)) return;
        const unit = unitFor(jobId, row.gate, String(row.unitId));
        const typing = Array.from(drafts.keys()).concat(Array.from(whyDrafts.keys())).some(key => key.indexOf(unit.key + '|') === 0);
        const idle = !unit.ops.length && !unit.inflight && !unit.sent.length && !unit.signoff && !typing && !signBackOpenOn(unit);
        if (idle && (!unit.base || row.rowVersion >= unit.base.rowVersion)) unit.base = row;
    });
}

function adoptState(jobId, json) {
    states.set(jobId, {
        viewer: json.viewer || null,
        access: plain(json.access),
        gates: Array.isArray(json.gates) ? json.gates : [],
        formVersions: plain(json.formVersions),
        // Step 5: whether each department checklist is passed right now, and
        // the newest Send to CSR for each. Both are worked out by the server.
        passedNow: plain(json.passedNow),
        handoffs: plain(json.handoffs),
        // A reviewer who asked the operator to send the files (PHASE6_PLAN d).
        asks: plain(json.asks),
        // What the CSR asked for when she last signed the job back in, per
        // checklist: her words, the blocks she ticked and the lines she flagged
        // for that department (SIGN_BACK_IN_PLAN).
        signBacks: plain(json.signBacks),
        // What the operator typed on this round's Send for review, per
        // checklist, while that send is still the round's (OPERATOR_NOTE_PLAN).
        sendNotes: plain(json.sendNotes)
    });
}

// What the CSR asked for on this checklist's current round, or null. It stands
// until the checklist passes again, so it is on screen for the whole round
// rather than only at the start.
function signBackFor(jobId, gate) {
    const s = stateOf(jobId);
    const row = s ? plain(s.signBacks)[gate] : null;
    if (!row || typeof row !== 'object') return null;
    if (gate !== 'csr' && plain(s.passedNow)[gate]) return null;
    return row;
}

// The newest Send to CSR on one department checklist, or null.
function handoffFor(jobId, gate) {
    const s = stateOf(jobId);
    const sent = s ? plain(s.handoffs)[gate] : null;
    return sent && typeof sent === 'object' ? sent : null;
}

// The reviewer's outstanding "please send the files" on this checklist, or null.
function askFor(jobId, gate) {
    const s = stateOf(jobId);
    const ask = s ? plain(s.asks)[gate] : null;
    return ask && typeof ask === 'object' ? ask : null;
}

// What is in the Send to CSR box for this checklist. Until someone types in
// it, it shows the paths of this round's send, so a small fix is a small edit,
// and nothing once a sign back in has ended that round: a window left open
// across one must not offer round 1's paths again, or call them unsent.
function pathDraft(jobId, gate) {
    const key = jobId + '|' + gate;
    let draft = pathDrafts.get(key);
    if (!draft) {
        draft = { text: '', start: 0, end: 0, edited: false };
        pathDrafts.set(key, draft);
    }
    if (!draft.edited) {
        const sent = handoffFor(jobId, gate);
        draft.text = sent ? String(sent.paths || '') : '';
    }
    return draft;
}

// The note on this checklist's Send for review, or null. The server hands it
// back only while that send is the round's.
function sendNoteFor(jobId, gate) {
    const s = stateOf(jobId);
    const sent = s ? plain(s.sendNotes)[gate] : null;
    return sent && typeof sent === 'object' && String(sent.note || '') ? sent : null;
}

// The pieces waiting to be checked again whose Fixed carried a note, one entry
// per press (the same note, person and time), in the order of the blocks:
// [{ units, fixed }], fixed being the server's fixedNote.
function fixedNotes(jobId, gate) {
    const out = [];
    unitIdsFor(jobId, gate).forEach(id => {
        const unit = units.get(unitKey(jobId, gate, id));
        const row = unit && unit.base;
        const f = row && row.disposition === 'corrections' && row.holder === 'reviewer' ? row.fixedNote : null;
        if (!f || typeof f !== 'object' || !String(f.note || '')) return;
        const same = out.find(o => o.fixed.whenIso === f.whenIso && o.fixed.note === f.note &&
            saveRules.samePerson(o.fixed.actorName, o.fixed.actorLogin, { name: f.actorName, login: f.actorLogin }));
        if (same) same.units.push(unit);
        else out.push({ units: [unit], fixed: f });
    });
    return out;
}

// What is in the Send for review or Fixed box: what was typed since it opened
// on this checklist, else nothing.
function noteDraft(jobId, gate, kind) {
    const key = jobId + '|' + gate + '|' + kind;
    let draft = noteDrafts.get(key);
    if (!draft) {
        draft = { text: '', start: 0, end: 0 };
        noteDrafts.set(key, draft);
    }
    return draft;
}

// A note typed for the reviewer and never sent, on any checklist of this job.
function notesWaiting(jobId) {
    return Array.from(noteDrafts.entries()).some(([key, draft]) => key.indexOf(jobId + '|') === 0 && String(draft.text).trim());
}

// Paths typed into a box and never sent, on any checklist of this job.
function pathsWaiting(jobId) {
    return TAB_ORDER.some(gate => {
        const draft = pathDrafts.get(jobId + '|' + gate);
        if (!draft || !draft.edited || !String(draft.text).trim()) return false;
        const sent = handoffFor(jobId, gate);
        return !sent || String(sent.paths || '') !== String(draft.text);
    });
}

// PHASE4_PLAN e2: this page's checklists must be the ones the server enforces.
// The first time they differ on a page, the page is the older one: reload it.
// If a page loaded since then still differs, the page has the file from disk
// and the server does not: the service needs a restart (the 2026-08-10 failure).
function checkChecklist(jobId, serverVersions) {
    const versions = plain(serverVersions);
    const differs = REVIEW_ITEMS.gates.some(g => versions[g.gate] && versions[g.gate] !== REVIEW_ITEMS.formVersion(g.gate));
    if (!differs) {
        storageSet(MISMATCH_KEY, '');
        return false;
    }
    markChecklistChanged(jobId);
    return true;
}

function markChecklistChanged(jobId) {
    const noted = storageGet(MISMATCH_KEY);
    const afterReload = !!noted && noted !== PAGE_LOADED;
    if (!noted) storageSet(MISMATCH_KEY, PAGE_LOADED);
    const text = afterReload ? 'The server needs a restart after the checklist change. Tell IT.' : 'The checklist was updated. Reload the page.';
    readonlyJobs.set(jobId, text);
    jobUnits(jobId).forEach(u => { u.readonly = text; saveRules.dropSignoff(u); clearRetry(u); });
}

// Reload who may do what, the gate rows, idle blocks and the activity list:
// after this window's own actions, and when the browser tab comes back into
// view. No polling; email (step 5) is what brings people back.
async function refreshFromServer(jobId) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    // A deleted job's record has only its history to read again.
    if (win.record) {
        refreshSeq++;
        loadActivity(jobId);
        return;
    }
    const seq = ++refreshSeq;
    const res = await getJson(reviewsUrl(jobId));
    if (seq !== refreshSeq || !win.open || win.opening || win.jobId !== jobId) return;
    const reloaded = res.ok && res.json && res.json.available !== false;
    if (reloaded) applyReviews(jobId, res.json);
    else sheetsBackAfterReload(jobId, false);
    loadActivity(jobId);
}

// A reviews read drawn into the open window: idle blocks take the newer rows.
function applyReviews(jobId, json) {
    noteGone(jobId, json.units);
    const before = accessSignature(jobId);
    adoptIdleRows(jobId, json.units);
    adoptState(jobId, json);
    sheetsBackAfterReload(jobId, true);
    liftNotSentLocks(jobId);
    checkChecklist(jobId, json.formVersions);
    if (accessSignature(jobId) !== before) {
        renderBody();
    } else {
        jobUnits(jobId).forEach(u => refreshUnit(u));
        renderBanners();
    }
    renderSide();
    renderFooter();
    keepFocusInside();
}

// A checklist refused as not sent yet opens once someone sends it: the lock
// that refusal left on this window goes as soon as the server says it is sent,
// and the window then says what this person may do, the operator's line
// included when it was the viewer who sent it. Other locks stay until the
// window is opened again.
const NOT_SENT_TEXT = 'Read only until it is sent for review.';   // the server's REVIEW_NOT_SENT

function liftNotSentLocks(jobId) {
    TAB_ORDER.forEach(gate => {
        const key = jobId + '|' + gate;
        if (readonlyGates.get(key) !== NOT_SENT_TEXT || !sentBy(gateRowFor(jobId, gate))) return;
        readonlyGates.delete(key);
        const canEdit = accessFor(jobId, gate).canEdit;
        jobUnits(jobId).filter(u => u.gate === gate && u.readonly === NOT_SENT_TEXT).forEach(u => {
            u.readonly = '';
            if (!u.ops.length) return;
            // A click refused while it was closed saves now. Anyone the server
            // says may not edit (above all whoever sent it, the operator) never
            // may, so theirs go, and the block is idle again so it takes newer
            // rows.
            if (canEdit) {
                pump(u, true);
            } else {
                u.ops = [];
                u.sent = [];
                u.wait = '';
                u.problem = null;
                clearRetry(u);
                [drafts, whyDrafts].forEach(map => Array.from(map.keys()).forEach(k => { if (k.indexOf(u.key + '|') === 0) map.delete(k); }));
            }
        });
    });
}

function refreshSoon(jobId) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (win.open && !win.opening && win.jobId === jobId) refreshFromServer(jobId);
    }, REFRESH_MS);
}

// What would change the whole tab: who the viewer is on it.
function accessSignature(jobId) {
    const a = accessFor(jobId, win.gate);
    return [win.gate, a.role, a.canEdit, shutReason(jobId, win.gate)].join('|');
}

async function loadActivity(jobId) {
    const seq = ++activitySeq;
    const res = await getJson('/api/jobs/' + encodeURIComponent(jobId) + '/review-log');
    if (seq === activitySeq && res.ok && res.json && Array.isArray(res.json.entries)) {
        adoptHistory(jobId, res.json.entries.filter(Boolean));
        if (win.open && win.jobId === jobId) renderActivity();
    }
}

function adoptHistory(jobId, rows) {
    activity.set(jobId, rows.filter(e => e.logAction !== 'signoff_snapshot'));
    sheets.set(jobId, rows.filter(e => e.logAction === 'signoff_snapshot'));
}

// The job's history, newest first: { rows } when it was read, else
// { status } (0 when the server did not answer).
async function historyRows(jobId) {
    ++activitySeq;
    const res = await getJson('/api/jobs/' + encodeURIComponent(jobId) + '/review-log');
    if (!res.ok || !res.json || !Array.isArray(res.json.entries)) return { rows: null, status: res.status || 0 };
    return { rows: res.json.entries.filter(Boolean), status: res.status };
}

// ── A deleted job's QC record (item 7, DELETED_QC_PLAN.md) ──
//
// The job and its pieces are gone; its history and its signed sheets are
// kept. The window shows them read only: no tabs (a checklist needs its
// pieces), no side panel, the history full width in the body, and every
// signed sheet with Export as on a live job. Nothing here saves anything.

function openRecord(jobId, rows) {
    // The newest job_deleted row says who deleted it, when, and what it was;
    // a job deleted before those rows were written has none.
    const gone = rows.find(e => e.logAction === 'job_deleted') || null;
    const facts = gone ? safeDetail(gone.detail) : {};
    const text = v => (v == null ? '' : String(v).trim());
    win.record = {
        jobNumber: text(gone ? gone.jobNumber : '') || text((rows[0] || {}).jobNumber),
        clientName: text(facts.clientName),
        jobDescription: text(facts.jobDescription),
        deletedAt: gone ? text(gone.whenIso) : '',
        deletedBy: gone ? personText(gone.actorName, gone.actorLogin) : ''
    };
    // What this page still holds from a visit while the job existed must not
    // show here (a "Changes needed" tag read off an old block) or go out
    // later (a click never sent, retried into a job that is gone).
    forgetJob(jobId);
    adoptHistory(jobId, rows);
    win.loadText = '';
    modal.classList.add('review-modal--record');
    renderHeader();
    renderTabs();
    renderBody();
    renderSide();
    renderFooter();
    keepFocusInside();
    // Drawn and readable: the link has done its job.
    clearReviewLink();
}

function forgetJob(jobId) {
    jobs.delete(jobId);
    states.delete(jobId);
    readonlyJobs.delete(jobId);
    TAB_ORDER.forEach(gate => readonlyGates.delete(jobId + '|' + gate));
    Array.from(units.entries()).forEach(([key, unit]) => {
        if (unit.jobId !== jobId) return;
        clearRetry(unit);
        sheetsBack.delete(key);
        units.delete(key);
        [drafts, whyDrafts].forEach(map => Array.from(map.keys()).forEach(k => { if (k.indexOf(key + '|') === 0) map.delete(k); }));
    });
}

// "This job was deleted Sep 29 2026, 3:05 PM by David Marra."
function recordLine() {
    const r = win.record;
    const when = r.deletedAt ? fullWhen(r.deletedAt) : '';
    if (!when) return 'This job was deleted. When, and by whom, was not recorded.';
    return 'This job was deleted ' + when + (r.deletedBy ? ' by ' + r.deletedBy : '') + '.';
}

function renderRecordBody() {
    const alert = el('div', 'review-alert review-record-line');
    alert.appendChild(el('div', 'review-record-title', recordLine()));
    alert.appendChild(el('div', 'review-record-text', 'This is its QC record. Nothing on it can be changed.'));
    bodyEl.appendChild(alert);
    bodyEl.appendChild(activityBox('review-record'));
    renderActivity();
}

// The Activity heading with Export all on its right (drawn by renderActivity
// once the history is read), why the last Export all printed nothing, and the
// list: the side panel's, and a deleted job's record's.
function activityBox(className) {
    const box = el('div', className);
    const head = el('div', 'review-activity-head');
    head.appendChild(el('div', 'review-side-title', 'Activity'));
    head.appendChild(el('div', 'review-activity-tools'));
    box.appendChild(head);
    box.appendChild(el('div', 'review-export-all-note'));
    box.appendChild(el('div', 'review-activity-list'));
    return box;
}

// Where the activity list is drawn: the side panel, or the body on a record.
function activityHost() {
    return win.record ? bodyEl : sideEl;
}

async function closeReview() {
    if (!win.open || win.closing) return;
    closeSheet();
    // Export all ends with the window. Should the window stay open after all
    // (Cancel on "Close anyway?"), the heading says why nothing printed.
    if (exporting) {
        if (exporting.all) win.exportNote = 'Not exported: Close was pressed while it got ready. Press Export all again.';
        endExport(exporting);
    }
    const token = win.token;
    // A deleted job's record has nothing to save.
    if (!win.opening && !win.record) {
        win.closing = true;
        renderFooter();
        flushDrafts();
        jobUnits(win.jobId).forEach(u => {
            if (u.wait && !u.readonly) {
                clearRetry(u);
                pump(u, true);
            }
        });
        const until = Date.now() + CLOSE_WAIT_MS;
        while (jobUnits(win.jobId).some(u => u.inflight) && Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        win.closing = false;
        closeSheet();
        if (token !== win.token) return;
        // A conflict counts: its lines are not saved either, and the last
        // save Close sent may have just met one.
        const unsaved = jobUnits(win.jobId).some(u => u.ops.length || u.conflict || u.signoff);
        const paths = pathsWaiting(win.jobId);
        const notes = notesWaiting(win.jobId);
        if ((unsaved || paths || notes) && !confirm(unsaved ? 'Some changes are not saved. Close anyway?'
            : paths ? 'The paths you pasted have not been sent. Close anyway?'
            : 'The note you typed has not been sent. Close anyway?')) {
            resumeSaves(win.jobId);
            renderFooter();
            renderActivity();
            keepFocusInside();
            return;
        }
        // Close anyway: a Mark passed, Corrections needed or Sign back in that
        // did not go is dropped here. Kept, it went out by itself when the tab
        // later closed, hours on, under her name, freezing instructions she
        // never saw (the overall review's R03, 2026-10-01). Plain lines stay,
        // and go again when this job's window is opened (PHASE3_PLAN).
        jobUnits(win.jobId).forEach(u => { u.signoff = null; });
    }
    const closedJobId = win.jobId;
    win.token++;
    win.open = false;
    win.opening = false;
    win.confirm = null;
    clearSideNote();
    win.exportNote = '';
    document.removeEventListener('focusin', onDocumentFocusIn, true);
    document.removeEventListener('keydown', onDocumentKeyDown, true);
    document.removeEventListener('beforeinput', onDocumentBeforeInput, true);
    retryTimers.forEach(timer => clearTimeout(timer));
    retryTimers.clear();
    clearTimeout(noteTimer);
    clearTimeout(refreshTimer);
    refreshTimer = null;
    clearTimeout(activityTimer);
    activityTimer = null;
    clearReviewLink();
    win.link = null;
    pathDrafts.clear();
    noteDrafts.clear();
    sectionPresses.clear();
    toTopBtn.hidden = true;
    // Shown once: the reviewer does those lines again while the window is open.
    units.forEach(u => { u.conflict = null; u.refused = ''; });
    sheetsBack.clear();
    win.record = null;
    modal.classList.remove('is-open', 'review-modal--record');
    bodyEl.textContent = '';
    tabsEl.textContent = '';
    if (sideEl) sideEl.textContent = '';
    rendered = null;
    // The header button lives in the work order's own header. A window opened
    // from a link has the job list behind it instead, so focus goes to its
    // search box rather than falling to the page.
    if (openBtn.getClientRects().length > 0) {
        openBtn.focus({ preventScroll: true });
    } else {
        const search = document.getElementById('landingSearchInput');
        if (search && search.getClientRects().length > 0) search.focus({ preventScroll: true });
    }
    // The job list's QC column asks the server again (app.js). Only an event:
    // the window never calls the page's load or save code.
    document.dispatchEvent(new CustomEvent('sts-review-closed', { detail: { jobId: closedJobId } }));
}

// Email lines are written after the action has been answered (the "opened"
// row once this page has handed the email to Outlook), so the activity list
// is read once more a few seconds later.
function activityAgain(jobId) {
    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => {
        activityTimer = null;
        if (win.open && !win.opening && win.jobId === jobId) loadActivity(jobId);
    }, ACTIVITY_AGAIN_MS);
}

// ── Saving ──

function utf8Bytes(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x80) bytes += 1;
        else if (c < 0x800) bytes += 2;
        else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; }
        else bytes += 3;
    }
    return bytes;
}

function requestBody(unit, request) {
    const body = Object.assign({
        rowVersion: request.rowVersion,
        formVersion: REVIEW_ITEMS.formVersion(unit.gate)
    }, request.sheet);
    if (request.signoff) {
        body.action = request.signoff.action;
        if (request.signoff.flagDepts) body.flagDepts = request.signoff.flagDepts;
        if (request.signoff.action === 'signback') {
            body.note = request.signoff.note;
            body.production = !!request.signoff.production;
            body.units = request.signoff.units;
        }
    }
    const swept = request.sections || {};
    if (swept.ticks && swept.ticks.length) body.sectionTicks = swept.ticks;
    if (swept.unticks && swept.unticks.length) body.sectionUnticks = swept.unticks;
    const lines = request.lines || {};
    if ((lines.ticks && lines.ticks.length) || (lines.unticks && lines.unticks.length)) {
        body.sweptLines = { ticks: lines.ticks || [], unticks: lines.unticks || [] };
    }
    return JSON.stringify(body);
}

// A save is a PUT to the block; a sign-off a POST to its disposition route.
function reviewUrl(unit, signoff) {
    return '/api/jobs/' + encodeURIComponent(unit.jobId) + '/reviews/' + encodeURIComponent(unit.gate) + '/' +
        encodeURIComponent(unit.unitId) + (signoff ? '/disposition' : '');
}

function pump(unit, force) {
    const request = saveRules.nextRequest(unit, force);
    if (!request) {
        refreshUnit(unit);
        return;
    }
    send(unit, request);
}

async function send(unit, request) {
    saveRules.begin(unit, request);
    refreshUnit(unit);
    const body = requestBody(unit, request);
    // A request that never answers (a server gone from the network mid-save)
    // would hold the block forever with no warning; give up on it and retry.
    // If it did save, the retry's conflict answer shows that.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SAVE_TIMEOUT_MS);
    let answer;
    try {
        const res = await fetch(reviewUrl(unit, request.signoff), {
            method: request.signoff ? 'POST' : 'PUT',
            headers: userHeaders({ 'Content-Type': 'application/json' }),
            body,
            keepalive: utf8Bytes(body) < KEEPALIVE_BYTES,
            signal: controller.signal
        });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch (e) { json = undefined; }
        answer = { status: res.status, json };
        noticeUserAnswer(res.status, json);
    } catch (e) {
        answer = { network: true };
    } finally {
        clearTimeout(timer);
    }
    const result = saveRules.settle(unit, request, answer);
    afterSettle(unit, result);
    // A sign-off that landed (Corrections needed, the pass that finishes the
    // checklist, a sign back in) opens its email in Outlook; a conflict, a
    // refusal or a dropped click opens nothing.
    if (request.signoff && result.outcome === 'saved' && answer && answer.json) openOutlook(unit.jobId, answer.json.emails);
    if (request.signoff) activityAgain(unit.jobId);
}

function afterSettle(unit, result) {
    const outcome = result.outcome;
    if (outcome === 'conflict') {
        // Notes still being typed on this unit are dropped with its clicks,
        // and named with the same cause (the newest conflict decides it).
        const prefix = unit.key + '|';
        const ids = unit.conflict ? unit.conflict.ids : [];
        let typed = false;
        [drafts, whyDrafts].forEach(map => Array.from(map.keys()).forEach(key => {
            if (key.indexOf(prefix) !== 0) return;
            const id = key.slice(prefix.length);
            if (!ids.includes(id)) ids.push(id);
            map.delete(key);
            typed = true;
        }));
        if (ids.length) {
            const was = unit.conflict || { signoff: '', signedBackBy: null, csr: null };
            const fresh = typed || result.dropped.length || result.droppedSignoff;
            unit.conflict = Object.assign({}, was, fresh ? { ids, signedBackBy: result.signedBackBy || null, csr: result.csr || null } : { ids });
        }
        const back = result.signoff && result.signoff.action === 'signback' ? result.signoff : null;
        // Her own save refused under her open Sign back in sheet: the sheet
        // stays, with what she typed; it still goes with the version it was
        // filled in against, so it is refused and named rather than sent on
        // top of whatever changed (decision 5).
        if (back || !signBackOpenOn(unit)) closeConfirmOn(unit);
        refreshUnit(unit, true);
        if (back && win.open && win.jobId === unit.jobId) {
            // A Sign back in refused: her sheet comes back as she filled it in,
            // so nothing she typed is lost and she can Cancel or send it
            // anyway, but only once the window has reloaded and knows who got
            // there first: never when it was this very person, in another
            // window (David, 2026-09-25, answer 5).
            sheetsBack.set(unit.key, back);
            refreshFromServer(unit.jobId);
        } else {
            refreshSoon(unit.jobId);
        }
    } else if (outcome === 'readonly') {
        if (result.readonlyScope === 'window') {
            if (result.formVersion) {
                markChecklistChanged(unit.jobId);
            } else {
                readonlyJobs.set(unit.jobId, result.text);
                jobUnits(unit.jobId).forEach(u => { u.readonly = result.text; saveRules.dropSignoff(u); clearRetry(u); });
            }
        } else if (result.readonlyScope === 'gate') {
            // Stays until the window is opened again: the reload below only
            // redraws who may do what.
            readonlyGates.set(unit.jobId + '|' + unit.gate, result.text);
            jobUnits(unit.jobId).filter(u => u.gate === unit.gate).forEach(u => { u.readonly = result.text; saveRules.dropSignoff(u); clearRetry(u); });
        }
        closeConfirmOn(unit);
        if (win.open && win.jobId === unit.jobId) {
            renderBody();
            renderSide();
            renderFooter();
            keepFocusInside();
        }
        // A lock (403) or a checklist change: find out again what this person may do.
        if (result.locked || result.formVersion) refreshSoon(unit.jobId);
    } else if (outcome === 'retry') {
        scheduleRetry(unit);
        refreshUnit(unit);
    } else {
        if (result.signedOff) closeConfirmOn(unit);
        // A sign back in the server refused (a flag's departments, the note,
        // the blocks): her sheet comes back as she filled it in, and the blocks
        // are read again.
        // Only while this job's CSR tab is still on screen: an answer can come
        // back after the window was closed and another job opened.
        if (outcome === 'signoff-refused' && result.signoff && result.signoff.action === 'signback' &&
            win.open && !win.opening && win.jobId === unit.jobId && win.gate === unit.gate) {
            giveSheetBack(unit, result.signoff);
            refreshSoon(unit.jobId);
        }
        refreshUnit(unit);
    }
    // Her own save landing under her open Sign back in sheet, made on the
    // version the sheet goes with, moves it on; nothing else does, not even a
    // save sent again on top of someone else's change (decision 5).
    if (outcome === 'saved' && signBackOpenOn(unit) && unit.base && result.from === Number(win.confirm.against)) {
        win.confirm.against = Number(unit.base.rowVersion) || 0;
    }
    if (outcome === 'saved' || outcome === 'caught-up') refreshSoon(unit.jobId);
    if (outcome === 'saved' || outcome === 'caught-up' || outcome === 'rebased' || outcome === 'signoff-refused') pump(unit);
}

function scheduleRetry(unit) {
    clearRetry(unit);
    if (!win.open || win.jobId !== unit.jobId) return;
    retryTimers.set(unit.key, setTimeout(() => {
        retryTimers.delete(unit.key);
        if (win.open && win.jobId === unit.jobId && unit.wait === 'retry') pump(unit, true);
    }, RETRY_MS));
}

function clearRetry(unit) {
    const timer = retryTimers.get(unit.key);
    if (timer !== undefined) clearTimeout(timer);
    retryTimers.delete(unit.key);
}

// The window is open on this job again: clicks still unsaved from before (a
// retry that was waiting, a failed save, or Close anyway) try again now, so the
// screen never shows them as saved without saying otherwise.
function resumeSaves(jobId) {
    jobUnits(jobId).forEach(u => {
        if ((!u.ops.length && !u.signoff) || u.inflight || u.readonly) return;
        clearRetry(u);
        pump(u, true);
    });
}

function click(unit, op) {
    saveRules.addOp(unit, op);
    pump(unit);
}

// A typed note becomes a click 800 ms after the last key, and at once on
// leaving the box, a flag, a block, a tab, a sign-off or Close.
function flushDrafts() {
    clearTimeout(noteTimer);
    noteTimer = null;
    const touched = new Set();
    Array.from(drafts.entries()).forEach(([key, text]) => {
        drafts.delete(key);
        const cut = key.lastIndexOf('|');
        const unit = units.get(key.slice(0, cut));
        const id = key.slice(cut + 1);
        if (!unit) return;
        const sheet = saveRules.sheet(unit);
        if (!own(sheet.flags, id) || sheet.flags[id] === text) return;
        saveRules.addOp(unit, { type: 'note', id, text });
        touched.add(unit);
    });
    Array.from(whyDrafts.entries()).forEach(([key, text]) => {
        whyDrafts.delete(key);
        const cut = key.lastIndexOf('|');
        const unit = units.get(key.slice(0, cut));
        const id = key.slice(cut + 1);
        if (!unit) return;
        const sheet = saveRules.sheet(unit);
        if (!own(sheet.na, id) || naWords(sheet.na[id]) === naWords({ reason: text })) return;
        saveRules.addOp(unit, { type: 'naReason', id, text });
        touched.add(unit);
    });
    touched.forEach(unit => pump(unit));
}

// Page closing or reloading. The work order's own unload code has already
// run by now, so there is no asking. A unit with nothing in flight sends its
// clicks (and a sign-off waiting) with keepalive; anything else is lost, and
// the footer already said so.
function onPageHide() {
    clearTimeout(noteTimer);
    // Someone else was picked in another tab: these clicks are not theirs.
    if (userChangedElsewhere()) return;
    Array.from(drafts.entries()).forEach(([key, text]) => {
        const cut = key.lastIndexOf('|');
        const unit = units.get(key.slice(0, cut));
        const id = key.slice(cut + 1);
        if (unit && own(saveRules.sheet(unit).flags, id)) saveRules.addOp(unit, { type: 'note', id, text });
    });
    drafts.clear();
    Array.from(whyDrafts.entries()).forEach(([key, text]) => {
        const cut = key.lastIndexOf('|');
        const unit = units.get(key.slice(0, cut));
        const id = key.slice(cut + 1);
        if (unit && own(saveRules.sheet(unit).na, id)) saveRules.addOp(unit, { type: 'naReason', id, text });
    });
    whyDrafts.clear();
    units.forEach(unit => {
        // A sign-off goes only from the window that is open on its job: one
        // left on a closed window was not the person's to send any more.
        if (unit.signoff && !(win.open && win.jobId === unit.jobId)) unit.signoff = null;
        const request = saveRules.nextRequest(unit, true);
        if (!request) return;
        const body = requestBody(unit, request);
        if (utf8Bytes(body) >= KEEPALIVE_BYTES) return;
        // Remembered as a request that may have saved, not as one in flight:
        // if Chrome brings the page back (Back button), the block must still send.
        unit.sent.push(request);
        try {
            fetch(reviewUrl(unit, request.signoff), {
                method: request.signoff ? 'POST' : 'PUT', headers: userHeaders({ 'Content-Type': 'application/json' }), body, keepalive: true
            }).catch(() => {});
        } catch (e) { /* the page is going away */ }
    });
}

// ── The loop's buttons ──

function closeConfirmOn(unit) {
    if (win.confirm && win.jobId === unit.jobId && win.confirm.gate === unit.gate && win.confirm.unitId === unit.unitId) win.confirm = null;
}

// Back with the operator for fixes: nobody passes it until they press Fixed
// (David, 2026-09-18).
function withOperator(unit) {
    const row = unit && unit.base;
    return !!row && row.disposition === 'corrections' && row.holder === 'operator';
}

// The CSR's change, with the operator: she signed the piece back in and it went
// straight back to whoever sent the round for review. Nothing on it is checked
// until they press Fixed, so it is read only for everyone until then (David,
// 2026-09-22). The server refuses the same writes.
function csrChangeWithOperator(unit) {
    return saveRules.herChangeWaiting(unit && unit.base);
}

// Her Sign back in sheet is open on this block. Until she sends it or presses
// Cancel nothing else on the block may close it, because each would throw away
// what she typed (David, 2026-09-22).
function signBackOpenOn(unit) {
    const c = win.confirm;
    return !!unit && !!c && win.jobId === unit.jobId && c.kind === 'signback' && c.gate === unit.gate && c.unitId === unit.unitId;
}

// Whether Corrections needed has something to send: always, unless the piece is
// already with the operator, when only a line flagged since, or a note changed
// since, goes again (David, 2026-09-18). sentFlags is the server's list of what
// went in this round.
function somethingToSend(unit, verdict) {
    if (!withOperator(unit)) return true;
    const sent = plain(unit.base.sentFlags);
    // A note still being typed counts, so the button comes back with the first
    // key rather than when the note is saved.
    const noteOf = id => {
        const key = unit.key + '|' + id;
        const text = drafts.has(key) ? drafts.get(key) : verdict.flags[id];
        return String(text == null ? '' : text);
    };
    return Object.keys(verdict.flags).some(id => !own(sent, id) || String(sent[id]) !== noteOf(id));
}

// Mark passed: no confirm, as in the design.
function markPassed(unit) {
    flushDrafts();
    if (!editable(unit) || unit.signoff || withOperator(unit)) return;
    if (!REVIEW_ITEMS.unitVerdict(unit.gate, unit.unitId, saveRules.sheet(unit)).canPass) return;
    win.confirm = null;
    saveRules.addSignoff(unit, { action: 'pass', by: viewerBy(unit.jobId) });
    pump(unit);
}

// Corrections needed, from its confirm. Department checklists only: the CSR
// signs the job back in instead (SIGN_BACK_IN_PLAN section e).
function sendCorrections(unit) {
    flushDrafts();
    if (unit.gate === 'csr' || !editable(unit) || unit.signoff || !win.confirm) return;
    const verdict = REVIEW_ITEMS.unitVerdict(unit.gate, unit.unitId, saveRules.sheet(unit));
    if (!Object.keys(verdict.flags).length || !somethingToSend(unit, verdict)) return;
    win.confirm = null;
    saveRules.addSignoff(unit, { action: 'corrections', by: viewerBy(unit.jobId) });
    pump(unit);
}

function openCorrectionsConfirm(unit) {
    win.confirm = { kind: 'corrections', gate: unit.gate, unitId: unit.unitId };
}

// Sign back in: the job comes back and the whole QC runs again for the blocks
// she ticks. It carries her sheet, so a flag she has just typed goes with it.
function signBackIn(unit) {
    flushDrafts();
    const c = win.confirm;
    if (!c || c.kind !== 'signback' || unit.gate !== 'csr' || unit.signoff) return;
    if (!signBackReady(unit, c).ok) return;
    const counted = Object.keys(REVIEW_ITEMS.unitVerdict('csr', 'job', saveRules.sheet(unit)).flags);
    const picked = plain(c.flagDepts);
    const signoff = {
        action: 'signback', by: viewerBy(unit.jobId),
        note: String(c.note || '').trim(), production: !!c.production,
        units: signBackTicked(c), since: String(c.since || '')
    };
    if (c.against != null) signoff.against = c.against;
    if (counted.length) {
        signoff.flagDepts = {};
        counted.forEach(id => { signoff.flagDepts[id] = DEPTS.filter(d => (picked[id] || []).includes(d)); });
    }
    win.confirm = null;
    saveRules.addSignoff(unit, signoff);
    pump(unit);
}

function openSignBackConfirm(unit) {
    const flagDepts = {};
    Object.keys(REVIEW_ITEMS.unitVerdict('csr', 'job', saveRules.sheet(unit)).flags).forEach(id => { flagDepts[id] = []; });
    // since: the row this sheet is filled in against, so a refusal can name
    // whoever signed the job back in after it (decision 5).
    // against: its version, which only this window's own saves move on while
    // it is open, so anyone else's change meanwhile refuses the press.
    win.confirm = { kind: 'signback', gate: 'csr', unitId: 'job', flagDepts, note: '', production: false, ticked: {},
        since: unit.base ? String(unit.base.lastModified || '') : '', against: unit.base ? Number(unit.base.rowVersion) || 0 : 0 };
}

// Sign back in sheets waiting to come back after a refusal, by unit key,
// until the window has reloaded (afterSettle, refreshFromServer).
const sheetsBack = new Map();

// Gives a refused Sign back in sheet back on screen, unfolding her block if
// it was folded while the press was out (a sheet in a folded block can be
// neither seen nor closed).
function giveSheetBack(unit, signoff) {
    reopenSignBack(unit, signoff);
    if (win.openUnit === 'closed' || (win.openUnit && win.openUnit !== unit.unitId)) {
        win.openUnit = unitIdsFor(unit.jobId, unit.gate).length === 1 ? null : unit.unitId;
        renderBody();
    }
}

// What the window had for sheets waiting to come back, now that it has
// reloaded: each comes back unless the one who got there first was the
// person looking, from another window. With no answer from the server it
// comes back anyway, so nothing typed is lost.
function sheetsBackAfterReload(jobId, reloaded) {
    let again = false;
    jobUnits(jobId).forEach(u => {
        const back = sheetsBack.get(u.key);
        if (!back) return;
        const by = u.conflict ? conflictCause(u) : null;
        // Nobody named yet and no answer: wait for the next reload rather
        // than hand back a sheet under "press Sign back in again".
        if (!by && !reloaded) { again = true; return; }
        sheetsBack.delete(u.key);
        if (!win.open || win.jobId !== u.jobId || win.gate !== u.gate || win.confirm) return;
        if (by && isViewer(u.jobId, by.name, by.login)) return;
        giveSheetBack(u, back);
        refreshUnit(u);
    });
    if (again) refreshSoon(jobId);
}

// The sheet again, as the sign back in the server refused carried it.
function reopenSignBack(unit, signoff) {
    openSignBackConfirm(unit);
    const c = win.confirm;
    c.note = String(signoff.note || '');
    c.production = !!signoff.production;
    (signoff.units || []).forEach(u => { c.ticked[u.gate + '|' + u.unitId] = true; });
    const picked = plain(signoff.flagDepts);
    Object.keys(c.flagDepts).forEach(id => { if (Array.isArray(picked[id])) c.flagDepts[id] = picked[id].slice(); });
}

// The department blocks ticked, in the order the sheet lists them.
function signBackTicked(c) {
    return signBackBlocks(win.jobId).filter(b => c.ticked && c.ticked[b.gate + '|' + b.unitId])
        .map(b => ({ gate: b.gate, unitId: b.unitId }));
}

// Every department block on the job. A passed block is cleared and checked
// again. One nobody has touched can be ticked too, so a flag can still reach a
// department that has not reviewed this job. In a department somebody is part
// way through, what she ticks joins the round already going and goes straight
// back to the operator (David, 2026-09-19): deptBusy says so on the sheet.
function signBackBlocks(jobId) {
    const out = [];
    DEPTS.forEach(gate => {
        if (!gateInfo(gate)) return;
        const ids = unitIdsFor(jobId, gate);
        const rowOf = unitId => { const unit = units.get(unitKey(jobId, gate, unitId)); return unit && unit.base; };
        const isBusy = row => !!row && row.disposition !== 'passed' && !!(row.hasActivity || row.disposition);
        // The round is going: sent for review and not every block passed, the
        // server's test too.
        const board = window.REVIEW_BOARD;
        const deptBusy = !!sentBy(gateRowFor(jobId, gate)) && !!board && !board.allPassed(blockRows(jobId, gate));
        ids.forEach(unitId => {
            const row = rowOf(unitId);
            const passed = !!row && row.disposition === 'passed';
            out.push({
                gate, unitId, passed, deptBusy,
                name: unitName({ jobId, gate, unitId }),
                why: isBusy(row) ? 'being reviewed now' : passed ? '' : 'not reviewed yet'
            });
        });
    });
    return out;
}

// Why Sign back in is off, or ok. The server tests all of this again.
function signBackReady(unit, c) {
    if (!String(c.note || '').trim()) return { ok: false, why: 'Say what is being asked for.' };
    const ticked = signBackTicked(c);
    if (!ticked.length) return { ok: false, why: 'Check off what has to be done again.' };
    const counted = Object.keys(REVIEW_ITEMS.unitVerdict('csr', 'job', saveRules.sheet(unit)).flags);
    const picked = plain(c.flagDepts);
    if (counted.some(id => !Array.isArray(picked[id]) || !picked[id].length)) {
        return { ok: false, why: 'Pick Prepress, Tech Services or both for each flagged item.' };
    }
    // A flag aimed at a department nothing is ticked for would go nowhere.
    const gates = ticked.map(t => t.gate);
    const stranded = DEPTS.filter(d => counted.some(id => (picked[id] || []).includes(d)) && !gates.includes(d));
    if (stranded.length) {
        return { ok: false, why: 'Check off what ' + joinAnd(stranded.map(gateLabel)) + ' has to do again.' };
    }
    return { ok: true, why: '' };
}

async function reopenUnit(unit) {
    if (win.busy || !editable(unit, true) || unit.inflight || unit.ops.length || unit.signoff || !unit.base) return;
    win.busy = true;
    win.confirm = null;
    unit.refused = '';
    refreshUnit(unit);
    const res = await postJson(reviewUrl(unit, true), { action: 'reopen', rowVersion: unit.base.rowVersion });
    win.busy = false;
    const idle = !unit.ops.length && !unit.inflight && !unit.sent.length && !unit.signoff;
    if (res.ok && res.json && res.json.review && idle) unit.base = res.json.review;
    else if (!res.ok) unit.refused = res.json && typeof res.json.error === 'string' ? res.json.error : 'Could not reopen it. Try again.';
    refreshUnit(unit, true);
    refreshFromServer(unit.jobId);
}

// ── A stale Fixed (STALE_FIXED_PLAN.md, David 2026-10-11) ──
// Fixed sends a piece only as it was when this window opened it, or as it was
// when the red line last named it. A piece sent back again, or signed back in,
// since then stays with the operator, and the line says who did it and what to
// do. Drawn is not seen: the window redraws on its own when its tab comes back
// into view, a moment before the press.

function clearSideNote() {
    win.sideNote = '';
    win.sentNote = '';
    win.heldOut = [];
}

// The rows whose piece was deleted, as the latest read says (the window's own
// list of pieces is read when it opens and when Fixed is pressed).
function noteGone(jobId, rows) {
    if (jobId !== win.jobId) return;
    win.gone = new Set((Array.isArray(rows) ? rows : []).filter(r => r && r.orphaned).map(r => r.gate + '|' + r.unitId));
}

// A piece with the operator that Fixed can offer: still on the job.
function onJobNow(jobId, gate, unitId) {
    return !win.gone.has(gate + '|' + unitId) && (unitId === 'job' || !!pieceOf(jobId, unitId));
}

// Who handed a piece back, from a row: the server's backBy, else (a row from a
// save's reply carries none) the CSR when her sign back in is the newer, else
// whoever sent it back.
function backByOf(row) {
    if (!row) return null;
    if (row.backBy) return row.backBy;
    const her = row.signedBack;
    if (her && String(her.whenIso || '') >= String(row.returnedDate || '')) {
        return { action: 'signed_back', name: her.actorName || '', login: her.actorLogin || '' };
    }
    return { action: 'sent_back', name: row.returnedByName || '', login: row.returnedByLogin || '' };
}

function ackOf(gate, unitId) {
    const key = gate + '|' + unitId;
    return win.ack.has(key) ? win.ack.get(key) : null;
}

// Pieces kept out of Fixed: named in the red line, and taken as shown.
// entries: [{ unitId, mark, by }]. show is false for an answer that comes
// back after another tab was chosen: the marks move, the line is not drawn
// over the wrong checklist.
function holdFromFixed(jobId, gate, entries, show) {
    if (!entries.length) return;
    entries.forEach(e => {
        if (Number.isInteger(e.mark)) win.ack.set(gate + '|' + e.unitId, e.mark);
        if (show === false) return;
        win.heldOut = win.heldOut.filter(h => h.unitId !== e.unitId).concat([{ unitId: e.unitId, by: e.by || null }]);
    });
    if (show !== false) win.sideNote = stayedLines(jobId, gate, win.heldOut);
}

// A piece the red line names that is no longer with the operator (fixed from
// another window, deleted) comes off the line.
function trimHeldOut(jobId, gate) {
    if (!win.heldOut.length) return;
    const still = win.heldOut.filter(h => onJobNow(jobId, gate, h.unitId) && withOperator(units.get(unitKey(jobId, gate, h.unitId))));
    if (still.length === win.heldOut.length) return;
    win.heldOut = still;
    win.sideNote = still.length ? stayedLines(jobId, gate, still) : '';
    if (!still.length) win.sentNote = '';
}

// What a Fixed sent while the red line names a piece it kept back, so the
// line does not read as the press having failed (David, after his hand test,
// 2026-10-12): "Buckslip sent for re-review."
function sentLine(jobId, gate, ids) {
    const text = joinAnd(ids.map(id => unitPhrase(unitFor(jobId, gate, id)))) + ' sent for re-review.';
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// The red line: one sentence pair for each person and what they did.
function stayedLines(jobId, gate, entries) {
    const groups = [];
    entries.forEach(e => {
        const by = e.by || {};
        const kind = by.action === 'signed_back' ? 'signed_back' : 'sent_back';
        const key = kind + '|' + String(by.login || by.name || '');
        let group = groups.find(g => g.key === key);
        if (!group) {
            group = { key, kind, by, ids: [] };
            groups.push(group);
        }
        if (!group.ids.includes(e.unitId)) group.ids.push(e.unitId);
    });
    return groups.map(g => {
        const who = isViewer(jobId, g.by.name, g.by.login) ? 'You'
            : personText(g.by.name, g.by.login) || (g.kind === 'signed_back' ? 'The CSR' : 'The reviewer');
        const pieces = joinAnd(g.ids.map(id => unitPhrase(unitFor(jobId, gate, id))));
        return g.kind === 'signed_back'
            ? 'Not sent: ' + who + ' signed ' + pieces + ' back in after you opened this window. Do the CSR\'s change, then press Fixed again.'
            : 'Not sent: ' + who + ' sent ' + pieces + ' back after you opened this window. Look at what was flagged, then press Fixed again.';
    }).join(' ');
}

// Fixed, ready for re-review: read the latest first, keep out every piece
// whose mark moved since this window showed it, and open the box on the rest.
async function pressFixed() {
    const jobId = win.jobId;
    const gate = win.gate;
    const token = win.token;
    if (win.busy || win.fixedReading || !win.open || win.opening || win.loadText || win.record) return;
    win.fixedReading = true;
    win.confirm = null;
    clearSideNote();
    renderSide();
    // This read takes over from a refresh still waiting or on its way.
    clearTimeout(refreshTimer);
    refreshTimer = null;
    const seq = ++refreshSeq;
    // The job too: a piece added or deleted since the window opened has to be
    // drawn, offered and named as it is now.
    const [jobRes, res] = await Promise.all([getJson('/api/jobs/' + encodeURIComponent(jobId)), getJson(reviewsUrl(jobId))]);
    win.fixedReading = false;
    if (token !== win.token || !win.open || win.opening || win.jobId !== jobId) return;
    const fresh = res.ok && !!res.json && res.json.available !== false && Array.isArray(res.json.units) &&
        jobRes.ok && !!jobRes.json && Array.isArray(jobRes.json.components);
    if (!fresh) {
        // The refresh this read took over from still has to happen.
        sheetsBackAfterReload(jobId, false);
        refreshSoon(jobId);
        win.sideNote = 'That did not go through. Try again.';
        renderSide();
        return;
    }
    const piecesBefore = unitIdsFor(jobId, gate).join('|');
    jobs.set(jobId, jobRes.json);
    if (seq === refreshSeq) {
        applyReviews(jobId, res.json);
        loadActivity(jobId);
    } else {
        noteGone(jobId, res.json.units);
    }
    if (unitIdsFor(jobId, gate).join('|') !== piecesBefore) renderBody();
    // Another tab, another box or another press since: no box.
    const access = plain(res.json.access)[gate];
    if (win.gate !== gate || win.busy || win.confirm || !access || !access.canReready) {
        renderSide();
        return;
    }
    const seen = {};
    const held = [];
    res.json.units.forEach(row => {
        if (!row || row.gate !== gate || row.orphaned || row.disposition !== 'corrections' || row.holder !== 'operator') return;
        const id = String(row.unitId);
        if (!onJobNow(jobId, gate, id)) return;
        const mark = Number.isInteger(row.backMark) ? row.backMark : null;
        if (mark !== null && mark === ackOf(gate, id)) seen[id] = mark;
        else held.push({ unitId: id, mark, by: row.backBy });
    });
    holdFromFixed(jobId, gate, held);
    if (Object.keys(seen).length) win.confirm = { kind: 'reready', gate, unitId: '', seen, units: Object.keys(seen) };
    renderSide();
    const box = win.confirm && sideEl ? sideEl.querySelector('.review-note-box') : null;
    if (box) box.focus();
}

// Send for review, Ready for re-review, Send to CSR and the ask: plain requests
// outside the blocks' save queues. The window reloads the reviews afterwards,
// and idle blocks take the newer rows. A sign back in is not one of these: it
// carries the CSR's sheet, so it goes through her block's save queue.
async function runPanelAction(kind) {
    const jobId = win.jobId;
    const gate = win.gate;
    if (win.busy || !win.open || win.opening) return;
    const named = win.confirm && Array.isArray(win.confirm.units) ? win.confirm.units.slice() : null;
    const seenAt = win.confirm && win.confirm.seen ? Object.assign({}, win.confirm.seen) : {};
    // Fixed sends only what its box names: no box, nothing to send.
    if (kind === 'reready' && !named) return;
    win.busy = true;
    // The red line about pieces kept out of this Fixed stays while it goes.
    if (kind === 'reready') {
        win.sideNote = win.heldOut.length ? stayedLines(jobId, gate, win.heldOut) : '';
        win.sentNote = '';
    } else {
        clearSideNote();
    }
    win.confirm = null;
    renderSide();
    const base = '/api/jobs/' + encodeURIComponent(jobId) + '/reviews/';
    let res;
    if (kind === 'send') {
        const row = gateRowFor(jobId, gate);
        const note = noteDraft(jobId, gate, 'send').text;
        res = await postJson(base + encodeURIComponent(gate) + '/action', { action: 'send', rowVersion: row ? row.rowVersion : 0, note });
        if (res.ok) noteDrafts.delete(jobId + '|' + gate + '|send');
    } else if (kind === 'reready') {
        // The pieces the box named, each with the mark it was opened on, so
        // one sent back or signed back in since stays with the operator
        // (STALE_FIXED_PLAN.md).
        const seen = {};
        named.forEach(id => { if (Object.prototype.hasOwnProperty.call(seenAt, id)) seen[id] = seenAt[id]; });
        const note = noteDraft(jobId, gate, 'reready').text;
        res = await postJson(base + encodeURIComponent(gate) + '/action', { action: 'reready', units: named, seen, note });
        if (res.ok) noteDrafts.delete(jobId + '|' + gate + '|reready');
    } else if (kind === 'askhandoff') {
        res = await postJson(base + encodeURIComponent(gate) + '/action', { action: 'askhandoff' });
    } else if (kind === 'handoff') {
        const draft = pathDraft(jobId, gate);
        res = await postJson(base + encodeURIComponent(gate) + '/action', { action: 'handoff', paths: draft.text });
        // Sent: the box starts again from what the server stored, so Close has
        // nothing to ask about and Send again opens with the paths that went.
        if (res.ok) pathDrafts.delete(jobId + '|' + gate);
    } else {
        win.busy = false;
        return;
    }
    win.busy = false;
    // The press landed: its email opens in Outlook even if this window has
    // moved on, because the press is on the record either way.
    if (res.ok && res.json) openOutlook(jobId, res.json.emails);
    if (!win.open || win.jobId !== jobId) return;
    const stayed = kind === 'reready' && res.json && Array.isArray(res.json.stayed) ? res.json.stayed : [];
    if (stayed.length) {
        holdFromFixed(jobId, gate, stayed.map(x => ({ unitId: String(x.unitId), mark: x.mark, by: x.by })), win.gate === gate);
    } else if (!res.ok) {
        win.heldOut = [];
        win.sideNote = res.json && typeof res.json.error === 'string' ? res.json.error : 'That did not go through. Try again.';
    }
    const moved = kind === 'reready' && res.ok && res.json && Array.isArray(res.json.moved) ? res.json.moved.map(String) : [];
    await refreshFromServer(jobId);
    // Said only beside a red line on this checklist; it goes with that line.
    if (moved.length && win.heldOut.length && win.gate === gate && win.jobId === jobId) win.sentNote = sentLine(jobId, gate, moved);
    renderSide();
    activityAgain(jobId);
}

// ── Drawing ──

function renderHeader() {
    jobEl.textContent = '';
    if (win.record) {
        jobEl.appendChild(el('span', 'review-job-number', win.record.jobNumber));
        const kept = [win.record.clientName, win.record.jobDescription].filter(Boolean).join(' · ');
        if (kept) jobEl.appendChild(el('span', 'review-job-meta', kept));
        return;
    }
    const job = jobs.get(win.jobId);
    if (!job || String(job.id) !== win.jobId) return;
    jobEl.appendChild(el('span', 'review-job-number', job.jobNumber || ''));
    const meta = [job.clientName, job.jobDescription].map(v => String(v || '').trim()).filter(Boolean).join(' · ');
    if (meta) jobEl.appendChild(el('span', 'review-job-meta', meta));
}

function renderTabs() {
    tabsEl.textContent = '';
    if (win.record) return;   // a checklist needs its pieces, and they are gone
    TAB_ORDER.filter(gateInfo).forEach(gate => {
        const active = gate === win.gate;
        const tab = el('button', ['review-tab', deptClass(gate), active ? 'is-active' : ''].filter(Boolean).join(' '));
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.setAttribute('data-review-action', 'tab');
        tab.setAttribute('data-review-gate', gate);
        tab.appendChild(el('span', 'review-tab-dot'));
        tab.appendChild(document.createTextNode(gateLabel(gate)));
        tabsEl.appendChild(tab);
    });
}

function renderBody() {
    bodyEl.textContent = '';
    bodyEl.className = ['review-body', deptClass(win.gate)].filter(Boolean).join(' ');
    rendered = null;
    if (win.record) {
        bodyEl.className = 'review-body';
        renderRecordBody();
        return;
    }
    if (win.loadText) {
        bodyEl.appendChild(el('div', 'review-message', win.loadText));
        return;
    }
    const readonly = shutReason(win.jobId, win.gate);
    if (readonly) bodyEl.appendChild(el('div', 'review-alert', readonly));
    const banners = el('div', 'review-banners');
    bodyEl.appendChild(banners);

    rendered = { gate: win.gate, banners, blocks: new Map() };
    renderBanners();
    const wrap = el('div', 'review-units');
    const ids = unitIdsFor(win.jobId, win.gate);
    const solo = ids.length === 1;
    ids.forEach(unitId => wrap.appendChild(renderBlock(unitFor(win.jobId, win.gate, unitId), solo)));
    bodyEl.appendChild(wrap);
}

// The department checklists not passed yet, for the CSR tab (question 1).
// Only tabs with any activity or a send are named: the app cannot tell which
// departments a job uses.
function notPassedYet(jobId) {
    const board = window.REVIEW_BOARD;
    return TAB_ORDER.filter(gate => gate !== 'csr' && gateInfo(gate)).filter(gate => {
        // The landing board's own rule, so the two never disagree: a
        // department she signed back in counts before anyone there touches it
        // (David, 2026-09-18).
        const rows = blockRows(jobId, gate);
        const row = gateRowFor(jobId, gate);
        if (board) return board.deptCounts(rows, row) && !board.allPassed(rows);
        // review-board.js did not load (a file missed in a swap): the same
        // rule written out here, rather than no line at all. It has to name
        // every fact deptCounts names, or the line quietly drops a department.
        const touched = rows.some(r => r && (r.hasActivity || r.disposition)) ||
            !!(row && (sentBy(row) || personText(row.startedByName, row.startedByLogin) ||
                row.signedBackInDate || row.newJobDate));
        return touched && !rows.every(r => r && r.disposition === 'passed');
    }).map(gate => gateLabel(gate) + ' Checklist');
}

// A checklist's stored rows, one per block, null where a block has none.
function blockRows(jobId, gate) {
    return unitIdsFor(jobId, gate).map(id => {
        const unit = units.get(unitKey(jobId, gate, id));
        return unit ? unit.base : null;
    });
}

// Whether the files sent to the CSR still stand: every block is passed now
// and none has been passed again since they went. A piece reopened and passed
// again after they went needs them sent again, and the board says SEND TO CSR
// for the same job (BOARD_PLAN D3).
function handoffCurrent(jobId, gate, sent) {
    if (!sent || !sent.passedNow) return false;
    // A piece added since they went leaves them out of date, even in a window
    // opened before it was added, which has no block for it: the server's own
    // test says the same, because that piece is either not passed or passed
    // after they went (ADDED_PIECE_PLAN).
    if (addedSince(sent).length) return false;
    const board = window.REVIEW_BOARD;
    const newest = board ? board.newestPass(blockRows(jobId, gate)) : '';
    return !(newest > String(sent.whenIso || ''));
}

// The pieces the server says were not on the job when these files went, named
// as the window names a piece: "V2 Letter", "Buckslip". Taken from the server,
// so a window opened before the piece was added still names it.
function addedSince(sent) {
    const added = sent && Array.isArray(sent.added) ? sent.added : [];
    return added.map(p => ({
        id: String(p.id),
        name: ((p.version ? p.version + ' ' : '') + (p.name || '')).trim()
    }));
}

// The union of the changed lists of a department's passed blocks, in the
// job's piece order, without a piece the send names as added.
function changedSince(jobId, gate, sent) {
    const added = new Set((sent && Array.isArray(sent.added) ? sent.added : []).map(p => String(p && p.id)));
    const seen = new Map();
    units.forEach(unit => {
        if (unit.jobId !== jobId || unit.gate !== gate) return;
        const row = unit.base || {};
        if (row.disposition !== 'passed' || !Array.isArray(row.changed)) return;
        row.changed.forEach(p => {
            if (!p || added.has(String(p.id)) || seen.has(String(p.id))) return;
            seen.set(String(p.id), (((p.version) ? p.version + ' ' : '') + (p.name || '')).trim());
        });
    });
    const job = jobs.get(jobId);
    const order = new Map(((job && job.components) || []).map((c, i) => [String(c.id), i]));
    const place = id => (order.has(id) ? order.get(id) : Number.MAX_SAFE_INTEGER);
    return Array.from(seen.keys()).sort((a, b) => place(a) - place(b)).map(id => seen.get(id)).filter(Boolean);
}

// The amber lines under files sent to the CSR, none while they still stand.
// A piece added since they went is named, rather than the department blamed
// for a change someone else made (David, 2026-09-24). Today's line stays for a
// Reopen or a block passed again, and comes as well when that happened too.
function handoffLines(jobId, gate, sent) {
    if (handoffCurrent(jobId, gate, sent)) return [];
    const added = addedSince(sent);
    const names = added.map(p => p.name).filter(Boolean);
    const lines = names.length ? [joinAnd(names) + ' added after this was sent.'] : [];
    const addedIds = added.map(p => p.id);
    const ids = unitIdsFor(jobId, gate);
    const others = blockRows(jobId, gate).filter((row, i) => addedIds.indexOf(ids[i]) < 0);
    const board = window.REVIEW_BOARD;
    const otherChanged = others.some(row => !row || row.disposition !== 'passed') ||
        (board ? board.newestPass(others) : '') > String(sent.whenIso || '');
    if (!names.length || otherChanged) lines.push(gateLabel(gate) + ' changed its checklist after this was sent.');
    return lines;
}

// The banners above the blocks: whose checklist this is, and what is waiting.
function renderBanners() {
    if (!rendered || !rendered.banners || rendered.gate !== win.gate) return;
    const box = rendered.banners;
    box.textContent = '';
    const jobId = win.jobId;
    const gate = win.gate;
    const access = accessFor(jobId, gate);
    // With a body (even '') the first line is a bold title; without, a plain line.
    const add = (tone, title, body) => {
        const banner = el('div', 'review-banner review-banner--' + tone);
        banner.appendChild(el('div', body === undefined ? 'review-banner-line' : 'review-banner-title', title));
        if (body) banner.appendChild(el('div', 'review-banner-body', body));
        box.appendChild(banner);
    };

    if (!shutReason(jobId, gate)) {
        if (access.role === 'archived') {
            add('amber', access.reason);
        } else if (access.role === 'unlinked') {
            const viewer = viewerOf(jobId);
            add('amber', (viewer.user || userName()) + ' is not linked to a name on the lists yet.',
                'Everything here is read only until an admin links it in Manage CSRs & Assignees.');
        } else if (access.role === 'operator') {
            // One line each, the headline only: the waiting line and the
            // piece's own box say the rest (David, 2026-09-18). Once the fix
            // has gone back nothing is wrong, so there is no red for it.
            const onOperator = unitIdsFor(jobId, gate).map(id => units.get(unitKey(jobId, gate, id)))
                .filter(u => u && u.base && u.base.disposition === 'corrections' && u.base.holder === 'operator');
            if (onOperator.length) add('red', 'Corrections are waiting on you', '');
            else add('amber', 'You are the operator, so you cannot review this.', '');
        } else if (access.role === 'other' && gate === 'csr') {
            add('amber', 'Only CSRs fill in the CSR checklist.', '');
        } else if (access.role === 'other') {
            add('amber', 'Only ' + gateLabel(gate) + ' can review this.', '');
        } else if (access.role === 'csr_cover' && access.canEdit) {
            add('navy', 'Covering as a CSR. Recorded on the sign-off.');
        }
    }
    if (gate === 'csr') {
        const waiting = notPassedYet(jobId);
        if (waiting.length) box.appendChild(el('div', 'review-not-passed', 'Not passed yet: ' + joinAnd(waiting) + '.'));
    } else {
        const back = signBackFor(jobId, gate);
        if (back) box.appendChild(renderSignBackBanner(jobId, gate, back));
    }
    box.hidden = !box.childNodes.length;
}

// What the CSR asked for this round, at the top of the department's tab. It is
// the only place the department reads her words and her flagged lines, so it
// stays until the checklist passes again (SIGN_BACK_IN_PLAN section h). It
// shows on every round, so it carries only what the operator acts on (David,
// 2026-09-17): what came back, whether it goes to production, her words and her
// flags for this department. The job number is in the header; the round, who
// signed it back in and when are in the activity list.
function renderSignBackBanner(jobId, gate, back) {
    const job = jobs.get(jobId);
    const what = back.blocks && back.blocks.length ? joinAnd(back.blocks) : ((job && job.jobNumber) || 'This job');
    const banner = el('div', 'review-banner review-banner--navy review-signback-banner');
    banner.appendChild(el('div', 'review-banner-title',
        what + ' came back from the CSR' + (back.production ? ', for production.' : '.')));
    if (back.note) banner.appendChild(el('div', 'review-banner-body', '\u201c' + back.note + '\u201d'));
    (back.flags || []).forEach(flag => {
        const line = el('div', 'review-banner-flag');
        line.appendChild(el('span', 'review-banner-flag-label', String(flag.label || flag.itemId || '')));
        if (flag.note) line.appendChild(el('span', 'review-banner-flag-note', '\u201c' + flag.note + '\u201d'));
        banner.appendChild(line);
    });
    return banner;
}

function renderBlock(unit, solo) {
    const open = solo ? win.openUnit !== 'closed' : win.openUnit === unit.unitId;
    const wholeJob = unit.unitId === 'job';
    const block = el('div', ['review-block', open ? 'is-open' : '', wholeJob && !solo ? 'review-block--divided' : ''].filter(Boolean).join(' '));
    block.setAttribute('data-review-unit', unit.unitId);

    const head = el('button', 'review-block-head');
    head.type = 'button';
    head.setAttribute('data-review-action', 'toggle');
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    head.appendChild(svg('review-caret', ['M9 18l6-6-6-6'], '2.5'));
    head.appendChild(el('span', 'review-block-name', unitName(unit)));
    const sub = wholeJob ? '' : pieceSubLine(pieceOf(unit.jobId, unit.unitId));
    if (sub) head.appendChild(el('span', 'review-block-sub', sub));
    head.appendChild(el('span', 'review-block-spacer'));
    const count = el('span', 'review-block-count');
    const chip = el('span', 'review-chip');
    head.appendChild(count);
    head.appendChild(chip);
    block.appendChild(head);

    // A passed block whose instructions changed since says so under its name
    // while it is folded; open, the line is the first of its top strip
    // (CHANGED_AFTER_PASS_PLAN.md, David 2026-10-08). Drawn as the block is
    // built, press or no press: a block built afresh moves nothing under the
    // pointer, and one drawn hidden would make the list jump when it showed.
    const changed = el('div', 'review-block-changed', changedLine(unit, ' instructions changed after this passed.'));
    changed.hidden = !changed.textContent;
    if (!open) block.appendChild(changed);

    const parts = { block, head, count, chip, changed: open ? null : changed, alert: null, top: null, rows: new Map(), sections: new Map() };
    rendered.blocks.set(unit.unitId, parts);

    if (open) {
        const body = el('div', 'review-block-body');
        parts.alert = el('div', 'review-block-alert');
        body.appendChild(parts.alert);
        parts.top = el('div', 'review-unit-top');
        body.appendChild(parts.top);
        REVIEW_ITEMS.unitSections(unit.gate, unit.unitId).forEach(section => {
            const sec = el('div', 'review-section');
            const title = el('div', 'review-section-title');
            title.appendChild(el('span', 'review-section-num', section.section));
            title.appendChild(el('span', 'review-section-name', section.title));
            // One press ticks the lines of this section nobody has answered
            // yet, with an Undo for exactly those lines (CARRIED_FORWARD, the
            // window changes after step 4). Drawn once and shown or hidden by
            // refreshUnit, so a lock mid-edit takes it away without a redraw.
            const attrs = { 'data-review-section': section.section };
            const press = button('review-section-tick', 'Check all', 'section-tick', attrs);
            const takeBack = button('review-section-back', 'Undo', 'section-back', attrs);
            title.appendChild(press);
            title.appendChild(takeBack);
            parts.sections.set(section.section, { press, takeBack, section });
            sec.appendChild(title);
            section.items.forEach(item => {
                const row = renderRow(item);
                parts.rows.set(item.id, row);
                sec.appendChild(row.row);
            });
            body.appendChild(sec);
        });
        block.appendChild(body);
    }
    refreshUnit(unit, true);
    return block;
}

function renderRow(item) {
    const row = el('div', 'review-row');
    row.setAttribute('data-review-item', item.id);

    const check = el('input', 'review-check');
    check.type = 'checkbox';
    check.setAttribute('aria-label', item.label);

    const main = el('div', 'review-row-main');
    // A click anywhere on the line ticks it, not only the small box.
    main.setAttribute('data-review-action', 'line');
    const label = el('div', 'review-label', item.label);
    const reason = el('div', 'review-reason');
    const noteWrap = el('div', 'review-note-wrap');
    noteWrap.appendChild(svg('review-note-flag', FLAG_PATHS, '2.4'));
    const note = el('input', 'review-note');
    note.type = 'text';
    note.maxLength = NOTE_MAX;
    note.placeholder = 'What needs fixing?';
    note.setAttribute('aria-label', 'What needs fixing: ' + item.label);
    noteWrap.appendChild(note);
    const deptTag = el('div', 'review-dept-tag');
    // An N/A's words: a box while the checklist can be changed, the words
    // alone once it cannot. Optional (David, 2026-09-23).
    const whyText = el('div', 'review-na-why-text');
    const why = el('input', 'review-na-why');
    why.type = 'text';
    why.maxLength = REASON_MAX;
    why.placeholder = 'Why N/A? (optional)';
    why.setAttribute('aria-label', 'Why N/A: ' + item.label);
    main.appendChild(label);
    main.appendChild(reason);
    main.appendChild(whyText);
    main.appendChild(why);
    main.appendChild(noteWrap);
    main.appendChild(deptTag);

    const naBtn = el('button', 'review-na', 'N/A');
    naBtn.type = 'button';
    naBtn.setAttribute('data-review-action', 'na');

    const flagBtn = el('button', 'review-flag');
    flagBtn.type = 'button';
    flagBtn.setAttribute('data-review-action', 'flag');
    flagBtn.setAttribute('aria-label', 'Flag: ' + item.label);
    flagBtn.appendChild(svg('review-flag-icon', FLAG_PATHS, '2.2'));

    row.appendChild(check);
    row.appendChild(main);
    row.appendChild(naBtn);
    row.appendChild(flagBtn);
    return { row, item, check, reason, why, whyText, noteWrap, note, deptTag, naBtn, flagBtn };
}

// Who wrote an N/A's words, when it was not the person who marked it.
function naWordsBy(mark) {
    const m = plain(mark);
    const by = String(m.reasonName || m.reasonLogin || '');
    const who = String(m.name || m.login || '');
    return by && by !== who ? ' (' + by + ')' : '';
}

function naMarkText(mark) {
    const m = plain(mark);
    const who = String(m.name || m.login || '');
    const when = m.at ? reviewWhen(m.at) : '';
    if (!when) return 'Marked N/A';
    return 'Marked N/A' + (who ? ' by ' + who : '') + ' (' + when + ')';
}

// Bring one block on screen up to date with its sheet, in place, so focus
// stays where it is. forceNotes also resets a note box being typed in.
function refreshUnit(unit, forceNotes) {
    if (win.open && win.jobId === unit.jobId) renderFooter();
    if (!win.open || win.jobId !== unit.jobId || !rendered || rendered.gate !== unit.gate) return;
    const parts = rendered.blocks.get(unit.unitId);
    if (!parts) return;
    const sheet = saveRules.sheet(unit);
    const readonly = !editable(unit);

    const progress = REVIEW_ITEMS.unitProgress(unit.gate, unit.unitId, sheet);
    parts.count.textContent = progress.done + ' of ' + progress.total;
    const disposition = unit.base ? unit.base.disposition : '';
    // Re-check: the fix came back and the reviewer is to check it.
    const state = disposition === 'passed' ? ['passed', 'Passed']
        : disposition === 'corrections' ? (unit.base.holder === 'reviewer' ? ['recheck', 'Re-check'] : ['corrections', 'Corrections'])
        : readyToPass(unit, sheet) ? ['ready', 'Ready to pass']
        : REVIEW_ITEMS.hasActivity(sheet) ? ['progress', 'In progress']
        : ['', 'Not started'];
    parts.chip.className = ['review-chip', state[0]].filter(Boolean).join(' ');
    parts.chip.textContent = state[1];
    refreshChangedLine(unit);

    if (parts.alert) {
        const text = unit.readonly && unit.readonly !== shutReason(unit.jobId, unit.gate) ? unit.readonly : '';
        parts.alert.textContent = text;
        parts.alert.hidden = !text;
    }
    if (parts.top) renderUnitTop(unit, parts.top, sheet);
    parts.sections.forEach(part => {
        const sweep = sectionSweepIds(unit, part.section, sheet);
        part.press.hidden = readonly || !sweep.length;
        part.press.disabled = readonly || !sweep.length;
        const back = sectionUndoIds(unit, part.section.section, sheet);
        part.takeBack.hidden = readonly || !back.length;
        part.takeBack.disabled = readonly || !back.length;
    });
    parts.rows.forEach(row => refreshRow(unit, row, sheet, readonly, forceNotes));
    if (unit.gate === 'csr') renderBanners();
    keepFocusInside();
}

function refreshRow(unit, row, sheet, readonly, forceNotes) {
    const id = row.item.id;
    const ownNA = own(sheet.na, id);
    const follows = REVIEW_ITEMS.followingNA(unit.gate, id, sheet.na);
    const na = ownNA || !!follows;
    const flagged = !na && own(sheet.flags, id);
    const ticked = !na && sheet.items[id] === true && !own(sheet.flags, id);
    const followsTitle = follows ? 'Follows N/A on ' + lineLabel(unit.gate, row.item.naWith) : '';

    row.row.classList.toggle('is-na', na);
    row.row.classList.toggle('is-flagged', flagged);
    if (followsTitle) row.row.title = followsTitle;
    else row.row.removeAttribute('title');

    row.check.checked = ticked;
    row.check.disabled = readonly || na;

    const reason = follows || (ownNA ? naMarkText(sheet.na[id]) : '');
    row.reason.textContent = reason;
    row.reason.hidden = !reason;

    row.naBtn.classList.toggle('is-on', na);
    row.naBtn.setAttribute('aria-pressed', na ? 'true' : 'false');
    row.naBtn.disabled = readonly || !!follows;
    row.naBtn.title = followsTitle || (ownNA ? 'Put this item back in play' : 'Mark this item not applicable');

    row.flagBtn.classList.toggle('is-on', flagged);
    row.flagBtn.setAttribute('aria-pressed', flagged ? 'true' : 'false');
    row.flagBtn.disabled = readonly || na;
    row.flagBtn.title = followsTitle || 'Flag this item for fixes';

    row.noteWrap.hidden = !flagged;
    row.note.readOnly = readonly;
    const draftKey = unit.key + '|' + id;
    if (forceNotes || document.activeElement !== row.note) {
        row.note.value = drafts.has(draftKey) ? drafts.get(draftKey) : (flagged ? String(sheet.flags[id] || '') : '');
    }

    // The words of the line's own N/A. A line following another's N/A has the
    // checklist's words instead, and no box.
    const ownMark = ownNA && !follows ? plain(sheet.na[id]) : null;
    const words = ownMark ? naWords(ownMark) : '';
    row.why.hidden = !ownMark || readonly;
    row.why.readOnly = readonly;
    // Kept as it is only while words are being typed in it: a box that merely
    // holds the cursor (as it does after a mouse press of N/A) shows words
    // someone else saved, rather than letting them be typed over unseen.
    if (forceNotes || document.activeElement !== row.why || !whyDrafts.has(draftKey)) {
        row.why.value = whyDrafts.has(draftKey) ? whyDrafts.get(draftKey) : String(plain(ownMark).reason || '');
    }
    const shownWords = ownMark && readonly && words ? '"' + words + '"' + naWordsBy(ownMark) : '';
    row.whyText.textContent = shownWords;
    row.whyText.hidden = !shownWords;

    // Which departments a flag went to is shown on their own tabs now, from the
    // sign back in that carried it, not on the line here.
    row.deptTag.hidden = true;
}

// The top of an open block: the line that says where it stands, its buttons,
// the confirm, and the return banner.
function renderUnitTop(unit, box, sheet) {
    // Held still while the mouse is down on one of its buttons (pressHold).
    if (pressHold && pressHold.top === box) {
        if (!pressHold.clicking) {
            pressHold.held = unit;
            return;
        }
        pressHold.held = null;
    }
    const focus = focusKey(box);
    box.textContent = '';
    const access = accessFor(unit.jobId, unit.gate);
    const row = unit.base || {};
    const disposition = row.disposition || '';
    const passed = disposition === 'passed';
    const verdict = REVIEW_ITEMS.unitVerdict(unit.gate, unit.unitId, sheet);
    const shut = !!(unit.readonly || shutReason(unit.jobId, unit.gate) || win.loadText);
    const canAct = access.canEdit && !shut;
    const pending = !!unit.signoff;

    // Open, the line saying its instructions changed after it passed comes
    // first, right under the head.
    const changedText = changedLine(unit, ' instructions changed after this passed.');
    if (changedText) box.appendChild(el('div', 'review-block-changed', changedText));
    // A block in corrections says where it stands first, above the buttons.
    if (disposition === 'corrections') box.appendChild(renderReturn(unit, verdict, canAct));
    const bar = el('div', 'review-actions');
    bar.appendChild(el('div', 'review-actions-note' + (unit.refused ? ' is-refused' : ''), unitNote(unit, access, verdict, shut)));
    // Sign back in is the CSR's one way of sending work to a department, and it
    // has to be there when her checklist is passed as well, because that is the
    // usual way a job comes back: she passed it, it went to the client, and the
    // client wants something changed (SIGN_BACK_IN_PLAN section f).
    const signBack = unit.gate === 'csr' && !shut && accessFor(unit.jobId, 'csr').canSignBack;
    // A Corrections needed box left open when the CSR's change arrived goes
    // with it: nothing on the piece is sent until the operator presses Fixed.
    if (csrChangeWithOperator(unit) && win.confirm && win.confirm.kind === 'corrections' &&
        win.confirm.gate === unit.gate && win.confirm.unitId === unit.unitId) win.confirm = null;
    const c = win.confirm;
    // While her sheet is open, Sign back in, Reopen and Mark passed would each
    // close it and drop what she typed, so they are greyed; Cancel is the way
    // out (David, 2026-09-22).
    const signBackOpen = signBackOpenOn(unit);
    const signBackBtn = () => {
        const b = button('review-btn review-btn--corrections', 'Sign back in', 'signback');
        b.disabled = win.busy || pending || !!unit.signoff || signBackOpen;
        return b;
    };
    if (passed) {
        if (canAct) {
            const reopen = button('review-btn review-btn--quiet', 'Reopen', 'reopen');
            reopen.disabled = win.busy || signBackOpen;
            bar.appendChild(reopen);
        }
        if (signBack) bar.appendChild(signBackBtn());
    } else {
        if (unit.gate === 'csr') {
            if (signBack) bar.appendChild(signBackBtn());
        } else {
            const corrections = button('review-btn review-btn--corrections', 'Corrections needed', 'corrections');
            corrections.disabled = !canAct || pending || !somethingToSend(unit, verdict) || csrChangeWithOperator(unit);
            bar.appendChild(corrections);
        }
        const pass = button('review-btn review-btn--pass', 'Mark passed', 'pass');
        pass.disabled = !canAct || pending || !verdict.canPass || withOperator(unit) || signBackOpen;
        bar.appendChild(pass);
    }
    box.appendChild(bar);

    if (c && c.gate === unit.gate && c.unitId === unit.unitId && c.kind === 'signback' && signBack && !pending) {
        box.appendChild(renderSignBackSheet(unit, c, verdict));
    }
    if (c && c.gate === unit.gate && c.unitId === unit.unitId && canAct) {
        if (c.kind === 'corrections' && !passed && !pending && !csrChangeWithOperator(unit)) box.appendChild(renderCorrectionsConfirm(unit, c, verdict));
        if (c.kind === 'reopen' && passed) {
            const confirmBox = el('div', 'review-confirm');
            confirmBox.appendChild(el('div', 'review-confirm-title', 'Reopen ' + unitPhrase(unit) + '? The pass comes off.'));
            const pills = el('div', 'review-pills');
            pills.appendChild(button('review-pill', 'Reopen', 'confirm-reopen'));
            pills.appendChild(button('review-pill review-pill--quiet', 'Cancel', 'confirm-cancel'));
            confirmBox.appendChild(pills);
            box.appendChild(confirmBox);
        }
    }
    // While her Sign back in sheet is open it is the only thing in her block:
    // the checklist steps aside and the top loses its own scroll, so the sheet
    // scrolls with the window (David, 2026-09-22).
    const block = box.closest('.review-block');
    if (block) block.classList.toggle('review-block--signback', !!box.querySelector('.review-signback'));
    restoreFocus(box, focus);
}

// The pieces the server says changed after this block passed (changed on its
// row, CHANGED_AFTER_PASS_PLAN.md), named as unitName names a piece, then the
// ending: "Letter instructions changed after this passed." Only a passed
// Prepress or Tech Services block; '' otherwise.
function changedNames(row) {
    return (Array.isArray(row && row.changed) ? row.changed : [])
        .map(p => (((p && p.version) ? p.version + ' ' : '') + ((p && p.name) || '')).trim())
        .filter(Boolean);
}

function changedLine(unit, ending) {
    const row = unit.base || {};
    if (unit.gate === 'csr' || row.disposition !== 'passed') return '';
    const names = changedNames(row);
    return names.length ? joinAnd(names) + ending : '';
}

// The line under a folded block's name, already on screen. One appearing or
// going moves every block under it, so it waits while a press is down
// anywhere in the window (holdLines) and is drawn once the press has landed.
function refreshChangedLine(unit) {
    if (!win.open || win.jobId !== unit.jobId || !rendered || rendered.gate !== unit.gate) return;
    const parts = rendered.blocks.get(unit.unitId);
    if (!parts || !parts.changed) return;
    const text = changedLine(unit, ' instructions changed after this passed.');
    if (text === parts.changed.textContent && parts.changed.hidden === !text) return;
    if (linesHold) {
        linesHold.pending = true;
        return;
    }
    parts.changed.textContent = text;
    parts.changed.hidden = !text;
}

function unitNote(unit, access, verdict, shut) {
    const row = unit.base || {};
    if (unit.refused) return unit.refused;
    if (unit.signoff) return unit.signoff.action === 'pass' ? 'Marking it passed...' : 'Sending it...';
    if (row.disposition === 'passed') {
        const who = personText(row.reviewerName, row.reviewerLogin);
        const when = row.completedDate ? reviewWhen(row.completedDate) : '';
        return 'Passed' + (who ? ' by ' + who : '') + (when ? ' (' + when + ')' : '') + '.';
    }
    if (row.disposition === 'corrections') {
        // Who has it and what was flagged are in the box above the buttons, so
        // only the re-check says anything here (David, 2026-09-18). It counts
        // down as flagged items are ticked, then reads like any block
        // (David, 2026-09-14).
        if (row.holder === 'reviewer' && access.canEdit && !shut) {
            const left = Object.keys(verdict.flags).length;
            if (left) return left + (left === 1 ? ' flagged item to re-check.' : ' flagged items to re-check.');
        } else if (!shut) {
            return '';
        }
    }
    // The reason goes on the block too: the alert above the blocks scrolls out
    // of view when a block opens.
    if (shut) return unit.readonly || shutReason(unit.jobId, unit.gate) || 'Read only.';
    if (!access.canEdit) {
        if (access.role === 'operator') return 'Read only: you are the operator.';
        if (access.role === 'other') return unit.gate === 'csr' ? 'Read only. Only CSRs fill in the CSR checklist.' : 'Read only. Only ' + gateLabel(unit.gate) + ' can review this.';
        return access.reason || 'Read only.';
    }
    if (verdict.missingValue) return verdict.missingValue + (verdict.missingValue === 1 ? ' checked item is missing its number.' : ' checked items are missing their numbers.');
    // The head already counts what is left ("12 of 17").
    return verdict.canPass ? 'Ready to pass.' : '';
}

function renderCorrectionsConfirm(unit, c, verdict) {
    const box = el('div', 'review-confirm');
    const count = Object.keys(verdict.flags).length;
    const to = operatorName(unit.jobId, unit.gate);
    box.appendChild(el('div', 'review-confirm-title', 'Send ' + unitPhrase(unit) + ' back' + (to ? ' to ' + to : ' for fixes') + '?'));
    if (!count) box.appendChild(el('div', 'review-confirm-body', 'Nothing is flagged yet. Flag what needs fixing first.'));
    else if (!somethingToSend(unit, verdict)) box.appendChild(el('div', 'review-confirm-body', 'Nothing new to send.'));
    // Its buttons stay on screen however much is above them (David, 2026-09-22).
    const foot = el('div', 'review-confirm-foot');
    const pills = el('div', 'review-pills');
    const go = button('review-pill', 'Send it back', 'confirm-corrections');
    go.disabled = !count || !somethingToSend(unit, verdict);
    pills.appendChild(go);
    pills.appendChild(button('review-pill review-pill--quiet', 'Cancel', 'confirm-cancel'));
    foot.appendChild(pills);
    box.appendChild(foot);
    return box;
}

// The Sign back in sheet: what the client is asking for, whether this round
// goes to production, and which blocks have to be done again. Her own checklist
// is always on the list and cannot be untucked, because 29 of its 31 items check
// what the departments produced and hers is the last signature before live
// production (SIGN_BACK_IN_PLAN section d).
function renderSignBackSheet(unit, c, verdict) {
    const box = el('div', 'review-confirm review-signback');
    box.appendChild(el('div', 'review-confirm-title', 'Sign back in'));
    // The work order is the record, not this screen: the CSR writes the round's
    // instructions there and attaches the printed PDF to Midnight for the audit,
    // and other things change on it that this screen cannot know about (David,
    // 2026-09-17). Said once, as a line, never as a tick to get past.
    box.appendChild(el('div', 'review-signback-first',
        'First update the work order instructions and attach the PDF to Midnight.'));

    const counted = Object.keys(verdict.flags);
    if (counted.length) {
        box.appendChild(el('div', 'review-signback-label', 'Who each flag goes to'));
        const picked = plain(c.flagDepts);
        const list = el('div', 'review-confirm-lines');
        counted.forEach(id => {
            const chosen = Array.isArray(picked[id]) ? picked[id] : [];
            const line = el('div', 'review-confirm-line');
            const text = el('div', 'review-confirm-text');
            text.appendChild(el('div', 'review-confirm-label', lineLabel('csr', id)));
            if (verdict.flags[id]) text.appendChild(el('div', 'review-confirm-note', verdict.flags[id]));
            line.appendChild(text);
            const toggles = el('div', 'review-dept-toggles');
            DEPTS.forEach(dept => {
                const on = chosen.includes(dept);
                toggles.appendChild(button('review-dept-toggle' + (on ? ' is-on' : ''), gateLabel(dept), 'dept-toggle',
                    { 'data-review-flag-id': id, 'data-review-dept': dept, 'aria-pressed': on ? 'true' : 'false' }));
            });
            line.appendChild(toggles);
            list.appendChild(line);
        });
        box.appendChild(list);
    }

    box.appendChild(el('div', 'review-signback-label', 'What is being asked for'));
    const area = document.createElement('textarea');
    area.className = 'review-note review-signback-note';
    area.setAttribute('data-review-action', 'signback-note');
    area.setAttribute('rows', '3');
    area.setAttribute('maxlength', String(NOTE_MAX));
    area.setAttribute('placeholder', 'What is the client asking for?');
    area.value = String(c.note || '');
    box.appendChild(area);
    // It is the email the CSR used to send before this existed, not the
    // instructions: saying so is what stops it becoming a second place to
    // write them (David, 2026-09-17). The line above already says where they go.
    box.appendChild(el('div', 'review-signback-hint', 'A line or two, like the email you used to send.'));

    const prod = el('label', 'review-signback-prod');
    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.checked = !!c.production;
    tick.setAttribute('data-review-action', 'signback-production');
    prod.appendChild(tick);
    prod.appendChild(el('span', '', 'This round goes to production'));
    box.appendChild(prod);

    box.appendChild(el('div', 'review-signback-label', 'What has to be done again'));
    const blocks = el('div', 'review-signback-blocks');
    let lastGate = '';
    signBackBlocks(unit.jobId).forEach(b => {
        if (b.gate !== lastGate) {
            lastGate = b.gate;
            blocks.appendChild(el('div', 'review-signback-gate', gateLabel(b.gate)));
            // Part way through: what she ticks joins that round and goes back
            // to the operator at once, rather than starting a new round.
            if (b.deptBusy) {
                const operator = operatorName(unit.jobId, b.gate) || 'the operator';
                blocks.appendChild(el('div', 'review-signback-deptnote', 'Being reviewed now. What you check off goes back to ' + operator + ' straight away.'));
            }
        }
        const row = el('label', 'review-signback-block');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!(c.ticked && c.ticked[b.gate + '|' + b.unitId]);
        // Never data-review-unit or data-review-gate: currentUnitOf walks up to
        // the nearest data-review-unit to find the block a press belongs to, and
        // these sit inside the CSR block.
        cb.setAttribute('data-review-action', 'signback-tick');
        cb.setAttribute('data-review-block-gate', b.gate);
        cb.setAttribute('data-review-block-unit', b.unitId);
        row.appendChild(cb);
        row.appendChild(el('span', 'review-signback-name', b.name));
        if (b.why) row.appendChild(el('span', 'review-signback-why', b.why));
        blocks.appendChild(row);
    });
    // Her own checklist comes back with every round, except a production one:
    // she passed those items on the sign-offs and that pass is what made her
    // ask for the live files (David, 2026-09-17).
    blocks.appendChild(el('div', 'review-signback-gate', gateLabel('csr')));
    const mine = el('label', 'review-signback-block is-fixed');
    const mineBox = document.createElement('input');
    mineBox.type = 'checkbox';
    mineBox.checked = !c.production;
    mineBox.disabled = true;
    mine.appendChild(mineBox);
    mine.appendChild(el('span', 'review-signback-name', 'CSR Checklist'));
    mine.appendChild(el('span', 'review-signback-why',
        c.production ? 'your pass stands on a production round' : 'always checked again'));
    blocks.appendChild(mine);
    box.appendChild(blocks);

    // The line saying what is still missing and the two buttons stay on screen
    // however long the sheet is (David, 2026-09-22).
    const foot = el('div', 'review-confirm-foot');
    foot.appendChild(el('div', 'review-confirm-body review-signback-ready', ''));
    const pills = el('div', 'review-pills');
    pills.appendChild(button('review-pill', 'Sign it back in', 'confirm-signback'));
    pills.appendChild(button('review-pill review-pill--quiet', 'Cancel', 'confirm-cancel'));
    foot.appendChild(pills);
    box.appendChild(foot);
    signBackReadyLine(box, unit, c);
    return box;
}

// The one line saying what is still missing, and the button that follows it.
// Called on every draw and on every keystroke in the note, which must not
// redraw the sheet or the caret would jump.
function signBackReadyLine(sheet, unit, c) {
    const ready = signBackReady(unit, c);
    const line = sheet.querySelector('.review-signback-ready');
    const go = sheet.querySelector('[data-review-action="confirm-signback"]');
    if (line) {
        line.textContent = ready.why;
        line.hidden = ready.ok;
    }
    if (go) go.disabled = !ready.ok || win.busy;
}

// A piece the CSR signed back in while its round was going, in the loop it is
// in now: the server's signedBack { note, actorName, actorLogin, whenIso }, or
// null (David, 2026-09-19).
function signedBackOnto(unit) {
    const row = unit && unit.base;
    return row && row.signedBack && typeof row.signedBack === 'object' ? row.signedBack : null;
}

// Who checks a piece the CSR signed back in once it is fixed: whoever is
// reviewing the round, else the department.
function recheckerOf(unit) {
    const row = gateRowFor(unit.jobId, unit.gate);
    return (row && personText(row.startedByName, row.startedByLogin)) || gateLabel(unit.gate);
}

// canRecheck: this person may re-check it now, so the box says how, in two short
// lines (David, 2026-09-14: people see this box all the time).
function renderReturn(unit, verdict, canRecheck) {
    const row = unit.base || {};
    const fixed = row.holder === 'reviewer';
    const fromCsr = signedBackOnto(unit);
    const box = el('div', 'review-return');
    const head = el('div', 'review-return-head');
    // The operator is never shown their own name here (David, 2026-09-18).
    const to = accessFor(unit.jobId, unit.gate).role === 'operator' ? 'you' : operatorName(unit.jobId, unit.gate);
    head.appendChild(el('div', 'review-return-title', fixed ? 'Fixed and ready for re-review'
        : 'Back with ' + (to || 'the operator') + ' for fixes'));
    box.appendChild(head);
    if (fixed && canRecheck) {
        const steps = el('div', 'review-return-body review-return-steps');
        // Signed back in by the CSR: the whole piece changed, so every line.
        steps.appendChild(el('div', 'review-return-step', fromCsr ? 'Check every line again: it came back from the CSR.'
            : 'Check off each flagged item that is fixed on the work order.'));
        steps.appendChild(el('div', 'review-return-step', fromCsr ? 'Something wrong? Press Corrections needed.' : 'Not fixed? Press Corrections needed.'));
        box.appendChild(steps);
    } else if (fixed) {
        const who = fromCsr ? recheckerOf(unit) : personText(row.returnedByName, row.returnedByLogin) || 'the reviewer';
        box.appendChild(el('div', 'review-return-body', 'Waiting for ' + who + (fromCsr ? ' to check it again.' : ' to re-check.')));
    } else if (fromCsr) {
        const who = personText(fromCsr.actorName, fromCsr.actorLogin) || 'The CSR';
        const when = fromCsr.whenIso ? ' (' + reviewWhen(fromCsr.whenIso) + ')' : '';
        box.appendChild(el('div', 'review-return-body', 'Signed back in by ' + who + when + '.'));
        // Her words for this piece, when the banner above shows a later ask.
        const banner = signBackFor(unit.jobId, unit.gate);
        if (fromCsr.note && (!banner || String(banner.note || '') !== fromCsr.note)) {
            box.appendChild(el('div', 'review-return-body review-return-quote', '\u201c' + fromCsr.note + '\u201d'));
        }
        // Anything a reviewer had flagged on it still went, and still counts.
        const flagged = Object.keys(plain(row.sentFlags)).length;
        if (flagged) box.appendChild(el('div', 'review-return-body', personText(row.returnedByName, row.returnedByLogin) + ' flagged ' + flagged + (flagged === 1 ? ' item.' : ' items.')));
        // Everyone but the operator is told it is not their turn: the lines are
        // read only until the operator presses Fixed (David, 2026-09-22). No
        // email is promised: email can be off, and the re-review email goes
        // only to whoever is reviewing the round.
        if (to !== 'you') {
            box.appendChild(el('div', 'review-return-body', 'Nothing to check until ' + (to || 'the operator') + ' presses Fixed.'));
        }
    } else {
        const who = personText(row.returnedByName, row.returnedByLogin) || 'The reviewer';
        // What went, not what is on the sheet now: a flag ticked off while it
        // is with the operator still went (David, 2026-09-18).
        const count = Object.keys(plain(row.sentFlags)).length || Object.keys(verdict.flags).length;
        const when = row.returnedDate ? ' (' + reviewWhen(row.returnedDate) + ')' : '';
        box.appendChild(el('div', 'review-return-body', who + ' flagged ' + count + (count === 1 ? ' item' : ' items') + when + '.'));
    }
    return box;
}

// ── The side panel ──

// Every line answered and the block may be passed, but nobody has pressed it.
// "17 of 17, In progress" reads as finished, which stopped David twice while he
// drove a job through by hand (PHASE6_PLAN e).
function readyToPass(unit, sheet) {
    if (!unit || !unit.base || unit.base.disposition === 'passed') return false;
    const s = sheet || saveRules.sheet(unit);
    if (!REVIEW_ITEMS.hasActivity(s)) return false;
    const verdict = REVIEW_ITEMS.unitVerdict(unit.gate, unit.unitId, s);
    return !!(verdict && verdict.canPass);
}

// " is" for one block, " are" for several, and for "the Whole Job checks",
// which is plural on its own (David, 2026-09-18, B4 and D13).
function isAre(blocks) {
    const g = blocks.length === 1 ? gateInfo(blocks[0].gate) : null;
    return blocks.length === 1 && !(blocks[0].unitId === 'job' && g && g.perPiece) ? ' is' : ' are';
}

// One sentence at the top of the panel: what this checklist is waiting for and
// on whom. Nothing here decides anything; it reads what the server already sent.
function waitingLine(jobId, gate, access, row) {
    const blocks = unitIdsFor(jobId, gate).map(id => units.get(unitKey(jobId, gate, id))).filter(Boolean);
    if (!blocks.length) return '';
    const dispositionOf = u => (u.base && u.base.disposition) || '';

    // Rows from before every round had to start with Send for review can be
    // passed without one. Once every block is passed that no longer matters:
    // the files are what is waiting, as the job list's board says (SEND TO CSR).
    const board = window.REVIEW_BOARD;
    const everyPassed = !!board && board.allPassed(blockRows(jobId, gate));
    // Fixes waiting outrank everything else, as on the job list's board, and
    // are the operator's one line saying what to do (David, 2026-09-18, W1).
    const withOperator = blocks.filter(u => dispositionOf(u) === 'corrections' && u.base.holder === 'operator');
    if (withOperator.length) {
        const names = joinAnd(withOperator.map(unitPhrase));
        if (access.canReready && access.role === 'operator') return names + ' came back for fixes.';
        return names + isAre(withOperator) + ' with the operator for fixes.';
    }

    if (gate !== 'csr' && !(row && sentBy(row)) && !everyPassed) return 'Not sent for review yet.';

    const unpassed = blocks.filter(u => dispositionOf(u) !== 'passed');
    if (!unpassed.length) {
        if (gate === 'csr') return 'Every block passed.';
        const ask = askFor(jobId, gate);
        const sent = handoffFor(jobId, gate);
        if (handoffCurrent(jobId, gate, sent)) return 'Every block passed.';
        // The button's own name: Send again once files have gone this round.
        if (access.canHandoff) return sent ? 'Every block passed. Paste where the files are and press Send again.'
            : 'Every block passed. Paste where the files are and press Send to CSR.';
        return ask ? 'Every block passed. Waiting for the operator to send the files.'
            : 'Waiting for ' + gateLabel(gate) + ' to send the files.';
    }

    const ready = unpassed.filter(u => readyToPass(u, null));
    if (ready.length) {
        const one = ready.length === 1;
        return joinAnd(ready.map(unitPhrase)) + isAre(ready) +
            ' filled in but not passed yet. Open ' + (one ? 'it' : 'each one') + ' and press Mark passed.';
    }
    // A tab with one checklist says nothing more than its own block does.
    return blocks.length === 1 ? '' : 'Still to pass: ' + joinAnd(unpassed.map(unitPhrase)) + '.';
}

function renderSide() {
    if (!sideEl) return;
    // Held still while the mouse is down on one of its buttons (pressHold).
    if (pressHold && pressHold.side) {
        if (!pressHold.clicking) {
            pressHold.sideHeld = true;
            return;
        }
        pressHold.sideHeld = false;
    }
    const focus = focusKey(sideEl);
    // Where the caret is right now: a click or an arrow key moves it without an
    // input event, and the panel is about to be built again from scratch.
    const live = sideEl.querySelector('.review-paths-box, .review-note-box');
    if (live && document.activeElement === live) {
        const held = boxDraft(live);
        held.start = live.selectionStart;
        held.end = live.selectionEnd;
    }
    sideEl.textContent = '';
    if (!win.open || win.opening || win.loadText) return;
    // A record keeps its history in the body and has no panel (hidden). What a
    // press held back is the history, drawn here.
    if (win.record) {
        renderActivity();
        return;
    }
    const jobId = win.jobId;
    const gate = win.gate;
    const access = accessFor(jobId, gate);
    const row = gateRowFor(jobId, gate);
    const job = jobs.get(jobId) || {};
    const dept = gate !== 'csr';

    const waiting = waitingLine(jobId, gate, access, row);
    if (waiting) {
        const box = el('div', 'review-side-section review-waiting');
        // A sentence can start with a block's phrase ("the Whole Job checks").
        box.appendChild(el('div', 'review-waiting-text', waiting.charAt(0).toUpperCase() + waiting.slice(1)));
        sideEl.appendChild(box);
    }

    // Who is who.
    const people = el('div', 'review-side-section review-people');
    const person = (role, name) => {
        const p = el('div', 'review-person');
        p.appendChild(el('div', 'review-person-role', role));
        p.appendChild(el('div', 'review-person-name', name));
        people.appendChild(p);
    };
    if (dept) {
        // Whoever sent it for review is the operator; before anyone has,
        // whoever does will be.
        const sender = sentBy(row);
        person('Operator', sender ? sender + (isViewer(jobId, row.sentForReviewByName, row.sentForReviewByLogin) ? ' (you)' : '')
            : 'Whoever sends it for review');
    }
    const starter = row ? personText(row.startedByName, row.startedByLogin) : '';
    // Nobody has started: say who may, rather than naming a rule. Before it is
    // sent for review nobody may yet, so it says only that.
    const nobodyYet = !dept ? 'Not started yet. Any CSR can take it.'
        : sentBy(row) ? 'Not started yet. Anyone in ' + gateLabel(gate) + ' except the operator can take it.'
        : 'Not started yet.';
    person('Reviewer', starter ? starter + (isViewer(jobId, row.startedByName, row.startedByLogin) ? ' (you)' : '') : nobodyYet);
    const due = dept ? dueText(job, gate) : '';
    if (due) person('Signoff due', due);
    sideEl.appendChild(people);

    // The buttons.
    const actions = el('div', 'review-side-section review-side-actions');
    const c = win.confirm && win.confirm.gate === gate && !win.confirm.unitId ? win.confirm : null;
    const panelButton = (label, kind, extra) => {
        const b = button('review-side-btn', label, 'panel-' + kind, extra);
        b.disabled = win.busy || (kind === 'reready' && win.fixedReading);
        return b;
    };
    const panelConfirm = (title, kind, extra) => {
        const box = el('div', 'review-confirm review-confirm--side');
        box.appendChild(el('div', 'review-confirm-title', title));
        // Send for review and Fixed carry a box for the reviewer, which may be
        // left empty (OPERATOR_NOTE_PLAN, David 2026-10-01).
        if (kind === 'send' || kind === 'reready') box.appendChild(noteBox(jobId, gate, kind));
        const pills = el('div', 'review-pills');
        const go = button('review-pill', 'Send it', 'confirm-panel-' + kind, extra);
        go.disabled = win.busy;
        pills.appendChild(go);
        pills.appendChild(button('review-pill review-pill--quiet', 'Cancel', 'confirm-cancel', extra));
        box.appendChild(pills);
        return box;
    };
    if (dept) {
        // Who sent it is the operator, named above.
        if (sentBy(row)) {
            const when = row.sentForReviewDate ? reviewWhen(row.sentForReviewDate) : '';
            actions.appendChild(el('div', 'review-side-line', 'Sent for review' + (when ? ' ' + when : '') + '.'));
            // What the operator typed for the reviewer, for the whole round;
            // then what each Fixed carried, while its pieces wait to be checked
            // again (OPERATOR_NOTE_PLAN, David 2026-10-01).
            const sendNote = sendNoteFor(jobId, gate);
            if (sendNote) actions.appendChild(el('div', 'review-sent-note', sendNote.note));
            fixedNotes(jobId, gate).forEach(entry => {
                const f = entry.fixed;
                const who = personText(f.actorName, f.actorLogin);
                actions.appendChild(el('div', 'review-side-line', joinAnd(entry.units.map(unitPhrase)) + ' fixed' +
                    (who ? ' by ' + who : '') + (f.whenIso ? ' (' + reviewWhen(f.whenIso) + ')' : '') + '.'));
                actions.appendChild(el('div', 'review-sent-note', String(f.note)));
            });
        } else if (access.canSend) {
            actions.appendChild(c && c.kind === 'send'
                ? panelConfirm('Send for review?', 'send')
                : panelButton('Send for review', 'send'));
        }
        if (access.canReready) {
            const withOperatorNow = unitIdsFor(jobId, gate).filter(id => onJobNow(jobId, gate, id))
                .map(id => units.get(unitKey(jobId, gate, id)))
                .filter(u => u && u.base && u.base.disposition === 'corrections' && u.base.holder === 'operator');
            // While the box is open it offers only the pieces it has a mark
            // for, still on that mark. Any other piece with the operator (back
            // since the box opened, or its mark moved) is kept out and named in
            // the red line, so the box never names a piece Fixed would leave
            // with the operator (STALE_FIXED_PLAN.md 3.3).
            let box = c && c.kind === 'reready' ? c : null;
            let waiting = withOperatorNow;
            if (box) {
                const kept = [];
                waiting = withOperatorNow.filter(u => {
                    const mark = Number.isInteger(u.base.backMark) ? u.base.backMark : null;
                    if (Object.prototype.hasOwnProperty.call(box.seen || {}, u.unitId) && (mark === null || mark === box.seen[u.unitId])) return true;
                    kept.push({ unitId: u.unitId, mark, by: backByOf(u.base) });
                    return false;
                });
                holdFromFixed(jobId, gate, kept);
                if (!waiting.length) {
                    win.confirm = null;
                    box = null;
                }
            }
            const names = joinAnd(waiting.map(unitPhrase));
            // Whoever sent each back checks it again; for a piece the CSR
            // signed back in, whoever is reviewing the round. Named only when
            // it is one person, and "you" when that is the viewer.
            const starter = row || {};
            const checkers = waiting.map(u => (signedBackOnto(u)
                ? { name: starter.startedByName, login: starter.startedByLogin }
                : { name: u.base.returnedByName, login: u.base.returnedByLogin }));
            const one = checkers.every(p => saveRules.samePerson(p.name, p.login, checkers[0])) ? checkers[0] : null;
            const back = !one || !personText(one.name, one.login) ? ''
                : isViewer(jobId, one.name, one.login) ? 'you' : personText(one.name, one.login);
            // What this confirm names is what Send it moves: a panel held
            // still under a press can be older than the pieces in memory.
            if (box) box.units = waiting.map(u => u.unitId);
            actions.appendChild(box
                ? panelConfirm('Send ' + (names || 'this') + ' back' + (back ? ' to ' + back : '') + ' for re-review?', 'reready')
                : panelButton('Fixed, ready for re-review', 'reready'));
        }
        // Send to CSR: where the finished files are (PHASE5_PLAN section p).
        // The server decides who may press it and whether every block of this
        // checklist is passed; the window only draws the answer.
        const sent = handoffFor(jobId, gate);
        // Only while it can still be drawn: if someone reopened a block, or the
        // job was archived, the button goes and what was sent comes back. What
        // was typed is kept, and is there again when the button is.
        const asking = !!(c && c.kind === 'handoff') && access.canHandoff;
        // While the box is open it already holds those paths, so they are not
        // shown twice: the panel is only 300px wide and Send it must stay on
        // screen at 1280x720.
        if (sent && !asking) {
            const who = personText(sent.actorName, sent.actorLogin);
            actions.appendChild(el('div', 'review-side-line', 'Sent to ' + (sent.recipientName || 'the CSR') +
                (who ? ' by ' + who : '') + (sent.whenIso ? ' (' + reviewWhen(sent.whenIso) + ')' : '') + '.'));
            actions.appendChild(el('div', 'review-paths', String(sent.paths || '')));
            handoffLines(jobId, gate, sent).forEach(line => actions.appendChild(el('div', 'review-side-warn', line)));
        }
        // A reviewer asked the operator to send the files. The operator reads
        // it right above their Send to CSR, so it is plain that part is not
        // done yet; whoever asked has made their choice and their button is
        // greyed (David, 2026-09-19).
        const ask = askFor(jobId, gate);
        const askOpen = !!ask && !handoffCurrent(jobId, gate, sent);
        const askedByMe = askOpen && isViewer(jobId, ask.actorName, ask.actorLogin);
        // The operator's instruction and the asker's greyed button only while
        // every block is passed: after a Reopen nobody can send yet.
        const passedNow = !!plain(stateOf(jobId) ? stateOf(jobId).passedNow : {})[gate];
        const operator = operatorName(jobId, gate) || 'the operator';
        if (askOpen) {
            const who = personText(ask.actorName, ask.actorLogin) || 'The reviewer';
            const when = ask.whenIso ? ' (' + reviewWhen(ask.whenIso) + ')' : '';
            actions.appendChild(access.role === 'operator' && passedNow
                ? el('div', 'review-side-ask', who + ' asked you to send the file paths to the CSR' + when + '.')
                : el('div', 'review-side-line', (askedByMe ? 'You' : who) + ' asked ' +
                    (access.role === 'operator' ? 'you' : operator) + ' to send the file paths to the CSR' + when + '.'));
        }
        if (!access.canHandoff && askedByMe && passedNow) {
            const off = button('review-side-btn', sent ? 'Send again' : 'Send to CSR', 'panel-handoff');
            off.disabled = true;
            off.title = 'You asked ' + operator + ' to send them.';
            actions.appendChild(off);
        }
        if (access.canHandoff) {
            if (asking) {
                const csrName = String((plain(accessFor(jobId, 'csr').owner).name) || '').trim();
                actions.appendChild(handoffConfirm(jobId, gate, csrName, job));
            } else {
                actions.appendChild(panelButton(sent ? 'Send again' : 'Send to CSR', 'handoff'));
                // The operator and anyone else on the list may send; whoever
                // asked may not while the ask stands (David, 2026-09-19).
                if (!handoffCurrent(jobId, gate, sent) && !ask && access.role !== 'operator') {
                    actions.appendChild(c && c.kind === 'askhandoff'
                        ? panelConfirm('Ask the operator to send the files to the CSR?', 'askhandoff')
                        : panelButton('Ask the operator to send them', 'askhandoff'));
                }
            }
        }
    }
    // A piece the red line names comes off it once it is no longer with the
    // operator (fixed from another window, deleted).
    if (dept) trimHeldOut(jobId, gate);
    if (win.sideNote && win.sentNote && win.heldOut.length) actions.appendChild(el('div', 'review-side-sent', win.sentNote));
    if (win.sideNote) actions.appendChild(el('div', 'review-side-note', win.sideNote));
    if (actions.childNodes.length) sideEl.appendChild(actions);

    // Outputs: what each department has sent the CSR, as text people can select
    // and copy. Never a file: link, which Chrome will not follow from a page
    // served over plain http.
    if (!dept) {
        const outputs = el('div', 'review-side-section review-outputs');
        DEPTS.forEach(d => {
            const sent = handoffFor(jobId, d);
            if (!sent) return;
            if (!outputs.childNodes.length) outputs.appendChild(el('div', 'review-side-title', 'Outputs'));
            const who = personText(sent.actorName, sent.actorLogin);
            outputs.appendChild(el('div', 'review-side-line', 'From ' + gateLabel(d) + ': ' + (who || 'someone') +
                (sent.whenIso ? ', ' + reviewWhen(sent.whenIso) : '')));
            outputs.appendChild(el('div', 'review-paths', String(sent.paths || '')));
            handoffLines(jobId, d, sent).forEach(line => outputs.appendChild(el('div', 'review-side-warn', line)));
            // The pieces whose instructions changed after a passed block of
            // that department, once each and never one named as added.
            const changed = changedSince(jobId, d, sent);
            if (changed.length) outputs.appendChild(el('div', 'review-side-warn', joinAnd(changed) + ' instructions changed after the pass.'));
        });
        if (outputs.childNodes.length) sideEl.appendChild(outputs);
    }

    // The job's QC activity.
    sideEl.appendChild(activityBox('review-side-section review-activity'));
    renderActivity();
    restoreFocus(sideEl, focus);
    const box = sideEl.querySelector('.review-paths-box, .review-note-box');
    if (box && document.activeElement === box) {
        const draft = boxDraft(box);
        try { box.setSelectionRange(draft.start, draft.end); } catch (e) { /* nothing to put back */ }
    }
}

// The draft behind a box in the panel: the Send to CSR paths, or the note on
// Send for review or Fixed.
function boxDraft(box) {
    if (box.classList.contains('review-note-box')) return noteDraft(win.jobId, win.gate, box.getAttribute('data-review-kind') || 'send');
    return pathDraft(win.jobId, win.gate);
}

// The box in the Send for review and Fixed confirms: the Send to CSR box's
// twin, but never required, so Send it does not wait for it.
function noteBox(jobId, gate, kind) {
    const draft = noteDraft(jobId, gate, kind);
    const area = document.createElement('textarea');
    area.className = 'review-note-box';
    area.setAttribute('data-review-action', 'note');
    area.setAttribute('data-review-kind', kind);
    area.setAttribute('rows', '3');
    area.setAttribute('maxlength', String(SEND_NOTE_MAX));
    area.setAttribute('placeholder', 'Notes or where the files are, for the reviewer.');
    area.setAttribute('spellcheck', 'false');
    area.value = draft.text;
    return area;
}

// The Send to CSR confirm: who it goes to, one box for the paths, Send it and
// Cancel. Send it stays off while the box is empty.
function handoffConfirm(jobId, gate, csrName, job) {
    const draft = pathDraft(jobId, gate);
    const box = el('div', 'review-confirm review-confirm--side');
    box.appendChild(el('div', 'review-confirm-title', csrName
        ? 'Send to ' + csrName + '?'
        : 'Send the ' + gateLabel(gate) + ' outputs? ' + (job.jobNumber || 'This job') + ' has no CSR.'));
    const area = document.createElement('textarea');
    area.className = 'review-paths-box';
    area.setAttribute('data-review-action', 'paths');
    area.setAttribute('rows', '4');
    area.setAttribute('maxlength', String(PATHS_MAX));
    area.setAttribute('placeholder', 'Paste where the files are.');
    area.setAttribute('spellcheck', 'false');
    area.value = draft.text;
    box.appendChild(area);
    const pills = el('div', 'review-pills');
    const go = button('review-pill', 'Send it', 'confirm-panel-handoff');
    go.disabled = win.busy || !String(draft.text).trim();
    pills.appendChild(go);
    pills.appendChild(button('review-pill review-pill--quiet', 'Cancel', 'confirm-cancel'));
    box.appendChild(pills);
    return box;
}

// The flag entries still waiting on whoever fixes them, by history row id
// (David, 2026-09-14). One per line: its newest flagged entry, in the unit's
// current round, while the unit is sent back and the fix has not come back,
// and while the line is still flagged. entries are newest first.
function changesNeeded(jobId, entries) {
    const seen = new Set();
    const verdicts = new Map();
    const out = new Set();
    entries.forEach(e => {
        if (e.logAction !== 'flagged' || !gateInfo(e.gate)) return;
        const unitId = String(e.unitId);
        const line = e.gate + '|' + unitId + '|' + e.itemId;
        if (seen.has(line)) return;
        seen.add(line);
        const unit = units.get(unitKey(jobId, e.gate, unitId));
        const row = unit && unit.base;
        if (!row || row.disposition !== 'corrections' || row.holder !== 'operator' || Number(e.reviewRound) !== Number(row.returnCount)) return;
        if (!verdicts.has(unit.key)) verdicts.set(unit.key, REVIEW_ITEMS.unitVerdict(e.gate, unitId, saveRules.sheetOf(row)));
        if (!own(verdicts.get(unit.key).flags, e.itemId)) return;
        out.add(e.id);
    });
    return out;
}

function renderActivity() {
    const host = activityHost();
    const list = host ? host.querySelector('.review-activity-list') : null;
    if (!list) return;
    // Part of the panel, so held with it (pressHold): drawn with the rest.
    if (pressHold && pressHold.side && !pressHold.clicking) {
        pressHold.sideHeld = true;
        return;
    }
    // On a record the list is redrawn by itself (the tab coming back into
    // view), so the signed sheet link that had focus gets it back.
    const had = win.record && list.contains(document.activeElement)
        ? document.activeElement.getAttribute('data-review-log') : null;
    drawExportAll(host);
    drawActivity(list);
    if (had) {
        const again = Array.from(list.querySelectorAll('[data-review-log]')).find(b => b.getAttribute('data-review-log') === had);
        if (again) again.focus({ preventScroll: true });
        else keepFocusInside();
    }
}

// Export all, once the history is read and holds a signed sheet. While one
// gets ready it says so and a press does nothing; it stays a button with
// focus, so a press by the keys does not lose its place.
function drawExportAll(host) {
    const tools = host.querySelector('.review-activity-tools');
    const note = host.querySelector('.review-export-all-note');
    if (!tools || !note) return;
    const had = tools.contains(document.activeElement);
    tools.textContent = '';
    note.textContent = win.exportNote || '';
    if ((sheets.get(win.jobId) || []).length) {
        const busy = !!exporting && !!exporting.all;
        const press = button('review-export-all', busy ? 'Preparing...' : 'Export all', 'export-all');
        if (busy) press.setAttribute('aria-disabled', 'true');
        tools.appendChild(press);
        if (had) press.focus({ preventScroll: true });
    }
    if (had && !tools.contains(document.activeElement)) keepFocusInside();
}

function drawActivity(list) {
    list.textContent = '';
    const entries = activity.get(win.jobId);
    if (!entries) {
        list.appendChild(el('div', 'review-activity-empty', 'Loading...'));
        return;
    }
    // Empty is what the list shows: a job whose only rows are hidden kinds
    // (someone ticked a few lines) says so rather than showing nothing.
    activityWords = naWordsByEntry(entries);
    const shown = shownActivity(entries);
    if (!shown.length) {
        // A deleted job's record will get no more ("yet" would promise some).
        list.appendChild(el('div', 'review-activity-empty', win.record ? 'No QC activity to show on this job.' : 'No QC activity on this job yet.'));
        return;
    }
    const waiting = changesNeeded(win.jobId, entries);
    shown.forEach(group => {
        const entry = group.entry;
        const item = el('div', 'review-activity-item');
        const top = el('div', 'review-activity-top');
        top.appendChild(el('span', 'review-activity-when', reviewWhen(entry.whenIso)));
        // A sign back in is pressed on the CSR tab, whichever checklists it
        // sent back.
        const tag = entry.logAction === 'signed_back_in' ? 'csr' : entry.gate;
        if (waiting.has(entry.id)) top.appendChild(el('span', 'review-activity-tag is-changes', 'Changes needed'));
        // A row about the whole job (its delete) names no checklist.
        else if (gateLabel(tag) || tag) top.appendChild(el('span', 'review-activity-tag', gateLabel(tag) || tag));
        item.appendChild(top);
        const text = el('div', 'review-activity-text');
        const line = activityLine(group);
        if (line.who) {
            text.appendChild(el('span', 'review-activity-who', line.who));
            text.appendChild(document.createTextNode(' ' + line.text));
        } else {
            text.appendChild(document.createTextNode(line.text));
        }
        item.appendChild(text);
        // Where the files were: once the job is signed back in, Outputs drops
        // them and this is the only place they are on screen. What the
        // operator typed for the reviewer on Send for review or Fixed is kept
        // the same way (OPERATOR_NOTE_PLAN, David 2026-10-01).
        if (['sent_to_csr', 'sent_for_review', 'ready_for_rereview'].includes(entry.logAction) && String(entry.detail || '').trim()) {
            item.appendChild(el('div', 'review-activity-paths', String(entry.detail)));
        }
        // What she told the department when she sent them the job.
        if (entry.logAction === 'new_job' && String(entry.detail || '').trim()) {
            item.appendChild(el('div', 'review-activity-note', '\u201c' + String(entry.detail).trim() + '\u201d'));
        }
        // The signed sheet each pass froze, as it was that day. Every round is
        // kept, and the sheet of a round already gone is the only place its
        // ticks still exist: signing a job back in clears the live one.
        if (entry.logAction === 'passed') {
            const frozen = sheetsFor(group);
            if (frozen.length) {
                const row = el('div', 'review-activity-sheets');
                frozen.forEach(s => row.appendChild(button('review-sheet-link',
                    frozen.length > 1 ? (s.unitName || 'the sheet') : 'See the signed sheet',
                    'sheet', { 'data-review-log': String(s.id) })));
                item.appendChild(row);
            }
        }
        list.appendChild(item);
    });
}

// A history row whose detail is JSON. Never throws: a row written by an older
// build, or by hand, must not stop the activity list drawing.
function safeDetail(detail) {
    try {
        const parsed = JSON.parse(String(detail || '{}'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {};
    }
}

// What the list shows, newest first (David, 2026-09-18). The history keeps
// every row; the list leaves out what nobody acts on: an email that went out
// (one that did not still shows, so a person nobody told is named), a section
// ticked with one press and its Undo, and who started a review, which the
// panel names as the Reviewer. Rows that are one press read as one entry: a sign back in
// writes a row per checklist, and passes by one person on one checklist one
// after another on the same day are one entry. Returns [{ entry, rows }],
// entry being the newest row of the group.
// A line checked or unchecked (never sent by the server, listed here so one
// could never show) and a change to an N/A's words, which its entry carries.
const ACTIVITY_HIDDEN = ['emailed', 'section_ticked', 'section_unticked', 'started', 'signed_back',
    'na_reason', 'ticked', 'unticked'];

// The words each N/A entry was last given. Every na_reason row belongs to the
// newest earlier na_set for the same checklist, block and line, and the next
// na_set or na_unset for that line ends it: a sign back in clears marks with
// no na_unset, so a line marked N/A again in a later round starts its own.
function naWordsByEntry(entries) {
    const out = new Map();
    const open = new Map();
    (entries || []).slice().reverse().forEach(e => {
        const key = e.gate + '|' + e.unitId + '|' + e.itemId;
        if (e.logAction === 'na_set') {
            const words = { text: String(e.detail || ''), by: personText(e.actorName, e.actorLogin), setBy: personText(e.actorName, e.actorLogin) };
            out.set(e.id, words);
            open.set(key, words);
        } else if (e.logAction === 'na_unset') {
            open.delete(key);
        } else if (e.logAction === 'na_reason') {
            const words = open.get(key);
            if (words) {
                words.text = String(e.detail || '');
                words.by = personText(e.actorName, e.actorLogin);
            }
        }
    });
    return out;
}

function shownActivity(entries) {
    const out = [];
    entries.forEach(e => {
        if (ACTIVITY_HIDDEN.includes(e.logAction)) return;
        const last = out[out.length - 1];
        if (last && samePress(last.entry, e)) last.rows.push(e);
        else out.push({ entry: e, rows: [e] });
    });
    return out;
}

// The frozen sheets belonging to one pass entry. A pass and its frozen sheet
// are written in the same batch, so they carry the same time, checklist and
// block.
function sheetsFor(group) {
    const frozen = sheets.get(win.jobId) || [];
    const out = [];
    group.rows.forEach(row => {
        const match = frozen.find(s => s.gate === row.gate && s.unitId === row.unitId && String(s.whenIso) === String(row.whenIso));
        if (match && !out.includes(match)) out.push(match);
    });
    return out;
}

function samePress(a, b) {
    if (a.logAction !== b.logAction || !saveRules.samePerson(a.actorName, a.actorLogin, { name: b.actorName, login: b.actorLogin })) return false;
    if (a.logAction === 'signed_back_in') return String(a.whenIso) === String(b.whenIso);
    // The pieces one Fixed, ready for re-review sent on carry the same time and
    // the same note, which then shows once (OPERATOR_NOTE_PLAN).
    if (a.logAction === 'ready_for_rereview') return a.gate === b.gate && String(a.whenIso) === String(b.whenIso);
    if (a.logAction !== 'passed' || a.gate !== b.gate) return false;
    const day = iso => new Date(iso).toDateString();
    return day(a.whenIso) === day(b.whenIso);
}

// One entry as a name in bold and a sentence after it. A "not emailed" entry
// names the person it was for, not the person who pressed; a line about a
// whole list, about nobody, or about the email opened in Outlook has no name
// to put in bold (PHASE5_PLAN section i).
function activityLine(group) {
    const entry = group.entry;
    const detail = String(entry.detail || '');
    const who = String(entry.recipientName || '');
    if (entry.logAction === 'email_not_sent') {
        if (who) return { who, text: 'was not emailed: ' + detail + '.' };
        return { who: '', text: detail };   // already a whole sentence
    }
    // "Email opened in Outlook for Sue Foster and Don Marcotte." (David's
    // answer 2, 2026-10-26): the server's own sentence, with nobody in bold.
    if (entry.logAction === 'email_opened') return { who: '', text: detail };
    return { who: personText(entry.actorName, entry.actorLogin) || 'Someone', text: activitySentence(entry, group.rows) };
}

// ── A press per section (the window changes after step 4) ──
//
// The lines a press would tick: everything in that section that is not
// flagged, not N/A (its own mark or one it follows) and not ticked already. It
// never clears a flag, an N/A or a note, and it fills no value.

function sectionPressKey(unit, number) {
    return unit.key + '|' + number;
}

function sectionSweepIds(unit, section, sheet) {
    return section.items
        .filter(item => !own(sheet.flags, item.id) && !own(sheet.na, item.id) &&
            !REVIEW_ITEMS.followingNA(unit.gate, item.id, sheet.na) && sheet.items[item.id] !== true)
        .map(item => item.id);
}

// Whether the last press on this section can still be taken back exactly: every
// line it ticked is still ticked and still unflagged.
function sectionUndoIds(unit, number, sheet) {
    const ids = sectionPresses.get(sectionPressKey(unit, number)) || [];
    if (!ids.length) return [];
    return ids.every(id => sheet.items[id] === true && !own(sheet.flags, id)) ? ids : [];
}

// The first line of a block still flagged in this round, so a block that was
// sent back opens where the work is rather than at the top.
function firstFlaggedId(unit) {
    const row = unit.base;
    if (!row || row.disposition !== 'corrections') return '';
    const counted = REVIEW_ITEMS.unitVerdict(unit.gate, unit.unitId, saveRules.sheet(unit)).flags;
    let found = '';
    REVIEW_ITEMS.unitSections(unit.gate, unit.unitId).forEach(section => section.items.forEach(item => {
        if (!found && own(counted, item.id)) found = item.id;
    }));
    return found;
}

// A block's name as the window names it now: a piece still on the job by its
// current name and version, else the name the history row kept. Bare, as the
// block heads show it ("Letter", "Whole Job", "Tech Services Checklist"), for
// the short sentences (David, 2026-09-18).
function activityUnitName(e) {
    if (!e.unitId) return '';
    const unit = { jobId: win.jobId, gate: e.gate, unitId: String(e.unitId) };
    if (unit.unitId === 'job') return gateInfo(e.gate) ? unitName(unit) : String(e.unitName || '');
    return pieceOf(win.jobId, unit.unitId) ? unitName(unit) : String(e.unitName || '');
}

// The same inside a longer sentence: "the Whole Job checks", "the CSR Checklist".
function activityUnitPhrase(e) {
    if (String(e.unitId) === 'job' && gateInfo(e.gate)) return unitPhrase({ jobId: win.jobId, gate: e.gate, unitId: 'job' });
    return activityUnitName(e);
}

// One history row in plain words, as short as they will go (David,
// 2026-09-18). rows is every row the entry stands for, newest first: the
// checklists of one sign back in, or passes one after another.
function activitySentence(e, rows) {
    const label = '"' + (e.itemLabel || lineLabel(e.gate, e.itemId) || e.itemId) + '"';
    const name = activityUnitPhrase(e);
    const on = name ? ' on ' + name : '';
    const block = activityUnitName(e) || 'it';
    const detail = String(e.detail || '');
    const job = jobs.get(win.jobId);
    const all = Array.isArray(rows) && rows.length ? rows : [e];
    switch (e.logAction) {
        case 'sent_for_review': return 'sent it for review.';
        // The CSR handing a brand new job over from the work order. Her line
        // goes under it, never into the sentence: she can send it again while
        // nobody has picked the job up, and two lines must read as two presses.
        case 'new_job': return 'sent this job to ' + (gateLabel(e.gate) || e.gate) + '.';
        // Both lines stay, for ever: the record is what she did, not where it
        // ended up (David, 2026-09-20).
        case 'new_job_taken_back': return 'took this job back from ' + (gateLabel(e.gate) || e.gate) + ': sent by mistake.';
        // The block and the note, not the line's wording: the line itself is
        // highlighted on the block (David, 2026-09-18).
        case 'flagged': return 'flagged ' + (activityUnitName(e) ? 'the ' + activityUnitName(e) : 'it') + (detail ? ': "' + detail + '"' : '.');
        case 'sent_back': {
            // Written by the CSR's old Send to work order, before the sign back in.
            const m = /^(\d+) items? flagged for (.+)$/.exec(detail);
            if (m) return 'sent ' + m[1] + (m[1] === '1' ? ' flagged item' : ' flagged items') + ' to ' + m[2] + '.';
            return 'sent ' + block + ' back.';
        }
        // One press can send several pieces back to be checked: one entry.
        case 'ready_for_rereview': return 'fixed ' + joinAnd(all.slice().reverse().map(r => activityUnitName(r) || 'it')) + '.';
        case 'signed_back_in': {
            // Every department block she sent back, in tab order. Her own
            // checklist comes back with every changes round and is not named.
            const blocks = [];
            all.filter(r => r.gate !== 'csr')
                .sort((a, b) => TAB_ORDER.indexOf(a.gate) - TAB_ORDER.indexOf(b.gate))
                .forEach(r => {
                    const d = safeDetail(r.detail);
                    if (Array.isArray(d.blocks)) d.blocks.forEach(b => { if (String(b || '')) blocks.push(String(b)); });
                });
            const live = all.some(r => safeDetail(r.detail).production) ? ', for production' : '';
            return 'signed it back in' + live + (blocks.length ? ': ' + joinAnd(blocks) : '') + '.';
        }
        case 'passed': return 'passed ' + joinAnd(all.slice().reverse().map(r => activityUnitName(r) || 'it')) + '.';
        case 'reopened': return 'reopened ' + block + '.';
        case 'sent_to_csr': return e.recipientName
            ? 'sent the outputs to ' + e.recipientName + '.'
            : 'sent the outputs on. Nobody is the CSR on ' + (e.jobNumber || (job && job.jobNumber) || 'this job') + '.';
        case 'handoff_asked': return 'asked for the outputs.';
        // Written by the job's delete (item 7). Also on a live job's history
        // when a deleted job was imported back from its export.
        case 'job_deleted': return 'deleted this job.';
        case 'na_set': {
            const words = activityWords.get(e.id);
            const said = words && words.text.trim() ? ': "' + words.text + '"' + (words.by && words.by !== words.setBy ? ' (' + words.by + ')' : '') : '';
            return 'marked ' + label + ' as N/A' + on + said + '.';
        }
        case 'na_unset': return 'put ' + label + ' back in play' + on + '.';
        case 'flag_removed': return 'took the flag off ' + label + on + (detail ? ' (the note was "' + detail + '").' : '.');
        case 'flag_cleared_by_check': return 'cleared a flag' + (activityUnitName(e) ? ' on the ' + activityUnitName(e) : '') + '.';
        default: return String(e.logAction || '').replace(/_/g, ' ') + '.';
    }
}

function renderFooter() {
    if (!win.open) return;
    if (win.record) {
        footEl.classList.remove('is-problem');
        saveLineEl.textContent = 'Read only.';
        return;
    }
    const messages = [];
    let retrying = false;
    jobUnits(win.jobId).forEach(unit => {
        if (unit.problem && unit.problem.kind === 'retry') retrying = true;
        if (unit.problem && unit.problem.kind === 'failed') messages.push(unit.problem.text);
        if (unit.conflict) messages.push(conflictText(unit));
        if (unit.readonly && (unit.ops.length || unit.lostSignoff)) messages.push(unsavedText(unit));
    });
    if (retrying) messages.unshift('Not saved yet. Trying again.');
    const unique = messages.filter((m, i) => messages.indexOf(m) === i);

    footEl.classList.toggle('is-problem', unique.length > 0);
    if (unique.length) saveLineEl.textContent = unique.join(' ');
    else if (win.closing) saveLineEl.textContent = 'Saving...';
    else saveLineEl.textContent = savedText();
}

function whereText(unit) {
    const g = gateInfo(unit.gate);
    if (g && g.perPiece) return unitName(unit);
    return unit.gate === win.gate ? 'this checklist' : 'the ' + unitName(unit);
}

function conflictText(unit) {
    const labels = unit.conflict.ids.map(id => lineLabel(unit.gate, id));
    const signoff = unit.conflict.signoff;
    const what = signoff === 'pass' ? 'Not marked passed' : signoff === 'signback' ? 'Not signed back in'
        : signoff && !labels.length ? 'Not sent' : 'Not saved';
    const by = conflictCause(unit);
    if (by) return signedBackText(unit, what, labels, signoff, by);
    const head = what + ': someone else changed ' + whereText(unit) + '.';
    let text = labels.length === 1 ? head + ' Check ' + labels[0] + ' and do it again.'
        : labels.length ? head + ' Check these and do them again: ' + labels.join('; ') + '.'
        : head + ' Check it';
    if (signoff) {
        const name = signoff === 'pass' ? 'Mark passed' : signoff === 'signback' ? 'Sign back in' : 'Corrections needed';
        text += (labels.length ? ' Then press ' : ', then press ') + name + ' again.';
    }
    return text;
}

// Who made a conflict, when a CSR signing back in did (decision 5). On a
// department block: kept on the conflict from the answer that refused the
// click. On the CSR checklist: the newest "signed back in" stamp on the job's
// checklists that is later than the row the clicks or the Sign back in sheet
// were made against (every sign back in stamps each checklist it touches, the
// CSR checklist too unless it is for production), read from what the window
// last loaded; for clicks only a sign back in that cleared the CSR checklist
// counts. Before the window has reloaded, the first guess the answer gave, or
// nobody, and today's words.
function conflictCause(unit) {
    const c = unit.conflict;
    if (c.signedBackBy) return c.signedBackBy;
    const k = c.csr;
    const back = c.signoff === 'signback';
    if (!k || (!back && !k.roundUp)) return null;
    if (k.found) return Object.assign({ job: true }, k.found);
    const s = stateOf(unit.jobId);
    const newest = (s && Array.isArray(s.gates) ? s.gates : [])
        .filter(g => (back || g.gate === 'csr') && String(g.signedBackInDate || '') > String(k.since || '') &&
            (!k.until || String(g.signedBackInDate || '') <= k.until))
        .sort((a, b) => String(b.signedBackInDate).localeCompare(String(a.signedBackInDate)))[0];
    // Kept once found: each checklist holds only its newest stamp, which a
    // later sign back in replaces.
    if (newest) k.found = { name: String(newest.signedBackInByName || ''), login: String(newest.signedBackInByLogin || '') };
    if (k.found) return Object.assign({ job: true }, k.found);
    return k.guess ? Object.assign({ job: true }, k.guess) : null;
}

// The line when a CSR's sign back in refused the clicks (David, 2026-09-25):
// who, and on a department block when to do them again. "After <operator>
// presses Fixed" only while the block's own box says to wait for Fixed; once
// the window knows Fixed was pressed the wait comes off. Mark passed never
// lists lines: the change cleared every answer on the block. Read from
// another tab, a CSR checklist line names the checklist.
function signedBackText(unit, what, labels, signoff, by) {
    const me = isViewer(unit.jobId, by.name, by.login);
    const who = me ? 'you' : personText(by.name, by.login) || 'a CSR';
    if (by.job) {
        const on = unit.gate === win.gate ? '' : ' on the ' + unitName(unit);
        const lines = labels.length === 1 ? ' Check ' + labels[0] + on + ' and do it again.'
            : labels.length ? ' Check these' + on + ' and do them again: ' + labels.join('; ') + '.' : '';
        if (signoff === 'signback') {
            if (me) return what + ': you already signed the job back in from another window.' + lines;
            return what + ': ' + who + ' signed the job back in first.' + lines +
                ' Check what was sent back before you sign it back in again.';
        }
        const head = what + ': ' + who + ' signed the job back in.';
        if (signoff === 'pass') return head + ' Check every line' + on + ' again, then press Mark passed again.';
        return head + (lines || ' Check it' + on + '.');
    }
    const head = what + ': ' + who + ' signed ' + whereText(unit) + ' back in.';
    const waiting = csrChangeWithOperator(unit);
    const say = text => waiting
        ? ' After ' + (operatorName(unit.jobId, unit.gate) || 'the operator') + ' presses Fixed, ' + text
        : ' ' + text.charAt(0).toUpperCase() + text.slice(1);
    if (signoff === 'pass') return head + say('check every line again, then press Mark passed again.');
    let text = head + (labels.length === 1 ? say('do ' + labels[0] + ' again.')
        : labels.length ? say('do these again: ' + labels.join('; ') + '.')
        : say('check it'));
    if (signoff) text += (labels.length ? ' Then press ' : ', then press ') + 'Corrections needed again.';
    return text;
}

function unsavedText(unit) {
    const labels = saveRules.opIds(unit.ops).map(id => lineLabel(unit.gate, id));
    const g = gateInfo(unit.gate);
    const where = g && g.perPiece ? ' on ' + unitName(unit) : unit.gate === win.gate ? '' : ' on the ' + unitName(unit);
    const what = unit.lostSignoff === 'pass' ? 'Not marked passed'
        : unit.lostSignoff === 'signback' ? 'Not signed back in'
        : unit.lostSignoff ? 'Not sent back' : 'Not saved';
    return what + where + (labels.length ? ': ' + labels.join('; ') : '') + '.';
}

// "Last saved 2:41 PM by Don Marcotte." for the newest row on this tab (David,
// 2026-09-18); just "Saves as you go." before there is one.
function savedText() {
    let latest = null;
    if (!win.loadText) {
        unitIdsFor(win.jobId, win.gate).forEach(unitId => {
            const unit = units.get(unitKey(win.jobId, win.gate, unitId));
            const row = unit && unit.base;
            if (row && row.lastModified && (!latest || String(row.lastModified) > String(latest.lastModified))) latest = row;
        });
    }
    if (!latest) return 'Saves as you go.';
    const date = new Date(latest.lastModified);
    if (isNaN(date.getTime())) return 'Saves as you go.';
    const day = dayText(date);
    const who = String(latest.lastModifiedByName || latest.lastModifiedByLogin || '');
    return 'Last saved ' + (day ? day + ', ' : '') + clockText(date) + (who ? ' by ' + who : '') + '.';
}

// ── Focus ──

function focusables() {
    return Array.from(modal.querySelectorAll('button, input, textarea'))
        .filter(node => !node.disabled && node.getClientRects().length > 0);
}

// A control that had focus was redrawn or disabled: Chrome hands focus to the
// page, where Ctrl+Z would reach the work order. Take it back.
function keepFocusInside() {
    if (!win.open) return;
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) modal.focus({ preventScroll: true });
}

// Redrawing part of the window must not throw focus away: remember which
// control had it, by what it does, and give focus to the one drawn in its place.
const FOCUS_ATTRS = ['data-review-action', 'data-review-dept', 'data-review-flag-id'];

function focusKey(container) {
    const active = document.activeElement;
    if (!active || !container.contains(active) || active === container) return null;
    return FOCUS_ATTRS.map(name => active.getAttribute(name) || '');
}

function restoreFocus(container, key) {
    if (!key || !key[0]) return;
    const match = Array.from(container.querySelectorAll('[data-review-action]'))
        .find(node => FOCUS_ATTRS.every((name, i) => (node.getAttribute(name) || '') === key[i]));
    if (match && !match.disabled) match.focus({ preventScroll: true });
}

function isAppPopup(node) {
    if (!node || typeof node.closest !== 'function') return false;
    if (node.closest('#serverBanner')) return true;
    // Every .modal shares one z-index, so only those later in the page paint
    // over the window. One earlier in the page is hidden under it.
    const other = node.closest('.modal');
    return !!other && other !== modal && getComputedStyle(other).display !== 'none' &&
        !!(modal.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
}

// Focus leaving the window (Tab past either end, or anything else) comes back:
// Tab to the first control, Shift+Tab to the last, otherwise to the window.
function onDocumentFocusIn(e) {
    // A signed sheet is drawn over the window and is the only thing to read
    // while it is open, so the live checklist behind it stays out of reach of
    // the Tab key as well as the mouse.
    if (win.open && sheetOpen && sheetEl && !sheetEl.contains(e.target)) {
        e.stopPropagation();
        const back = sheetEl.querySelector('[data-review-action="sheet-close"]');
        if (back) back.focus({ preventScroll: true });
        else modal.focus({ preventScroll: true });
        return;
    }
    if (!win.open || modal.contains(e.target) || isAppPopup(e.target)) return;
    e.stopPropagation();
    const list = focusables();
    const direction = tabDirection;
    tabDirection = '';
    if (direction === 'back' && list.length) list[list.length - 1].focus({ preventScroll: true });
    else if (direction === 'forward' && list.length) list[0].focus({ preventScroll: true });
    else modal.focus({ preventScroll: true });
}

// Ctrl+Z / Ctrl+Y outside the window (focus on the page after a redraw) would
// rewind the work order. Inside the window they stay with the note box.
function onDocumentKeyDown(e) {
    if (!win.open || !(e.ctrlKey || e.metaKey)) return;
    const key = String(e.key).toLowerCase();
    // Ctrl+P while a signed sheet is open prints the sheet, as Export does
    // (David, 2026-09-27). The page's own print would show what is behind the
    // window, which is hidden in print, so the key is taken even while the
    // sheet is still loading, when there is nothing to print yet. A held key
    // prints once.
    if (key === 'p' && !e.altKey && !e.shiftKey && sheetOpen) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) exportSheet();
        return;
    }
    if (key !== 'z' && key !== 'y') return;
    if (modal.contains(e.target) || isAppPopup(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    modal.focus({ preventScroll: true });
}

// Chrome keeps one list of typing to take back for the whole page. Ctrl+Z in
// the window (on a checkbox, or in a note with nothing of its own left to take
// back) would take back text typed earlier in the work order, and the work
// order would save that. Only the window's own note boxes are let through.
function onDocumentBeforeInput(e) {
    if (!win.open || (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo')) return;
    if (!modal.contains(e.target)) e.preventDefault();
}

// ── Events ──

function currentUnitOf(node) {
    const block = node.closest('[data-review-unit]');
    return block ? unitFor(win.jobId, win.gate, block.getAttribute('data-review-unit')) : null;
}

function rowIdOf(node) {
    const row = node.closest('[data-review-item]');
    return row ? row.getAttribute('data-review-item') : '';
}

// Whether this person may change the block now: the server's access for the
// tab, nothing making the window, the checklist or the block read only, no
// sign-off waiting to go (it carries the sheet as it was pressed), and not
// passed (a passed checklist is locked until someone reopens it). evenIfPassed
// is for Reopen.
function editable(unit, evenIfPassed) {
    return !!unit && !unit.readonly && !unit.signoff && !shutReason(unit.jobId, unit.gate) && !win.loadText &&
        accessFor(unit.jobId, unit.gate).canEdit && (evenIfPassed || !(unit.base && unit.base.disposition === 'passed')) &&
        !csrChangeWithOperator(unit);
}

// ── A signed sheet, as it was frozen ──
// Every pass freezes a full copy: every line in that day's wording, every
// answer, the flags, who reviewed, and the work order it was signed against.
// Signing a job back in clears the live sheet, so for every round already gone
// the frozen copy is the only place those ticks still exist. It is drawn from
// its own copy and never rebuilt from today's checklist, which would silently
// drop a line that has since been retired. One drawing serves the screen and
// Export, so the two can never say different things; only the dates differ.

function closeSheet() {
    // Export all is not the open sheet's: a sheet opened and closed while it
    // gets ready leaves it going.
    if (exporting && !exporting.all) endExport(exporting);
    sheetOpen = null;
    if (!sheetEl) return;
    sheetEl.textContent = '';
    sheetEl.hidden = true;
}

async function openSheet(logId) {
    // Not while the window is going: closeReview waits for the saves in
    // flight, and a sheet opened inside that wait would still be drawn when
    // the next job opens.
    if (!sheetEl || !win.open || win.closing) return;
    const jobId = win.jobId;
    sheetOpen = { logId, loading: true, error: '', row: null, frozen: null };
    renderSheet();
    const res = await getJson('/api/jobs/' + encodeURIComponent(jobId) + '/review-log?snapshot=' + encodeURIComponent(logId));
    if (!sheetOpen || sheetOpen.logId !== logId || win.jobId !== jobId || !win.open || win.closing) return;
    sheetOpen.loading = false;
    if (!res.ok || !res.json || !res.json.entry) {
        sheetOpen.error = 'That signed sheet could not be loaded.';
    } else {
        sheetOpen.row = res.json.entry;
        sheetOpen.frozen = safeDetail(res.json.entry.detail);
    }
    renderSheet();
}

// While Export all gets ready the open sheet's Export does nothing (one export
// at a time), so it is greyed for that time. Set on the button in place: the
// sheet is not drawn again, which would lose the place she is reading.
function greySheetExport() {
    const press = sheetEl ? sheetEl.querySelector('[data-review-action="sheet-export"]') : null;
    if (!press) return;
    if (exporting && exporting.all) press.setAttribute('aria-disabled', 'true');
    else press.removeAttribute('aria-disabled');
}

// Loaded, and its frozen copy readable: the only time there is a sheet to
// export.
function sheetReady() {
    return !!sheetOpen && !sheetOpen.loading && !sheetOpen.error && !!sheetOpen.frozen &&
        Array.isArray(sheetOpen.frozen.sections);
}

function sheetAnswerText(line) {
    if (line.answer === 'ticked') return 'Checked';
    if (line.answer === 'na') return 'N/A';
    return 'Not answered';
}

// "Sep 27 2026, 2:33 PM". Paper is read later, so Export never writes
// "Today" and never leaves the year off.
function fullWhen(iso) {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return MONTHS[date.getMonth()] + ' ' + date.getDate() + ' ' + date.getFullYear() + ', ' + clockText(date);
}

// A line's wording on the same frozen sheet, never today's checklist.
function sheetLineLabel(frozen, id) {
    for (const section of frozen.sections || []) {
        for (const line of section.lines || []) {
            if (line.id === id) return line.label || id;
        }
    }
    return id;
}

function sheetNaText(line, frozen, when) {
    const na = line.na || null;
    if (!na) return '';
    if (na.follows) return 'N/A with ' + sheetLineLabel(frozen, na.follows) + ': ' + (na.reason || '');
    const who = na.name ? 'by ' + na.name : '';
    const on = na.at ? ' on ' + when(na.at) : '';
    const marked = ('Marked N/A ' + who + on).trim();
    const words = naWords(na);
    if (!words) return marked;
    const by = na.reasonName && na.reasonName !== na.name ? ' (' + na.reasonName + ')' : '';
    return marked + ': "' + words + '"' + by;
}

// The number the work order wrote into each revision's heading ("(3) Updated
// by ..."), read the way the server read it when it froze them. Text from
// before that format counts as revision 0.
function sheetRevisionNumbers(added) {
    return added.map(html => {
        const m = /<strong>\((\d+)\)/.exec(String(html));
        return m ? Number(m[1]) : 0;
    });
}

function drawSheetWorkOrder(frozen, into, make, when) {
    const wo = frozen.workOrder;
    const box = make('div', 'review-sheet-section');
    box.appendChild(make('h4', 'review-sheet-section-title', 'The work order it was signed against'));
    if (!wo || !Array.isArray(wo.pieces)) {
        box.appendChild(make('p', 'review-sheet-gap',
            'This sheet was signed off before the work order was kept with it, so what the instructions said that day is not in this record. The work order’s own revisions still hold it while the job exists.'));
        into.appendChild(box);
        return;
    }
    box.appendChild(make('p', 'review-sheet-stamp', 'The work order reported it was last changed '
        + (wo.reportedAt ? when(wo.reportedAt) : 'at an unrecorded time')
        + (wo.reportedBy ? ' by ' + wo.reportedBy : '') + '. Frozen here ' + when(wo.frozenAt) + '.'));
    if (!wo.pieces.length) box.appendChild(make('p', 'review-sheet-gap', 'No pieces were on the job at that moment.'));
    wo.pieces.forEach(piece => {
        const card = make('div', 'review-sheet-piece');
        card.appendChild(make('div', 'review-sheet-piece-name',
            (piece.name || 'A piece') + (piece.version ? ' (' + piece.version + ')' : '')));
        REVIEW_SHEET_DEPTS.forEach(dept => {
            const part = piece[dept.key];
            if (!part) return;
            const block = make('div', 'review-sheet-dept');
            block.appendChild(make('div', 'review-sheet-dept-name', dept.label));
            const added = Array.isArray(part.added) ? part.added : [];
            const live = String(part.live || '').trim() ? String(part.live) : '';
            const through = Number.isFinite(part.throughRevision) ? part.throughRevision : 0;
            // A sheet holds only the revisions filed since the last signed
            // sheet of the same block; the ones before are kept with that one
            // (David, 2026-09-27: say where they are).
            const earlier = part.rewritten ? 0 : added.length ? Math.min(...sheetRevisionNumbers(added)) - 1 : through;
            // The revisions were replaced between the two sign-offs, which an
            // import over the job can do. Everything below is the whole
            // history as it stood, not what is new.
            if (part.rewritten) {
                block.appendChild(make('p', 'review-sheet-gap',
                    'The revisions on this piece were replaced after the last signed sheet, which went up to revision '
                    + part.wasThrough + '. Everything below is the whole history as it stood at this sign-off.'));
            } else if (!added.length && !live) {
                // A history held only in the old unnumbered form is revision 0
                // but still has a mark, so it counts as instructions.
                block.appendChild(make('p', 'review-sheet-gap', through > 0 || part.throughMark
                    ? 'Nothing new here since this piece was last signed off.'
                    : 'No ' + dept.label + ' instructions on this piece when it was signed off.'));
            }
            if (live) {
                block.appendChild(make('div', 'review-sheet-live-label', 'Typed and not yet filed into the revisions'));
                const words = make('div', 'review-sheet-instructions');
                // Old plain text (no tags at all) kept its line breaks as
                // newlines, drawn as the work order draws them.
                words.innerHTML = sheetHtml(into.ownerDocument, live.includes('<') ? live : live.replace(/\n/g, '<br>'));
                block.appendChild(words);
            }
            if (added.length) {
                const all = part.rewritten || earlier < 1;
                block.appendChild(make('div', 'review-sheet-live-label', all
                    ? (added.length === 1 ? 'The one revision on this piece' : 'Every revision on this piece')
                    : added.length === 1 ? 'The revision filed since this piece was last signed off' : 'The revisions filed since this piece was last signed off'));
                const revs = make('div', 'review-sheet-instructions');
                revs.innerHTML = sheetHtml(into.ownerDocument, added.join(''));
                block.appendChild(revs);
            }
            // The earlier sheets are this block's own: a piece's on Prepress,
            // the whole checklist's on CSR, Tech Services and Whole Job
            // (David, 2026-09-27).
            if (earlier >= 1) {
                const whose = (frozen.unitId || 'job') === 'job' ? 'this checklist' : 'this piece';
                block.appendChild(make('div', 'review-sheet-through', earlier === 1
                    ? 'Revision 1 is kept with an earlier signed sheet of ' + whose + '.'
                    : 'Revisions 1 to ' + earlier + ' are kept with earlier signed sheets of ' + whose + '.'));
            }
            if (through > 0) {
                block.appendChild(make('div', 'review-sheet-through', 'Up to revision ' + through + ' of this piece.'));
            }
            card.appendChild(block);
        });
        box.appendChild(card);
    });
    into.appendChild(box);
}

const REVIEW_SHEET_DEPTS = [{ key: 'prepress', label: 'Prepress' }, { key: 'techservices', label: 'Tech Services' }];

// The frozen words as the sheet draws them (R25, the after-rollout batch,
// item 12). On screen they go into the page itself, so they are cleaned
// first with DOMPurify (lib/purify.min.js), as the work order cleans its
// instructions: Quill's formats stay, scripts, event attributes, <style>,
// form controls, ids and names go. In the export frame they are drawn as
// frozen: that frame is sandboxed and runs nothing (exportSheet).
const SHEET_CLEAN = { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option'], FORBID_ATTR: ['id', 'name'] };
function sheetHtml(doc, html) {
    if (doc !== document || !html) return html || '';
    if (window.DOMPurify && window.DOMPurify.isSupported) return window.DOMPurify.sanitize(html, SHEET_CLEAN);
    // lib/purify.min.js did not load: the words as plain text, never the
    // stored HTML as it is.
    const text = new DOMParser().parseFromString(String(html).replace(/<(br|\/p|\/li|\/div|\/h[1-6])\b[^>]*>/gi, '$&\n'), 'text/html').body.textContent;
    const box = document.createElement('div');
    box.textContent = text;
    return box.innerHTML.replace(/\n/g, '<br>');
}

// Everything below the sheet's head, built in the document doc: the page's
// own for the screen, the export frame's for paper, so the frozen
// instructions are read by the document that shows them.
// "David Marra passed Self-Mailer on the Prepress checklist, Sep 14 2026,
// 2:05 PM." The block and the checklist are marked with their department
// (review-sheet-who-mark is-prepress / is-techservices / is-csr), which colours
// them on screen and on paper (David, 2026-10-16): Prepress in its red, Tech
// Services in its navy; CSR has no colour of its own, so it stays as the line.
function drawSheetWho(doc, row, frozen, when) {
    const who = row.actorName || frozen.reviewerName || 'Somebody';
    const gate = frozen.gate || row.gate;
    const info = gateInfo(gate);
    const mark = info ? gate : '';
    // A checklist for the whole job is its own block; its name only repeats
    // the checklist's ("passed CSR Checklist on the CSR checklist").
    const what = info && !info.perPiece
        ? [['the '], [info.label, mark], [' checklist']]
        : [[frozen.unitName || row.unitName || 'this block', mark], [' on the '], [gateLabel(gate) || 'QC', mark], [' checklist']];
    const line = elIn(doc, 'p', 'review-sheet-who');
    [[who + ' passed ']].concat(what, [[', ' + when(row.whenIso) + '.']]).forEach(([text, dept]) => {
        line.appendChild(dept ? elIn(doc, 'span', 'review-sheet-who-mark is-' + dept, text) : doc.createTextNode(text));
    });
    return line;
}

function drawSheetBody(doc, when, row, frozen) {
    const make = (tag, className, text) => elIn(doc, tag, className, text);
    const body = make('div', 'review-sheet-body');
    body.appendChild(drawSheetWho(doc, row, frozen, when));
    let facts = 'Job ' + (frozen.jobNumber || row.jobNumber || '')
        + (frozen.clientName ? ', ' + frozen.clientName : '')
        + (frozen.jobDescription ? ', ' + frozen.jobDescription : '')
        + (frozen.operatorName ? '. Operator ' + frozen.operatorName : '')
        + (frozen.sentForReviewByName ? '. Sent for review by ' + frozen.sentForReviewByName : '') + '.';
    // How many times this block had gone back before this pass. It is the
    // block's own count, not the job's round, which the job list words its own
    // way, so it is said plainly and left out the first time through.
    const backs = Number((row.reviewRound !== undefined && row.reviewRound !== null) ? row.reviewRound : frozen.returnCount) || 0;
    if (backs > 0) facts += ' Sent back ' + backs + (backs === 1 ? ' time' : ' times') + ' before this pass.';
    body.appendChild(make('p', 'review-sheet-facts', facts));
    body.appendChild(make('p', 'review-sheet-note',
        'This is the sheet as it was signed off. Nothing on it can be changed, and it stays on the record even if the job is deleted.'));

    const flags = (frozen.sheet && frozen.sheet.flags) || {};
    const hidden = frozen.hiddenFlags || {};
    (frozen.sections || []).forEach(section => {
        const box = make('div', 'review-sheet-section');
        box.appendChild(make('h4', 'review-sheet-section-title',
            (section.section ? section.section + '. ' : '') + (section.title || '')));
        (section.lines || []).forEach(line => {
            const item = make('div', 'review-sheet-line');
            item.appendChild(make('span', 'review-sheet-answer is-' + (line.answer || 'open'), sheetAnswerText(line)));
            item.appendChild(make('span', 'review-sheet-label', line.label || line.id));
            if (String(line.value || '').trim()) item.appendChild(make('span', 'review-sheet-value', String(line.value)));
            const na = sheetNaText(line, frozen, when);
            if (na) item.appendChild(make('div', 'review-sheet-na', na));
            const note = flags[line.id] !== undefined ? flags[line.id] : hidden[line.id];
            if (note !== undefined) {
                item.appendChild(make('div', 'review-sheet-flag',
                    (hidden[line.id] !== undefined ? 'Flagged, not counted while the line was N/A: ' : 'Flagged: ') + String(note)));
            }
            box.appendChild(item);
        });
        body.appendChild(box);
    });

    const off = frozen.offList || {};
    const offIds = Object.keys(Object.assign({}, off.items, off.itemValues, off.flags, off.na));
    if (offIds.length) {
        const box = make('div', 'review-sheet-section');
        box.appendChild(make('h4', 'review-sheet-section-title', 'Answers to lines no longer on this checklist'));
        offIds.forEach(id => {
            const bits = [];
            if (off.items && off.items[id] !== undefined) bits.push(off.items[id] ? 'checked' : 'not checked');
            if (off.na && off.na[id] !== undefined) bits.push('N/A');
            if (off.itemValues && off.itemValues[id] !== undefined && String(off.itemValues[id]).trim()) bits.push(String(off.itemValues[id]));
            if (off.flags && off.flags[id] !== undefined) bits.push('flagged: ' + String(off.flags[id]));
            box.appendChild(make('div', 'review-sheet-line', id + ': ' + (bits.join(', ') || 'answered')));
        });
        body.appendChild(box);
    }

    drawSheetWorkOrder(frozen, body, make, when);
    body.appendChild(make('p', 'review-sheet-foot',
        'Checklist ' + (frozen.formVersion || 'of that day') + '. Record version ' + (frozen.snapshot || 'before these were numbered') + '.'));
    return body;
}

function renderSheet() {
    if (!sheetEl) return;
    sheetEl.textContent = '';
    if (!sheetOpen) {
        sheetEl.hidden = true;
        return;
    }
    sheetEl.hidden = false;
    const head = el('div', 'review-sheet-head');
    head.appendChild(el('h3', 'review-sheet-title', 'The signed sheet'));
    const actions = el('div', 'review-sheet-actions');
    if (sheetReady()) actions.appendChild(button('review-sheet-export', 'Export', 'sheet-export'));
    actions.appendChild(button('review-sheet-close', 'Close', 'sheet-close'));
    head.appendChild(actions);
    sheetEl.appendChild(head);
    greySheetExport();

    if (sheetOpen.loading || sheetOpen.error) {
        const body = el('div', 'review-sheet-body');
        body.appendChild(el('p', 'review-sheet-gap', sheetOpen.loading ? 'Loading...' : sheetOpen.error));
        sheetEl.appendChild(body);
        return;
    }
    sheetEl.appendChild(drawSheetBody(document, reviewWhen, sheetOpen.row || {}, sheetOpen.frozen || {}));
}

// ── Export: the signed sheet on paper ──
// Export, or Ctrl+P while a sheet is open, opens the print box with the sheet
// (DECISIONS_2026-09-23 item 7; EXPORT_PLAN.md). The page itself cannot print
// it: the window is hidden in print and would be cut to one screen. So the
// sheet is built again, by the same drawing, in a hidden frame of its own and
// printed from there. The frame is sandboxed with no scripts, so nothing in the
// frozen instructions can run in it. Chrome names the PDF from the page's
// title, not the frame's, so the page wears the file name while the print box
// is open and gets its own back after. Nothing is written or recorded; a
// picture held in the instructions as a web address is fetched again, as on
// screen. Real Chrome returns from print() only when the print
// box closes, and the page is paused until then; a headless one returns at
// once. Either way the tidy-up runs once, and only for the export that
// started it.

const EXPORT_WAIT_MS = 3000;    // longest wait for the instructions' pictures

// Light always, whatever the app's theme, and Arial, as the work order print:
// a web font on a PDF can lose the text behind its letters (styles.css, the
// print block). A written frame has none of the app's colour tokens, so every
// colour is written out: these are the .review-sheet-* rules of styles.css
// in their light colours, so a change there belongs here too. The Quill block
// is word for word the one in styles.css.
const EXPORT_CSS = [
    '@page { margin: 0.5in 0.4in; @bottom-right { content: "Page " counter(page) " of " counter(pages); font-size: 9px; color: #6b6b80; } }',
    '*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }',
    'html { font-family: Arial, Helvetica, sans-serif; color: #1a1a2e; background: #fff; overflow-wrap: anywhere; -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
    'body { font-size: 13px; line-height: 1.45; }',
    '.review-sheet-title { font-size: 15px; font-weight: 700; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #e8e6e1; }',
    '.review-sheet-who { margin: 0 0 4px; font-size: 14px; font-weight: 600; }',
    // The printed STS Work Order's own colours (printAccent in prepress.js and
    // techservices.js; the window check compares them).
    '.review-sheet-who-mark.is-prepress { color: #CB333B; }',
    '.review-sheet-who-mark.is-techservices { color: #1e3a5f; }',
    '.review-sheet-facts { margin: 0 0 8px; font-size: 12.5px; color: #6b6b80; }',
    '.review-sheet-note { margin: 0 0 18px; font-size: 12.5px; color: #6b6b80; font-style: italic; }',
    '.review-sheet-section { margin-bottom: 18px; }',
    '.review-sheet-section-title { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #6b6b80; break-after: avoid; }',
    '.review-sheet-line { padding: 5px 0; border-bottom: 1px solid #e8e6e1; font-size: 13px; line-height: 1.45; break-inside: avoid; }',
    '.review-sheet-line:last-child { border-bottom: none; }',
    '.review-sheet-answer { display: inline-block; min-width: 92px; margin-right: 8px; font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }',
    '.review-sheet-answer.is-ticked { color: #1a7f4b; }',
    '.review-sheet-answer.is-na { color: #6b6b80; }',
    '.review-sheet-answer.is-open { color: #9a6a00; }',
    '.review-sheet-value { margin-left: 8px; font-weight: 600; }',
    '.review-sheet-na, .review-sheet-flag, .review-sheet-through { margin-left: 100px; font-size: 12px; color: #6b6b80; }',
    '.review-sheet-flag { color: #b91c1c; }',
    '.review-sheet-gap { margin: 0 0 10px; font-size: 12.5px; color: #6b6b80; }',
    '.review-sheet-stamp { margin: 0 0 12px; font-size: 12.5px; color: #6b6b80; }',
    '.review-sheet-piece { margin-bottom: 14px; padding: 12px 14px; border: 1px solid #e8e6e1; border-radius: 6px; background: #f6f5f2; }',
    '.review-sheet-piece-name { font-size: 13px; font-weight: 700; margin-bottom: 8px; break-after: avoid; break-inside: avoid; }',
    '.review-sheet-dept { margin-bottom: 10px; }',
    '.review-sheet-dept:last-child { margin-bottom: 0; }',
    '.review-sheet-dept-name { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: #6b6b80; margin-bottom: 4px; break-after: avoid; }',
    '.review-sheet-live-label { font-size: 11.5px; color: #6b6b80; margin: 6px 0 2px; break-after: avoid; }',
    '.review-sheet-instructions { font-size: 12.5px; line-height: 1.5; padding: 8px 10px; border-left: 2px solid #d8d5cf; background: #fff; overflow-wrap: anywhere; }',
    '.review-sheet-instructions .history-divider { display: none; }',
    '.review-sheet-instructions .history-timestamp { font-size: 11.5px; font-weight: 700; color: #6b6b80; margin: 8px 0 4px; break-after: avoid; }',
    '.review-sheet-instructions .history-content { margin-bottom: 12px; }',
    '.review-sheet-through { margin-left: 0; margin-top: 4px; }',
    '.review-sheet-foot { margin: 18px 0 0; font-size: 11.5px; color: #6b6b80; }',
    '.review-sheet-printed { margin: 4px 0 0; font-size: 11.5px; color: #6b6b80; }'
].join('\n');

// Quill's own rules for what its editor stores, so a frozen instruction reads
// as it was typed. Word for word the block between the same two comments in
// styles.css, which the screen sheet uses; the window check compares them.
const SHEET_QUILL_CSS = [
    '/* Quill in the signed sheet (start) */',
    '.review-sheet-instructions ol, .review-sheet-instructions ul { padding-left: 1.5em; margin: 2px 0; }',
    '.review-sheet-instructions ul { list-style-type: disc; }',
    '.review-sheet-instructions ol { counter-reset: list-0 list-1 list-2 list-3 list-4 list-5 list-6 list-7 list-8 list-9; }',
    '.review-sheet-instructions li[data-list] { list-style-type: none; padding-left: 1.5em; position: relative; counter-set: list-1 list-2 list-3 list-4 list-5 list-6 list-7 list-8 list-9; }',
    '.review-sheet-instructions li[data-list] > .ql-ui { position: absolute; }',
    '.review-sheet-instructions li[data-list] > .ql-ui::before { display: inline-block; margin-left: -1.5em; margin-right: 0.3em; text-align: right; white-space: nowrap; width: 1.2em; }',
    '.review-sheet-instructions li[data-list=bullet] > .ql-ui::before { content: "•"; }',
    '.review-sheet-instructions li[data-list=checked] > .ql-ui::before { content: "☑"; }',
    '.review-sheet-instructions li[data-list=unchecked] > .ql-ui::before { content: "☐"; }',
    '.review-sheet-instructions li[data-list=ordered] { counter-increment: list-0; }',
    '.review-sheet-instructions li[data-list=ordered] > .ql-ui::before { content: counter(list-0, decimal) ". "; }',
    '.review-sheet-instructions li[data-list].ql-indent-1 { counter-set: list-2 list-3 list-4 list-5 list-6 list-7 list-8 list-9; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-1 { counter-increment: list-1; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-1 > .ql-ui::before { content: counter(list-1, lower-alpha) ". "; }',
    '.review-sheet-instructions li[data-list].ql-indent-2 { counter-set: list-3 list-4 list-5 list-6 list-7 list-8 list-9; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-2 { counter-increment: list-2; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-2 > .ql-ui::before { content: counter(list-2, lower-roman) ". "; }',
    '.review-sheet-instructions li[data-list].ql-indent-3 { counter-set: list-4 list-5 list-6 list-7 list-8 list-9; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-3 { counter-increment: list-3; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-3 > .ql-ui::before { content: counter(list-3, decimal) ". "; }',
    '.review-sheet-instructions li[data-list].ql-indent-4 { counter-set: list-5 list-6 list-7 list-8 list-9; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-4 { counter-increment: list-4; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-4 > .ql-ui::before { content: counter(list-4, lower-alpha) ". "; }',
    '.review-sheet-instructions li[data-list].ql-indent-5 { counter-set: list-6 list-7 list-8 list-9; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-5 { counter-increment: list-5; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-5 > .ql-ui::before { content: counter(list-5, lower-roman) ". "; }',
    '.review-sheet-instructions li[data-list].ql-indent-6 { counter-set: list-7 list-8 list-9; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-6 { counter-increment: list-6; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-6 > .ql-ui::before { content: counter(list-6, decimal) ". "; }',
    '.review-sheet-instructions li[data-list].ql-indent-7 { counter-set: list-8 list-9; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-7 { counter-increment: list-7; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-7 > .ql-ui::before { content: counter(list-7, lower-alpha) ". "; }',
    '.review-sheet-instructions li[data-list].ql-indent-8 { counter-set: list-9; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-8 { counter-increment: list-8; }',
    '.review-sheet-instructions li[data-list=ordered].ql-indent-8 > .ql-ui::before { content: counter(list-8, lower-roman) ". "; }',
    '.review-sheet-instructions .ql-indent-1 { padding-left: 3em; }',
    '.review-sheet-instructions li.ql-indent-1 { padding-left: 4.5em; }',
    '.review-sheet-instructions .ql-indent-2 { padding-left: 6em; }',
    '.review-sheet-instructions li.ql-indent-2 { padding-left: 7.5em; }',
    '.review-sheet-instructions .ql-indent-3 { padding-left: 9em; }',
    '.review-sheet-instructions li.ql-indent-3 { padding-left: 10.5em; }',
    '.review-sheet-instructions .ql-indent-4 { padding-left: 12em; }',
    '.review-sheet-instructions li.ql-indent-4 { padding-left: 13.5em; }',
    '.review-sheet-instructions .ql-indent-5 { padding-left: 15em; }',
    '.review-sheet-instructions li.ql-indent-5 { padding-left: 16.5em; }',
    '.review-sheet-instructions .ql-indent-6 { padding-left: 18em; }',
    '.review-sheet-instructions li.ql-indent-6 { padding-left: 19.5em; }',
    '.review-sheet-instructions .ql-indent-7 { padding-left: 21em; }',
    '.review-sheet-instructions li.ql-indent-7 { padding-left: 22.5em; }',
    '.review-sheet-instructions .ql-indent-8 { padding-left: 24em; }',
    '.review-sheet-instructions li.ql-indent-8 { padding-left: 25.5em; }',
    '.review-sheet-instructions .ql-size-small { font-size: 0.75em; }',
    '.review-sheet-instructions .ql-size-large { font-size: 1.5em; }',
    '.review-sheet-instructions .ql-size-huge { font-size: 2.5em; }',
    '.review-sheet-instructions .ql-align-center { text-align: center; }',
    '.review-sheet-instructions .ql-align-right { text-align: right; }',
    '.review-sheet-instructions .ql-align-justify { text-align: justify; }',
    '.review-sheet-instructions blockquote { border-left: 4px solid #ccc; margin: 5px 0; padding-left: 16px; }',
    '.review-sheet-instructions img { max-width: 100%; height: auto; }',
    '/* Quill in the signed sheet (end) */'
].join('\n');

// What the job's pieces say on each page and in the file name (David,
// 2026-09-27): the job, the checklist, and the block on Prepress's per-piece
// checklist. A checklist for the whole job leaves its block out, which would
// only repeat it.
function exportParts(row, frozen) {
    const gate = frozen.gate || row.gate;
    const info = gateInfo(gate);
    // Two pieces can share a name (V1 and V2 Letters), so the version goes
    // with it when the piece has one (David, 2026-09-27).
    const unitId = frozen.unitId || row.unitId;
    const pieces = (frozen.workOrder && Array.isArray(frozen.workOrder.pieces)) ? frozen.workOrder.pieces : [];
    const piece = pieces.find(p => p && p.id === unitId);
    const version = piece && piece.version ? ' ' + piece.version : '';
    return {
        job: String(frozen.jobNumber || row.jobNumber || ''),
        label: gateLabel(gate) || 'QC',
        block: info && info.perPiece ? String(frozen.unitName || row.unitName || '') + (unitId === 'job' ? '' : version) : ''
    };
}

// "48127 - QC Prepress Letter V2 2026-09-27 150512": the job number first, like
// the work order's PDFs, so the two sit together in a folder, and when the
// block was passed, to the second, so two passes never share a name. The same sheet
// always gets the same name: it never changes. A dot and the characters
// Windows refuses become _, as in the work order's names.
function exportFileName(row, frozen) {
    const parts = exportParts(row, frozen);
    // A name longer than about 250 characters is refused by Windows, so a very
    // long piece name is cut short here (the sheet itself keeps it whole).
    return exportSafeName([parts.job, '- QC', parts.label, parts.block.slice(0, 60).trim(), exportStamp(row.whenIso)]);
}

// "2026-09-27 150512", the browser's clock, 24 hours, no colon.
function exportStamp(iso) {
    const date = new Date(iso);
    const two = n => String(n).padStart(2, '0');
    return isNaN(date.getTime()) ? '' : date.getFullYear() + '-' + two(date.getMonth() + 1) + '-' + two(date.getDate()) +
        ' ' + two(date.getHours()) + two(date.getMinutes()) + two(date.getSeconds());
}

function exportSafeName(bits) {
    return bits.filter(Boolean).join(' ')
        .replace(/[\u0000-\u001f]/g, ' ').replace(/\./g, '_').replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

// "Job 48127, Prepress QC, Letter V2", at the top of every page.
function exportPageLine(row, frozen) {
    const parts = exportParts(row, frozen);
    return 'Job ' + parts.job + ', ' + parts.label + ' QC' + (parts.block ? ', ' + parts.block : '');
}

// Text as a CSS string. Anything but letters, digits, spaces, commas and dots
// is written as its code, so no name can end the string or the rule.
function cssString(text) {
    return '"' + String(text).replace(/[^A-Za-z0-9 ,.]/gu, ch => '\\' + ch.codePointAt(0).toString(16) + ' ') + '"';
}

// Pictures in the instructions load after the frame is written, and printed
// before they have, they are left out. Wait for each to load or fail, at most
// waitMs. A picture told to load only when scrolled to would never load in a
// frame nobody sees, so it is told to load now.
function exportPictures(doc, waitMs) {
    const waiting = Array.from(doc.images).filter(img => {
        img.removeAttribute('loading');
        return !img.complete;
    });
    if (!waiting.length) return Promise.resolve();
    return new Promise(resolve => {
        let left = waiting.length;
        const timer = setTimeout(resolve, waitMs);
        const one = () => {
            left -= 1;
            if (left === 0) {
                clearTimeout(timer);
                resolve();
            }
        };
        waiting.forEach(img => {
            img.addEventListener('load', one, { once: true });
            img.addEventListener('error', one, { once: true });
        });
    });
}

// Quill's list markers are positioned, and Chrome draws positioned text after
// everything else on the page, so a list copied out of the PDF came out last,
// each bullet after its line. The printed work order has the same rule. The
// same look on paper, the text in order (EXPORT_ALL_PLAN.md, David's answer 4).
const EXPORT_TEXT_ORDER_CSS = '.review-sheet-instructions li[data-list], .review-sheet-instructions li[data-list] > .ql-ui { position: static; }';

// The export's own frame, in the page and empty but for a fixed shell. The
// sandbox is set before the frame is in the page, or it does not apply: no
// scripts, but this page may write its document and ask it to print.
function makeExportFrame(job) {
    const frame = document.createElement('iframe');
    frame.className = 'review-print-frame';
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    job.frame = frame;
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title></title><style></style></head><body></body></html>');
    doc.close();
    return doc;
}

async function exportSheet() {
    if (!sheetReady() || exporting || !win.open || win.closing) return;
    const row = sheetOpen.row;
    const frozen = sheetOpen.frozen;
    const job = { frame: null, logId: sheetOpen.logId, title: null, done: false };
    exporting = job;
    try {
        const doc = makeExportFrame(job);
        const frame = job.frame;
        // Given as text, never read as HTML, so a piece named with "</style>"
        // in it stays a name.
        doc.querySelector('style').textContent = EXPORT_CSS + '\n' + SHEET_QUILL_CSS + '\n' + EXPORT_TEXT_ORDER_CSS + '\n' +
            '@page { @top-left { content: ' + cssString(exportPageLine(row, frozen)) + '; font-size: 9px; color: #6b6b80; } }';
        const fileName = exportFileName(row, frozen);
        doc.title = fileName;
        doc.body.appendChild(elIn(doc, 'h1', 'review-sheet-title', 'The signed sheet'));
        doc.body.appendChild(drawSheetBody(doc, fullWhen, row, frozen));
        doc.body.appendChild(elIn(doc, 'p', 'review-sheet-printed', 'Printed ' + fullWhen(new Date().toISOString()) + '.'));
        await exportPictures(doc, EXPORT_WAIT_MS);
        // Closing the sheet, a tab or the window during the wait ends the
        // export; so does another sheet opened in its place.
        if (exporting !== job || job.done || !frame.isConnected || !sheetOpen || sheetOpen.logId !== job.logId ||
            !win.open || win.closing) return;
        printExport(job, fileName);
    } finally {
        endExport(job);
    }
}

// The print box, from the export's frame, with the page wearing the file name
// Chrome offers (it names the PDF from the page's title, not the frame's).
// Real Chrome returns only when the box closes; a headless one at once.
function printExport(job, fileName) {
    const frame = job.frame;
    frame.contentWindow.addEventListener('afterprint', () => endExport(job));
    job.title = document.title;
    document.title = fileName;
    frame.contentWindow.print();
}

// Once, and only for its own export: the page's title back, the frame gone.
function endExport(job) {
    if (!job || job.done) return;
    job.done = true;
    if (job.title !== null) document.title = job.title;
    if (job.frame) job.frame.remove();
    if (exporting === job) exporting = null;
}

// ── Export all: every signed sheet of the job in one print ──
// The button on the Activity heading prints every signed sheet the list has a
// button for, every checklist and round, oldest first, in one print box
// (EXPORT_ALL_PLAN.md, David's five answers of 2026-10-15). Each sheet is drawn
// exactly as its own Export draws it and starts a page of its own, whose top
// line names it and the day it was passed; the page count runs through the
// file, and "Printed" comes once, at the end. The history is read again first,
// so a pass made a moment ago in another window is in it. The sheets are
// fetched one by one, a few at a time, through the route the sheet itself
// opens with; every one must load, or nothing is printed and the heading says
// so. A picture still not loaded after the wait is printed as a line saying
// so, never as a blank. Nothing is written or recorded.

const EXPORT_ALL_WAIT_MS = 15000;   // longest wait for every picture of every sheet
const EXPORT_ALL_AT_ONCE = 4;       // sheets asked for at a time: two of Chrome's six left for the window's own saves

// Each sheet starts a page because each has a page name of its own (a change
// of name is a page break), so this is all Export all adds.
const EXPORT_ALL_CSS = '.review-export-missing { font-style: italic; color: #6b6b80; }';

// "passed Sep 27 2026": a sheet's every page says which pass it is, since one
// block's sheets of every round share the rest of the line (answer 5).
function exportPassedText(row) {
    const date = new Date(row.whenIso);
    return isNaN(date.getTime()) ? '' : ', passed ' + MONTHS[date.getMonth()] + ' ' + date.getDate() + ' ' + date.getFullYear();
}

// "48127 - QC all signed sheets 2026-10-15 143005": the newest pass's time,
// so the same sheets always get the same name, as one sheet does (answer 3).
function exportAllFileName(newest) {
    return exportSafeName([String(newest.jobNumber || ''), '- QC all signed sheets', exportStamp(newest.whenIso)]);
}

// A sheet whose record cannot be drawn keeps its place, so the count of what
// was printed stays true: who passed what and when, and that the rest is not
// here.
function unreadableSheet(doc, row) {
    const body = elIn(doc, 'div', 'review-sheet-body');
    body.appendChild(drawSheetWho(doc, row, {}, fullWhen));
    body.appendChild(elIn(doc, 'p', 'review-sheet-gap', 'The rest of this signed sheet could not be read from the record, so it is not printed here.'));
    return body;
}

function markMissingPictures(doc) {
    Array.from(doc.images).forEach(img => {
        if (img.complete && img.naturalWidth > 0) return;
        img.replaceWith(elIn(doc, 'span', 'review-export-missing', 'A picture here did not load.'));
    });
}

// Each sheet, a few at a time: { row, frozen } in the list's order, null for
// one that did not load.
async function fetchSheets(jobId, list, gone) {
    const out = list.map(() => null);
    let next = 0;
    const worker = async () => {
        while (next < list.length && !gone()) {
            const i = next++;
            const res = await getJson('/api/jobs/' + encodeURIComponent(jobId) + '/review-log?snapshot=' + encodeURIComponent(list[i].id));
            if (res.ok && res.json && res.json.entry) {
                const row = res.json.entry;
                const frozen = safeDetail(row.detail);
                row.detail = '';
                out[i] = { row, frozen };
            }
        }
    };
    await Promise.all(Array.from({ length: EXPORT_ALL_AT_ONCE }, worker));
    return out;
}

async function exportAll() {
    if (exporting || !win.open || win.opening || win.closing || win.loadText) return;
    const job = { all: true, jobId: win.jobId, token: win.token, frame: null, logId: null, title: null, done: false };
    // Closing the window, or another job opened in it, ends the export.
    const gone = () => exporting !== job || job.done || !win.open || win.closing || win.token !== job.token || win.jobId !== job.jobId;
    try {
        exporting = job;
        win.exportNote = '';
        renderActivity();
        greySheetExport();
        const reading = historyRows(job.jobId);
        const seq = activitySeq;
        const history = await reading;
        if (gone()) return;
        if (!history.rows) {
            win.exportNote = 'Not exported: the list of signed sheets could not be read. Nothing was printed. Press Export all again.';
            return;
        }
        // The list on screen takes it too, unless a newer read has come back
        // meanwhile; the export prints what this read found.
        if (seq === activitySeq) adoptHistory(job.jobId, history.rows);
        // Oldest first (answer 1): the order they were written.
        const list = history.rows.filter(e => e.logAction === 'signoff_snapshot').sort((a, b) => Number(a.id) - Number(b.id));
        if (!list.length) return;
        const items = await fetchSheets(job.jobId, list, gone);
        if (gone()) return;
        const missing = items.filter(item => !item).length;
        if (missing) {
            win.exportNote = 'Not exported: ' + missing + ' of ' + list.length + ' signed sheets did not load. Nothing was printed. Press Export all again.';
            return;
        }
        const doc = makeExportFrame(job);
        const frame = job.frame;
        let pages = '';
        items.forEach((item, i) => {
            const n = i + 1;
            const part = elIn(doc, 'div', 'review-export-part review-export-p' + n);
            part.appendChild(elIn(doc, 'h1', 'review-sheet-title', 'The signed sheet'));
            let body = null;
            if (Array.isArray(item.frozen.sections)) {
                try { body = drawSheetBody(doc, fullWhen, item.row, item.frozen); } catch (e) { body = null; }
            }
            part.appendChild(body || unreadableSheet(doc, item.row));
            if (n === items.length) part.appendChild(elIn(doc, 'p', 'review-sheet-printed', 'Printed ' + fullWhen(new Date().toISOString()) + '.'));
            doc.body.appendChild(part);
            // A page name of its own, for its own top line (the printed work
            // order names its pieces' pages the same way).
            pages += '\n.review-export-p' + n + ' { page: p' + n + '; }\n@page p' + n + ' { @top-left { content: ' +
                cssString(exportPageLine(item.row, item.frozen) + exportPassedText(item.row)) + '; font-size: 9px; color: #6b6b80; } }';
        });
        doc.querySelector('style').textContent = [EXPORT_CSS, SHEET_QUILL_CSS, EXPORT_TEXT_ORDER_CSS, EXPORT_ALL_CSS].join('\n') + pages;
        const fileName = exportAllFileName(items[items.length - 1].row);
        doc.title = fileName;
        await exportPictures(doc, EXPORT_ALL_WAIT_MS);
        if (gone() || !frame.isConnected) return;
        markMissingPictures(doc);
        printExport(job, fileName);
    } finally {
        endExport(job);
        renderActivity();
        greySheetExport();
    }
}

// A press on a button in a block's top strip holds that strip still until the
// click lands (DECISIONS_2026-09-23 item 3). Saving a note on the way out of
// its box, the note timer, a save's reply and the refresh after it all redraw
// the strip; one landing between the mouse going down and coming up replaced
// the button under the pointer, and the press was lost. The side panel is held
// the same way: every refresh drew it afresh, coming back to the tab refreshes
// the window, and a Send to CSR pressed just then never went (David's hand test
// of decision 4, 2026-09-24). What was held is drawn once, straight after the
// click, or when the mouse comes up with no click.
// The changed lines under folded block names (refreshChangedLine) wait while
// the mouse, or Space, is down on any button in the window: one appearing or
// going moves the blocks under it, and a button moved from under the pointer
// loses the press, as the first press after typing did. What waited is drawn
// once the press has landed.
let linesHold = null;

function holdLines() {
    if (linesHold) return;
    linesHold = { pending: false, timer: setTimeout(releaseLines, HOLD_MAX_MS) };
    window.addEventListener('mouseup', onLinesUp, true);
    window.addEventListener('keyup', onLinesUp, true);
    window.addEventListener('blur', releaseLines);
}

function onLinesUp(e) {
    if (e && e.type === 'keyup' && e.key !== ' ') return;
    // After the click this mouse-up or key-up brings, if it brings one.
    setTimeout(releaseLines, 0);
}

function releaseLines() {
    window.removeEventListener('mouseup', onLinesUp, true);
    window.removeEventListener('keyup', onLinesUp, true);
    window.removeEventListener('blur', releaseLines);
    const hold = linesHold;
    linesHold = null;
    if (!hold) return;
    clearTimeout(hold.timer);
    if (hold.pending) units.forEach(unit => refreshChangedLine(unit));
}

function startHold(target) {
    const top = target ? target.closest('.review-unit-top') : null;
    // On a deleted job's record the history is in the body, held the same way.
    const host = activityHost();
    const side = !!target && !top && !!host && host.contains(target);
    if (!top && !side) return false;
    endHold();
    pressHold = { top, side, held: null, sideHeld: false, clicking: false, timer: setTimeout(endHold, HOLD_MAX_MS) };
    window.addEventListener('blur', endHold);
    return true;
}

function onMouseDown(e) {
    if (e.button !== 0) return;
    // Any press in the window holds the changed lines: a row's own check box
    // has no action name, and nothing is lost by holding for one that does
    // nothing.
    holdLines();
    const target = e.target && e.target.closest ? e.target.closest('[data-review-action]') : null;
    if (startHold(target)) window.addEventListener('mouseup', onHoldUp, true);
}

// Space presses a button or ticks a box on the key coming up, so a redraw
// between down and up loses it the same way; Enter presses on the way down and
// needs nothing. Never a text box: a space typed there is only a space.
function onSpaceDown(e) {
    if (e.key !== ' ' || e.repeat) return;
    const target = e.target && e.target.closest
        ? e.target.closest('button[data-review-action], input[type="checkbox"][data-review-action]') : null;
    if (e.target && e.target.matches && e.target.matches('button, input[type="checkbox"]')) holdLines();
    if (target && target === e.target && startHold(target)) window.addEventListener('keyup', onHoldUp, true);
}

function onHoldUp(e) {
    if (e && e.type === 'keyup' && e.key !== ' ') return;
    window.removeEventListener('mouseup', onHoldUp, true);
    window.removeEventListener('keyup', onHoldUp, true);
    // After the click this mouse-up or key-up brings, if it brings one. Only
    // this press's hold: on a busy page the timer can run after the next
    // press has started its own (STALE_FIXED_PLAN.md section 11).
    const hold = pressHold;
    setTimeout(() => {
        if (pressHold === hold) endHold();
    }, 0);
}

function endHold() {
    window.removeEventListener('mouseup', onHoldUp, true);
    window.removeEventListener('keyup', onHoldUp, true);
    window.removeEventListener('blur', endHold);
    const hold = pressHold;
    pressHold = null;
    if (!hold) return;
    clearTimeout(hold.timer);
    if (hold.held && units.get(hold.held.key) === hold.held) refreshUnit(hold.held);
    if (hold.sideHeld) renderSide();
}

function onClick(e) {
    // The click a held press was waiting for: the handler's own redraws go
    // ahead, and anything still held is drawn once it is done.
    if (pressHold) pressHold.clicking = true;
    try {
        handleClick(e);
    } finally {
        if (pressHold && pressHold.clicking) endHold();
    }
}

function handleClick(e) {
    const target = e.target.closest('[data-review-action]');
    // A greyed button that stays a button (aria-disabled), so the keys keep
    // its focus, is pressed as one that is disabled: not at all.
    if (!target || !modal.contains(target) || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
    const action = target.getAttribute('data-review-action');

    if (action === 'close') {
        closeReview();
        return;
    }
    if (action === 'to-top') {
        bodyEl.scrollTo({ top: 0, behavior: 'smooth' });
        return;
    }
    // Reading a frozen sheet changes nothing, so it is allowed while the rest
    // of the window is still settling.
    if (action === 'sheet-close') {
        closeSheet();
        return;
    }
    if (action === 'sheet-export') {
        exportSheet();
        return;
    }
    if (action === 'export-all') {
        exportAll();
        return;
    }
    if (action === 'sheet') {
        openSheet(target.getAttribute('data-review-log'));
        return;
    }
    if (win.opening) return;
    if (action === 'tab') {
        const gate = target.getAttribute('data-review-gate');
        if (!gateInfo(gate)) return;
        // The tab already showing: like any tab click, it closes an open block
        // and opens a one-checklist tab again.
        flushDrafts();
        closeSheet();
        const leftSignBack = !!win.confirm && win.confirm.kind === 'signback';
        win.gate = gate;
        win.openUnit = null;
        win.confirm = null;
        clearSideNote();
        renderTabs();
        renderBody();
        renderSide();
        renderFooter();
        bodyEl.scrollTop = 0;
        scrollToWork();
        const tab = tabsEl.querySelector('[data-review-gate="' + gate + '"]');
        if (tab) tab.focus({ preventScroll: true });
        // Her block held its row while the sheet was open: take any newer one.
        if (leftSignBack) refreshFromServer(win.jobId);
        return;
    }
    if (action === 'toggle') {
        const unit = currentUnitOf(target);
        if (!unit) return;
        // Folding her block would drop her Sign back in sheet and what she
        // typed: it stays open until she sends it or presses Cancel.
        if (signBackOpenOn(unit)) return;
        flushDrafts();
        const solo = unitIdsFor(win.jobId, win.gate).length === 1;
        const wasOpen = target.getAttribute('aria-expanded') === 'true';
        win.openUnit = wasOpen ? (solo ? 'closed' : null) : unit.unitId;
        if (win.confirm && win.confirm.unitId) win.confirm = null;
        renderBody();
        const head = bodyEl.querySelector('[data-review-unit="' + unit.unitId + '"] .review-block-head');
        if (head) head.focus({ preventScroll: true });
        if (!wasOpen) scrollUnitIntoView(unit.unitId);
        return;
    }

    // The side panel.
    if (action === 'paths' || action === 'note') return;   // the boxes in the panel: typing in them is not a press
    // Fixed reads the latest before its box opens (STALE_FIXED_PLAN.md).
    if (action === 'panel-reready') {
        pressFixed();
        return;
    }
    if (action === 'panel-send' ||
        action === 'panel-handoff' || action === 'panel-askhandoff') {
        win.confirm = { kind: action.slice(6), gate: win.gate, unitId: '' };
        clearSideNote();
        renderSide();
        // The box is where the typing goes, and focusing it brings it and the
        // buttons under it onto a short screen.
        const box = sideEl ? sideEl.querySelector('.review-paths-box, .review-note-box') : null;
        if (box) box.focus();
        return;
    }
    if (action === 'confirm-panel-send' || action === 'confirm-panel-reready' ||
        action === 'confirm-panel-handoff' || action === 'confirm-panel-askhandoff') {
        runPanelAction(action.slice(14));
        return;
    }
    if (action === 'confirm-cancel') {
        const unit = win.confirm && win.confirm.unitId ? unitFor(win.jobId, win.confirm.gate, win.confirm.unitId) : null;
        const leftSignBack = !!win.confirm && win.confirm.kind === 'signback';
        win.confirm = null;
        if (unit) refreshUnit(unit);
        else renderSide();
        // Her block held its row while the sheet was open: take any newer one.
        if (leftSignBack) refreshFromServer(win.jobId);
        return;
    }

    const unit = currentUnitOf(target);
    // The top of a block: sign-offs and their confirms.
    if (action === 'pass') {
        markPassed(unit);
        return;
    }
    if (action === 'corrections') {
        if (!editable(unit) || unit.signoff || !somethingToSend(unit, REVIEW_ITEMS.unitVerdict(unit.gate, unit.unitId, saveRules.sheet(unit)))) return;
        flushDrafts();
        if (win.confirm && win.confirm.kind === 'corrections' && win.confirm.unitId === unit.unitId && win.confirm.gate === unit.gate) win.confirm = null;
        else openCorrectionsConfirm(unit);
        refreshUnit(unit);
        return;
    }
    if (action === 'signback') {
        if (!unit || unit.gate !== 'csr' || unit.signoff || !accessFor(unit.jobId, 'csr').canSignBack) return;
        flushDrafts();
        const opening = !(win.confirm && win.confirm.kind === 'signback');
        if (opening) openSignBackConfirm(unit); else win.confirm = null;
        refreshUnit(unit);
        // Her checklist steps aside while the sheet is open and its buttons are
        // pinned, so what matters is its top: just under the block head
        // (scroll-margin-top in styles.css), where she starts typing.
        if (opening) {
            const sheet = bodyEl.querySelector('.review-signback');
            if (sheet && sheet.scrollIntoView) sheet.scrollIntoView({ block: 'start' });
            // Sign back in is greyed while the sheet is open, so focus goes to
            // what she types first rather than to nothing.
            const note = sheet && sheet.querySelector('.review-signback-note');
            if (note) note.focus({ preventScroll: true });
        }
        refreshToTop();
        return;
    }
    if (action === 'signback-tick') {
        const c = win.confirm;
        if (!unit || !c || c.kind !== 'signback' || target.disabled) return;
        const key = target.getAttribute('data-review-block-gate') + '|' + target.getAttribute('data-review-block-unit');
        if (target.checked) c.ticked[key] = true;
        else delete c.ticked[key];
        refreshUnit(unit);
        return;
    }
    if (action === 'signback-production') {
        const c = win.confirm;
        if (!unit || !c || c.kind !== 'signback') return;
        c.production = !!target.checked;
        refreshUnit(unit);
        return;
    }
    if (action === 'confirm-signback') {
        signBackIn(unit);
        return;
    }
    if (action === 'dept-toggle') {
        const c = win.confirm;
        if (!unit || !c || c.kind !== 'signback' || c.unitId !== unit.unitId) return;
        const id = target.getAttribute('data-review-flag-id');
        const dept = target.getAttribute('data-review-dept');
        if (!DEPTS.includes(dept)) return;
        const list = Array.isArray(c.flagDepts[id]) ? c.flagDepts[id] : [];
        c.flagDepts[id] = list.includes(dept) ? list.filter(d => d !== dept) : list.concat([dept]);
        refreshUnit(unit);
        return;
    }
    if (action === 'confirm-corrections') {
        sendCorrections(unit);
        return;
    }
    if (action === 'reopen') {
        if (!editable(unit, true)) return;
        win.confirm = { kind: 'reopen', gate: unit.gate, unitId: unit.unitId };
        refreshUnit(unit);
        return;
    }
    if (action === 'confirm-reopen') {
        reopenUnit(unit);
        return;
    }

    // A press per section, and its Undo. The lines go in as ordinary ticks and
    // leave in one request; the save names the sections it swept, and the
    // server counts what really changed.
    if (action === 'section-tick' || action === 'section-back') {
        const number = target.getAttribute('data-review-section');
        if (!editable(unit) || !number || !rendered) return;
        const parts = rendered.blocks.get(unit.unitId);
        const part = parts ? parts.sections.get(number) : null;
        if (!part) return;
        flushDrafts();
        const sheet = saveRules.sheet(unit);
        const ids = action === 'section-tick'
            ? sectionSweepIds(unit, part.section, sheet)
            : sectionUndoIds(unit, number, sheet);
        if (!ids.length) return;
        // Added first, sent once: one request for the block, not one per line.
        ids.forEach(id => saveRules.addOp(unit, { type: action === 'section-tick' ? 'tick' : 'untick', id, section: number }));
        if (action === 'section-tick') sectionPresses.set(sectionPressKey(unit, number), ids);
        else sectionPresses.delete(sectionPressKey(unit, number));
        pump(unit);
        refreshUnit(unit);
        return;
    }

    // A checklist line.
    const id = rowIdOf(target);
    if (!editable(unit) || !id) return;
    const sheet = saveRules.sheet(unit);
    if (action === 'line') {
        // Typing in a note is not a tick, and a flagged or N/A line is left alone.
        if (e.target.closest('.review-note-wrap')) return;
        if (own(sheet.flags, id) || own(sheet.na, id) || REVIEW_ITEMS.followingNA(unit.gate, id, sheet.na)) return;
        click(unit, { type: sheet.items[id] === true ? 'untick' : 'tick', id });
        refreshUnit(unit);
        return;
    }
    if (action === 'na') {
        if (REVIEW_ITEMS.followingNA(unit.gate, id, sheet.na)) return;
        const putting = !own(sheet.na, id);
        click(unit, { type: putting ? 'naOn' : 'naOff', id });
        // Pressed with the mouse, the cursor goes into the new box, so words
        // can follow at once. Never by scrolling, so no line moves under the
        // pointer, and not from the keyboard, where Tab would walk back onto
        // the same N/A button.
        if (putting && e.detail > 0) focusWhy(unit, id);
    } else if (action === 'flag') {
        if (own(sheet.na, id) || REVIEW_ITEMS.followingNA(unit.gate, id, sheet.na)) return;
        flushDrafts();
        const now = saveRules.sheet(unit);
        click(unit, { type: own(now.flags, id) ? 'unflag' : 'flag', id });
    }
}

function focusWhy(unit, id) {
    const parts = rendered && rendered.gate === unit.gate ? rendered.blocks.get(unit.unitId) : null;
    const line = parts ? parts.rows.get(id) : null;
    if (!line || line.why.hidden) return;
    const box = line.why.getBoundingClientRect();
    const view = bodyEl.getBoundingClientRect();
    if (box.top >= view.top && box.bottom <= view.bottom) line.why.focus({ preventScroll: true });
}

function onChange(e) {
    const target = e.target;
    if (target.classList.contains('review-check')) {
        const unit = currentUnitOf(target);
        const id = rowIdOf(target);
        if (editable(unit) && id) {
            const sheet = saveRules.sheet(unit);
            const na = own(sheet.na, id) || REVIEW_ITEMS.followingNA(unit.gate, id, sheet.na);
            const ticked = sheet.items[id] === true && !own(sheet.flags, id);
            if (!na) click(unit, { type: ticked ? 'untick' : 'tick', id });
        }
        if (unit) refreshUnit(unit);
    }
}

function onInput(e) {
    const target = e.target;
    // The note for the reviewer: kept as typed. Send it never waits for it.
    if (target.classList.contains('review-note-box')) {
        const draft = boxDraft(target);
        draft.text = String(target.value || '').slice(0, SEND_NOTE_MAX);
        draft.start = target.selectionStart;
        draft.end = target.selectionEnd;
        return;
    }
    if (target.classList.contains('review-paths-box')) {
        const draft = pathDraft(win.jobId, win.gate);
        draft.text = String(target.value || '').slice(0, PATHS_MAX);
        draft.edited = true;
        draft.start = target.selectionStart;
        draft.end = target.selectionEnd;
        // Drawn again would move the caret, so only Send it changes.
        const go = sideEl ? sideEl.querySelector('[data-review-action="confirm-panel-handoff"]') : null;
        if (go) go.disabled = win.busy || !draft.text.trim();
        return;
    }
    // What is being asked for, on the Sign back in sheet. Drawn again on every
    // keystroke would move the caret, so only the button changes, the way the
    // Send to CSR paths box does.
    if (target.classList.contains('review-signback-note')) {
        const c = win.confirm;
        if (!c || c.kind !== 'signback') return;
        c.note = String(target.value || '').slice(0, NOTE_MAX);
        const sheet = target.closest ? target.closest('.review-signback') : null;
        const unitHere = currentUnitOf(target);
        if (sheet && unitHere) signBackReadyLine(sheet, unitHere, c);
        return;
    }
    // An N/A's words: saved like a flag's note, 800 ms after the last key.
    if (target.classList.contains('review-na-why')) {
        const unitHere = currentUnitOf(target);
        const lineId = rowIdOf(target);
        if (!editable(unitHere) || !lineId) return;
        whyDrafts.set(unitHere.key + '|' + lineId, String(target.value || '').slice(0, REASON_MAX));
        clearTimeout(noteTimer);
        noteTimer = setTimeout(flushDrafts, NOTE_DELAY_MS);
        return;
    }
    if (!target.classList.contains('review-note')) return;
    const unit = currentUnitOf(target);
    const id = rowIdOf(target);
    if (!editable(unit) || !id) return;
    drafts.set(unit.key + '|' + id, target.value);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushDrafts, NOTE_DELAY_MS);
    // Back with the operator, a changed note turns Corrections needed on as
    // it is typed.
    const parts = withOperator(unit) && rendered && rendered.gate === unit.gate ? rendered.blocks.get(unit.unitId) : null;
    const corrections = parts && parts.top ? parts.top.querySelector('[data-review-action="corrections"]') : null;
    if (corrections && !unit.signoff) {
        corrections.disabled = !somethingToSend(unit, REVIEW_ITEMS.unitVerdict(unit.gate, unit.unitId, saveRules.sheet(unit)));
    }
}

// A flag's note or an N/A's words: text that saves 800 ms after the last key.
function isTypedBox(node) {
    return !!(node && node.classList && (node.classList.contains('review-note') || node.classList.contains('review-na-why')));
}

function onKeyDown(e) {
    if (e.key === 'Tab') tabDirection = e.shiftKey ? 'back' : 'forward';
    if (e.key === 'Enter' && isTypedBox(e.target)) flushDrafts();
    onSpaceDown(e);
}

// Back to the top, for the long Tech Services and CSR lists. It sits over the
// bottom of the lines, clear of the footer's save line, and is out of the way
// until there is something to scroll back from.
const toTopBtn = button('review-to-top', 'Back to the top', 'to-top');
toTopBtn.hidden = true;
if (bodyEl.parentNode) bodyEl.parentNode.appendChild(toTopBtn);
// Not while her Sign back in sheet is open: its buttons are pinned right where
// this one sits, and the sheet is short enough without it (David, 2026-09-22).
function refreshToTop() {
    toTopBtn.hidden = !win.open || bodyEl.scrollTop < 200 || !!bodyEl.querySelector('.review-block--signback');
}
bodyEl.addEventListener('scroll', refreshToTop);

// The page-wide listeners in app.js must never see these events.
function stopAtRoot(handler) {
    return function (e) {
        if (handler) handler(e);
        e.stopPropagation();
    };
}

modal.addEventListener('click', onClick);
modal.addEventListener('change', stopAtRoot(onChange));
modal.addEventListener('input', stopAtRoot(onInput));
modal.addEventListener('focusin', stopAtRoot(null));
modal.addEventListener('mousedown', stopAtRoot(onMouseDown));
modal.addEventListener('keydown', stopAtRoot(onKeyDown));
// A path pasted into the Send to CSR box comes out in its server form, as on
// the work order's path boxes (paste-path.js, PASTE_PATH_PLAN.md).
modal.addEventListener('paste', e => {
    if (window.PASTE_PATH && e.target.classList && e.target.classList.contains('review-paths-box')) window.PASTE_PATH.onPaste(e);
});
modal.addEventListener('focusout', e => {
    if (isTypedBox(e.target)) flushDrafts();
});
window.addEventListener('pagehide', onPageHide);
window.addEventListener('sts-user-back', onUserBack);
window.addEventListener('pageshow', e => {
    if (e.persisted && win.open) resumeSaves(win.jobId);
});
// Someone else's action shows when the browser tab comes back into view.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && win.open && !win.opening && !win.loadText) refreshFromServer(win.jobId);
});

// ══ Send to Prepress / Send to Tech Services: a new job handed over ══
//
// Today a CSR finishes the work order, prints the PDF into Midnight and writes
// an email in Outlook to Prepress or Tech Services. This is that email, as one
// press on the work order itself (START_NEW_JOB_PLAN, David 2026-09-19). The
// press sends the email AND starts that department's QC record, so the job
// reads NEW JOB on the job list from that moment.
//
// The button lives next to QC Review and its words follow the department tab,
// so a job that needs both departments is one press on each. review.js owns it
// for two reasons: this is the one file that talks to the QC Review routes,
// and everything drawn outside #reviewModal needs the same event fence, or
// app.js's page-wide listeners would save the work order on this box's typing
// and Ctrl+Z would rewind it.
//
// What may be pressed is always the server's answer, from its own small route
// (GET /api/jobs/:id/newjob) and its own rule (reviewCanNewJob), never worked
// out here. That route is asked once per work order opened, rather than the
// reviews GET, which reads every sheet on the job and belongs to the window.

const newJobBtn = document.getElementById('reviewNewJobBtn');
const newJobWrap = document.getElementById('reviewNewJobWrap');
const newJob = {
    jobId: '',      // the work order showing, '' on the job list
    dept: '',       // its department tab
    allowed: null,  // what the server said she may send, per department
    takeBack: null, // where a hand-over is standing that she may take back
    seq: 0,         // the newest ask; an older answer arriving late is dropped
    box: null,      // the open box
    note: '',       // what she has typed, kept while the box is open
    busy: '',       // '', 'send' or 'takeback': which press is on its way
    message: '',    // the server's words when a press did not go through
    off: false      // QC Review is switched off on this server: stop asking
};
let newJobCloseTimer = null;

function newJobGate(gate) {
    return DEPTS.indexOf(String(gate)) >= 0 ? String(gate) : '';
}

function canSendNewJob(gate) {
    return !!(newJobGate(gate) && newJob.allowed && newJob.allowed[gate] === true);
}

// "Sent by mistake" (David, 2026-09-20). The server answers it with the same
// rule as the button above plus "and there is one standing", so the two can
// never disagree. It lives in the box rather than the header: while nobody has
// picked the job up it would otherwise be a third button sitting on the work
// order for as long as the department takes, which is most of the time.
function canTakeBackNewJob(gate) {
    return !!(newJobGate(gate) && newJob.takeBack && newJob.takeBack[gate] === true);
}

// Hidden is the default everywhere it cannot be answered for: no work order
// showing, QC Review switched off on this server, nobody picked, not a CSR, or
// the department has already picked the job up. It must never look like it
// sent an email that never went.
function renderNewJobBtn() {
    if (!newJobBtn) return;
    const gate = newJobGate(newJob.dept);
    if (!newJob.jobId || !canSendNewJob(gate)) {
        // A box with something to read stays until she has read it: the words
        // saying why a press was refused, or that the job went. Taking either
        // away would leave her with no way of telling whether it went at all.
        if (!newJob.message && !(newJob.box && newJob.box.sent)) closeNewJobBox();
        newJobBtn.hidden = true;
        return;
    }
    newJobBtn.hidden = false;
    newJobBtn.textContent = 'Send to ' + gateLabel(gate);
}

// One request per work order opened; moving between the tabs only redraws.
// Never throws: anything it cannot answer leaves the button hidden. On a
// server where QC Review is switched off it asks once and then stops, so a
// work order does not carry a refused request every time it is opened.
async function loadNewJobAccess(jobId) {
    if (newJob.off) return;
    const seq = ++newJob.seq;
    const res = await getJson('/api/jobs/' + encodeURIComponent(jobId) + '/newjob');
    if (res.status === 503 && res.json && res.json.available === false) newJob.off = true;
    if (seq !== newJob.seq || newJob.jobId !== jobId) return;
    newJob.allowed = res.ok && res.json && res.json.gates ? res.json.gates : null;
    newJob.takeBack = res.ok && res.json && res.json.takeBack ? res.json.takeBack : null;
    renderNewJobBtn();
}

function onJobOpened(e) {
    const detail = (e && e.detail) || {};
    newJob.jobId = String(detail.jobId || '');
    newJob.dept = String(detail.dept || '');
    newJob.allowed = null;
    newJob.takeBack = null;
    newJob.note = '';
    newJob.message = '';
    newJob.seq++;
    renderNewJobBtn();
    if (newJob.jobId) loadNewJobAccess(newJob.jobId);
}

function onDeptChanged(e) {
    const detail = (e && e.detail) || {};
    if (String(detail.jobId || '') !== newJob.jobId) return;
    newJob.dept = String(detail.dept || '');
    newJob.note = '';
    newJob.message = '';
    closeNewJobBox();    // the box belongs to the tab it was opened on
    renderNewJobBtn();
}

function onJobClosed() {
    newJob.jobId = '';
    newJob.dept = '';
    newJob.allowed = null;
    newJob.takeBack = null;
    newJob.note = '';
    newJob.message = '';
    newJob.seq++;
    renderNewJobBtn();
}

// The box under the button: her line, required, and Send. One grey line says
// what the box IS (David, 2026-09-20): the notification a CSR used to write in
// Outlook to tell a department a job is waiting. Sometimes that is all she
// says, sometimes she adds a quick summary. The instructions themselves stay
// on the work order, which is what gets printed and attached to Midnight.
function openNewJobBox() {
    const gate = newJobGate(newJob.dept);
    if (newJob.box || !newJob.jobId || !canSendNewJob(gate)) return;
    const label = gateLabel(gate);
    const box = el('div', 'review-newjob-box');
    box.appendChild(el('div', 'review-newjob-title', 'Send this job to ' + label));
    // Said plainly, because the way out sits under it and a button with no
    // reason on the screen above it reads as a trap.
    if (canTakeBackNewJob(gate)) box.appendChild(el('div', 'review-newjob-standing', 'Already sent to ' + label + '.'));
    const area = document.createElement('textarea');
    area.className = 'review-newjob-note';
    area.setAttribute('rows', '3');
    area.setAttribute('maxlength', String(NOTE_MAX));
    area.setAttribute('placeholder', 'What does ' + label + ' need to know?');
    area.value = newJob.note;
    box.appendChild(area);
    box.appendChild(el('div', 'review-newjob-hint',
        'This is the notification that a new job is in. The instructions are on the work order.'));
    const message = el('div', 'review-newjob-message', newJob.message);
    box.appendChild(message);
    const pills = el('div', 'review-pills review-newjob-actions');
    const send = button('review-pill', 'Send', 'newjob-send');
    const cancel = button('review-pill review-pill--quiet', 'Cancel', 'newjob-cancel');
    pills.appendChild(send);
    pills.appendChild(cancel);
    // Only while one is standing and nobody has picked the job up. It needs no
    // note, so it is not held by Send's empty-box rule.
    let backBtn = null;
    if (canTakeBackNewJob(gate)) {
        backBtn = button('review-pill review-pill--quiet review-newjob-back', 'Sent by mistake', 'newjob-takeback');
        pills.appendChild(backBtn);
    }
    box.appendChild(pills);

    // The page-wide listeners in app.js must never see this box's events. It
    // carries no .notes and no checkbox either, so it is fenced twice.
    ['change', 'input', 'focusin', 'mousedown', 'keydown'].forEach(name => {
        box.addEventListener(name, stopAtRoot(null));
    });
    // Ctrl+Z is stopped at the root above, so app.js never rewinds the work
    // order. What is left is Chrome's own page-wide list of typing to take
    // back: once the box has nothing of its own left, it would walk into a
    // note on the work order and app.js would save that. Only the box's own
    // words are let through, the same guard the window has.
    document.addEventListener('beforeinput', onNewJobBeforeInput, true);
    area.addEventListener('input', () => {
        newJob.note = area.value;
        updateNewJobBox();
    });
    send.addEventListener('click', sendNewJob);
    if (backBtn) backBtn.addEventListener('click', takeBackNewJob);
    // Not while a press is on its way: closing the box throws its reply away,
    // and she would be left with no way of telling whether anything went. A
    // click outside is already refused for the same reason.
    cancel.addEventListener('click', () => { if (!newJob.busy) closeNewJobBox(); });

    // Inside the wrapper beside the button, so where it sits is CSS and
    // nothing here ever writes a style.
    newJobWrap.appendChild(box);
    newJob.box = { root: box, area, send, backBtn, cancel, message };
    updateNewJobBox();
    area.focus();
    // Next tick, so the press that opened it does not close it again, and only
    // if it is still open by then: nothing should outlive the box.
    setTimeout(() => { if (newJob.box) document.addEventListener('mousedown', closeNewJobBoxOnOutside); }, 0);
}

function onNewJobBeforeInput(e) {
    if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return;
    if (!newJob.box || !newJob.box.root.contains(e.target)) e.preventDefault();
}

function updateNewJobBox() {
    if (!newJob.box || !newJob.box.send) return;
    const sending = newJob.busy === 'send';
    newJob.box.send.disabled = !!newJob.busy || !newJob.note.trim();
    // The word follows the press that is actually running: taking a job back
    // must never put "Sending..." on the screen, which reads as if it had just
    // been sent to the department she is taking it back from.
    newJob.box.send.textContent = sending ? 'Sending...' : 'Send';
    if (newJob.box.backBtn) {
        newJob.box.backBtn.disabled = !!newJob.busy;
        newJob.box.backBtn.textContent = newJob.busy === 'takeback' ? 'Taking it back...' : 'Sent by mistake';
    }
    if (newJob.box.cancel) newJob.box.cancel.disabled = !!newJob.busy;
    newJob.box.message.textContent = newJob.message;
}

function closeNewJobBox() {
    document.removeEventListener('mousedown', closeNewJobBoxOnOutside);
    document.removeEventListener('beforeinput', onNewJobBeforeInput, true);
    if (newJobCloseTimer) {
        clearTimeout(newJobCloseTimer);
        newJobCloseTimer = null;
    }
    if (!newJob.box) return;
    if (newJob.box.root.parentNode) newJob.box.root.parentNode.removeChild(newJob.box.root);
    newJob.box = null;
    newJob.message = '';
}

function closeNewJobBoxOnOutside(e) {
    if (newJob.busy || !newJob.box) return;
    if (newJob.box.root.contains(e.target) || e.target === newJobBtn) return;
    closeNewJobBox();
}

async function sendNewJob() {
    const gate = newJobGate(newJob.dept);
    const jobId = newJob.jobId;
    const note = newJob.note.trim();
    if (!newJob.box || newJob.busy || !jobId || !gate || !note) return;
    newJob.busy = 'send';
    newJob.message = '';
    updateNewJobBox();
    const res = await postJson('/api/jobs/' + encodeURIComponent(jobId) + '/reviews/' +
        encodeURIComponent(gate) + '/action', { action: 'newjob', note });
    newJob.busy = '';
    // Redrawn before anything else: whatever box is on screen now owns the
    // Send button, and a reply for a box she has already left behind must not
    // leave that one greyed and reading "Sending...".
    updateNewJobBox();
    // The job list's QC column is drawn from one reply per fetch, and closing a
    // work order redraws it rather than asking again. So the press says it has
    // moved the job on, the way closing the window does, or her own job would
    // still read blank when she got back to the list. Said before anything
    // else, because she may already be back on the list while it was in
    // flight, and the list's Depts dots and Dept filter read the same answer
    // (decision 6).
    if (res.ok) document.dispatchEvent(new CustomEvent('sts-new-job-sent', { detail: { jobId, gate } }));
    // Her email to the department opens in Outlook, filled in; she presses Send.
    if (res.ok && res.json) openOutlook(jobId, res.json.emails);
    // She moved on while it was in flight: the answer is still hers, but the
    // box it belonged to has gone.
    if (!newJob.box || newJob.jobId !== jobId || newJobGate(newJob.dept) !== gate) return;
    if (!res.ok) {
        newJob.message = (res.json && res.json.error) ||
            (res.status === 0 ? 'The server could not be reached. Try again.' : 'That did not go through. Try again.');
        updateNewJobBox();
        // Someone may have picked the job up while she was typing.
        if (res.status !== 0) loadNewJobAccess(jobId);
        return;
    }
    newJob.note = '';
    showNewJobSent(gateLabel(gate));
    loadNewJobAccess(jobId);
}

// "Sent by mistake": she sent the job to the wrong department. It clears the
// hand-over, so the job list stops reading NEW JOB, and the same people are
// told to ignore the first email. It carries no note, so nothing holds it up.
// It cannot unsend the first email, and the line it leaves says so.
async function takeBackNewJob() {
    const gate = newJobGate(newJob.dept);
    const jobId = newJob.jobId;
    if (!newJob.box || newJob.busy || !jobId || !gate || !canTakeBackNewJob(gate)) return;
    newJob.busy = 'takeback';
    newJob.message = '';
    updateNewJobBox();
    const res = await postJson('/api/jobs/' + encodeURIComponent(jobId) + '/reviews/' +
        encodeURIComponent(gate) + '/action', { action: 'takeback' });
    newJob.busy = '';
    // Redrawn first, for the same reason the send does it: a reply for a box
    // she has already left behind must not leave the one on screen greyed.
    updateNewJobBox();
    // The same event the send fires, and as early, for the same reasons:
    // without it her job would still read NEW JOB when she got back to the list.
    if (res.ok) document.dispatchEvent(new CustomEvent('sts-new-job-sent', { detail: { jobId, gate } }));
    if (res.ok && res.json) openOutlook(jobId, res.json.emails);
    if (!newJob.box || newJob.jobId !== jobId || newJobGate(newJob.dept) !== gate) return;
    if (!res.ok) {
        newJob.message = (res.json && res.json.error) ||
            (res.status === 0 ? 'The server could not be reached. Try again.' : 'That did not go through. Try again.');
        updateNewJobBox();
        // They may have picked the job up while the box was open.
        if (res.status !== 0) loadNewJobAccess(jobId);
        return;
    }
    newJob.note = '';
    showNewJobDone('Taken back. ' + gateLabel(gate) + ' has been told to ignore it.');
    loadNewJobAccess(jobId);
}

// Nothing closes and she stays where she is (David, 2026-09-19, answer 6), so
// the one line is all the press says. The job list now reads NEW JOB and the
// QC activity carries her line.
function showNewJobSent(label) {
    showNewJobDone('Sent to ' + label + '.');
}

// The box says what happened and closes itself. It must outlive its own press
// long enough to be read: renderNewJobBtn leaves a box with something in it
// alone, or she would have no way of telling whether anything went.
function showNewJobDone(text) {
    if (!newJob.box) return;
    const box = newJob.box.root;
    box.textContent = '';
    box.appendChild(el('div', 'review-newjob-sent', text));
    newJob.box = { root: box, area: null, send: null, backBtn: null, message: null, sent: true };
    newJobCloseTimer = setTimeout(closeNewJobBox, 2500);
}

if (newJobBtn && newJobWrap) {
    // The click is deliberately left to bubble: app.js closes its own job
    // selector and status popover on any click, and this press should close
    // them as every other press does.
    newJobBtn.addEventListener('click', () => {
        if (newJob.busy) return;    // the same rule as Cancel: never throw a reply away
        if (newJob.box) closeNewJobBox();
        else openNewJobBox();
    });
    document.addEventListener('sts-job-opened', onJobOpened);
    document.addEventListener('sts-dept-changed', onDeptChanged);
    document.addEventListener('sts-job-closed', onJobClosed);
    // Somebody may have sent the round for review in the window just closed.
    document.addEventListener('sts-review-closed', () => {
        if (newJob.jobId) loadNewJobAccess(newJob.jobId);
    });
}

window.openReview = openReview;
openBtn.hidden = false;

})();
