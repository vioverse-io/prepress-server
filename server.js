require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { getPool, query, healthCheck, sql } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));

// ── Health Check ──
// Deliberately OPEN, registered before the login gate below, so IT can verify
// SQL connectivity even when a login problem is blocking the app itself.

app.get('/api/health', async (req, res) => {
    const status = await healthCheck();
    res.status(status.connected ? 200 : 503).json(status);
});

// ── Login gate (NTLM / Windows authentication) ──
//
// When NTLM_AUTH=true, everything past this point requires a real Windows
// login. The browser negotiates NTLM and the credentials are validated against
// the domain controller named in NTLM_DOMAINCONTROLLER, so a wrong password --
// or a cancelled login dialog -- is rejected (401/403) instead of being waved
// through. This is the actual front door, not a name label.
//
// A login that is not validated is worse than no login: it looks secure and
// isn't. So if NTLM_AUTH=true without a domain controller, the app refuses to
// serve anything and says exactly why. It does NOT quietly accept everyone.
//
// When NTLM_AUTH is false or unset (local dev, no domain controller), there is
// no gate and the user types a profile name by hand. See dev/README.md.

let gate = null;

if (process.env.NTLM_AUTH === 'true') {
    const dcRaw = (process.env.NTLM_DOMAINCONTROLLER || '').trim();

    if (!dcRaw) {
        const msg = 'NTLM_AUTH=true but NTLM_DOMAINCONTROLLER is not set. ' +
            'The app will not start a Windows login it cannot validate. ' +
            'Add NTLM_DOMAINCONTROLLER=ldap://<your-domain-controller> to .env ' +
            '(ask IT for the domain controller host), then restart.';
        console.error('\n*** LOGIN CONFIG ERROR ***\n' + msg + '\n');
        // Fail closed: every request gets a plain-language explanation. No app,
        // no data, until a real domain controller is configured.
        gate = (req, res) => res.status(503).type('text/plain').send('Server misconfigured. ' + msg);
    } else {
        const ntlm = require('express-ntlm');
        // Comma-separated list allowed for failover between controllers.
        const domaincontroller = dcRaw.indexOf(',') !== -1
            ? dcRaw.split(',').map(function(s) { return s.trim(); }).filter(Boolean)
            : dcRaw;
        gate = ntlm({
            debug: function() {},
            domain: process.env.NTLM_DOMAIN || undefined,
            domaincontroller: domaincontroller
        });
        console.log('NTLM auth enabled -- Windows credentials validated against ' + dcRaw);
    }

    app.use(gate);
}

// ── User Identity ──
// With the gate above, req.ntlm is present and validated on every request that
// reaches here. Without the gate (dev), it is absent and the frontend falls
// back to a typed profile name.

app.get('/api/whoami', (req, res) => {
    if (req.ntlm && req.ntlm.UserName) {
        return res.json({
            username: req.ntlm.UserName,
            domain: req.ntlm.DomainName,
            authenticated: true
        });
    }
    res.json({ username: null, authenticated: false });
});

