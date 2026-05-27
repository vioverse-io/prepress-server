const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'prepress.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables on first run
db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        jobNumber TEXT NOT NULL,
        jobDescription TEXT DEFAULT '',
        clientName TEXT NOT NULL,
        csrName TEXT DEFAULT '',
        dueDate TEXT,
        dateCreated TEXT NOT NULL,
        createdBy TEXT DEFAULT '',
        lastModified TEXT NOT NULL,
        lastModifiedBy TEXT DEFAULT '',
        lastAccessed TEXT,
        headerModified TEXT,
        headerModifiedBy TEXT DEFAULT '',
        duplicatedFrom TEXT,
        version TEXT DEFAULT '',
        midnightOrderId TEXT,
        archivedDate TEXT,
        activeComponentId TEXT
    );

    CREATE TABLE IF NOT EXISTS components (
        id TEXT PRIMARY KEY,
        jobId TEXT NOT NULL,
        name TEXT NOT NULL,
        instructions TEXT DEFAULT '',
        instructionsHistory TEXT DEFAULT '',
        checkboxes TEXT DEFAULT '{}',
        notes TEXT DEFAULT '{}',
        sortOrder INTEGER DEFAULT 0,
        FOREIGN KEY (jobId) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_components_jobId ON components(jobId);
    CREATE INDEX IF NOT EXISTS idx_jobs_archivedDate ON jobs(archivedDate);
`);

// Prepared statements for performance
const stmts = {
    // Jobs
    getAllActiveJobs: db.prepare(`SELECT * FROM jobs WHERE archivedDate IS NULL ORDER BY lastAccessed DESC, lastModified DESC`),
    getAllArchivedJobs: db.prepare(`SELECT * FROM jobs WHERE archivedDate IS NOT NULL ORDER BY archivedDate DESC`),
    getJobById: db.prepare(`SELECT * FROM jobs WHERE id = ?`),
    insertJob: db.prepare(`
        INSERT INTO jobs (id, jobNumber, jobDescription, clientName, csrName, dueDate, dateCreated, createdBy, lastModified, lastModifiedBy, lastAccessed, headerModified, headerModifiedBy, duplicatedFrom, version, midnightOrderId, archivedDate, activeComponentId)
        VALUES (@id, @jobNumber, @jobDescription, @clientName, @csrName, @dueDate, @dateCreated, @createdBy, @lastModified, @lastModifiedBy, @lastAccessed, @headerModified, @headerModifiedBy, @duplicatedFrom, @version, @midnightOrderId, @archivedDate, @activeComponentId)
    `),
    updateJob: db.prepare(`
        UPDATE jobs SET
            jobNumber = @jobNumber,
            jobDescription = @jobDescription,
            clientName = @clientName,
            csrName = @csrName,
            dueDate = @dueDate,
            lastModified = @lastModified,
            lastModifiedBy = @lastModifiedBy,
            lastAccessed = @lastAccessed,
            headerModified = @headerModified,
            headerModifiedBy = @headerModifiedBy,
            duplicatedFrom = @duplicatedFrom,
            version = @version,
            activeComponentId = @activeComponentId
        WHERE id = @id
    `),
    deleteJob: db.prepare(`DELETE FROM jobs WHERE id = ?`),
    archiveJob: db.prepare(`UPDATE jobs SET archivedDate = ? WHERE id = ?`),

    // Components
    getComponentsByJobId: db.prepare(`SELECT * FROM components WHERE jobId = ? ORDER BY sortOrder`),
    getComponentById: db.prepare(`SELECT * FROM components WHERE id = ?`),
    insertComponent: db.prepare(`
        INSERT INTO components (id, jobId, name, instructions, instructionsHistory, checkboxes, notes, sortOrder)
        VALUES (@id, @jobId, @name, @instructions, @instructionsHistory, @checkboxes, @notes, @sortOrder)
    `),
    updateComponent: db.prepare(`
        UPDATE components SET
            name = @name,
            instructions = @instructions,
            instructionsHistory = @instructionsHistory,
            checkboxes = @checkboxes,
            notes = @notes,
            sortOrder = @sortOrder
        WHERE id = @id
    `),
    deleteComponent: db.prepare(`DELETE FROM components WHERE id = ?`),
    deleteComponentsByJobId: db.prepare(`DELETE FROM components WHERE jobId = ?`),
};

// Helper: attach components array to a job row
function attachComponents(job) {
    if (!job) return null;
    const comps = stmts.getComponentsByJobId.all(job.id);
    job.components = comps.map(c => ({
        ...c,
        checkboxes: JSON.parse(c.checkboxes || '{}'),
        notes: JSON.parse(c.notes || '{}')
    }));
    return job;
}

// ── Public API ──

function getAllActiveJobs() {
    const jobs = stmts.getAllActiveJobs.all();
    return jobs.map(attachComponents);
}

function getAllArchivedJobs() {
    const jobs = stmts.getAllArchivedJobs.all();
    return jobs.map(attachComponents);
}

function getJobById(id) {
    const job = stmts.getJobById.get(id);
    return attachComponents(job);
}

const createJob = db.transaction((jobData) => {
    const components = jobData.components || [];
    const jobRow = {
        id: jobData.id,
        jobNumber: jobData.jobNumber,
        jobDescription: jobData.jobDescription || '',
        clientName: jobData.clientName,
        csrName: jobData.csrName || '',
        dueDate: jobData.dueDate || null,
        dateCreated: jobData.dateCreated,
        createdBy: jobData.createdBy || '',
        lastModified: jobData.lastModified,
        lastModifiedBy: jobData.lastModifiedBy || '',
        lastAccessed: jobData.lastAccessed || null,
        headerModified: jobData.headerModified || null,
        headerModifiedBy: jobData.headerModifiedBy || '',
        duplicatedFrom: jobData.duplicatedFrom || null,
        version: jobData.version || '',
        midnightOrderId: jobData.midnightOrderId || null,
        archivedDate: jobData.archivedDate || null,
        activeComponentId: jobData.activeComponentId || (components[0] && components[0].id) || null,
    };
    stmts.insertJob.run(jobRow);

    components.forEach((comp, idx) => {
        stmts.insertComponent.run({
            id: comp.id,
            jobId: jobData.id,
            name: comp.name,
            instructions: comp.instructions || '',
            instructionsHistory: comp.instructionsHistory || '',
            checkboxes: JSON.stringify(comp.checkboxes || {}),
            notes: JSON.stringify(comp.notes || {}),
            sortOrder: idx,
        });
    });

    return getJobById(jobData.id);
});

const updateJob = db.transaction((id, jobData) => {
    const existing = stmts.getJobById.get(id);
    if (!existing) return null;

    const jobRow = {
        id: id,
        jobNumber: jobData.jobNumber !== undefined ? jobData.jobNumber : existing.jobNumber,
        jobDescription: jobData.jobDescription !== undefined ? jobData.jobDescription : existing.jobDescription,
        clientName: jobData.clientName !== undefined ? jobData.clientName : existing.clientName,
        csrName: jobData.csrName !== undefined ? jobData.csrName : existing.csrName,
        dueDate: jobData.dueDate !== undefined ? jobData.dueDate : existing.dueDate,
        lastModified: jobData.lastModified || new Date().toISOString(),
        lastModifiedBy: jobData.lastModifiedBy !== undefined ? jobData.lastModifiedBy : existing.lastModifiedBy,
        lastAccessed: jobData.lastAccessed !== undefined ? jobData.lastAccessed : existing.lastAccessed,
        headerModified: jobData.headerModified !== undefined ? jobData.headerModified : existing.headerModified,
        headerModifiedBy: jobData.headerModifiedBy !== undefined ? jobData.headerModifiedBy : existing.headerModifiedBy,
        duplicatedFrom: jobData.duplicatedFrom !== undefined ? jobData.duplicatedFrom : existing.duplicatedFrom,
        version: jobData.version !== undefined ? jobData.version : existing.version,
        activeComponentId: jobData.activeComponentId !== undefined ? jobData.activeComponentId : existing.activeComponentId,
    };
    stmts.updateJob.run(jobRow);

    // Update components if provided
    if (jobData.components) {
        // Delete existing and re-insert (simpler than diffing)
        stmts.deleteComponentsByJobId.run(id);
        jobData.components.forEach((comp, idx) => {
            stmts.insertComponent.run({
                id: comp.id,
                jobId: id,
                name: comp.name,
                instructions: comp.instructions || '',
                instructionsHistory: comp.instructionsHistory || '',
                checkboxes: JSON.stringify(comp.checkboxes || {}),
                notes: JSON.stringify(comp.notes || {}),
                sortOrder: idx,
            });
        });
    }

    return getJobById(id);
});

function deleteJobById(id) {
    // Components deleted via ON DELETE CASCADE
    return stmts.deleteJob.run(id);
}

const deleteJobsBatch = db.transaction((ids) => {
    for (const id of ids) {
        stmts.deleteJob.run(id);
    }
    return { deleted: ids.length };
});

function archiveJobById(id) {
    const job = stmts.getJobById.get(id);
    if (!job) return null;
    stmts.archiveJob.run(new Date().toISOString(), id);
    return getJobById(id);
}

module.exports = {
    db,
    getAllActiveJobs,
    getAllArchivedJobs,
    getJobById,
    createJob,
    updateJob,
    deleteJobById,
    deleteJobsBatch,
    archiveJobById,
};
