/*
 * Instructions changed after the pass (CHANGED_AFTER_PASS_PLAN.md, the
 * independent review's F1, David 2026-10-08).
 *
 * Everything about comparing the words a pass froze with the words on the
 * job now that does not touch the database: how the Revisions are read, what
 * counts as the same words, which frozen copy each block is compared with,
 * and the cache the job list's read keeps. server.js reads the rows and the
 * signed sheets and hands them in, so dev/review-words-check.js can check all
 * of it with no server and no database.
 *
 * Rules this file keeps (the plan's section 2):
 *   - Words and pictures only (answer 10): the editor rewrites stored words on
 *     its own (two spaces to one, a colour and a highlight swapping places), so
 *     stored HTML is never compared, and formatting alone never counts.
 *   - Filing the box into the Revisions word for word, which the work order's
 *     X, Lock instructions, Archive and Change user do all the time, is not a
 *     change.
 *   - Whole Job stops naming a piece once that piece's own block has passed
 *     with the new words (answer 11).
 *   - When the answer cannot be known (no sheet, a sheet from before the
 *     freeze, one that cannot be read), nothing is named. Never a guess.
 */

'use strict';

const crypto = require('crypto');

const DEPTS = ['prepress', 'techservices'];

// ── The Revisions, as the work order writes them (app.js, the X's filing) ──

// The revisions blob as entries, newest first, numbered as the work order
// numbered them ("(3) Updated by ...", app.js). Text written before that
// format is kept as revision 0. server.js freezes a pass's Revisions with
// these two, so a frozen copy and today's words are read one way.
const HISTORY_SPLIT = '<div class="history-divider">';
const HISTORY_CONTENT = '<div class="history-content">';

function historyEntries(html) {
    const text = String(html || '');
    if (!text.trim()) return [];
    const out = [];
    text.split(HISTORY_SPLIT).forEach((part, i) => {
        if (i === 0) {
            if (part.trim()) out.push({ rev: 0, html: part });
            return;
        }
        const m = /<strong>\((\d+)\)/.exec(part);
        out.push({ rev: m ? Number(m[1]) : 0, html: HISTORY_SPLIT + part });
    });
    return out;
}

