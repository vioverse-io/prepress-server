/*
 * QC Review email (PHASE5_PLAN.md, step 5; OUTLOOK_EMAIL_PLAN.md, 2026-10-26).
 *
 * The app never sends an email. Each press that used to send one builds the
 * email here (who it is for, the subject, the plain-text words) and hands it
 * to the page, which opens it as a ready Outlook message on the presser's own
 * screen through a mailto link (mailtoFor); the person presses Send in Outlook.
 * IT decided it in the 2026-10-26 meeting: no mail server, no password, no
 * mail lines in .env.
 *
 * Everything about email that does not touch the database lives here: the two
 * settings it needs (APP_BASE_URL for the link, USER_EMAIL_DOMAIN for the
 * addresses) and the optional department addresses, the address each person's
 * user makes, who is in To for which of the nine emails, the wording of each
 * one, and the mailto link. server.js reads the job, the roster and the user
 * list, hands the facts in, and writes the history rows. Nothing here reads
 * the database, so dev/review-mail-check.js checks all of it with no server,
 * no database and no network.
 *
 * Rules this file keeps (PHASE5_PLAN sections b, c, e and h):
 *   - The review is the record; the email is the tap on the shoulder. Building
 *     an email can never hold up, refuse or undo a review action, so every
 *     failure here comes back as an answer, never as a throw.
 *   - Nobody is in To for their own press, and an address only ever comes from
 *     a user on the user list (plus USER_EMAIL_DOMAIN).
 *   - Line breaks are stripped from the subject.
 *   - One email a press, everyone in To, from the presser's own mailbox: so no
 *     From, no Reply-To, no test address and no HTML part. The body is plain
 *     text; Outlook makes the http link clickable in the received email.
 */

'use strict';

const MAIL_LIMIT = { paths: 4000, subject: 250, name: 100, local: 64 };

