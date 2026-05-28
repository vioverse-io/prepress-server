require('dotenv').config();
const express = require('express');
const path = require('path');
const { getPool, query, healthCheck, sql } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health Check ──

app.get('/api/health', async (req, res) => {
    const status = await healthCheck();
    res.status(status.connected ? 200 : 503).json(status);
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
        jobReq.input('duplicatedFrom', j.duplicatedFrom || '');
        jobReq.input('deletionLog', JSON.stringify(j.deletionLog || []));
        await jobReq.query(`
            INSERT INTO jobs (id, jobNumber, jobDescription, clientName, csrName,
                assignedToPrepress, signoffDueDatePrepress, signoffDueTimePrepress,
                assignedToTechservices, signoffDueDateTechservices, signoffDueTimeTechservices,
                version, dateCreated, createdBy, lastModified, lastModifiedBy,
                activeComponentId, activeDepartment, duplicatedFrom, deletionLog, rowVersion)
            VALUES (@id, @jobNumber, @jobDescription, @clientName, @csrName,
                @assignedToPrepress, @signoffDueDatePrepress, @signoffDueTimePrepress,
                @assignedToTechservices, @signoffDueDateTechservices, @signoffDueTimeTechservices,
                @version, @dateCreated, @createdBy, @lastModified, @lastModifiedBy,
                @activeComponentId, @activeDepartment, @duplicatedFrom, @deletionLog, 1)
        `);

        // Insert components
        if (j.components && j.components.length > 0) {
            for (let i = 0; i < j.components.length; i++) {
                const c = j.components[i];
                await insertComponent(pool, j.id, c, i);
            }
        }

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
        const result = await query`UPDATE jobs SET archivedDate = ${now} WHERE id = ${req.params.id}`;
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
    res.json({ locked: false, lockedBy: user });
});

app.put('/api/jobs/:id/lock', (req, res) => {
    const jobId = req.params.id;
    const user = req.body.user || 'Anonymous';
    const existing = locks.get(jobId);
    if (existing && existing.user === user) {
        existing.heartbeat = Date.now();
    }
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

app.listen(PORT, () => {
    console.log(`Prepress WO server running on port ${PORT}`);
    console.log(`http://localhost:${PORT}`);
});
