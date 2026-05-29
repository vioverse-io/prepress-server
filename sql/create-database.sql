-- Run this once as a sysadmin to create the database.

USE master;
GO

IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'PrepressWO')
BEGIN
    CREATE DATABASE PrepressWO;
END
GO

-- After deciding which Windows account will run the Node service,
-- grant it access to this database:
--   USE PrepressWO;
--   CREATE USER [DOMAIN\service_account] FOR LOGIN [DOMAIN\service_account];
--   ALTER ROLE db_datareader ADD MEMBER [DOMAIN\service_account];
--   ALTER ROLE db_datawriter ADD MEMBER [DOMAIN\service_account];