// A short fingerprint of one revision, so the next sheet can tell the revision
// it marked from a different one that ended up with the same number. FNV-1a,
// the same shape the checklist registry uses for its own version.
function revisionMark(text) {
    let hash = 0x811c9dc5;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

// The words a revision filed: what the X put between its content div and the
// entry's last </div>. A revision from before that format is all words.
function revisionContent(html) {
    const text = String(html || '');
    const from = text.indexOf(HISTORY_CONTENT);
    if (from < 0) return text;
    const to = text.lastIndexOf('</div>');
    return to > from ? text.slice(from + HISTORY_CONTENT.length, to) : text.slice(from + HISTORY_CONTENT.length);
}

// ── Words and pictures (the plan's 2.2) ──

// The HTML 4 named characters (the browser reads every one of them, so an
// old job that wrote &eacute; reads as the editor's own e with its accent),
// and &apos;. A name not here stays as it is written, on both sides alike.
const ENTITIES = {
    AElig:198,Aacute:193,Acirc:194,Agrave:192,Alpha:913,Aring:197,Atilde:195,Auml:196,Beta:914,
    Ccedil:199,Chi:935,Dagger:8225,Delta:916,ETH:208,Eacute:201,Ecirc:202,Egrave:200,Epsilon:917,
    Eta:919,Euml:203,Gamma:915,Iacute:205,Icirc:206,Igrave:204,Iota:921,Iuml:207,Kappa:922,Lambda:923,
    Mu:924,Ntilde:209,Nu:925,OElig:338,Oacute:211,Ocirc:212,Ograve:210,Omega:937,Omicron:927,Oslash:216,
    Otilde:213,Ouml:214,Phi:934,Pi:928,Prime:8243,Psi:936,Rho:929,Scaron:352,Sigma:931,THORN:222,
    Tau:932,Theta:920,Uacute:218,Ucirc:219,Ugrave:217,Upsilon:933,Uuml:220,Xi:926,Yacute:221,Yuml:376,
    Zeta:918,aacute:225,acirc:226,acute:180,aelig:230,agrave:224,alefsym:8501,alpha:945,amp:38,and:8743,
    ang:8736,aring:229,asymp:8776,atilde:227,auml:228,bdquo:8222,beta:946,brvbar:166,bull:8226,cap:8745,
    ccedil:231,cedil:184,cent:162,chi:967,circ:710,clubs:9827,cong:8773,copy:169,crarr:8629,cup:8746,
    curren:164,dArr:8659,dagger:8224,darr:8595,deg:176,delta:948,diams:9830,divide:247,eacute:233,
    ecirc:234,egrave:232,empty:8709,emsp:8195,ensp:8194,epsilon:949,equiv:8801,eta:951,eth:240,euml:235,
    euro:8364,exist:8707,fnof:402,forall:8704,frac12:189,frac14:188,frac34:190,frasl:8260,gamma:947,
    ge:8805,gt:62,hArr:8660,harr:8596,hearts:9829,hellip:8230,iacute:237,icirc:238,iexcl:161,igrave:236,
    image:8465,infin:8734,int:8747,iota:953,iquest:191,isin:8712,iuml:239,kappa:954,lArr:8656,
    lambda:955,lang:9001,laquo:171,larr:8592,lceil:8968,ldquo:8220,le:8804,lfloor:8970,lowast:8727,
    loz:9674,lrm:8206,lsaquo:8249,lsquo:8216,lt:60,macr:175,mdash:8212,micro:181,middot:183,minus:8722,
    mu:956,nabla:8711,nbsp:160,ndash:8211,ne:8800,ni:8715,not:172,notin:8713,nsub:8836,ntilde:241,
    nu:957,oacute:243,ocirc:244,oelig:339,ograve:242,oline:8254,omega:969,omicron:959,oplus:8853,
    or:8744,ordf:170,ordm:186,oslash:248,otilde:245,otimes:8855,ouml:246,para:182,part:8706,permil:8240,
    perp:8869,phi:966,pi:960,piv:982,plusmn:177,pound:163,prime:8242,prod:8719,prop:8733,psi:968,
    quot:34,rArr:8658,radic:8730,rang:9002,raquo:187,rarr:8594,rceil:8969,rdquo:8221,real:8476,reg:174,
    rfloor:8971,rho:961,rlm:8207,rsaquo:8250,rsquo:8217,sbquo:8218,scaron:353,sdot:8901,sect:167,
    shy:173,sigma:963,sigmaf:962,sim:8764,spades:9824,sub:8834,sube:8838,sum:8721,sup:8835,sup1:185,
    sup2:178,sup3:179,supe:8839,szlig:223,tau:964,there4:8756,theta:952,thetasym:977,thinsp:8201,
    thorn:254,tilde:732,times:215,trade:8482,uArr:8657,uacute:250,uarr:8593,ucirc:251,ugrave:249,
    uml:168,upsih:978,upsilon:965,uuml:252,weierp:8472,xi:958,yacute:253,yen:165,yuml:255,zeta:950,
    zwj:8205,zwnj:8204,
    apos:39
};

// Characters that take no room on screen: a zero-width space, a soft hyphen,
// a byte-order mark. Written as numbers so none hides in this file.
const INVISIBLE = new RegExp('[' + String.fromCharCode(0x200b, 0x00ad, 0xfeff) + ']', 'g');
const PICTURE = String.fromCharCode(1) + 'picture ';

function readEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, name) => {
        let code;
        if (name[0] === '#') code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        else code = Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : NaN;
        if (!Number.isFinite(code) || code <= 0 || code >= 0x110000) return m;
        // A line break written as a number is still only a space in HTML.
        return code === 9 || code === 10 || code === 13 ? ' ' : String.fromCodePoint(code);
    });
}