// Static app -- served after the gate, so a valid login is required to load it.
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
        const result = await pool.request().query(
            'SELECT id, kind, name, active FROM roster ORDER BY kind, name'
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

// Add a name. Admin password is verified here, not trusted from the client.
app.post('/api/roster/add', async (req, res) => {
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
            .query('SELECT id, active FROM roster WHERE kind = @kind AND name = @name');
        if (existing.recordset.length > 0) {
            const row = existing.recordset[0];
            if (!row.active) {
                await pool.request().input('id', row.id)
                    .query('UPDATE roster SET active = 1 WHERE id = @id');
                return res.json({ reactivated: true, id: row.id });
            }
            return res.status(409).json({ error: 'That name is already on the list' });
        }
        const ins = await pool.request()
            .input('kind', kind).input('name', clean)
            .input('addedBy', (addedBy || '').trim())
            .input('addedDate', new Date().toISOString())
            .query(`INSERT INTO roster (kind, name, active, addedBy, addedDate)
                    OUTPUT INSERTED.id VALUES (@kind, @name, 1, @addedBy, @addedDate)`);
        res.json({ added: true, id: ins.recordset[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
// rowVersion is not bumped, matching sql/fix-user-names.sql: these are old
// imported jobs nobody is actively editing, and not bumping avoids handing any
// open browser a false conflict.
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
            .query(`UPDATE jobs SET ${col} = @to
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
                `SELECT * FROM components WHERE jobId IN (SELECT id FROM jobs WHERE archivedDate IS NULL OR archivedDate = '') ORDER BY sortOrder`
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
        const result = await query`SELECT * FROM jobs WHERE id = ${req.params.id}`;
        if (result.recordset.length === 0) return res.status(404).json({ error: 'Job not found' });
        const job = result.recordset[0];
        const comps = await query`SELECT * FROM components WHERE jobId = ${job.id} ORDER BY sortOrder`;
        job.components = comps.recordset.map(formatComponent);
        job.deletionLog = safeParseJSON(job.deletionLog, []);
        res.json(job);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Jobs: Create ──

app.post('/api/jobs', async (req, res) => {
    try {
        const j = req.body;
        const pool = await getPool();
        const jobReq = pool.request();
        jobReq.input('id', j.id);
        jobReq.input('jobNumber', j.jobNumber);
        jobReq.input('jobDescription', j.jobDescription || '');
        jobReq.input('clientName', j.clientName);
        jobReq.input('csrName', j.csrName || '');
        jobReq.input('assignedToPrepress', j.assignedToPrepress || '');
        jobReq.input('signoffDueDatePrepress', j.signoffDueDatePrepress || '');
        jobReq.input('signoffDueTimePrepress', j.signoffDueTimePrepress || '');
        jobReq.input('assignedToTechservices', j.assignedToTechservices || '');
        jobReq.input('signoffDueDateTechservices', j.signoffDueDateTechservices || '');
        jobReq.input('signoffDueTimeTechservices', j.signoffDueTimeTechservices || '');
        jobReq.input('version', j.version || '');
        jobReq.input('dateCreated', j.dateCreated);
        jobReq.input('createdBy', j.createdBy || '');
        jobReq.input('lastModified', j.lastModified);
        jobReq.input('lastModifiedBy', j.lastModifiedBy || '');
        jobReq.input('activeComponentId', j.activeComponentId || '');
        jobReq.input('activeDepartment', j.activeDepartment || 'prepress');
        jobReq.input('status', j.status || 'new');
        jobReq.input('duplicatedFrom', j.duplicatedFrom || '');
        jobReq.input('deletionLog', JSON.stringify(j.deletionLog || []));
        await jobReq.query(`
            INSERT INTO jobs (id, jobNumber, jobDescription, clientName, csrName,
                assignedToPrepress, signoffDueDatePrepress, signoffDueTimePrepress,
                assignedToTechservices, signoffDueDateTechservices, signoffDueTimeTechservices,
                version, dateCreated, createdBy, lastModified, lastModifiedBy,
                activeComponentId, activeDepartment, status, duplicatedFrom, deletionLog, rowVersion)
            VALUES (@id, @jobNumber, @jobDescription, @clientName, @csrName,
                @assignedToPrepress, @signoffDueDatePrepress, @signoffDueTimePrepress,
                @assignedToTechservices, @signoffDueDateTechservices, @signoffDueTimeTechservices,
                @version, @dateCreated, @createdBy, @lastModified, @lastModifiedBy,
                @activeComponentId, @activeDepartment, @status, @duplicatedFrom, @deletionLog, 1)
        `);

        // Insert components
        if (j.components && j.components.length > 0) {
            for (let i = 0; i < j.components.length; i++) {
                const c = j.components[i];
                await insertComponent(pool, j.id, c, i);
            }
        }

        trackUser(j.createdBy, 'created job');
        res.status(201).json({ id: j.id, rowVersion: 1 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Jobs: Update (optimistic locking) ──

app.put('/api/jobs/:id', async (req, res) => {
    try {
        const j = req.body;
        const expectedVersion = j.rowVersion;
        if (expectedVersion == null) {
            return res.status(400).json({ error: 'rowVersion is required' });
        }

        const pool = await getPool();
        const upd = pool.request();
        upd.input('id', req.params.id);
        upd.input('expectedVersion', expectedVersion);
        upd.input('jobDescription', j.jobDescription || '');
        upd.input('clientName', j.clientName || '');
        upd.input('csrName', j.csrName || '');
        upd.input('assignedToPrepress', j.assignedToPrepress || '');
        upd.input('signoffDueDatePrepress', j.signoffDueDatePrepress || '');
        upd.input('signoffDueTimePrepress', j.signoffDueTimePrepress || '');
        upd.input('assignedToTechservices', j.assignedToTechservices || '');
        upd.input('signoffDueDateTechservices', j.signoffDueDateTechservices || '');
        upd.input('signoffDueTimeTechservices', j.signoffDueTimeTechservices || '');
        upd.input('version', j.version || '');
        upd.input('lastModified', j.lastModified || new Date().toISOString());
        upd.input('lastModifiedBy', j.lastModifiedBy || '');
        upd.input('lastAccessed', j.lastAccessed || '');
        upd.input('headerModified', j.headerModified || '');
        upd.input('headerModifiedBy', j.headerModifiedBy || '');
        upd.input('activeComponentId', j.activeComponentId || '');
        upd.input('activeDepartment', j.activeDepartment || 'prepress');
        upd.input('status', j.status || 'new');
        upd.input('duplicatedFrom', j.duplicatedFrom || '');
        upd.input('deletionLog', JSON.stringify(j.deletionLog || []));

        const result = await upd.query(`
            UPDATE jobs SET
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
                lastModified = @lastModified,
                lastModifiedBy = @lastModifiedBy,
                lastAccessed = @lastAccessed,
                headerModified = @headerModified,
                headerModifiedBy = @headerModifiedBy,
                activeComponentId = @activeComponentId,
                activeDepartment = @activeDepartment,
                status = @status,
                duplicatedFrom = @duplicatedFrom,
                deletionLog = @deletionLog,
                rowVersion = rowVersion + 1
            WHERE id = @id AND rowVersion = @expectedVersion
        `);

        if (result.rowsAffected[0] === 0) {
            return res.status(409).json({
                error: 'This job was updated by someone else. Reload to see their changes.'
            });
        }

        // Return the new rowVersion
        const updated = await query`SELECT rowVersion FROM jobs WHERE id = ${req.params.id}`;
        trackUser(j.lastModifiedBy, 'saved job');
        res.json({ rowVersion: updated.recordset[0].rowVersion });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Jobs: Delete ──

app.delete('/api/jobs/:id', async (req, res) => {
    try {
        await query`DELETE FROM jobs WHERE id = ${req.params.id}`;
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Jobs: Archive ──

app.post('/api/jobs/:id/archive', async (req, res) => {
    try {
        const now = new Date().toISOString();
        const pool = await getPool();
        const upd = pool.request();
        upd.input('id', req.params.id);
        upd.input('archivedDate', now);
        const result = await upd.query('UPDATE jobs SET archivedDate = @archivedDate WHERE id = @id');
        if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Job not found' });
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
                `SELECT * FROM components WHERE jobId IN (SELECT id FROM jobs WHERE archivedDate IS NOT NULL AND archivedDate != '') ORDER BY sortOrder`
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
        const c = req.body;
        const pool = await getPool();

        // Bump parent job rowVersion
        const jobUpd = pool.request();
        jobUpd.input('jobId', req.params.id);
        jobUpd.input('expectedVersion', c.rowVersion || 0);
        jobUpd.input('lastModified', new Date().toISOString());
        jobUpd.input('lastModifiedBy', c.lastModifiedBy || '');
        const updResult = await jobUpd.query(`
            UPDATE jobs SET rowVersion = rowVersion + 1, lastModified = @lastModified, lastModifiedBy = @lastModifiedBy
            WHERE id = @jobId AND rowVersion = @expectedVersion
        `);
        if (updResult.rowsAffected[0] === 0) {
            return res.status(409).json({
                error: 'This job was updated by someone else. Reload to see their changes.'
            });
        }

        // Get sort order
        const countResult = await query`SELECT COUNT(*) AS cnt FROM components WHERE jobId = ${req.params.id}`;
        const sortOrder = countResult.recordset[0].cnt;

        await insertComponent(pool, req.params.id, c, sortOrder);

        const newVersion = await query`SELECT rowVersion FROM jobs WHERE id = ${req.params.id}`;
        res.status(201).json({ id: c.id, rowVersion: newVersion.recordset[0].rowVersion });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Components: Update ──

app.put('/api/components/:id', async (req, res) => {
    try {
        const c = req.body;
        const pool = await getPool();

        // Look up parent job
        const parent = await query`SELECT jobId FROM components WHERE id = ${req.params.id}`;
        if (parent.recordset.length === 0) return res.status(404).json({ error: 'Component not found' });
        const jobId = parent.recordset[0].jobId;

        // Optimistic lock on parent job
        if (c.rowVersion != null) {
            const jobUpd = pool.request();
            jobUpd.input('jobId', jobId);
            jobUpd.input('expectedVersion', c.rowVersion);
            jobUpd.input('lastModified', c.lastModified || new Date().toISOString());
            jobUpd.input('lastModifiedBy', c.lastModifiedBy || '');
            const updResult = await jobUpd.query(`
                UPDATE jobs SET rowVersion = rowVersion + 1, lastModified = @lastModified, lastModifiedBy = @lastModifiedBy
                WHERE id = @jobId AND rowVersion = @expectedVersion
            `);
            if (updResult.rowsAffected[0] === 0) {
                return res.status(409).json({
                    error: 'This job was updated by someone else. Reload to see their changes.'
                });
            }
        }

        // Update component
        const upd = pool.request();
        upd.input('id', req.params.id);
        upd.input('name', c.name || '');
        upd.input('instructions_prepress', c.instructions_prepress || '');
        upd.input('instructions_techservices', c.instructions_techservices || '');
        upd.input('instructionsHistory_prepress', c.instructionsHistory_prepress || '');
        upd.input('instructionsHistory_techservices', c.instructionsHistory_techservices || '');
        upd.input('checkboxes', JSON.stringify(c.checkboxes || {}));
        upd.input('notes', JSON.stringify(c.notes || {}));
        upd.input('version', c.version || '');
        upd.input('sortOrder', c.sortOrder != null ? c.sortOrder : 0);
        await upd.query(`
            UPDATE components SET
                name = @name,
                instructions_prepress = @instructions_prepress,
                instructions_techservices = @instructions_techservices,
                instructionsHistory_prepress = @instructionsHistory_prepress,
                instructionsHistory_techservices = @instructionsHistory_techservices,
                checkboxes = @checkboxes,
                notes = @notes,
                version = @version,
                sortOrder = @sortOrder
            WHERE id = @id
        `);

        const newVersion = await query`SELECT rowVersion FROM jobs WHERE id = ${jobId}`;
        res.json({ rowVersion: newVersion.recordset[0].rowVersion });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Components: Delete ──

app.delete('/api/components/:id', async (req, res) => {
    try {
        const parent = await query`SELECT jobId FROM components WHERE id = ${req.params.id}`;
        if (parent.recordset.length === 0) return res.status(404).json({ error: 'Component not found' });

        await query`DELETE FROM components WHERE id = ${req.params.id}`;

        // Bump parent job version
        const jobId = parent.recordset[0].jobId;
        await query`UPDATE jobs SET rowVersion = rowVersion + 1 WHERE id = ${jobId}`;

        const newVersion = await query`SELECT rowVersion FROM jobs WHERE id = ${jobId}`;
        res.json({ deleted: true, rowVersion: newVersion.recordset[0].rowVersion });
    } catch (err) {
        res.status(500).json({ error: err.message });
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

// ── Job Locking (lightweight) ──

const locks = new Map(); // jobId -> { user, heartbeat }
const LOCK_TIMEOUT_MS = 60000; // 60s without heartbeat = expired

app.post('/api/jobs/:id/lock', (req, res) => {
    const jobId = req.params.id;
    const user = req.body.user || 'Anonymous';
    const existing = locks.get(jobId);

    if (existing && existing.user !== user && (Date.now() - existing.heartbeat) < LOCK_TIMEOUT_MS) {
        return res.json({ locked: true, lockedBy: existing.user });
    }

    locks.set(jobId, { user, heartbeat: Date.now() });
    trackUser(user, 'editing');
    res.json({ locked: false, lockedBy: user });
});

app.put('/api/jobs/:id/lock', (req, res) => {
    const jobId = req.params.id;
    const user = req.body.user || 'Anonymous';
    const existing = locks.get(jobId);
    if (existing && existing.user === user) {
        existing.heartbeat = Date.now();
    }
    trackUser(user, 'editing');
    res.json({ ok: true });
});

app.delete('/api/jobs/:id/lock', (req, res) => {
    const jobId = req.params.id;
    const user = req.body.user || 'Anonymous';
    const existing = locks.get(jobId);
    if (existing && existing.user === user) {
        locks.delete(jobId);
    }
    res.json({ ok: true });
});

// ── Helpers ──

async function insertComponent(pool, jobId, c, sortOrder) {
    const req = pool.request();
    req.input('id', c.id);
    req.input('jobId', jobId);
    req.input('name', c.name || 'Main');
    req.input('instructions_prepress', c.instructions_prepress || '');
    req.input('instructions_techservices', c.instructions_techservices || '');
    req.input('instructionsHistory_prepress', c.instructionsHistory_prepress || '');
    req.input('instructionsHistory_techservices', c.instructionsHistory_techservices || '');
    req.input('checkboxes', JSON.stringify(c.checkboxes || {}));
    req.input('notes', JSON.stringify(c.notes || {}));
    req.input('version', c.version || '');
    req.input('sortOrder', sortOrder);
    await req.query(`
        INSERT INTO components (id, jobId, name, instructions_prepress, instructions_techservices,
            instructionsHistory_prepress, instructionsHistory_techservices, checkboxes, notes, version, sortOrder)
        VALUES (@id, @jobId, @name, @instructions_prepress, @instructions_techservices,
            @instructionsHistory_prepress, @instructionsHistory_techservices, @checkboxes, @notes, @version, @sortOrder)
    `);
}

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
    console.log(`Prepress WO server running on port ${PORT}`);
    console.log(`http://localhost:${PORT} (also available on LAN via this machine's IP)`);
});
