const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static frontend files from public/
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──

// GET /api/jobs -- all active (non-archived) jobs
app.get('/api/jobs', (req, res) => {
    try {
        const jobs = db.getAllActiveJobs();
        res.json(jobs);
    } catch (err) {
        console.error('GET /api/jobs error:', err.message);
        res.status(500).json({ error: 'Failed to load jobs' });
    }
});

// GET /api/jobs/:id -- single job with components
app.get('/api/jobs/:id', (req, res) => {
    try {
        const job = db.getJobById(req.params.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        res.json(job);
    } catch (err) {
        console.error('GET /api/jobs/:id error:', err.message);
        res.status(500).json({ error: 'Failed to load job' });
    }
});

// POST /api/jobs -- create a new job
app.post('/api/jobs', (req, res) => {
    try {
        const job = db.createJob(req.body);
        res.status(201).json(job);
    } catch (err) {
        console.error('POST /api/jobs error:', err.message);
        res.status(500).json({ error: 'Failed to create job' });
    }
});

// PUT /api/jobs/:id -- update a job and its components
app.put('/api/jobs/:id', (req, res) => {
    try {
        const job = db.updateJob(req.params.id, req.body);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        res.json(job);
    } catch (err) {
        console.error('PUT /api/jobs/:id error:', err.message);
        res.status(500).json({ error: 'Failed to update job' });
    }
});

// DELETE /api/jobs/batch -- delete multiple jobs by ID
// (Must be before /api/jobs/:id to avoid route conflict)
app.delete('/api/jobs/batch', (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids)) {
            return res.status(400).json({ error: 'ids array required' });
        }
        const result = db.deleteJobsBatch(ids);
        res.json(result);
    } catch (err) {
        console.error('DELETE /api/jobs/batch error:', err.message);
        res.status(500).json({ error: 'Failed to delete jobs' });
    }
});

// DELETE /api/jobs/:id -- permanently delete a single job
app.delete('/api/jobs/:id', (req, res) => {
    try {
        const result = db.deleteJobById(req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Job not found' });
        res.json({ deleted: true });
    } catch (err) {
        console.error('DELETE /api/jobs/:id error:', err.message);
        res.status(500).json({ error: 'Failed to delete job' });
    }
});

// POST /api/jobs/:id/archive -- move a job to archive
app.post('/api/jobs/:id/archive', (req, res) => {
    try {
        const job = db.archiveJobById(req.params.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        res.json(job);
    } catch (err) {
        console.error('POST /api/jobs/:id/archive error:', err.message);
        res.status(500).json({ error: 'Failed to archive job' });
    }
});

// GET /api/archive -- all archived jobs
app.get('/api/archive', (req, res) => {
    try {
        const jobs = db.getAllArchivedJobs();
        res.json(jobs);
    } catch (err) {
        console.error('GET /api/archive error:', err.message);
        res.status(500).json({ error: 'Failed to load archive' });
    }
});

// POST /api/import -- import jobs from JSON export
app.post('/api/import', (req, res) => {
    try {
        const { prepressJobs, prepressJobsArchive } = req.body;
        const imported = { active: 0, archived: 0 };

        if (prepressJobs && Array.isArray(prepressJobs)) {
            for (const job of prepressJobs) {
                const existing = db.getJobById(job.id);
                if (!existing) {
                    db.createJob(job);
                    imported.active++;
                }
            }
        }

        if (prepressJobsArchive && Array.isArray(prepressJobsArchive)) {
            for (const job of prepressJobsArchive) {
                const existing = db.getJobById(job.id);
                if (!existing) {
                    db.createJob(job);
                    imported.archived++;
                }
            }
        }

        res.json(imported);
    } catch (err) {
        console.error('POST /api/import error:', err.message);
        res.status(500).json({ error: 'Failed to import jobs' });
    }
});

// Fallback: serve index.html for any non-API route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n  Prepress Job Instructions server running`);
    console.log(`  Open in browser: http://localhost:${PORT}\n`);
});