function digest(text) {
    return crypto.createHash('sha1').update(String(text)).digest('hex');
}

// Stored HTML to its words and pictures, read the way the work order's editor
// reads it (app.js: instructionsAsHtml, then Quill's clipboard with its TABLE
// matcher), so two boxes that read the same in the editor give the same
// string whatever HTML they were written in:
//   - text with no < at all is old plain text: each line break is a line;
//     in HTML a line break in the text is a space, except inside <pre>;
//   - each paragraph, list item, heading and <br> is a line, every other tag
//     goes; a < not followed by a letter or / is text, as the browser reads it;
//   - a table row is one line, its cells joined by " | ", as the matcher
//     writes it (a picture in a cell goes, as innerText drops it);
//   - in a line, every run of spaces is one space, the ends trimmed, and
//     empty lines dropped; characters that take no room are dropped;
//   - a picture is a mark in its place, a digest of its src: none for a
//     picture with no src, which the editor drops, and the editor's own //:0
//     for any src that is not http, https or data, as its sanitizer writes.
// Every pattern stops at the next < or >, so no stored text can make it slow.
const COMMENT = /<!--[\s\S]*?-->/g;
// What the editor drops with its text (a script's text it keeps, as a line).
const DROPPED = /<(style|template|head|title)\b[^<>]*>[\s\S]*?<\/\1\s*>/gi;
const PRE = /<pre\b[^<>]*>[\s\S]*?<\/pre\s*>/gi;
const TABLE = /<table\b[^<>]*>([\s\S]*?)<\/table\s*>/gi;
const ROW = /<tr\b[^<>]*>([\s\S]*?)<\/tr\s*>/gi;
const CELL = /<t[dh]\b[^<>]*>([\s\S]*?)<\/t[dh]\s*>/gi;
const IMG = /<img\b[^<>]*>/gi;
const BR = /<br\b[^<>]*>/gi;
const BLOCK_TAG = /<\/?(?:p|li|div|h[1-6]|pre|blockquote|ol|ul|table|thead|tbody|tfoot|tr|caption|section|article|header|footer|aside|nav|main|dl|dt|dd|address|figure|figcaption|hr|center|details|summary|fieldset|legend)\b[^<>]*>/gi;
const TAG = /<\/?[a-z][^<>]*>/gi;

function pictureMark(tag) {
    const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/i.exec(tag);
    if (!src) return '';
    let url = readEntities(src[1] !== undefined ? src[1] : src[2] !== undefined ? src[2] : src[3] || '').trim();
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
    if (scheme && ['http', 'https', 'data'].indexOf(scheme[1].toLowerCase()) < 0) url = '//:0';
    return '\n' + PICTURE + digest(url) + '\n';
}

// The lines of HTML outside a table. withPictures false for a table cell.
function flowLines(html, withPictures) {
    const text = html
        .replace(IMG, tag => (withPictures ? pictureMark(tag) : ''))
        .replace(BR, '\n')
        .replace(BLOCK_TAG, '\n')
        .replace(TAG, '');
    return readEntities(text)
        .replace(INVISIBLE, '')
        .split('\n')
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

// A table's lines: a row's cells joined by " | ", a row with no cell text
// dropped, as the TABLE matcher does.
function tableLines(html) {
    const out = [];
    let row;
    ROW.lastIndex = 0;
    while ((row = ROW.exec(html))) {
        const cells = [];
        let cell;
        const inRow = new RegExp(CELL.source, 'gi');
        while ((cell = inRow.exec(row[1]))) cells.push(flowLines(cell[1], false).join('\n'));
        const rowText = cells.join(' | ');
        if (rowText) out.push(...rowText.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean));
    }
    return out;
}

