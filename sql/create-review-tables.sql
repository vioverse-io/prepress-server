-- QC Review: three tables and the columns they add to roster and review_gates.
--
-- Run once in SSMS against STS_WorkOrder, with the STS WorkOrder App service
-- stopped and a fresh backup taken. Safe to run again: every step checks first
-- and skips what already exists. It only creates tables and adds columns that
-- start empty (the email switch starts on). Nothing that exists today changes,
-- and the jobs and components tables are never touched.
--
-- The app never creates these itself. When it starts it checks that they exist
-- and that its login can read and write them (and read roster). Until then the QC Review routes
-- answer "unavailable" and the rest of the app works exactly as before.
-- /api/health shows "reviews": true once this has been run and the service
-- restarted.
--
-- None of these tables has a foreign key to jobs, on purpose. Deleting a job,
-- or re-importing one (which deletes and recreates it), must not wipe its QC
-- record.
--
-- Local development: dev/init-db.sh runs this file after create-tables.sql.

USE STS_WorkOrder;
GO

-- Give up after 5 seconds rather than queue behind someone else's lock.
SET LOCK_TIMEOUT 5000;
GO

-- Stop here if this is the wrong database, or if this window already has a
-- transaction open: changes made inside it would hold a lock on roster, which
-- the app reads, and would look finished in this window while nothing was
-- committed. SET NOEXEC ON skips every later batch until the SET NOEXEC OFF at
-- the bottom.
SET IMPLICIT_TRANSACTIONS OFF;
IF @@TRANCOUNT > 0
BEGIN
    RAISERROR('This window has an open transaction. COMMIT or ROLLBACK it, then run this again. Nothing was changed.', 16, 1);
    SET NOEXEC ON;
END
ELSE IF OBJECT_ID(N'dbo.jobs', N'U') IS NULL
BEGIN
    RAISERROR('dbo.jobs was not found. Wrong database? Nothing was changed.', 16, 1);
    SET NOEXEC ON;
END
GO

-- ── reviews: one row per job, gate and unit ──
-- unitId is a component id, or the literal 'job' (Whole Job on Prepress, the
-- single checklist on CSR and Tech Services). The JSON columns hold the sheet.

