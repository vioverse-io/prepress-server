/* ═════════════════════════════════════════════════════════════════
   QC REVIEW CHECKLISTS -- the three forms as data
   Loaded by index.html before app.js, and by server.js with require().
   The code prefix for this feature is review*; the existing qc* code is the
   print-time QC warning, a different feature.

   EDITING THE LISTS (one line per item):
   - Reword: edit the label. Once reviews exist in production, if a tick would
     now mean the opposite, retire the line and add a new one instead.
   - Re-scope: change scope. 'comp' repeats on every Prepress piece; 'job' is
     answered once (the Whole Job block on Prepress, the whole checklist on
     CSR and Tech Services). CSR and Tech Services take 'job' only.
   - Add: a new line with a new id. The check script prints the next free id.
   - Remove: add  retired: true  to the line. Never delete a line.
   - Move or reorder: move the line; its id stays.
   - Follow another line's N/A: add  naWith: '<id>', naWithReason: '...'  to
     the line. While the reviewer has that other line (same checklist, same
     scope) marked N/A, this line is N/A too, with that reason; un-setting it
     brings this line back as it was. One step only: the line it follows
     cannot itself follow another. To retire a line that others follow,
     remove naWith and naWithReason from those lines in the same edit. Once
     reviews exist in production, adding or removing naWith changes how
     existing sheets read: treat it like a reword that changes the meaning.
   - Never change, renumber or reuse an id. Reviews are stored by id.
   - Write an apostrophe as \'. Every item line ends with a comma.
   Then run, from the repo root:
       node server-sql/dev/review-items-check.js
   ═════════════════════════════════════════════════════════════════ */

