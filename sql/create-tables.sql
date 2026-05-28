-- Run this against the PrepressWO database after create-database.sql.

USE PrepressWO;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'jobs')
BEGIN
    CREATE TABLE jobs (
        id              NVARCHAR(36) PRIMARY KEY,
        jobNumber       NVARCHAR(50) NOT NULL,
        jobDescription  NVARCHAR(MAX) DEFAULT '',
        clientName      NVARCHAR(200) NOT NULL,
        csrName         NVARCHAR(100) DEFAULT '',
        assignedToPrepress       NVARCHAR(100) DEFAULT '',
        signoffDueDatePrepress   NVARCHAR(30) DEFAULT '',
        signoffDueTimePrepress   NVARCHAR(30) DEFAULT '',
        assignedToTechservices   NVARCHAR(100) DEFAULT '',
        signoffDueDateTechservices NVARCHAR(30) DEFAULT '',
        signoffDueTimeTechservices NVARCHAR(30) DEFAULT '',
        version         NVARCHAR(20) DEFAULT '',
        dateCreated     NVARCHAR(30) NOT NULL,
        createdBy       NVARCHAR(100) DEFAULT '',
        lastModified    NVARCHAR(30) NOT NULL,
        lastModifiedBy  NVARCHAR(100) DEFAULT '',
        lastAccessed    NVARCHAR(30) DEFAULT '',
        headerModified  NVARCHAR(30) DEFAULT '',
        headerModifiedBy NVARCHAR(100) DEFAULT '',
        duplicatedFrom  NVARCHAR(36) DEFAULT '',
        archivedDate    NVARCHAR(30) DEFAULT NULL,
        activeComponentId NVARCHAR(36) DEFAULT '',
        activeDepartment NVARCHAR(20) DEFAULT 'prepress',
        deletionLog     NVARCHAR(MAX) DEFAULT '[]',
        rowVersion      INT NOT NULL DEFAULT 1
    );

    CREATE INDEX idx_jobs_archivedDate ON jobs(archivedDate);
    CREATE INDEX idx_jobs_jobNumber ON jobs(jobNumber);
END
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'components')
BEGIN
    CREATE TABLE components (
        id              NVARCHAR(36) PRIMARY KEY,
        jobId           NVARCHAR(36) NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        name            NVARCHAR(200) NOT NULL,
        instructions_prepress       NVARCHAR(MAX) DEFAULT '',
        instructions_techservices   NVARCHAR(MAX) DEFAULT '',
        instructionsHistory_prepress NVARCHAR(MAX) DEFAULT '',
        instructionsHistory_techservices NVARCHAR(MAX) DEFAULT '',
        checkboxes      NVARCHAR(MAX) DEFAULT '{}',
        notes           NVARCHAR(MAX) DEFAULT '{}',
        version         NVARCHAR(20) DEFAULT '',
        sortOrder       INT DEFAULT 0
    );

    CREATE INDEX idx_components_jobId ON components(jobId);
END
GO