IF OBJECT_ID(N'dbo.reviews', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.reviews (
        id                  INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_reviews PRIMARY KEY,
        jobId               NVARCHAR(36)  NOT NULL,
        gate                NVARCHAR(20)  NOT NULL,
        unitId              NVARCHAR(36)  NOT NULL,
        items               NVARCHAR(MAX) NOT NULL CONSTRAINT DF_reviews_items               DEFAULT N'{}',
        itemValues          NVARCHAR(MAX) NOT NULL CONSTRAINT DF_reviews_itemValues          DEFAULT N'{}',
        flags               NVARCHAR(MAX) NOT NULL CONSTRAINT DF_reviews_flags               DEFAULT N'{}',
        na                  NVARCHAR(MAX) NOT NULL CONSTRAINT DF_reviews_na                  DEFAULT N'{}',
        unitFacts           NVARCHAR(MAX) NOT NULL CONSTRAINT DF_reviews_unitFacts           DEFAULT N'{}',
        formVersion         NVARCHAR(20)  NOT NULL CONSTRAINT DF_reviews_formVersion         DEFAULT N'',
        disposition         NVARCHAR(20)  NOT NULL CONSTRAINT DF_reviews_disposition         DEFAULT N'',
        hasActivity         BIT           NOT NULL CONSTRAINT DF_reviews_hasActivity         DEFAULT 0,
        holder              NVARCHAR(20)  NOT NULL CONSTRAINT DF_reviews_holder              DEFAULT N'',
        returnCount         INT           NOT NULL CONSTRAINT DF_reviews_returnCount         DEFAULT 0,
        reviewerName        NVARCHAR(100) NOT NULL CONSTRAINT DF_reviews_reviewerName        DEFAULT N'',
        reviewerLogin       NVARCHAR(100) NOT NULL CONSTRAINT DF_reviews_reviewerLogin       DEFAULT N'',
        reviewerSource      NVARCHAR(10)  NOT NULL CONSTRAINT DF_reviews_reviewerSource      DEFAULT N'',
        reviewerRole        NVARCHAR(20)  NOT NULL CONSTRAINT DF_reviews_reviewerRole        DEFAULT N'',
        operatorName        NVARCHAR(100) NOT NULL CONSTRAINT DF_reviews_operatorName        DEFAULT N'',
        operatorLogin       NVARCHAR(100) NOT NULL CONSTRAINT DF_reviews_operatorLogin       DEFAULT N'',
        returnedByName      NVARCHAR(100) NOT NULL CONSTRAINT DF_reviews_returnedByName      DEFAULT N'',
        returnedByLogin     NVARCHAR(100) NOT NULL CONSTRAINT DF_reviews_returnedByLogin     DEFAULT N'',
        returnedDate        NVARCHAR(30)  NOT NULL CONSTRAINT DF_reviews_returnedDate        DEFAULT N'',
        completedDate       NVARCHAR(30)  NOT NULL CONSTRAINT DF_reviews_completedDate       DEFAULT N'',
        rowVersion          INT           NOT NULL CONSTRAINT DF_reviews_rowVersion          DEFAULT 1,
        lastModified        NVARCHAR(30)  NOT NULL CONSTRAINT DF_reviews_lastModified        DEFAULT N'',
        lastModifiedByName  NVARCHAR(100) NOT NULL CONSTRAINT DF_reviews_lastModifiedByName  DEFAULT N'',
        lastModifiedByLogin NVARCHAR(100) NOT NULL CONSTRAINT DF_reviews_lastModifiedByLogin DEFAULT N'',
        CONSTRAINT UQ_reviews_job_gate_unit UNIQUE (jobId, gate, unitId)
    );
    IF OBJECT_ID(N'dbo.reviews', N'U') IS NOT NULL PRINT 'Created dbo.reviews'
    ELSE PRINT 'FAILED: dbo.reviews. See the error above.';
END
GO

-- ── review_gates: one row per job and gate ──
-- Sent for review and who started the review.

IF OBJECT_ID(N'dbo.review_gates', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.review_gates (
        id                   INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_review_gates PRIMARY KEY,
        jobId                NVARCHAR(36)  NOT NULL,
        gate                 NVARCHAR(20)  NOT NULL,
        sentForReviewByName  NVARCHAR(100) NOT NULL CONSTRAINT DF_review_gates_sentForReviewByName  DEFAULT N'',
        sentForReviewByLogin NVARCHAR(100) NOT NULL CONSTRAINT DF_review_gates_sentForReviewByLogin DEFAULT N'',
        sentForReviewDate    NVARCHAR(30)  NOT NULL CONSTRAINT DF_review_gates_sentForReviewDate    DEFAULT N'',
        startedByName        NVARCHAR(100) NOT NULL CONSTRAINT DF_review_gates_startedByName        DEFAULT N'',
        startedByLogin       NVARCHAR(100) NOT NULL CONSTRAINT DF_review_gates_startedByLogin       DEFAULT N'',
        startedDate          NVARCHAR(30)  NOT NULL CONSTRAINT DF_review_gates_startedDate          DEFAULT N'',
        rowVersion           INT           NOT NULL CONSTRAINT DF_review_gates_rowVersion           DEFAULT 1,
        lastModified         NVARCHAR(30)  NOT NULL CONSTRAINT DF_review_gates_lastModified         DEFAULT N'',
        lastModifiedByName   NVARCHAR(100) NOT NULL CONSTRAINT DF_review_gates_lastModifiedByName   DEFAULT N'',
        lastModifiedByLogin  NVARCHAR(100) NOT NULL CONSTRAINT DF_review_gates_lastModifiedByLogin  DEFAULT N'',
        CONSTRAINT UQ_review_gates_job_gate UNIQUE (jobId, gate)
    );
    IF OBJECT_ID(N'dbo.review_gates', N'U') IS NOT NULL PRINT 'Created dbo.review_gates'
    ELSE PRINT 'FAILED: dbo.review_gates. See the error above.';
END
GO

-- ── review_log: the permanent history. Rows are added, never changed. ──
-- jobNumber is copied in so the record still reads after a job is deleted.

IF OBJECT_ID(N'dbo.review_log', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.review_log (
        id               INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_review_log PRIMARY KEY,
        jobId            NVARCHAR(36)  NOT NULL,
        jobNumber        NVARCHAR(50)  NOT NULL CONSTRAINT DF_review_log_jobNumber        DEFAULT N'',
        gate             NVARCHAR(20)  NOT NULL CONSTRAINT DF_review_log_gate             DEFAULT N'',
        unitId           NVARCHAR(36)  NOT NULL CONSTRAINT DF_review_log_unitId           DEFAULT N'',
        unitName         NVARCHAR(200) NOT NULL CONSTRAINT DF_review_log_unitName         DEFAULT N'',
        itemId           NVARCHAR(20)  NOT NULL CONSTRAINT DF_review_log_itemId           DEFAULT N'',
        itemLabel        NVARCHAR(400) NOT NULL CONSTRAINT DF_review_log_itemLabel        DEFAULT N'',
        reviewRound      INT           NOT NULL CONSTRAINT DF_review_log_reviewRound      DEFAULT 0,
        logAction        NVARCHAR(40)  NOT NULL,
        detail           NVARCHAR(MAX) NOT NULL CONSTRAINT DF_review_log_detail           DEFAULT N'',
        actorName        NVARCHAR(100) NOT NULL CONSTRAINT DF_review_log_actorName        DEFAULT N'',
        actorLogin       NVARCHAR(100) NOT NULL CONSTRAINT DF_review_log_actorLogin       DEFAULT N'',
        actorSource      NVARCHAR(10)  NOT NULL CONSTRAINT DF_review_log_actorSource      DEFAULT N'',
        recipientName    NVARCHAR(100) NOT NULL CONSTRAINT DF_review_log_recipientName    DEFAULT N'',
        recipientAddress NVARCHAR(254) NOT NULL CONSTRAINT DF_review_log_recipientAddress DEFAULT N'',
        whenIso          NVARCHAR(30)  NOT NULL
    );
    IF OBJECT_ID(N'dbo.review_log', N'U') IS NOT NULL PRINT 'Created dbo.review_log'
    ELSE PRINT 'FAILED: dbo.review_log. See the error above.';
END
GO

-- ── review_gates: signing a job back in ──
-- A job is never finished: the client, or the production department, can send it
-- back at any point, and the whole QC runs again for whatever has to be redone.
-- Only a CSR signs a job back in. roundNo counts the rounds on this checklist,
-- roundNote is what she said is being asked for, and roundProduction says this
-- round goes to production. Added after the table, so a database made by an
-- earlier copy of this file picks them up too.

IF OBJECT_ID(N'dbo.review_gates', N'U') IS NOT NULL AND COL_LENGTH(N'dbo.review_gates', N'roundNo') IS NULL
BEGIN
    ALTER TABLE dbo.review_gates ADD
        roundNo              INT           NOT NULL CONSTRAINT DF_review_gates_roundNo              DEFAULT 1,
        roundNote            NVARCHAR(MAX) NOT NULL CONSTRAINT DF_review_gates_roundNote            DEFAULT N'',
        roundProduction      BIT           NOT NULL CONSTRAINT DF_review_gates_roundProduction      DEFAULT 0,
        signedBackInByName   NVARCHAR(100) NOT NULL CONSTRAINT DF_review_gates_signedBackInByName   DEFAULT N'',
        signedBackInByLogin  NVARCHAR(100) NOT NULL CONSTRAINT DF_review_gates_signedBackInByLogin  DEFAULT N'',
        signedBackInBySource NVARCHAR(10)  NOT NULL CONSTRAINT DF_review_gates_signedBackInBySource DEFAULT N'',
        signedBackInDate     NVARCHAR(30)  NOT NULL CONSTRAINT DF_review_gates_signedBackInDate     DEFAULT N'';
    IF COL_LENGTH(N'dbo.review_gates', N'roundNo') IS NOT NULL PRINT 'Added the dbo.review_gates round columns'
    ELSE PRINT 'FAILED: dbo.review_gates round columns. See the error above.';
END
GO

-- ── review_gates: the CSR handing a new job to a department ──
-- She finishes the work order, prints the PDF into Midnight, and presses Send
-- to Prepress (or Send to Tech Services) on the work order itself. That emails
-- the department and starts that department's QC record, so the job shows on
-- the job list from that moment. Nothing else is stamped: whoever presses Send
-- for review is still the round's operator, in every round. Added after the
-- table, so a database made by an earlier copy of this file picks them up too.

IF OBJECT_ID(N'dbo.review_gates', N'U') IS NOT NULL AND COL_LENGTH(N'dbo.review_gates', N'newJobDate') IS NULL
BEGIN
    ALTER TABLE dbo.review_gates ADD
        newJobByName   NVARCHAR(100) NOT NULL CONSTRAINT DF_review_gates_newJobByName   DEFAULT N'',
        newJobByLogin  NVARCHAR(100) NOT NULL CONSTRAINT DF_review_gates_newJobByLogin  DEFAULT N'',
        newJobBySource NVARCHAR(10)  NOT NULL CONSTRAINT DF_review_gates_newJobBySource DEFAULT N'',
        newJobDate     NVARCHAR(30)  NOT NULL CONSTRAINT DF_review_gates_newJobDate     DEFAULT N'';
    IF COL_LENGTH(N'dbo.review_gates', N'newJobDate') IS NOT NULL PRINT 'Added the dbo.review_gates new job columns'
    ELSE PRINT 'FAILED: dbo.review_gates new job columns. See the error above.';
END
GO

IF OBJECT_ID(N'dbo.review_log', N'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.indexes
                   WHERE object_id = OBJECT_ID(N'dbo.review_log') AND name = N'IX_review_log_jobId')
BEGIN
    CREATE NONCLUSTERED INDEX IX_review_log_jobId ON dbo.review_log (jobId, id);
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.review_log') AND name = N'IX_review_log_jobId') PRINT 'Created index IX_review_log_jobId'
    ELSE PRINT 'FAILED: index IX_review_log_jobId. See the error above.';
END
GO

-- The landing board reads the newest Send to CSR of every active job on each
-- refresh, and whether each piece back with its operator came from the CSR
-- (the piece and the round). Without this it reads the whole history table
-- every time: at a million history rows that was a second or more a refresh
-- (the overall review's R05, 2026-10-01). A plain index, not a filtered one,
-- so no write to the table needs special settings.
IF OBJECT_ID(N'dbo.review_log', N'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.indexes
                   WHERE object_id = OBJECT_ID(N'dbo.review_log') AND name = N'IX_review_log_action')
BEGIN
    CREATE NONCLUSTERED INDEX IX_review_log_action ON dbo.review_log (logAction, jobId, gate) INCLUDE (whenIso, unitId, reviewRound);
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.review_log') AND name = N'IX_review_log_action') PRINT 'Created index IX_review_log_action'
    ELSE PRINT 'FAILED: index IX_review_log_action. See the error above.';
END
GO

-- A copy of this file from before 2026-10-01 made that index without the
-- piece and the round. Rebuilt in place once; nothing else changes.
IF OBJECT_ID(N'dbo.review_log', N'U') IS NOT NULL
   AND EXISTS (SELECT 1 FROM sys.indexes
               WHERE object_id = OBJECT_ID(N'dbo.review_log') AND name = N'IX_review_log_action')
   AND NOT EXISTS (SELECT 1 FROM sys.index_columns ic
                   JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                   JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                   WHERE i.object_id = OBJECT_ID(N'dbo.review_log') AND i.name = N'IX_review_log_action' AND c.name = N'reviewRound')
BEGIN
    CREATE NONCLUSTERED INDEX IX_review_log_action ON dbo.review_log (logAction, jobId, gate) INCLUDE (whenIso, unitId, reviewRound)
        WITH (DROP_EXISTING = ON);
    PRINT 'Rebuilt index IX_review_log_action with the piece and the round';
END
GO

-- ── roster: the user linked to each name ──
-- People pick their own name from the user list, but jobs name people by their
-- roster name. windowsLogin keeps its column name and holds that user; an
-- admin links each name once in Manage CSRs & Assignees. Email addresses are
-- built from it, so nothing is typed in twice.
--
-- If roster was never created (the app's login could not create it), create it
-- here exactly as server.js does, plus the windowsLogin column. The app fills
-- in the names on its next start. If a roster table exists outside dbo, leave
-- it alone and say so.

IF OBJECT_ID(N'dbo.roster', N'U') IS NULL
   AND EXISTS (SELECT 1 FROM sys.tables WHERE name = N'roster')
BEGIN
    PRINT 'WARNING: a roster table exists outside the dbo schema. Roster left unchanged. Tell David.';
END
ELSE IF OBJECT_ID(N'dbo.roster', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.roster (
        id           INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_roster PRIMARY KEY,
        kind         NVARCHAR(20)  NOT NULL,
        name         NVARCHAR(100) NOT NULL,
        active       BIT           NOT NULL CONSTRAINT DF_roster_active    DEFAULT 1,
        addedBy      NVARCHAR(100) NULL     CONSTRAINT DF_roster_addedBy   DEFAULT N'',
        addedDate    NVARCHAR(30)  NULL     CONSTRAINT DF_roster_addedDate DEFAULT N'',
        windowsLogin NVARCHAR(100) NULL     CONSTRAINT DF_roster_windowsLogin DEFAULT N''
    );
    IF OBJECT_ID(N'dbo.roster', N'U') IS NOT NULL PRINT 'Created dbo.roster'
    ELSE PRINT 'FAILED: dbo.roster. See the error above.';
END
GO

IF OBJECT_ID(N'dbo.roster', N'U') IS NOT NULL AND COL_LENGTH(N'dbo.roster', N'windowsLogin') IS NULL
BEGIN
    ALTER TABLE dbo.roster ADD windowsLogin NVARCHAR(100) NULL
        CONSTRAINT DF_roster_windowsLogin DEFAULT N'';
    IF COL_LENGTH(N'dbo.roster', N'windowsLogin') IS NOT NULL PRINT 'Added dbo.roster.windowsLogin'
    ELSE PRINT 'FAILED: dbo.roster.windowsLogin. See the error above.';
END
GO

-- ── roster: the Email switch for each name ──
-- An admin can switch one person's QC Review email off in Manage CSRs &
-- Assignees: they stay on the list and can still be assigned and work the
-- checklist, only the email stops. Off is what is stored (1), so every name
-- that exists today, and every name added later, starts with email on (0).
-- Added after the table, so a database made by an earlier copy of this file
-- picks it up too. QC Review works without it (everyone is emailed, and the
-- switch is not offered) until this has run.

IF OBJECT_ID(N'dbo.roster', N'U') IS NOT NULL AND COL_LENGTH(N'dbo.roster', N'emailOff') IS NULL
BEGIN
    ALTER TABLE dbo.roster ADD emailOff BIT NOT NULL
        CONSTRAINT DF_roster_emailOff DEFAULT 0;
    IF COL_LENGTH(N'dbo.roster', N'emailOff') IS NOT NULL PRINT 'Added dbo.roster.emailOff'
    ELSE PRINT 'FAILED: dbo.roster.emailOff. See the error above.';
END
GO

SET NOEXEC OFF;
GO

-- ── What is in place now ──

SELECT 'dbo.reviews' AS item,
       CASE WHEN OBJECT_ID(N'dbo.reviews', N'U') IS NULL THEN 'MISSING' ELSE 'ok' END AS result
UNION ALL SELECT 'dbo.review_gates',
       CASE WHEN OBJECT_ID(N'dbo.review_gates', N'U') IS NULL THEN 'MISSING' ELSE 'ok' END
UNION ALL SELECT 'dbo.review_gates round columns',
       CASE WHEN COL_LENGTH(N'dbo.review_gates', N'roundNo') IS NULL THEN 'MISSING' ELSE 'ok' END
UNION ALL SELECT 'dbo.review_gates new job columns',
       CASE WHEN COL_LENGTH(N'dbo.review_gates', N'newJobDate') IS NULL THEN 'MISSING' ELSE 'ok' END
UNION ALL SELECT 'dbo.review_log',
       CASE WHEN OBJECT_ID(N'dbo.review_log', N'U') IS NULL THEN 'MISSING' ELSE 'ok' END
UNION ALL SELECT 'dbo.roster.windowsLogin',
       CASE WHEN COL_LENGTH(N'dbo.roster', N'windowsLogin') IS NULL THEN 'MISSING' ELSE 'ok' END
UNION ALL SELECT 'dbo.roster.emailOff',
       CASE WHEN COL_LENGTH(N'dbo.roster', N'emailOff') IS NULL THEN 'MISSING' ELSE 'ok' END
UNION ALL SELECT 'dbo.review_log indexes',
       CASE WHEN NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.review_log') AND name = N'IX_review_log_jobId')
              OR NOT EXISTS (SELECT 1 FROM sys.index_columns ic
                             JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                             WHERE i.object_id = OBJECT_ID(N'dbo.review_log') AND i.name = N'IX_review_log_action' AND c.name = N'reviewRound')
            THEN 'MISSING' ELSE 'ok' END;
GO