function words(html) {
    const raw = String(html || '');
    let text = raw.indexOf('<') < 0 ? raw.replace(/\r\n|\r|\n/g, '<br>') : raw;
    text = text.replace(COMMENT, '').replace(DROPPED, '')
        .replace(PRE, block => block.replace(/\r\n|\r|\n/g, '<br>'))
        .replace(/\r\n|\r|\n/g, ' ');
    const lines = [];
    const tables = new RegExp(TABLE.source, 'gi');
    let at = 0;
    let found;
    while ((found = tables.exec(text))) {
        lines.push(...flowLines(text.slice(at, found.index), true), ...tableLines(found[1]));
        at = tables.lastIndex;
    }
    lines.push(...flowLines(text.slice(at), true));
    return lines.join('\n');
}

const EMPTY = digest('');

// ── The two sides ──

// A signed sheet to what each piece's words were, per department: a digest of
// the box's words and the newest revision it went up to. null when the sheet
// cannot be read or froze no work order (before step 7).
function frozenFrom(detail) {
    let sheet = detail;
    if (typeof detail === 'string') {
        try { sheet = JSON.parse(detail); } catch (err) { return null; }
    }
    const pieces = sheet && sheet.workOrder && Array.isArray(sheet.workOrder.pieces) ? sheet.workOrder.pieces : null;
    if (!pieces) return null;
    const out = {};
    pieces.forEach(piece => {
        if (!piece || piece.id == null) return;
        const held = {};
        DEPTS.forEach(dept => {
            const part = piece[dept];
            if (!part || typeof part !== 'object') return;
            held[dept] = {
                box: digest(words(part.live)),
                // The X files the box with each line break as <br>, which in
                // HTML written by hand is a new line where the box had a space.
                filed: digest(words(String(part.live || '').replace(/\n/g, '<br>'))),
                through: Number.isFinite(part.throughRevision) ? part.throughRevision : 0,
                mark: typeof part.throughMark === 'string' ? part.throughMark : ''
            };
        });
        out[String(piece.id)] = held;
    });
    return out;
}

// A piece's four instruction columns to the same shape, per department, with
// each revision's number, mark and the digest of the words it filed.
function currentFrom(row) {
    const out = {};
    DEPTS.forEach(dept => {
        const boxWords = words(row ? row['instructions_' + dept] : '');
        const revs = historyEntries(row ? row['instructionsHistory_' + dept] : '').map(entry => {
            const filed = words(revisionContent(entry.html));
            return { rev: entry.rev, mark: revisionMark(entry.html), words: digest(filed), empty: !filed };
        });
        out[dept] = { box: digest(boxWords), revs, hasWords: !!boxWords || revs.some(r => !r.empty) };
    });
    return out;
}

// The plan's 2.3: have the words of one piece in one department changed since
// the frozen copy? frozen null means a piece the sheet does not hold, counted
// as frozen empty (Tech Services only; the caller decides).
function changed(frozen, current) {
    if (!current) return false;
    if (!frozen) return current.hasWords;
    const through = frozen.through;
    if (through > 0) {
        // The test the freeze itself uses for an import that rewrote the
        // history (server.js, reviewWorkOrder).
        const highest = current.revs.reduce((max, r) => (r.rev > max ? r.rev : max), 0);
        const still = current.revs.find(r => r.rev === through);
        if (highest < through || !still || (frozen.mark && still.mark !== frozen.mark)) return true;
    }
    const added = current.revs.filter(r => r.rev > through);
    if (!added.length) return current.box !== frozen.box;
    // Filed word for word, and the box emptied by the filing.
    if (added.length === 1) return !((added[0].words === frozen.box || added[0].words === frozen.filed) && current.box === EMPTY);
    return true;
}

