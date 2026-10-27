/* ═════════════════════════════════════════════════════════════════
   QC REVIEW BOARD -- what the landing table's QC column says about a job
   Pure rules: no page, no requests. The page fetches GET /api/reviews/states,
   builds an index from the reply once per fetch (buildIndex), then asks it
   about each job (jobState). Loaded by index.html after review-items.js, and
   by dev/review-board-check.js with require().

   The rules are BOARD_PLAN.md D1, decided by David on 2026-09-18:
   - The chip says the step the job is at. When the departments are at
     different steps, the first of CORRECTIONS, RE-CHECK, CAME BACK, NEW JOB,
     READY FOR REVIEW, IN REVIEW, SEND TO CSR that any of them is at shows.
     Otherwise CSR PASSED, WITH CSR, or nothing when nobody has done any QC.
   - NEW JOB is the CSR handing a brand new job to a department from the work
     order, before anyone has sent it for review (START_NEW_JOB_PLAN, David
     2026-09-19). It stops the moment somebody presses Send for review.
   - PRODUCTION shows from her "goes to production" tick until she next signs
     the job back in.
   - A department signed back in counts before anyone touches it. The window's
     "Not passed yet" line uses the same rule (deptCounts).
   - The round is in the hover only.
   - A piece added after a department's files went to the CSR, with no
     review row yet (nobody has ticked, marked N/A or flagged anything on it;
     looking at it writes nothing), is named on that department's hover line
     ("Buckslip added, not reviewed yet"). The server says which pieces those are
     (ADDED_PIECE_PLAN, David 2026-09-24); the chip does not change.
   - A piece whose instructions changed after a passed Prepress or Tech
     Services block froze them is named on that department's hover line
     ("Letter instructions changed after the pass"), never on the CSR's, and
     never twice with "added". The server says which pieces those are
     (CHANGED_AFTER_PASS_PLAN, David 2026-10-08); the chip does not change.
   A job is never finished: a CSR pass is one clean round, and the proof very
   often comes back. So no word here reads as closed (no DONE, COMPLETE or
   FINISHED); dev/review-board-check.js looks at every string it produces.
   ═════════════════════════════════════════════════════════════════ */