(function () {

// ── CSR sign-off check: one job-wide checklist ──
// She checks the finished sign-off proofs, electronic and printed, after the
// department reviews. Trimmed from 36 lines to 31 on 2026-09-19 (David, after
// the four CSR interviews): three pairs of lines that asked the same thing
// merged into one line each, and the Overall Common Sense Review section went,
// except "Matches client mockup", which moved into Print Layout.
// CSR_INTERVIEWS_PLAN.md holds his answers.
const csr = [
    { section: '1', title: 'Data Accuracy / Versioning', items: [
        { id: 'x101', label: 'Name, address, and company fields are correct and properly aligned', scope: 'job' },
        { id: 'x102', label: 'No missing or blank required fields', scope: 'job' },
        { id: 'x103', label: 'All versions are accounted for', scope: 'job' },
        { id: 'x104', label: 'Version naming/IDs match job setup', scope: 'job' },
        { id: 'x105', label: 'Correct data and variable content paired with each version (copy, offer, images, messaging, personalization)', scope: 'job' },
        { id: 'x106', label: 'Right data is paired with the right version', scope: 'job', retired: true },
        { id: 'x107', label: 'Seeds match expected records', scope: 'job' },
        { id: 'x108', label: 'Match mailing: Mail Piece # on all appropriate pieces and/or 2D BC used', scope: 'job' },
    ] },
    { section: '2', title: 'Addressing and Postal Compliance', items: [
        { id: 'x201', label: 'Meets Mail Stream Grid expectations', scope: 'job' },
        { id: 'x202', label: 'Address block meets USPS standards', scope: 'job' },
        { id: 'x203', label: 'IMb barcode present and readable', scope: 'job' },
        { id: 'x204', label: 'IMb barcode scanned and verified', scope: 'job' },
        { id: 'x205', label: 'Barcode matches address', scope: 'job' },
        { id: 'x206', label: 'Postage / Indicia correct', scope: 'job' },
        { id: 'x207', label: 'Return address correct', scope: 'job' },
        { id: 'x208', label: 'No overlapping or cutoff elements', scope: 'job', retired: true },
        { id: 'x209', label: 'Window aligns with address block, tap test passed and address stays in window', scope: 'job' },
        { id: 'x210', label: 'HIPAA/PII: no information shows in the window', scope: 'job' },
    ] },
    { section: '3', title: 'Print Layout, Quality and Physical Review', items: [
        { id: 'x301', label: 'No shifting or misalignment', scope: 'job' },
        { id: 'x302', label: 'Duplex alignment correct', scope: 'job' },
        { id: 'x303', label: 'No cutoff or overlapping text, images or barcodes', scope: 'job' },
        { id: 'x304', label: 'Color vs B/W matches specs', scope: 'job' },
        { id: 'x305', label: 'Trim size correct', scope: 'job' },
        { id: 'x306', label: 'Folding correct', scope: 'job' },
        { id: 'x307', label: 'Inserts correct and in order', scope: 'job' },
        { id: 'x308', label: 'Window aligns with address block', scope: 'job', retired: true },
        { id: 'x309', label: 'Matches CS/DI specs', scope: 'job' },
        { id: 'x310', label: 'Quantity / version setup correct', scope: 'job' },
        { id: 'x502', label: 'Matches client mockup', scope: 'job' },
        { id: 'x501', label: 'Nothing looks off or inconsistent', scope: 'job', retired: true },
        { id: 'x503', label: 'Nothing here the client would question', scope: 'job', retired: true },
    ] },
    { section: '4', title: 'Seeds / Samples / Blanks', items: [
        { id: 'x401', label: 'Correct seed records included', scope: 'job' },
        { id: 'x402', label: 'Samples reflect expected versions', scope: 'job' },
        { id: 'x403', label: 'Blanks are correct', scope: 'job' },
    ] },
    { section: '5', title: 'Postage Check', items: [
        { id: 'x601', label: 'Postage requested', scope: 'job' },
        { id: 'x602', label: 'Postage received', scope: 'job', naWith: 'x601', naWithReason: 'No postage on this job' },
    ] },
];

// ── Prepress Peer QC Review: a block per piece ('comp') plus Whole Job ('job') ──
const prepress = [
    { section: '1', title: 'Artwork and File Integrity', jobTitle: 'Job Overview', items: [
        { id: 'p203', label: 'Packaged InDesign files included', scope: 'comp' },
        { id: 'p204', label: 'Images 300 dpi minimum', scope: 'comp' },
        { id: 'p205', label: 'No text overflow boxes', scope: 'comp' },
        { id: 'p207', label: 'Bleeds included', scope: 'comp' },
        { id: 'p208', label: 'Crops included', scope: 'comp' },
        { id: 'p209', label: 'Colors match specifications', scope: 'comp' },
        { id: 'p101', label: 'All job instructions read', scope: 'job' },
        { id: 'p105', label: 'Correct data files used', scope: 'job' },
        { id: 'p106', label: 'Record counts match instructions', scope: 'job' },
        { id: 'p504', label: 'Repeat job: data is the only change', scope: 'job' },
    ] },
    { section: '2', title: 'Setup, variability and imposition', items: [
        { id: 'p104', label: 'Variable fields mapped correctly to mockup', scope: 'comp' },
        { id: 'p301', label: 'Number up correct', scope: 'comp' },
        { id: 'p506', label: 'Imposed cut and stack (step and repeat only if the instructions ask for it)', scope: 'comp' },
        { id: 'p304', label: 'Head / tail orientation correct', scope: 'comp' },
        { id: 'p406', label: 'Checked Inspire log for warnings or errors', scope: 'comp' },
        { id: 'p505', label: 'Number of versions correct', scope: 'comp' },
    ] },
    { section: '3', title: 'Proof PDF Review', items: [
        { id: 'p410', label: 'Client SOF generated, counts match', scope: 'comp' },
        { id: 'p411', label: 'Print sign off generated, counts match', scope: 'comp' },
        { id: 'p413', label: 'Seeds generated, counts match', scope: 'comp' },
        { id: 'p412', label: 'Samples generated, counts match', scope: 'comp' },
        { id: 'p414', label: 'Lives generated, counts match', scope: 'comp' },
        { id: 'p405', label: 'Variables matches mockup', scope: 'comp' },
    ] },
];

// ── Tech Services (Jason Strope's list): one job-wide checklist ──
const techservices = [
    { section: '1', title: 'Data Conversion', items: [
        { id: 't101', label: 'All job instructions read (CSR + Midnight)', scope: 'job' },
        { id: 't102', label: 'Initials are placed in midnight', scope: 'job' },
        { id: 't103', label: 'Job status in Midnight is set', scope: 'job' },
        { id: 't104', label: 'Midnight specs match job instructions', scope: 'job' },
        { id: 't105', label: 'Data source connected and validated', scope: 'job' },
        { id: 't106', label: 'Record counts verified', scope: 'job' },
        { id: 't107', label: 'Seeds', scope: 'job' },
        { id: 't108', label: 'Samples', scope: 'job' },
    ] },
    { section: '2', title: 'CASS/NCOA', items: [
        { id: 't201', label: 'CASS complete', scope: 'job' },
        { id: 't202', label: 'NCOA complete', scope: 'job' },
        { id: 't203', label: 'Deceased', scope: 'job' },
        { id: 't204', label: 'Walk Sequence', scope: 'job' },
        { id: 't205', label: 'Customer/CSR review and approve', scope: 'job' },
    ] },
    { section: '3', title: 'Dedup', items: [
        { id: 't301', label: 'Dedup completed based on instructions', scope: 'job' },
        { id: 't302', label: 'Customer/CSR approved', scope: 'job' },
    ] },
    { section: '4', title: 'Presort', items: [
        { id: 't401', label: 'Specs match Midnight', scope: 'job' },
        { id: 't402', label: 'CSR approved mailstream grid', scope: 'job' },
        { id: 't403', label: 'Mail.dat QC sent', scope: 'job' },
    ] },
    { section: '5', title: 'Print', items: [
        { id: 't501', label: 'Print variables mapped', scope: 'job' },
        { id: 't502', label: 'Samples provided', scope: 'job' },
        { id: 't503', label: 'Seeds provided', scope: 'job' },
        { id: 't504', label: 'Signoffs provided', scope: 'job' },
        { id: 't505', label: 'All variables are mapped according to the art', scope: 'job' },
    ] },
    { section: '6', title: 'Post Print', items: [
        { id: 't601', label: 'Mail.dat QC sent and approved', scope: 'job' },
        { id: 't602', label: 'Layout provided to Prepress', scope: 'job' },
        { id: 't603', label: 'Version counts match', scope: 'job' },
    ] },
];

// ═══ Code below: nothing here changes when a list changes ═══

// The keys a line may carry. A section also carries its items, and an item may
// carry retired: true. The check script reads these same lists, so the
// fingerprint and the allowed-key check can never disagree.
const SECTION_KEYS = ['section', 'title', 'jobTitle'];
const ITEM_KEYS = ['id', 'label', 'scope', 'valueLabel', 'naWith', 'naWithReason'];

// Tab order. Only Prepress has a block per piece; the other two are one
// job-wide checklist.
const gates = [
    { gate: 'csr',          label: 'CSR',           perPiece: false },
    { gate: 'prepress',     label: 'Prepress',      perPiece: true  },
    { gate: 'techservices', label: 'Tech Services', perPiece: false }
];

// The lists exactly as written above, retired lines included. For the check
// script only: a sheet, an item count or a pass check is always built from
// `forms` or unitSections(), which leave retired lines out.
const source = { csr, prepress, techservices };

function gateInfo(gate) {
    return gates.find(g => g.gate === gate) || null;
}

// The lists as a sheet shows them: retired lines left out, and a section left
// with no items dropped. Every line ever written is also kept by id, so a
// retired item can still be named in old sheets and history.
const forms = {};
const linesById = {};
gates.forEach(g => {
    linesById[g.gate] = new Map();
    forms[g.gate] = source[g.gate]
        .map(section => {
            section.items.forEach(item => linesById[g.gate].set(item.id, item));
            return Object.assign({}, section, { items: section.items.filter(item => !item.retired) });
        })
        .filter(section => section.items.length);
});

// The sections one review block shows. unitId 'job' is the Whole Job block
// (or the whole checklist on CSR and Tech Services); anything else is a piece,
// which only Prepress has. A section's jobTitle replaces its title on the
// job block.
function unitSections(gate, unitId) {
    const g = gateInfo(gate);
    if (!g) return [];
    const scope = unitId === 'job' ? 'job' : 'comp';
    if (scope === 'comp' && !g.perPiece) return [];
    return forms[gate]
        .map(section => ({
            section: section.section,
            title: scope === 'job' && section.jobTitle ? section.jobTitle : section.title,
            items: section.items.filter(item => item.scope === scope)
        }))
        .filter(section => section.items.length);
}

// The line for an item id, retired or not (a retired line carries
// retired: true), or null. A Map, so an id such as 'constructor' finds nothing.
function findItem(gate, id) {
    if (!gateInfo(gate)) return null;
    return linesById[gate].get(String(id)) || null;
}

// The reason an item is N/A because it follows another item's N/A, or '' when
// it does not. na is one sheet's N/A marks: the stored object (itemId -> mark)
// or a plain list of ids. Only the reviewer's own N/A press on the other item is
// stored; this is worked out from it every time, never stored, so un-setting
// that press brings this item back as it was (a tick, a flag, or its own N/A),
// provided whoever saves the sheet sends those back unchanged. Unlike the
// design file's autoNA(), which the port dropped, it never reads work-order data.
function followingNA(gate, itemId, na) {
    const item = findItem(gate, itemId);
    if (!item || !item.naWith || !na) return '';
    const leader = findItem(gate, item.naWith);
    if (!leader || leader.retired) return '';
    const marked = Array.isArray(na)
        ? na.includes(item.naWith)
        : Object.prototype.hasOwnProperty.call(na, item.naWith);
    return marked ? item.naWithReason : '';
}

function ownKey(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// How far one block's sheet has got. total is the lines in play, done the
// lines ticked and not flagged, missingValue the done lines with a valueLabel
// whose value is blank. A line marked N/A, by its own press or by following
// another line's N/A, is out of both halves, and a tick stored under it does
// not count. Only lines on the block count: answers stored against ids that
// are no longer on it are ignored. sheet is { items, itemValues, flags, na }.
function unitProgress(gate, unitId, sheet) {
    const s = plainObject(sheet);
    const items = plainObject(s.items);
    const values = plainObject(s.itemValues);
    const flags = plainObject(s.flags);
    const na = plainObject(s.na);
    let total = 0;
    let done = 0;
    let missingValue = 0;
    unitSections(gate, unitId).forEach(section => section.items.forEach(item => {
        if (ownKey(na, item.id) || followingNA(gate, item.id, na)) return;
        total++;
        if (!ownKey(items, item.id) || items[item.id] !== true || ownKey(flags, item.id)) return;
        done++;
        const value = ownKey(values, item.id) && values[item.id] != null ? String(values[item.id]) : '';
        if (item.valueLabel && !value.trim()) missingValue++;
    }));
    return { total, done, missingValue };
}

// Whether a block can be signed off, and which of its flags count. The window's
// Mark passed button and the server's pass check both call this, so they can
// never disagree. total, done and missingValue are unitProgress's. flags holds
// the flags (itemId -> note) on lines in play; hiddenFlags the flags on lines
// marked N/A, by their own press or by following another line. A hidden flag
// stays stored and shows again when the N/A comes off, but it does not hold up
// a pass or go out with a send-back. A flag on an id no longer on the block
// counts for nothing. A block whose every line is N/A can pass; a block with
// no lines at all (a gate or unit that does not exist) never can.
// sheet is { items, itemValues, flags, na } with na the stored marks object.
function unitVerdict(gate, unitId, sheet) {
    const s = plainObject(sheet);
    const flags = plainObject(s.flags);
    const na = plainObject(s.na);
    const progress = unitProgress(gate, unitId, s);
    const counted = {};
    const hidden = {};
    let lines = 0;
    unitSections(gate, unitId).forEach(section => section.items.forEach(item => {
        lines++;
        if (!ownKey(flags, item.id)) return;
        const note = flags[item.id] == null ? '' : String(flags[item.id]);
        if (ownKey(na, item.id) || followingNA(gate, item.id, na)) hidden[item.id] = note;
        else counted[item.id] = note;
    }));
    return {
        total: progress.total,
        done: progress.done,
        missingValue: progress.missingValue,
        flags: counted,
        hiddenFlags: hidden,
        canPass: lines > 0 && progress.done === progress.total && progress.missingValue === 0 && Object.keys(counted).length === 0
    };
}

// Whether a sheet holds any answer: a tick, a value, a flag or an N/A mark.
// The sheet is read the way the server stores it (only a tick that is exactly
// true, only a value that is not blank, never a tick on a flagged line), so a
// sheet on screen and the same sheet saved always agree. Mirrors hasActivity
// in writeReviewUnit (server.js).
function hasActivity(sheet) {
    const s = plainObject(sheet);
    const items = plainObject(s.items);
    const values = plainObject(s.itemValues);
    const flags = plainObject(s.flags);
    const ticked = Object.keys(items).some(id => items[id] === true && !ownKey(flags, id));
    const valued = Object.keys(values).some(id => values[id] != null && String(values[id]).trim() !== '');
    return ticked || valued || Object.keys(flags).length > 0 || Object.keys(plainObject(s.na)).length > 0;
}

// A fingerprint of one gate's list as a sheet shows it, stored with every
// sheet so a signed sheet says which wording it was signed against. Any change
// to that gate's list changes it; nobody bumps it by hand. FNV-1a over UTF-16
// code units (no Web Crypto, which plain HTTP does not have). The 'v' keeps a
// spreadsheet from reading it as a number.
function keyValuePairs(line, keys) {
    return keys
        .filter(key => Object.prototype.hasOwnProperty.call(line, key))
        .map(key => [key, line[key]]);
}

function fnv1a32(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

const versions = {};
gates.forEach(g => {
    versions[g.gate] = 'v' + fnv1a32(JSON.stringify([
        g.perPiece,
        forms[g.gate].map(section => [
            keyValuePairs(section, SECTION_KEYS),
            section.items.map(item => keyValuePairs(item, ITEM_KEYS))
        ])
    ]));
});

function formVersion(gate) {
    return gateInfo(gate) ? versions[gate] : '';
}

// Frozen, because every server request shares this one object: a stray write
// must not change the lists for everyone. unitSections() returns new arrays and
// section objects, but the items in them, and what findItem() returns, are the
// shared frozen lines: copy one before adding anything to it.
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.keys(value).forEach(key => deepFreeze(value[key]));
    }
    return value;
}

const api = deepFreeze({
    gates, forms, source, SECTION_KEYS, ITEM_KEYS,
    unitSections, findItem, followingNA, unitProgress, unitVerdict, hasActivity, formVersion
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else window.REVIEW_ITEMS = api;

})();
