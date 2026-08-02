/* ===================================================================
   One-time cleanup: normalise person names on existing jobs.

   Why this exists
   ---------------
   Before the SQL Server cutover the app stored the user's name in the
   browser and anyone could type anything, so the same person appears as
   "Stef", "STEF", "Stephanie" and "Stef Tarpy" across old jobs. Jobs
   created since the cutover carry the real Windows login, because the
   app now reads it from NTLM and locks the field.

   Two different targets, do not mix them up
   ----------------------------------------
   createdBy / lastModifiedBy / headerModifiedBy
       must be the WINDOWS LOGIN (for example  starpy ), because the
       My Jobs tab compares createdBy against the logged-in Windows
       user. A display name here means My Jobs stays empty for that
       person forever.

   csrName / assignedToPrepress / assignedToTechservices
       must be the DISPLAY NAME exactly as it appears in the app's
       dropdown (for example  Stef Tarpy ), because the CSR and
       Assignee filters group on that string.

   createdBy cannot be fixed in the app. PUT /api/jobs/:id does not
   update it, so editing the banner will never touch it. This script is
   the only way.

   Before you run it
   -----------------
   1. Stop the STS Work Order service. csrName IS part of the app's
      normal save, so a user with a job open could overwrite the fix.
   2. Run section 1 and read the output. Do not skip this.
   3. Fill in the mapping tables in section 3.
   4. Run section 4 (preview) and read it.
   5. Only then run section 5.

   Safe to re-run. It takes a fresh backup each time and only touches
   rows that still match an old name.
   =================================================================== */

USE STS_WorkOrder;
GO


/* -------------------------------------------------------------------
   SECTION 1 -- Audit. Read this before changing anything.
   Shows every distinct name in the database and how many jobs use it.
   Archived jobs are included; they live in the same table.

   Two details that matter, both learned the hard way:

   COLLATE Latin1_General_BIN2 forces a case-sensitive, exact grouping.
   Without it SQL Server's default collation is case-insensitive and
   quietly merges "Stef" and "STEF" into one row, so you would never see
   that both spellings exist.

   Values are wrapped in [brackets] so leading and trailing spaces are
   visible. "[ stef ]" and "[stef]" look identical otherwise.
   ------------------------------------------------------------------- */

SELECT 'createdBy' AS Field,
       '[' + createdBy COLLATE Latin1_General_BIN2 + ']' AS Value, COUNT(*) AS Jobs
FROM jobs WHERE ISNULL(createdBy, '') <> ''
GROUP BY createdBy COLLATE Latin1_General_BIN2
UNION ALL
SELECT 'lastModifiedBy', '[' + lastModifiedBy COLLATE Latin1_General_BIN2 + ']', COUNT(*)
FROM jobs WHERE ISNULL(lastModifiedBy, '') <> ''
GROUP BY lastModifiedBy COLLATE Latin1_General_BIN2
UNION ALL
SELECT 'headerModifiedBy', '[' + headerModifiedBy COLLATE Latin1_General_BIN2 + ']', COUNT(*)
FROM jobs WHERE ISNULL(headerModifiedBy, '') <> ''
GROUP BY headerModifiedBy COLLATE Latin1_General_BIN2
UNION ALL
SELECT 'csrName', '[' + csrName COLLATE Latin1_General_BIN2 + ']', COUNT(*)
FROM jobs WHERE ISNULL(csrName, '') <> ''
GROUP BY csrName COLLATE Latin1_General_BIN2
UNION ALL
SELECT 'assignedToPrepress', '[' + assignedToPrepress COLLATE Latin1_General_BIN2 + ']', COUNT(*)
FROM jobs WHERE ISNULL(assignedToPrepress, '') <> ''
GROUP BY assignedToPrepress COLLATE Latin1_General_BIN2
UNION ALL
SELECT 'assignedToTechservices', '[' + assignedToTechservices COLLATE Latin1_General_BIN2 + ']', COUNT(*)
FROM jobs WHERE ISNULL(assignedToTechservices, '') <> ''
GROUP BY assignedToTechservices COLLATE Latin1_General_BIN2
ORDER BY Field, Jobs DESC;