(function () {
'use strict';

// Tab order, as the window shows the tabs. Only Prepress has a block per
// piece. The labels are review-items.js's; the check holds them together.
const CHECKLISTS = [
    { gate: 'prepress',     label: 'Prepress',      perPiece: true  },
    { gate: 'techservices', label: 'Tech Services', perPiece: false },
    { gate: 'csr',          label: 'CSR',           perPiece: false }
];
const DEPTS = ['prepress', 'techservices'];

// The chip's words. ORDER is the order the QC header sorts by, and its first
// seven are the department steps in the order the chip picks among them.
// NEW JOB goes where David put it: before READY FOR REVIEW (2026-09-19,
// question 5), beside CAME BACK, which is already there and means the same
// kind of thing: handed to a department that has not picked it up. Above them
// are the two steps where work is owed right now.
const WORDS = {
    'corrections': 'CORRECTIONS',
    'recheck':     'RE-CHECK',
    'came-back':   'CAME BACK',
    'new-job':     'NEW JOB',
    'ready':       'READY FOR REVIEW',
    'in-review':   'IN REVIEW',
    'send-to-csr': 'SEND TO CSR',
    'with-csr':    'WITH CSR',
    'csr-passed':  'CSR PASSED'
};
const ORDER = ['corrections', 'recheck', 'came-back', 'new-job', 'ready', 'in-review', 'send-to-csr', 'with-csr', 'csr-passed'];
const DEPT_STEPS = ORDER.slice(0, 7);

// The hover: one line per checklist that counts, in tab order, then one
// PRODUCTION line. A line is the checklist's label and the words for its state,
// with who (the person whose move it is) as "by NAME" right after them, then
// the blocks (the pieces the step is about): "Prepress: RE-CHECK by Don
// Marcotte, No. 10 Envelope". Kept apart like that, a name never reads as one
// more piece. People read this hundreds of times a day, so only what is
// needed. A piece added after the files went, with no review row yet, comes last,
// after a comma, or after a semicolon when the line already names blocks, so
// a block never reads as one more added piece (David, 2026-09-24): "Prepress:
// IN REVIEW by Sue Foster, Buckslip added, not reviewed yet", "Prepress:
// CORRECTIONS, No. 10 Envelope; Buckslip added, not reviewed yet". A piece
// whose instructions changed after the pass comes after that, the same way
// (David, 2026-10-08): "Prepress: WITH CSR, Letter instructions changed after
// the pass", "Prepress: CORRECTIONS, Envelope; Letter instructions changed
// after the pass". Change the wording here.
const HOVER = {
    lines: {
        'corrections': { say: 'CORRECTIONS',      show: ['blocks'] },        // the operator fixes these
        'recheck':     { say: 'RE-CHECK',         show: ['blocks', 'who'] }, // who sent them back looks again
        'came-back':   { say: 'CAME BACK',        show: [] },
        'new-job':     { say: 'NEW JOB',          show: ['who'] },           // the CSR who sent it
        'ready':       { say: 'READY FOR REVIEW', show: [] },
        'in-review':   { say: 'IN REVIEW',        show: ['who'] },           // who started it
        'send-to-csr': { say: 'SEND TO CSR',      show: [] },
        'with-csr':    { say: 'WITH CSR',         show: [] },
        'csr-passed':  { say: 'PASSED',           show: [] }                 // reads "CSR: PASSED"
    },
    round: 'Round ',          // added only above round 1
    added: ' added, not reviewed yet',   // after the pieces' names
    changed: ' instructions changed after the pass',   // after the pieces' names
    production: 'PRODUCTION',
    wholeJob: 'Whole Job'     // Prepress's job-wide block, as the window names it
};

// ── Small readers. Rows come straight from the route, so nothing is assumed ──

function text(value) {
    return value == null ? '' : String(value);
}

function list(value) {
    return Array.isArray(value) ? value : [];
}

// A person as the window names one: the roster name, else the user key.
function person(name, login) {
    return text(name) || text(login);
}

function sender(gateRow) {
    return gateRow ? person(gateRow.sentForReviewByName, gateRow.sentForReviewByLogin) : '';
}

function starter(gateRow) {
    return gateRow ? person(gateRow.startedByName, gateRow.startedByLogin) : '';
}

function signedBackIn(gateRow) {
    return gateRow ? text(gateRow.signedBackInDate) : '';
}

// The CSR handed this job to the department from the work order.
function handedOver(gateRow) {
    return gateRow ? text(gateRow.newJobDate) : '';
}

function handedOverBy(gateRow) {
    return gateRow ? person(gateRow.newJobByName, gateRow.newJobByLogin) : '';
}

function isPassed(row) {
    return !!row && row.disposition === 'passed';
}

// A block somebody has done something on: an answer, or any disposition.
function touched(row) {
    return !!row && (!!row.hasActivity || !!row.disposition);
}

// A block sent back: the operator owes the fix until Fixed hands it to the
// reviewer again. Any holder but the reviewer is the operator, as in the window.
function withOperator(row) {
    return !!row && row.disposition === 'corrections' && row.holder !== 'reviewer';
}

function withReviewer(row) {
    return !!row && row.disposition === 'corrections' && row.holder === 'reviewer';
}

function roundOf(gateRow) {
    const n = Number(gateRow && gateRow.roundNo);
    return n >= 1 ? Math.floor(n) : 1;
}

// A piece's name as the window writes it: "V2 Letter", "No. 10 Envelope".
function pieceName(piece) {
    const version = text(piece.version).trim();
    return ((version ? version + ' ' : '') + text(piece.name).trim()).trim();
}

function joinAnd(names) {
    return names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

// ── The rules ──

// Whether a department checklist has work on this job. The app cannot tell
// which departments a job uses, so a department counts once somebody has done
// something on it, or once the CSR has signed it back in: signing back in
// wipes its ticks, its start and its send, and without this the board would
// forget it (David, 2026-09-18). A job she has just handed over counts too:
// that press is the start of the department's QC record (David, 2026-09-19).
// rows are the department's block rows with a missing row as null; gateRow may
// be null. The window's "Not passed yet" line calls this too, so the two can
// never disagree.
function deptCounts(rows, gateRow) {
    return list(rows).some(touched) ||
        !!(sender(gateRow) || starter(gateRow) || signedBackIn(gateRow) || handedOver(gateRow));
}

// Every block passed. A block with no row has not been passed, the same as
// the server's pass check.
function allPassed(rows) {
    const r = list(rows);
    return r.length > 0 && r.every(isPassed);
}

// The newest pass time among the blocks, or ''. Every stamp is toISOString,
// so comparing the strings orders them.
function newestPass(rows) {
    return list(rows).filter(isPassed).reduce((max, row) => (text(row.completedDate) > max ? text(row.completedDate) : max), '');
}

// Where one department checklist is, or '' when it does not count. The first
// rule that applies wins. sentToCsrDate is that department's newest Send to
// CSR of this round (the server leaves out one older than a sign back in, as
// the window does): the files are with her only when they went after the
// newest pass, so a piece reopened and passed again, or added, after they went
// says SEND TO CSR until someone sends again, and so does a round whose only
// signed back piece was deleted (F7, David 2026-10-13).
function deptState(rows, gateRow, sentToCsrDate) {
    const r = list(rows);
    if (!deptCounts(r, gateRow)) return '';
    if (r.some(withOperator)) return 'corrections';
    if (r.some(withReviewer)) return 'recheck';
    if (allPassed(r)) return text(sentToCsrDate) > newestPass(r) ? 'with-csr' : 'send-to-csr';
    // A passed block's own answers do not count here: otherwise a round 2
    // could never read READY FOR REVIEW.
    if (starter(gateRow) || r.some(row => row && !isPassed(row) && row.hasActivity)) return 'in-review';
    if (sender(gateRow)) return 'ready';
    if (signedBackIn(gateRow)) return 'came-back';
    // Last of the real steps: everything above it means somebody has picked
    // the job up, and the handover stamp stays on the row for ever.
    if (handedOver(gateRow)) return 'new-job';
    return 'in-review';  // old data only
}

// The CSR's own checklist: passed, and touched (an answer, any disposition,
// or a start). It never says CORRECTIONS: an old row left in corrections
// counts only as touched.
function csrState(row, gateRow) {
    const passed = isPassed(row);
    const isTouched = touched(row) || !!starter(gateRow);
    return { passed, touched: isTouched, state: passed ? 'csr-passed' : isTouched ? 'in-review' : '' };
}

// Whether her newest sign back in was a production round. Every sign back
// stamps each checklist it brings back with the same time and the same tick,
// so the newest time across the job's gates is that sign back. roundProduction
// is a BIT: accept true or 1, whichever the driver gives.
function production(gateRows) {
    const rows = list(gateRows).filter(Boolean);
    const newest = rows.reduce((max, g) => (signedBackIn(g) > max ? signedBackIn(g) : max), '');
    return !!newest && rows.some(g => signedBackIn(g) === newest && (g.roundProduction === true || g.roundProduction === 1));
}

// ── One fetch, many jobs ──

const NO_JOB = { units: new Map(), gates: new Map(), sends: new Map(), unreviewed: new Map(), changed: new Map() };

// Groups the route's reply by job once, so asking about a job reads only its
// own rows. reply is { units, gates, sends, unreviewed, changed }; a missing
// list counts as empty.
function buildIndex(reply) {
    const r = reply || {};
    const jobs = new Map();
    const jobFor = id => {
        const key = text(id);
        if (!jobs.has(key)) jobs.set(key, { units: new Map(), gates: new Map(), sends: new Map(), unreviewed: new Map(), changed: new Map() });
        return jobs.get(key);
    };
    list(r.units).forEach(u => {
        if (u) jobFor(u.jobId).units.set(text(u.gate) + '|' + text(u.unitId), u);
    });
    list(r.gates).forEach(g => {
        if (g) jobFor(g.jobId).gates.set(text(g.gate), g);
    });
    list(r.sends).forEach(s => {
        if (!s) return;
        const sends = jobFor(s.jobId).sends;
        const when = text(s.sentToCsrDate);
        if (when > (sends.get(text(s.gate)) || '')) sends.set(text(s.gate), when);
    });
    // The pieces the server names as added after this round's files went and
    // not opened since, per checklist.
    list(r.unreviewed).forEach(u => {
        if (!u) return;
        const byGate = jobFor(u.jobId).unreviewed;
        if (!byGate.has(text(u.gate))) byGate.set(text(u.gate), new Set());
        byGate.get(text(u.gate)).add(text(u.unitId));
    });
    // The pieces whose instructions changed after a passed block of that
    // department froze them, per checklist.
    list(r.changed).forEach(u => {
        if (!u) return;
        const byGate = jobFor(u.jobId).changed;
        if (!byGate.has(text(u.gate))) byGate.set(text(u.gate), new Set());
        byGate.get(text(u.gate)).add(text(u.unitId));
    });
    return { jobs };
}

// The facts a department's hover line may name, for its state.
function deptFacts(state, blocks, rows, gateRow) {
    const named = test => blocks.filter((b, i) => test(rows[i])).map(b => b.name).filter(Boolean);
    if (state === 'corrections') return { blocks: named(withOperator), who: '' };
    if (state === 'recheck') {
        // Whoever sent it back looks again; for a piece the CSR signed back in
        // while the round was going, whoever is reviewing the round.
        const who = rows.filter(withReviewer)
            .map(row => (row.fromCsr ? starter(gateRow) : person(row.returnedByName, row.returnedByLogin)))
            .filter((name, i, all) => name && all.indexOf(name) === i);
        return { blocks: named(withReviewer), who: joinAnd(who) };
    }
    if (state === 'in-review') return { blocks: [], who: starter(gateRow) };
    if (state === 'new-job') return { blocks: [], who: handedOverBy(gateRow) };
    return { blocks: [], who: '' };
}

// Everything the column shows for one job. pieces is the job's components
// (objects with id, name, version) or just their ids; only these pieces
// count, so a deleted piece's row is ignored. The reply:
//   chip        a key of WORDS, or '' for a blank cell
//   word        the chip's words
//   gate        the tab a click opens: the department the chip is about, or
//               'csr'; '' when the cell is blank
//   production  true while the newest sign back in was a production round
//   depts       per checklist: counts, state, round, blocks, who, added,
//               changed; the CSR's also carries passed and touched
//   hover       the hover's lines, joined with \n
function jobState(index, jobId, pieces) {
    const job = (index && index.jobs && index.jobs.get(text(jobId))) || NO_JOB;
    const named = list(pieces).map(p => (p && typeof p === 'object')
        ? { id: text(p.id), name: pieceName(p) }
        : { id: text(p), name: '' });

    const depts = {};
    DEPTS.forEach(gate => {
        const perPiece = CHECKLISTS.find(c => c.gate === gate).perPiece;
        const blocks = perPiece ? named.concat([{ id: 'job', name: HOVER.wholeJob }]) : [{ id: 'job', name: '' }];
        const rows = blocks.map(b => job.units.get(gate + '|' + b.id) || null);
        const gateRow = job.gates.get(gate) || null;
        const state = deptState(rows, gateRow, job.sends.get(gate));
        const facts = deptFacts(state, blocks, rows, gateRow);
        // Only a piece this list has (it needs a name, and its block counts
        // here), that the server named, and that has no row in this reply. Only
        // a checklist with a block per piece has pieces to name.
        const flagged = perPiece ? job.unreviewed.get(gate) : null;
        const addedIds = flagged ? named.filter((p, i) => flagged.has(p.id) && !rows[i]).map(p => p.id) : [];
        const added = named.filter(p => addedIds.indexOf(p.id) >= 0).map(p => p.name).filter(Boolean);
        // The same for a piece the server names as changed after the pass,
        // never one already named as added.
        const touched = job.changed.get(gate);
        const changed = touched
            ? named.filter(p => touched.has(p.id) && addedIds.indexOf(p.id) < 0).map(p => p.name).filter(Boolean)
            : [];
        depts[gate] = { counts: state !== '', state, round: roundOf(gateRow), blocks: facts.blocks, who: facts.who, added, changed };
    });

    const csrGate = job.gates.get('csr') || null;
    const csr = csrState(job.units.get('csr|job') || null, csrGate);
    depts.csr = {
        counts: csr.state !== '', state: csr.state, round: roundOf(csrGate), blocks: [], added: [], changed: [],
        who: csr.state === 'in-review' ? starter(csrGate) : '',
        passed: csr.passed, touched: csr.touched
    };

    const counted = DEPTS.filter(gate => depts[gate].counts);
    let chip = '';
    let gate = '';
    for (const step of DEPT_STEPS) {
        const at = counted.find(d => depts[d].state === step);
        if (at) {
            chip = step;
            gate = at;
            break;
        }
    }
    // Every department that counts has sent her its files, or none counts.
    if (!chip) {
        if (csr.passed) chip = 'csr-passed';
        else if (counted.length || csr.touched) chip = 'with-csr';
        if (chip) gate = 'csr';
    }

    const result = {
        chip,
        word: chip ? WORDS[chip] : '',
        gate,
        production: production(Array.from(job.gates.values())),
        depts
    };
    result.hover = hoverText(result);
    return result;
}

// The hover for a jobState reply, one line per checklist that counts.
function hoverText(state) {
    const s = state || {};
    const depts = s.depts || {};
    const lines = [];
    CHECKLISTS.forEach(c => {
        const d = depts[c.gate];
        const line = d && HOVER.lines[d.state];
        if (!line) return;
        const shows = fact => line.show.indexOf(fact) >= 0;
        const blocks = shows('blocks') ? list(d.blocks) : [];
        const parts = [line.say + (shows('who') && d.who ? ' by ' + d.who : '')].concat(blocks);
        if (d.round > 1) parts.push(HOVER.round + d.round);
        const added = list(d.added).filter(Boolean);
        const changed = list(d.changed).filter(Boolean);
        // A semicolon once the line names a piece, so a piece never reads as
        // one more of the list before it.
        lines.push(c.label + ': ' + parts.join(', ') +
            (added.length ? (blocks.length ? '; ' : ', ') + joinAnd(added) + HOVER.added : '') +
            (changed.length ? (blocks.length || added.length ? '; ' : ', ') + joinAnd(changed) + HOVER.changed : ''));
    });
    if (s.production) lines.push(HOVER.production);
    return lines.join('\n');
}

// Where a chip sorts under the QC header: ORDER, with a blank cell last.
function sortRank(chip) {
    const i = ORDER.indexOf(chip);
    return i < 0 ? ORDER.length : i;
}

// Frozen, like review-items.js: every caller shares these lists and words.
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.keys(value).forEach(key => deepFreeze(value[key]));
    }
    return value;
}

const api = deepFreeze({
    CHECKLISTS, DEPTS, WORDS, ORDER, HOVER,
    buildIndex, deptCounts, allPassed, newestPass, deptState, csrState, production, jobState, hoverText, sortRank
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else window.REVIEW_BOARD = api;

})();