// The plan's 2.4 for one job. blocks: the passed department blocks as
// { gate, unitId, sheetId, frozen } (frozen null when its sheet cannot be
// known); pieces: the pieces on the job now, in order, as { id, current };
// perPiece: the checklists with a block per piece. Answers a Map from
// gate|unitId to the ids of the pieces whose words changed after that pass.
function namesFor(blocks, pieces, perPiece) {
    const byKey = new Map();
    blocks.forEach(b => byKey.set(b.gate + '|' + b.unitId, b));
    const out = new Map();
    blocks.forEach(b => {
        const named = [];
        out.set(b.gate + '|' + b.unitId, named);
        if (!b.frozen || DEPTS.indexOf(b.gate) < 0) return;
        const dept = b.gate;
        const wholeJob = b.unitId === 'job';
        (wholeJob ? pieces : pieces.filter(p => p.id === b.unitId)).forEach(p => {
            const held = b.frozen[p.id] ? b.frozen[p.id][dept] : undefined;
            let copy;
            if (!wholeJob) {
                // A piece's block always froze its piece; one that did not
                // cannot be known.
                if (!held) return;
                copy = held;
            } else if (perPiece.has(dept)) {
                // Whole Job: the newer of its own copy and the piece's own
                // block's, while that block is passed now (answer 11). A piece
                // it never froze waits for its own block.
                const own = byKey.get(dept + '|' + p.id);
                const ownHeld = own && own.frozen && own.frozen[p.id] ? own.frozen[p.id][dept] : undefined;
                if (ownHeld && own.sheetId > b.sheetId) copy = ownHeld;
                else if (held) copy = held;
                else return;
            } else {
                // A checklist with one block for the job: a piece it never
                // froze counts as frozen empty.
                copy = held || null;
            }
            if (changed(copy, p.current[dept])) named.push(p.id);
        });
    });
    return out;
}

// ── The cache for the job list's read (the plan's 3.1) ──

// Signed sheets by history row id (a signed sheet never changes), and each
// job's words, reused while the job's key (its rowVersion and lastModified)
// has not moved and for at most maxAgeMs (an hour by default), give or take
// jitterMs so a restart's fill does not all come due at once. The age covers a
// write that moves no rowVersion (a piece save sent without one; no page sends
// one, and the review's F4 is to make it move). Only the job list's read
// prunes; the window's read only adds sheets.
function createCache(options) {
    const o = options || {};
    const maxAgeMs = Number.isFinite(o.maxAgeMs) && o.maxAgeMs >= 0 ? o.maxAgeMs : 60 * 60 * 1000;
    const jitterMs = Number.isFinite(o.jitterMs) && o.jitterMs >= 0 ? Math.min(o.jitterMs, maxAgeMs) : Math.min(10 * 60 * 1000, maxAgeMs);
    const sheets = new Map();
    const jobs = new Map();
    let running = null;
    return {
        sheets,
        jobs,
        hasSheet: id => sheets.has(id),
        sheet: id => sheets.get(id),
        putSheet(id, detail) {
            sheets.set(id, frozenFrom(detail));
            return sheets.get(id);
        },
        // The job's pieces with their words, or null when they must be read.
        job(jobId, key, now) {
            const entry = jobs.get(jobId);
            return entry && entry.key === key && now < entry.expires ? entry.pieces : null;
        },
        putJob(jobId, key, pieces, now) {
            const jitter = jitterMs ? Math.round((Math.random() * 2 - 1) * jitterMs) : 0;
            jobs.set(jobId, { key, pieces, expires: now + maxAgeMs + jitter });
        },
        prune(jobIds, sheetIds) {
            Array.from(jobs.keys()).forEach(id => { if (!jobIds.has(id)) jobs.delete(id); });
            Array.from(sheets.keys()).forEach(id => { if (!sheetIds.has(id)) sheets.delete(id); });
        },
        // One fill at a time: a read that comes while one is running shares
        // its answer, so job lists asking at once read nothing twice, and a
        // slow database is waited for once, not once each.
        shared(fn) {
            if (running) return running;
            const mine = Promise.resolve().then(fn);
            running = mine;
            const clear = () => { if (running === mine) running = null; };
            mine.then(clear, clear);
            return mine;
        }
    };
}

module.exports = {
    DEPTS, historyEntries, revisionMark, revisionContent, words, digest, EMPTY,
    frozenFrom, currentFrom, changed, namesFor, createCache
};