/* -------------------------------------------------------------------
   SECTION 2 -- Find the correct Windows logins without asking anyone.

   Jobs created after the cutover already carry the real login. Set the
   date below to the day the database went live and this gives you the
   canonical spelling of every login already in use.

   If someone has not created a job since the cutover, get their login
   another way: have them open the app and look at Profile (the field is
   locked and shows their Windows user), or ask IT to run
       Get-ADUser -Filter * | Select SamAccountName, Name
   ------------------------------------------------------------------- */

DECLARE @Cutover NVARCHAR(30) = '2026-06-01';   -- <<< set this

SELECT createdBy AS LikelyWindowsLogin, COUNT(*) AS JobsSinceCutover, MIN(dateCreated) AS FirstSeen
FROM jobs
WHERE dateCreated > @Cutover AND ISNULL(createdBy, '') <> ''
GROUP BY createdBy
ORDER BY JobsSinceCutover DESC;


/* -------------------------------------------------------------------
   SECTION 3 -- The mapping. This is the only part you edit.

   Matching ignores case and surrounding spaces, so ONE row covers
   "stef", "STEF" and " Stef ". Do not add a row per casing. If you list
   both 'Stef' and 'STEF' they collapse to the same key, and section 3b
   will stop you if they disagree about the new name.
   ------------------------------------------------------------------- */

IF OBJECT_ID('tempdb..#LoginMap')    IS NOT NULL DROP TABLE #LoginMap;
IF OBJECT_ID('tempdb..#CsrMap')      IS NOT NULL DROP TABLE #CsrMap;
IF OBJECT_ID('tempdb..#AssigneeMap') IS NOT NULL DROP TABLE #AssigneeMap;

CREATE TABLE #LoginMap    (OldName NVARCHAR(100), NewName NVARCHAR(100));
CREATE TABLE #CsrMap      (OldName NVARCHAR(100), NewName NVARCHAR(100));
CREATE TABLE #AssigneeMap (OldName NVARCHAR(100), NewName NVARCHAR(100));

-- createdBy, lastModifiedBy, headerModifiedBy  ->  Windows login
INSERT INTO #LoginMap (OldName, NewName) VALUES
    ('Stef',        'starpy'),
    ('Stephanie',   'starpy'),
    ('Stef Tarpy',  'starpy'),
    ('Steph Tarpy', 'starpy');
    -- add a row per DISTINCT variant you saw in section 1, ignoring case

-- csrName  ->  display name exactly as spelled in the app's CSR dropdown
INSERT INTO #CsrMap (OldName, NewName) VALUES
    ('Stef',      'Stef Tarpy'),
    ('Stephanie', 'Stef Tarpy'),
    ('starpy',    'Stef Tarpy');

-- assignedToPrepress / assignedToTechservices  ->  roster display name
INSERT INTO #AssigneeMap (OldName, NewName) VALUES
    ('Dave',  'David Marra'),
    ('DM',    'David Marra');


/* -------------------------------------------------------------------
   SECTION 3b -- Normalise and validate the mapping. Do not edit.

   Collapses each mapping to one row per case-insensitive, trimmed key.
   Without this an entry for both 'Stef' and 'STEF' would match the same
   job twice, and UPDATE ... FROM with two matching rows picks a winner
   nondeterministically -- it does not error. This turns that silent
   coin-flip into a loud stop.
   ------------------------------------------------------------------- */

IF OBJECT_ID('tempdb..#Keys') IS NOT NULL DROP TABLE #Keys;
CREATE TABLE #Keys (MapName NVARCHAR(20), OldKey NVARCHAR(100), NewName NVARCHAR(100));

INSERT INTO #Keys SELECT DISTINCT 'login',    UPPER(LTRIM(RTRIM(OldName))), NewName FROM #LoginMap;
INSERT INTO #Keys SELECT DISTINCT 'csr',      UPPER(LTRIM(RTRIM(OldName))), NewName FROM #CsrMap;
INSERT INTO #Keys SELECT DISTINCT 'assignee', UPPER(LTRIM(RTRIM(OldName))), NewName FROM #AssigneeMap;

