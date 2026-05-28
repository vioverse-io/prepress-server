-- Run this once as a sysadmin to create the database and login.
-- Adjust the login/password to match your .env file.

USE master;
GO

IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'PrepressWO')
BEGIN
    CREATE DATABASE PrepressWO;
END
GO

-- Create a SQL login for the app (skip if using Windows auth)
IF NOT EXISTS (SELECT name FROM sys.server_principals WHERE name = 'prepress_app')
BEGIN
    CREATE LOGIN prepress_app WITH PASSWORD = 'CHANGE_ME', DEFAULT_DATABASE = PrepressWO;
END
GO

USE PrepressWO;
GO

IF NOT EXISTS (SELECT name FROM sys.database_principals WHERE name = 'prepress_app')
BEGIN
    CREATE USER prepress_app FOR LOGIN prepress_app;
    ALTER ROLE db_datareader ADD MEMBER prepress_app;
    ALTER ROLE db_datawriter ADD MEMBER prepress_app;
END
GO