// The checklist file is the source of truth for these; server.js passes the
// label it read. This map is the fallback, so an email is never labelled with
// a bare gate key.
const GATE_LABEL = { csr: 'CSR', prepress: 'Prepress', techservices: 'Tech Services' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Nobody is in To for their own press (section b). Named, so the check can
// turn it off in a broken copy and prove it is caught.
const SKIP_OWN_PRESS = true;

// ── Small helpers ──

// One line, for the subject: a job number carrying a line break could
// otherwise end the subject early.
function headerSafe(text) {
    return String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim();
}

function joinAnd(list) {
    const items = (list || []).map(s => String(s)).filter(Boolean);
    if (items.length <= 1) return items.join('');
    if (items.length === 2) return items[0] + ' and ' + items[1];
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

// The user key of a person as server.js hands them over: lowercased, so two
// spellings of one user are one person.
function keyOf(person) {
    return String((person && person.key) || '').trim().toLowerCase();
}

const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const ADDRESS_LOCAL = /^[A-Za-z0-9.'_-]+$/;
const DOMAIN_NAME = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

// ── Settings (.env) ──
//
// Two lines make email on: APP_BASE_URL, the address people open the app at
// (every email's link uses it), and USER_EMAIL_DOMAIN, the part after the @
// (an address is the person's user plus it). Both empty is off, with one log
// line, and nothing else in the app changes. One of them missing or malformed
// is "incomplete": off, with the problem named, until it is fixed and the
// service restarted. Read once at start.
function readSettings(env) {
    const src = env || {};
    const get = name => String(src[name] == null ? '' : src[name]).trim();
    const problems = [];
    const out = { baseUrl: '', domain: '', deptEmails: {}, mode: 'off', problems };

    const base = get('APP_BASE_URL');
    const domain = get('USER_EMAIL_DOMAIN');
    if (!base && !domain) return out;

    if (!base) problems.push('APP_BASE_URL is not set');
    else if (!/^https?:\/\/\S+$/.test(base)) problems.push('APP_BASE_URL must start with http:// or https://');
    out.baseUrl = base.replace(/\/+$/, '');

    if (!domain) problems.push('USER_EMAIL_DOMAIN is not set');
    else if (!DOMAIN_NAME.test(domain)) problems.push('USER_EMAIL_DOMAIN must be a domain name, with no @ and no spaces');
    out.domain = domain;

    // One address per department (PHASE6_PLAN c). Empty is the default and
    // means every list email names each person; set, it is the one address in
    // To instead. Nothing here is hardcoded to any shop.
    ['prepress', 'techservices'].forEach(gate => {
        const name = 'DEPT_EMAIL_' + gate.toUpperCase();
        const value = get(name);
        if (!value) return;
        if (!ADDRESS.test(value)) problems.push(name + ' must be one email address');
        else out.deptEmails[gate] = value;
    });

    out.mode = problems.length ? 'incomplete' : 'on';
    return out;
}

// The one line the service log gets after the version line.
function startupLines(settings) {
    const s = settings || {};
    if (s.mode === 'off') return ['Email off: APP_BASE_URL and USER_EMAIL_DOMAIN are not set.'];
    if (s.mode === 'incomplete') {
        return ['EMAIL SETTINGS INCOMPLETE: ' + (s.problems || []).join('; ') +
            '. Email is off until it is fixed and the service restarted.'];
    }
    return ['Email: opens in Outlook; links to ' + s.baseUrl + '; addresses at ' + s.domain + '.'];
}

// ── Addresses ──

function addressFor(key, domain) {
    const local = String(key == null ? '' : key).trim().toLowerCase();
    const at = String(domain == null ? '' : domain).trim();
    if (!local || !at) return { error: 'bad-address' };
    if (local.length > MAIL_LIMIT.local || !ADDRESS_LOCAL.test(local)) return { error: 'bad-address' };
    return { address: local + '@' + at };
}

// One person, as server.js read them, turned into a recipient or a reason.
// person: { name, listLabel, onList, active, key, spelling, listed, display, domain }
//   name      the roster name, '' for someone known only by a stamp
//   onList    true / false on the list the job names them on; null when the
//             question does not apply (a stamped person)
//   key       the user key to email, '' when no user is linked
//   spelling  that user as it is stored (the roster link, or the stamp)
//   listed    the user list's spelling of that user, '' when not on the list
//   emailOff  true when their Email switch is off in Manage CSRs & Assignees
function recipientOf(person) {
    const p = person || {};
    const name = String(p.name || p.display || p.spelling || '').trim();
    const label = String(p.listLabel || '');
    const no = (reasonKind, reason) => ({ ok: false, name, reasonKind, reason, address: '' });

    // The Email switch, before any other reason: it is the one thing an admin
    // did on purpose (EMAIL_SWITCH_PLAN, David 2026-10-02).
    if (p.emailOff) return no('email-off', 'email turned off in Manage CSRs & Assignees');
    if (p.onList === false) return no('not-on-list', name + ' is not on the ' + label + ' list in Manage CSRs & Assignees');
    if (p.onList === true && p.active === false) return no('off-list', 'turned off on the ' + label + ' list in Manage CSRs & Assignees');
    if (!keyOf(p)) return no('no-link', 'no user linked to ' + name + ' in Manage CSRs & Assignees');
    if (!person.listed) {
        return no('not-listed', (p.spelling || p.key) + ' is not on the user list');
    }
    const built = addressFor(p.key, p.domain);
    if (built.error) return no('bad-address', p.listed + ' cannot be made into an email address');
    return { ok: true, name: name || p.listed, key: keyOf(p), address: built.address };
}

// The words a group of people share on one "not emailed" line. The Email
// switch is not among them on purpose: a list email says nothing about the
// people it left out for it (see audienceFor).
const GROUP_REASON = {
    'no-link': 'no user linked',
    'not-listed': 'not on the user list',
    'bad-address': 'no possible email address',
    'not-on-list': 'not on that list',
    'off-list': 'turned off on that list'
};

// ── Who gets which email (section b) ──
//
// A pure decision over the people server.js read. facts carry, per kind:
//   actorKey    whoever pressed; never emailed
//   operators   the checklist's operator on this job: whoever sent it for
//               review (none before it is sent)
//   list        everyone active on that department's list
//   senders     everyone who sent this piece back, or these corrections, in the
//               current round
//   reviewers   whoever is reviewing the round (its starter), for a piece the
//               CSR signed back in, which nobody in the department sent back
//   csr         the job's CSR
// Returns { to, notSent, groups, nobody, why, fallback }: to is everyone in
// To of the one email the press opens. notSent names one
// person each; groups name several together, one line per reason, which is
// what a whole-list read gets.
//
// Someone whose Email switch is off is never in To. An email that was
// for that one person (as operator, as whoever sent the piece back, as the
// round's reviewer, as the job's CSR) names them in notSent, because it then
// reached nobody. An email for a whole list leaves them out and says nothing:
// on the Tech Services list that is the ordinary state, and a line on every
// job would be noise (David, 2026-10-02: "only when it matters"). It speaks
// only when the switch left the list email with nobody to go to.
function audienceFor(kind, facts) {
    const f = facts || {};
    const actorKey = SKIP_OWN_PRESS ? String(f.actorKey || '').trim().toLowerCase() : '';
    const label = String(f.gateLabel || '');
    const jobNumber = String(f.jobNumber || 'this job');
    const operators = f.operators || [];
    const list = f.list || [];
    const senders = f.senders || [];
    const out = { to: [], notSent: [], groups: [], nobody: '', why: '', fallback: false };

    // Left out by user key, and by name for someone who has no user linked:
    // the operator is still the operator, and is not told about their own job
    // just because nobody has linked them yet.
    const nameOf = p => String((p && p.name) || '').trim().toLowerCase();
    const without = (people, keys, names) => people.filter(p => {
        const key = keyOf(p);
        if (key) return !keys.includes(key);
        return !nameOf(p) || !(names || []).includes(nameOf(p));
    });
    const keys = people => people.map(keyOf).filter(Boolean);
    const names = people => people.map(nameOf).filter(Boolean);
    const mine = actorKey ? [actorKey] : [];

    let pool = [];
    let grouped = false;

    // A department group address stands in for that department's list
    // (PHASE6_PLAN c). Nobody is resolved person by person, so none of the
    // per-person reasons apply and there is nobody to leave out: a distribution
    // list cannot drop the one member who pressed. key is the gate.
    const groupRecipient = () => ({ ok: true, group: true, name: label, address: String(f.groupAddress), key: String(f.gate || '') });

    if ((kind === 'send_for_review' || kind === 'signed_back_in' || kind === 'new_job'
         || kind === 'new_job_taken_back') && f.groupAddress) {
        out.why = 'list';
        out.to.push(groupRecipient());
        return out;
    }

    if (kind === 'send_for_review') {
        grouped = true;
        out.why = 'list';
        pool = without(list, mine.concat(keys(operators)), names(operators));
        if (!pool.length) {
            out.nobody = list.length
                ? 'No email was sent: everyone on the ' + label + ' list pressed it or is the operator.'
                : 'No email was sent: nobody on the ' + label + ' list.';
        }
    } else if (kind === 'signed_back_in' || kind === 'new_job' || kind === 'new_job_taken_back') {
        // With no department address it falls back to the list one by one, as
        // every other email does. Whoever picks it up is the operator, so
        // nobody is singled out and nobody is left out except the CSR who
        // pressed it, if she happens to be on that list too. A brand new job
        // has no operator at all yet, which is the same shape.
        grouped = true;
        out.why = 'list';
        pool = without(list, mine, []);
        if (!pool.length) {
            out.nobody = list.length
                ? 'No email was sent: everyone on the ' + label + ' list pressed it.'
                : 'No email was sent: nobody on the ' + label + ' list.';
        }
    } else if (kind === 'sent_back' || kind === 'passed' || kind === 'handoff_asked') {
        const left = without(operators, mine, []);
        if (operators.length) {
            out.why = 'operator';
            pool = left;
            if (!pool.length) {
                const me = operators.find(p => keyOf(p) === actorKey);
                out.nobody = 'No email was sent: ' + ((me && (me.name || me.display)) || 'whoever pressed it') +
                    ', the operator on ' + jobNumber + ', pressed it.';
            }
        } else {
            out.why = 'list';
            out.fallback = true;
            grouped = true;
            pool = without(list, mine, names(operators));
            if (!pool.length) {
                out.nobody = list.length
                    ? 'No email was sent: everyone on the ' + label + ' list pressed it or is the operator.'
                    : 'No email was sent: nobody on the ' + label + ' list.';
            }
        }
    } else if (kind === 'rereview' && senders.length && !f.fromCsr) {
        out.why = 'sent-it-back';
        pool = without(senders, mine, []);
        if (!pool.length) out.nobody = 'No email was sent: whoever sent it back pressed it.';
    } else if (kind === 'rereview') {
        // The CSR signed it back in while the round was going: whoever is
        // reviewing the round checks it again, with anyone who flagged it in
        // this loop, else the list (David, 2026-09-19).
        const seen = new Set();
        const reviewers = senders.concat(f.reviewers || []).filter(p => {
            const k = keyOf(p) || nameOf(p);
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
        });
        if (reviewers.length) {
            out.why = 'reviewer';
            pool = without(reviewers, mine, []);
            if (!pool.length) out.nobody = 'No email was sent: the reviewer pressed it.';
        } else {
            grouped = true;
            out.why = 'list';
            pool = without(list, mine.concat(keys(operators)), names(operators));
            if (!pool.length) {
                out.nobody = list.length
                    ? 'No email was sent: everyone on the ' + label + ' list pressed it or is the operator.'
                    : 'No email was sent: nobody on the ' + label + ' list.';
            }
        }
    } else if (kind === 'handoff') {
        out.why = 'csr';
        const csr = f.csr || null;
        if (!csr) out.nobody = 'No email was sent: nobody is the CSR on ' + jobNumber + '.';
        else if (actorKey && keyOf(csr) === actorKey) {
            out.nobody = 'No email was sent: ' + (csr.name || csr.display || 'the CSR') + ', the CSR on ' + jobNumber + ', pressed it.';
        } else pool = [csr];
    }

    const seen = new Set();
    const failed = [];
    let switchedOff = 0;
    pool.forEach(person => {
        const id = keyOf(person) || 'name:' + String(person.name || person.display || '').toLowerCase();
        if (seen.has(id)) return;
        seen.add(id);
        const r = recipientOf(person);
        if (r.ok) out.to.push(r);
        else if (grouped && r.reasonKind === 'email-off') switchedOff += 1;
        else if (grouped) failed.push(r);
        else out.notSent.push({ name: r.name, address: '', reasonKind: r.reasonKind, reason: r.reason, text: r.name + ' was not emailed: ' + r.reason + '.' });
    });

    Object.keys(GROUP_REASON).forEach(reasonKind => {
        const people = failed.filter(r => r.reasonKind === reasonKind);
        if (!people.length) return;
        out.groups.push({
            name: '', address: '', reasonKind,
            text: 'Not emailed, ' + GROUP_REASON[reasonKind] + ': ' + joinAnd(people.map(r => r.name)) + '.'
        });
    });
    if (grouped && switchedOff && !out.to.length && !failed.length && !out.nobody) {
        out.nobody = 'No email was sent: everyone it would go to on the ' + label +
            ' list has email turned off in Manage CSRs & Assignees.';
    }
    return out;
}

// ── Times and due dates ──
//
// The window's wording, written here because the window's own helpers are
// browser-only. The day is always shown ("Sep 14, 2:41 PM"), never "Today":
// an email is read whenever it is read.

function clockText(date) {
    const h = date.getHours();
    return (h % 12 || 12) + ':' + String(date.getMinutes()).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
}

function whenText(iso) {
    const date = new Date(iso);
    if (!iso || isNaN(date.getTime())) return '';
    const day = MONTHS[date.getMonth()] + ' ' + date.getDate();
    const year = date.getFullYear() === new Date().getFullYear() ? '' : ' ' + date.getFullYear();
    return day + year + ', ' + clockText(date);
}

// The department's signoff due on the work order ("Sep 15, 2:00 PM"), or ''.
// The CSR checklist has none.
function dueText(job, gate) {
    const j = job || {};
    const suffix = gate === 'prepress' ? 'Prepress' : gate === 'techservices' ? 'Techservices' : '';
    const date = suffix ? String(j['signoffDueDate' + suffix] || '').trim() : '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const day = MONTHS[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() === new Date().getFullYear() ? '' : ' ' + d.getFullYear());
    const time = String(j['signoffDueTime' + suffix] || '').trim();
    return day + (time ? ', ' + time : '');
}

// A block's state in the window's own chip words (review.js refreshUnit).
function blockState(row) {
    if (!row) return 'Not started';
    if (row.disposition === 'passed') return 'Passed';
    if (row.disposition === 'corrections') return row.holder === 'reviewer' ? 'Re-check' : 'Corrections';
    return row.hasActivity ? 'In progress' : 'Not started';
}

// ── The link ──

// The work order itself, the second link in a sign back in or new job email.
// It takes the ordinary edit lock when it opens, which is why the QC Review
// link above it does not (PHASE5_PLAN section d); the round's real
// instructions are here.
function workOrderUrl(baseUrl, jobId) {
    return String(baseUrl || '').replace(/\/+$/, '') + '/?job=' + encodeURIComponent(jobId);
}

function linkUrl(baseUrl, jobId, tab, piece) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    let url = base + '/?review=' + encodeURIComponent(jobId) + '&tab=' + encodeURIComponent(tab);
    if (piece) url += '&piece=' + encodeURIComponent(piece);
    return url;
}

// ── The nine emails (section c, plus PHASE6_PLAN c, START_NEW_JOB_PLAN f and
// TAKE_BACK_AND_WARNING_PLAN; the "review taken" heads-up went with the
// Outlook change, David 2026-10-26) ──

function gateLabelOf(data) {
    return String(data.gateLabel || GATE_LABEL[data.gate] || data.gate || '');
}

// What a flagged item with no note says.
const NO_NOTE = 'No detail added.';

function itemsTitle(verb, count) {
    return verb + (count === 1 ? ' this 1 item' : ' these ' + count + ' items');
}

// Why this copy came, in as few words as it takes (David, 2026-09-18).
function whyLine(kind, data, label) {
    const dept = String(data.deptLabel || label);
    switch (kind) {
        case 'send_for_review':
            return 'You are on the ' + label + ' list.';
        // A sign back in is on the CSR checklist but lands on a department, so
        // the list named is theirs, never hers. A new job is the same: the CSR
        // presses it on the work order and it lands on the department.
        case 'signed_back_in':
        case 'new_job':
        case 'new_job_taken_back':
            return 'You are on the ' + dept + ' list.';
        case 'sent_back':
        case 'passed':
        case 'handoff_asked':
            return data.why === 'list'
                ? 'You are on the ' + label + ' list, and the job has no operator.'
                : 'You are the operator.';
        case 'rereview':
            return data.why === 'reviewer' ? 'You are reviewing this checklist.'
                : data.why === 'list' ? 'You are on the ' + label + ' list.'
                : 'You sent the ' + String(data.unitName || 'piece') + ' back.';
        case 'handoff': return 'You are the CSR on this job.';
        default: return '';
    }
}

// Description, headline, the two or three short rows, the body and the
// closing line for one email. The description is what the subject said before
// every email about a job had one subject (EMAIL_THREAD_PLAN): the QC history
// records it, so the record still says which email went. Every value here is
// plain text, and the email is plain text, so nothing is escaped.

function specFor(kind, data) {
    const job = data.job || {};
    const jobNumber = String(job.jobNumber || '');
    const label = gateLabelOf(data);
    const dept = String(data.deptLabel || label);
    const unit = String(data.unitName || '');
    const actor = data.actor || {};
    // A row is { k, v }: the text writes "Label: value". A row with an empty k
    // is a whole sentence.
    const actorRow = (prefix, person) => ({
        k: prefix,
        v: String((person && person.name) || '') + (whenText(person && person.at) ? ', ' + whenText(person.at) : '')
    });
    // The one grey line under the job number: who did the thing this email is
    // about. It was a row in the facts table until David asked for that row to
    // go (2026-09-16). Kept now that the email is from the person: it may be
    // forwarded, and the line says who pressed.
    const byLine = (verb, person) => {
        const name = String((person && person.name) || '').trim();
        return name ? verb + ' by ' + name + '.' : '';
    };
    const items = Array.isArray(data.items) ? data.items : [];
    const due = dueText(job, kind === 'signed_back_in' ? data.dept : data.gate);
    // Shown wherever it was shown before, and says so when the work order has
    // no date, rather than the row quietly vanishing (David, 2026-09-16).
    const dueRow = [{ k: 'Signoff due', v: due || 'Not set' }];
    // The design leads with the piece (dc.html:1318). The email knows the piece
    // by the name the QC Review window uses; the flat size, ink and finishing
    // stay on the work order (David, 2026-09-16).
    const pieceRow = unit ? [{ k: 'Piece', v: unit }] : [];
    // What the operator typed for the reviewer on Send for review or Fixed,
    // ready for re-review, when anything (OPERATOR_NOTE_PLAN, David
    // 2026-10-01). Nothing typed leaves both emails as they were.
    const noteText = String(data.note == null ? '' : data.note).trim();
    const noteBody = noteText ? { kind: 'paths', title: 'Notes for the reviewer', text: noteText } : null;
    if (kind === 'send_for_review') {
        return {
            description: jobNumber + ': ready for ' + label + ' review',
            headline: 'Ready for ' + label + ' review',
            by: byLine('Sent for review', actor),
            rows: dueRow,
            body: noteBody,
            closing: ''
        };
    }
    // No round number in the description: a sign back in raises the same
    // count, so it stopped matching what anyone means by a round (David,
    // 2026-09-18).
    if (kind === 'sent_back') {
        return {
            description: jobNumber + ' ' + unit + ': sent back for fixes',
            headline: unit + ' sent back for fixes',
            by: byLine('Sent back', actor),
            rows: pieceRow.concat(dueRow),
            body: { kind: 'items', title: itemsTitle('Fix', items.length), items },
            closing: 'When they are fixed, press Fixed, ready for re-review.'
        };
    }
    if (kind === 'rereview') {
        // The CSR signed it back in: the whole piece is checked again, with
        // anything a reviewer flagged on it as well. The operator's note comes
        // first: it says what was done.
        const sections = [noteBody, items.length ? { kind: 'items', title: itemsTitle('Re-check', items.length), items } : null].filter(Boolean);
        return {
            description: jobNumber + ' ' + unit + ': ready for re-review',
            headline: unit + ' is ready for re-review',
            by: byLine('Fixed', actor),
            rows: pieceRow.concat(dueRow),
            body: sections.length ? sections : null,
            closing: data.fromCsr || !items.length ? 'It came back from the CSR: check every line again.' : ''
        };
    }
    // The job is back from the CSR and the whole QC runs again for what she
    // ticked (SIGN_BACK_IN_PLAN section h). It goes to the department address,
    // because weeks may have passed and whoever is free picks it up. The
    // headline names what came back, as the department's tab does, and her
    // words follow with no label (David, 2026-09-18).
    if (kind === 'signed_back_in') {
        const blocks = (Array.isArray(data.blocks) ? data.blocks : []).map(b => String(b || '')).filter(Boolean);
        const production = !!data.production;
        return {
            description: jobNumber + ': back from the CSR for ' + dept + (production ? ', for production' : ''),
            headline: (blocks.length ? joinAnd(blocks) : jobNumber) + ' came back from the CSR',
            by: byLine('Signed back in', actor),
            // The production row is left out when the tick is off, rather than
            // saying "no": an ordinary round is the ordinary case. A change
            // that joined a round already going names who it went back to.
            rows: (production ? [{ k: 'This round', v: 'Goes to production' }] : [])
                .concat(data.backWith ? [{ k: 'Back with', v: String(data.backWith) }] : [])
                .concat(dueRow),
            body: [
                { kind: 'quote', title: '', text: String(data.note || '') }
            ].concat(items.length ? [{ kind: 'items', title: 'Flagged by the CSR', items }] : []),
            closing: ''
        };
    }
    // A brand new job, handed to a department by the CSR from the work order
    // (START_NEW_JOB_PLAN section f). It is the email she writes in Outlook
    // today: what the job is, what is in the package, when it is due, and the
    // line she types. Like a sign back in it carries both links, because the
    // work order is where the instructions and the artwork paths are. There is
    // no closing line: the next step is whatever the department does about it,
    // and Send for review is inside the window the red button opens.
    if (kind === 'new_job') {
        const pieces = String(data.pieces || '').trim();
        return {
            description: jobNumber + ': new job for ' + dept,
            headline: jobNumber + ' is a new job for ' + dept,
            by: byLine('Sent', actor),
            // Client and project are already the grey line under the headline
            // on every email, so they are not repeated as rows.
            rows: (pieces ? [{ k: 'Pieces', v: pieces }] : []).concat(dueRow),
            body: { kind: 'quote', title: '', text: String(data.note || '') },
            closing: ''
        };
    }
    // 10. The CSR sent the job to this department by mistake and has taken it
    // back. The first email cannot be recalled, so this is the untap on the
    // shoulder: the same people it went to, and the fewest words that do the
    // job. No rows and no quote, because nothing about the job has changed and
    // there is nothing for them to read. It keeps the one red button the other
    // nine have: the QC activity is where both presses are on the record.
    if (kind === 'new_job_taken_back') {
        return {
            description: jobNumber + ': ignore the new job for ' + dept,
            headline: jobNumber + ' was sent to ' + dept + ' by mistake',
            by: byLine('Taken back', actor),
            rows: [],
            body: null,
            closing: 'Please ignore the earlier email. Nothing is waiting for ' + dept + ' on this job.'
        };
    }
    // The reviewer has passed everything and is asking the operator to send the
    // files on (PHASE6_PLAN d).
    if (kind === 'handoff_asked') {
        const csrName = String(data.csrName || '').trim();
        return {
            description: jobNumber + ': please send the ' + label + ' files to the CSR',
            // Not "QC passed": the passed email may have come moments before.
            // Whoever asked need not be whoever passed it. The department is
            // named because the subject no longer names it (David, 2026-10-14).
            headline: 'Please send the ' + label + ' files to the CSR',
            by: byLine('Asked', actor),
            rows: dueRow,
            // Drawn the way the flagged items are, numbered, because it is a
            // list of things to do rather than a sentence (David, 2026-09-16).
            body: {
                kind: 'items', quoted: false, title: 'What to do next',
                items: [
                    { label: 'Paste where the files are', note: '' },
                    { label: 'Press Send to CSR', note: 'They go to ' + (csrName || 'the CSR') + '.' }
                ]
            },
            closing: ''
        };
    }
    if (kind === 'handoff') {
        const rows = [];
        // Left out when whoever passed it also sent the files: the line under
        // the job number already names them (David, 2026-09-18).
        if (data.passedBy && !samePersonAs(data.passedBy, actor)) rows.push(actorRow(label + ' QC passed', data.passedBy));
        if (data.previousAt && whenText(data.previousAt)) rows.push({ k: '', v: 'This replaces the paths sent ' + whenText(data.previousAt) + '.' });
        return {
            // Success first, so the one email that means the job is through
            // Prepress stands out (David, 2026-09-16). It led the subject; the
            // subject is now the job's own, so it leads the headline (David,
            // 2026-10-14). A hyphen, never an em-dash.
            description: jobNumber + ': Success - ' + label + ' outputs ready for the CSR',
            headline: 'Success: ' + label + ' outputs are ready',
            by: byLine('Sent', actor),
            rows,
            body: { kind: 'paths', title: 'Where the files are', text: String(data.paths || '') },
            closing: 'The CSR Checklist is next.'
        };
    }
    // Sent only when the last block of a department checklist passes (David,
    // 2026-09-16): one piece passing is not an email.
    if (kind === 'passed') {
        const passes = Array.isArray(data.passes) ? data.passes : [];
        return {
            description: jobNumber + ': ' + label + ' QC passed',
            headline: label + ' QC passed',
            by: byLine('Passed', actor),
            rows: dueRow,
            // One block needs no list: the line under the job number says who.
            body: passes.length > 1
                ? { kind: 'lines', title: 'What passed', lines: passes.map(p => String(p.name || '') + ': ' + String(p.by || '')) }
                : null,
            closing: 'Next: paste where the files are and press Send to CSR.'
        };
    }
    return null;
}

// Two stamps are one person: by user key when both have one, else by name.
function samePersonAs(a, b) {
    const login = p => String((p && p.login) || '').trim().toLowerCase();
    const name = p => String((p && p.name) || '').trim().toLowerCase();
    if (login(a) && login(b)) return login(a) === login(b);
    return !!name(a) && name(a) === name(b);
}

function jobLine(job) {
    const number = String((job && job.jobNumber) || '');
    const meta = [job && job.clientName, job && job.jobDescription]
        .map(v => String(v || '').trim()).filter(Boolean).join(' \u00b7 ');
    return number + (meta ? '  ' + meta : '');
}

// "Hi Sue and Don," from the first names of everyone in To (David,
// 2026-10-26, now that one email goes to several people). "Hi," when it goes
// to a department address, or when nobody in To has a roster name.
function greetingFor(toNames) {
    const firsts = [];
    (Array.isArray(toNames) ? toNames : [toNames]).forEach(name => {
        const first = String(name == null ? '' : name).trim().split(/\s+/)[0];
        if (first && !firsts.includes(first)) firsts.push(first);
    });
    return firsts.length ? 'Hi ' + joinAnd(firsts) + ',' : 'Hi,';
}

// A spec's body is one section or several, in the order they are shown.
function bodySections(spec) {
    if (!spec || !spec.body) return [];
    return (Array.isArray(spec.body) ? spec.body : [spec.body]).filter(Boolean);
}

// "Label: value"; a row with no label is a whole sentence.
function rowText(row) {
    return row && row.k ? row.k + ': ' + String(row.v == null ? '' : row.v) : String((row && row.v) || '');
}

// The one drawing plain text allows (David's choice, 2026-10-26, from five
// Outlook tests on his work laptop: test 5, C): a row of equals signs above
// and below the headline and each section title, sized to the words. Outlook
// draws the message in a proportional font, so the row is sized by the
// letters' widths, not their count: narrow letters and marks count less,
// wide ones more, an average letter one. Within about a tenth of the words'
// width either way (David: "pretty close").
function ruleLine(text) {
    let w = 0;
    for (const ch of String(text == null ? '' : text)) {
        if (/[iljtfI.,:;'!|]/.test(ch)) w += 0.45;
        else if (/[mwMW]/.test(ch)) w += 1.45;
        else if (/[A-Z0-9]/.test(ch)) w += 1.15;
        else if (ch === ' ') w += 0.5;
        else w += 1;
    }
    return '='.repeat(Math.max(4, Math.round(w)));
}

// A headline or a section title between its two rows.
function ruled(text) {
    const rule = ruleLine(text);
    return [rule, text, rule];
}

function textPart(spec, data) {
    const job = data.job || {};
    const number = String(job.jobNumber || 'the job');
    const out = [spec.greeting, ''].concat(ruled(spec.headline), [jobLine(job)]);
    if (spec.by) out.push(spec.by);
    out.push('');
    const rows = spec.rows.filter(Boolean);
    rows.forEach(row => out.push(rowText(row)));
    if (rows.length) out.push('');
    // One section, or several: a sign back in carries her words and the
    // flagged lines. A section with no title (her words) has no label line.
    bodySections(spec).forEach(body => {
        if (body.title) out.push(...ruled(body.title + ':'));
        if (body.kind === 'items') {
            // A flagged item with no note says so; a numbered step (quoted:
            // false) with nothing under it has no second line.
            body.items.forEach((item, i) => {
                out.push((i + 1) + '. ' + String(item.label || ''));
                const note = String(item.note == null ? '' : item.note).trim();
                if (note) out.push('   ' + (body.quoted === false ? note : '"' + note + '"'));
                else if (body.quoted !== false) out.push('   ' + NO_NOTE);
            });
        } else if (body.kind === 'lines') {
            body.lines.forEach(line => out.push(line));
        } else if (body.kind === 'paths') {
            out.push(body.text);
        } else if (body.kind === 'quote') {
            out.push('"' + String(body.text || '').trim() + '"');
        }
        out.push('');
    });
    if (spec.closing) out.push(spec.closing, '');
    out.push('Open QC Review:', String(data.link || ''), '');
    if (data.workOrderLink) out.push('Open work order ' + number + ':', String(data.workOrderLink), '');
    // The why line is the last line: the email is from the person, so there
    // is no "reply to reach" and no "do not reply".
    out.push(spec.why);
    return out.join('\n');
}

function subjectFor(job) {
    const number = String((job && job.jobNumber) || '').trim();
    return headerSafe(number ? number + ' QC Review' : 'QC Review');
}

// One email: the subject, the description (what the subject said before
// every email about a job had one subject; the QC history keeps it) and the
// plain-text body. data.toNames is the roster names of everyone in To, for
// the greeting; a department address gives none.
function emailFor(kind, data) {
    const d = data || {};
    const spec = specFor(kind, d);
    if (!spec) return null;
    spec.why = whyLine(kind, d, gateLabelOf(d));
    spec.greeting = greetingFor(d.toNames == null ? d.toName : d.toNames);
    spec.description = headerSafe(spec.description);
    return { subject: subjectFor(d.job), description: spec.description, text: textPart(spec, d) };
}

// ── The mailto link ──
//
// What the page gives a hidden frame, so Outlook opens a new message with To,
// Subject and the body filled in (OUTLOOK_EMAIL_PLAN section 3: a hidden
// frame, never location.href, which fires the page's own leaving event).
// Every part is percent-encoded; a line break is %0D%0A, which Outlook on
// Windows reads as one. Addresses are joined by commas. Proven on David's
// laptop (2026-10-26): a link of 11,450 characters opened whole, and one
// opened seven seconds after the click.
function mailtoFor(email) {
    const e = email || {};
    const to = (Array.isArray(e.to) ? e.to : [e.to]).map(a => String(a == null ? '' : a).trim()).filter(Boolean);
    const body = String(e.text == null ? '' : e.text).replace(/\r\n|\r|\n/g, '\r\n');
    return 'mailto:' + to.join(',') +
        '?subject=' + encodeURIComponent(headerSafe(e.subject)) +
        '&body=' + encodeURIComponent(body);
}

module.exports = {
    MAIL_LIMIT, GROUP_REASON,
    readSettings, startupLines,
    addressFor, recipientOf, audienceFor,
    whenText, dueText, blockState, linkUrl, workOrderUrl,
    emailFor, subjectFor, mailtoFor, ruleLine,
    headerSafe, joinAnd
};