IF EXISTS (SELECT 1 FROM #Keys GROUP BY MapName, OldKey HAVING COUNT(*) > 1)
BEGIN
    SELECT MapName, OldKey, COUNT(*) AS ConflictingTargets
    FROM #Keys GROUP BY MapName, OldKey HAVING COUNT(*) > 1;
    RAISERROR ('Mapping conflict: one old name points at two different new names (see result above). Fix section 3 and re-run. Nothing was changed.', 16, 1);
END
ELSE
BEGIN
    DECLARE @KeyCount INT = (SELECT COUNT(*) FROM #Keys);
    PRINT 'Mapping validated: ' + CAST(@KeyCount AS VARCHAR(10)) + ' unique entries.';
END


/* -------------------------------------------------------------------
   SECTION 4 -- Preview. Nothing is written. Read every row.
   One row per job per field. If a job appears twice for the same field,
   section 3b failed to catch a duplicate -- stop and re-check.
   ------------------------------------------------------------------- */

SELECT j.jobNumber, 'createdBy' AS Field, '[' + j.createdBy + ']' AS OldValue, k.NewName AS NewValue,
       CASE WHEN j.archivedDate IS NULL THEN '' ELSE 'archived' END AS Note
FROM jobs j JOIN #Keys k
  ON k.MapName = 'login' AND UPPER(LTRIM(RTRIM(j.createdBy))) = k.OldKey
WHERE j.createdBy <> k.NewName
UNION ALL
SELECT j.jobNumber, 'lastModifiedBy' AS Field, '[' + j.lastModifiedBy + ']' AS OldValue, k.NewName AS NewValue,
       CASE WHEN j.archivedDate IS NULL THEN '' ELSE 'archived' END AS Note
FROM jobs j JOIN #Keys k
  ON k.MapName = 'login' AND UPPER(LTRIM(RTRIM(j.lastModifiedBy))) = k.OldKey
WHERE j.lastModifiedBy <> k.NewName
UNION ALL
SELECT j.jobNumber, 'headerModifiedBy' AS Field, '[' + j.headerModifiedBy + ']' AS OldValue, k.NewName AS NewValue,
       CASE WHEN j.archivedDate IS NULL THEN '' ELSE 'archived' END AS Note
FROM jobs j JOIN #Keys k
  ON k.MapName = 'login' AND UPPER(LTRIM(RTRIM(j.headerModifiedBy))) = k.OldKey
WHERE j.headerModifiedBy <> k.NewName
UNION ALL
SELECT j.jobNumber, 'csrName' AS Field, '[' + j.csrName + ']' AS OldValue, k.NewName AS NewValue,
       CASE WHEN j.archivedDate IS NULL THEN '' ELSE 'archived' END AS Note
FROM jobs j JOIN #Keys k
  ON k.MapName = 'csr' AND UPPER(LTRIM(RTRIM(j.csrName))) = k.OldKey
WHERE j.csrName <> k.NewName
UNION ALL
SELECT j.jobNumber, 'assignedToPrepress' AS Field, '[' + j.assignedToPrepress + ']' AS OldValue, k.NewName AS NewValue,
       CASE WHEN j.archivedDate IS NULL THEN '' ELSE 'archived' END AS Note
FROM jobs j JOIN #Keys k
  ON k.MapName = 'assignee' AND UPPER(LTRIM(RTRIM(j.assignedToPrepress))) = k.OldKey
WHERE j.assignedToPrepress <> k.NewName
UNION ALL
SELECT j.jobNumber, 'assignedToTechservices' AS Field, '[' + j.assignedToTechservices + ']' AS OldValue, k.NewName AS NewValue,
       CASE WHEN j.archivedDate IS NULL THEN '' ELSE 'archived' END AS Note
FROM jobs j JOIN #Keys k
  ON k.MapName = 'assignee' AND UPPER(LTRIM(RTRIM(j.assignedToTechservices))) = k.OldKey
WHERE j.assignedToTechservices <> k.NewName
ORDER BY Field, jobNumber;


/* -------------------------------------------------------------------
   SECTION 5 -- Apply. Takes a backup first, then updates in one
   transaction. If any statement fails, nothing is written.

   rowVersion is deliberately NOT bumped. These columns are not part of
   the app's normal save, so leaving it alone avoids handing every open
   browser a false "changed by another user" conflict.

   The whole section is guarded on the section 3b check. A RAISERROR at
   severity 16 reports an error but does NOT stop the rest of the script
   in SSMS, so the guard is what actually protects you if you paste the
   whole file in and run it at once.
   ------------------------------------------------------------------- */

IF EXISTS (SELECT 1 FROM #Keys GROUP BY MapName, OldKey HAVING COUNT(*) > 1)
    PRINT 'SKIPPED: mapping conflict from section 3b. Nothing was changed.';
ELSE
BEGIN

IF OBJECT_ID('dbo.jobs_backup_names') IS NOT NULL DROP TABLE dbo.jobs_backup_names;
SELECT * INTO dbo.jobs_backup_names FROM jobs;
PRINT 'Backup written to dbo.jobs_backup_names';

BEGIN TRANSACTION;

    UPDATE j SET createdBy = k.NewName
    FROM jobs j JOIN #Keys k
      ON k.MapName = 'login' AND UPPER(LTRIM(RTRIM(j.createdBy))) = k.OldKey
    WHERE j.createdBy <> k.NewName;
    PRINT 'createdBy rows updated: ' + CAST(@@ROWCOUNT AS VARCHAR(10));

    UPDATE j SET lastModifiedBy = k.NewName
    FROM jobs j JOIN #Keys k
      ON k.MapName = 'login' AND UPPER(LTRIM(RTRIM(j.lastModifiedBy))) = k.OldKey
    WHERE j.lastModifiedBy <> k.NewName;
    PRINT 'lastModifiedBy rows updated: ' + CAST(@@ROWCOUNT AS VARCHAR(10));

    UPDATE j SET headerModifiedBy = k.NewName
    FROM jobs j JOIN #Keys k
      ON k.MapName = 'login' AND UPPER(LTRIM(RTRIM(j.headerModifiedBy))) = k.OldKey
    WHERE j.headerModifiedBy <> k.NewName;
    PRINT 'headerModifiedBy rows updated: ' + CAST(@@ROWCOUNT AS VARCHAR(10));

    UPDATE j SET csrName = k.NewName
    FROM jobs j JOIN #Keys k
      ON k.MapName = 'csr' AND UPPER(LTRIM(RTRIM(j.csrName))) = k.OldKey
    WHERE j.csrName <> k.NewName;
    PRINT 'csrName rows updated: ' + CAST(@@ROWCOUNT AS VARCHAR(10));

    UPDATE j SET assignedToPrepress = k.NewName
    FROM jobs j JOIN #Keys k
      ON k.MapName = 'assignee' AND UPPER(LTRIM(RTRIM(j.assignedToPrepress))) = k.OldKey
    WHERE j.assignedToPrepress <> k.NewName;
    PRINT 'assignedToPrepress rows updated: ' + CAST(@@ROWCOUNT AS VARCHAR(10));

    UPDATE j SET assignedToTechservices = k.NewName
    FROM jobs j JOIN #Keys k
      ON k.MapName = 'assignee' AND UPPER(LTRIM(RTRIM(j.assignedToTechservices))) = k.OldKey
    WHERE j.assignedToTechservices <> k.NewName;
    PRINT 'assignedToTechservices rows updated: ' + CAST(@@ROWCOUNT AS VARCHAR(10));

COMMIT TRANSACTION;
PRINT 'Done. Re-run section 1 to confirm.';

END


/* -------------------------------------------------------------------
   SECTION 6 -- Optional. The component deletion audit trail stores the
   name of whoever deleted a component, inside a JSON string. Cosmetic
   only; nothing in the app filters on it. Run one REPLACE per variant.
   ------------------------------------------------------------------- */

-- UPDATE jobs
-- SET deletionLog = REPLACE(deletionLog, '"deletedBy":"Stef"', '"deletedBy":"starpy"')
-- WHERE deletionLog LIKE '%"deletedBy":"Stef"%';


/* -------------------------------------------------------------------
   ROLLBACK -- if the result is wrong, restore from the backup taken in
   section 5. Only do this before anyone starts using the app again;
   any real edits made after the backup would be lost.
   ------------------------------------------------------------------- */

-- UPDATE j
-- SET createdBy = b.createdBy, lastModifiedBy = b.lastModifiedBy,
--     headerModifiedBy = b.headerModifiedBy, csrName = b.csrName,
--     assignedToPrepress = b.assignedToPrepress,
--     assignedToTechservices = b.assignedToTechservices
-- FROM jobs j JOIN dbo.jobs_backup_names b ON b.id = j.id;
