# Prepress Work Order App -- IT Runbook

Node + MS SQL Server web app. Multi-user, LAN-accessible. Built and supported in-house by David Marra.

## Stack

- Node.js 18+ on the app server
- MS SQL Server (TCP/IP enabled, port 1433). Windows Authentication.
- App listens on a port chosen by IT (set in `.env`)

## Deploy

1. Drop the app folder on the server. Suggested: `C:\Apps\prepress-wo-sql`. Avoid `C:\Program Files` (UAC interferes with `.env` reads).

2. In SSMS, execute `sql\create-database.sql` to create the `PrepressWO` database. Grant the Windows account that will run the Node service `db_datareader` + `db_datawriter` on `PrepressWO`. Then switch to that database and execute `sql\create-tables.sql`.

3. Copy `.env.example` to `.env` and fill in real values:

   ```
   SQL_SERVER=<sql-host-or-ip>
   SQL_PORT=1433
   SQL_DATABASE=PrepressWO
   SQL_AUTH=windows
   SQL_ENCRYPT=false
   SQL_TRUST_SERVER_CERT=true
   PORT=<port>
   ```

4. `npm install` in the app folder.

5. `node server.js` to start. From the app server itself, verify with `http://localhost:<port>/api/health` -- should return `{"connected": true}`. (Localhost is only for this on-server check; user traffic uses the LAN URL below.)

6. Open inbound TCP `<port>` on the app server firewall.

7. Users access the app at `http://<app-server-hostname-or-ip>:<port>` from any LAN machine.

8. Install as a Windows service via NSSM. Path: `node.exe`, Arguments: `server.js`, Startup directory: app folder. **Log On:** set the service to run as the Windows account that was granted SQL access in step 2 (not LocalSystem).

## Notes

- **Data** lives in SQL Server. No app-side backups needed; covered by existing SQL Server DBA process.
- **Updates:** stop the service, replace files (keep `.env`), run `npm install` if `package.json` changed, restart.
- **ODBC Driver:** The app uses Windows Authentication via the `msnodesqlv8` native driver, which requires the [Microsoft ODBC Driver for SQL Server](https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server) on the app server. Machines running SQL Server already have it. If the app server is separate, install ODBC Driver 17 or 18 before running `npm install`.
- **If `/api/health` returns `connected: false`:** check `.env` values, SQL Server TCP/IP is on, and that the service's Windows account has access to `PrepressWO`.
- **Contact:** David Marra
