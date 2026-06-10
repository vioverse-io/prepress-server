# STS Work Order -- IT Runbook

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
   SQL_ODBC_DRIVER=ODBC Driver 18 for SQL Server
   PORT=<port>
   ```

   **SQL_SERVER:** For a default SQL Server instance, use the hostname or IP (e.g. `192.168.1.50`). For a named instance (e.g. SQL Express), use `hostname\INSTANCENAME` -- the port will be resolved automatically via SQL Server Browser.

   **SQL_ODBC_DRIVER:** Must match the ODBC driver installed on the app server. See "Checking the ODBC driver" below.

4. `npm install` in the app folder.

5. `node server.js` to start. From the app server itself, verify with `http://localhost:<port>/api/health` -- should return `{"connected": true}`. (Localhost is only for this on-server check; user traffic uses the LAN URL below.)

6. Open inbound TCP `<port>` on the app server firewall.

7. Users access the app at `http://<app-server-hostname-or-ip>:<port>` from any LAN machine. The landing page shows a sortable, filterable job table with My Jobs / All Jobs tabs and search.

8. Install as a Windows service via NSSM. Path: `node.exe`, Arguments: `server.js`, Startup directory: app folder. **Log On:** set the service to run as the Windows account that was granted SQL access in step 2 (not LocalSystem).

## Notes

- **Data** lives in SQL Server. No app-side backups needed; covered by existing SQL Server DBA process.
- **Updates:** stop the service, replace files (keep `.env`), run `npm install` if `package.json` changed, restart.
- **Contact:** David Marra

## ODBC Driver

The app uses Windows Authentication via the `msnodesqlv8` native driver, which requires the [Microsoft ODBC Driver for SQL Server](https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server) on the app server.

Machines running SQL Server typically have it already. If the app server is separate, install ODBC Driver 17 or 18 before running `npm install`.

### Checking the ODBC driver

Open `odbcad32` on the app server and look under the **Drivers** tab. The exact name listed there (e.g. `ODBC Driver 18 for SQL Server`) is what goes in `.env` as `SQL_ODBC_DRIVER`.

PowerShell alternative:

```powershell
Get-OdbcDriver | Where-Object Name -like '*SQL Server*' | Select-Object Name
```

## Troubleshooting

### `/api/health` returns `connected: false`

**"Data source name not found, no default driver specified"**
The `SQL_ODBC_DRIVER` value in `.env` does not match any installed ODBC driver. Check the installed driver name (see above) and update `.env` to match exactly.

**"TCP Provider: No connection could be made because the target machine actively refused it"**
- Verify SQL Server is running and TCP/IP is enabled (SQL Server Configuration Manager > Protocols).
- Verify `SQL_SERVER` and `SQL_PORT` in `.env` are correct.
- For named instances (e.g. SQL Express), set `SQL_SERVER=hostname\INSTANCENAME` and leave `SQL_PORT` blank. Make sure the SQL Server Browser service is running.

**"Login failed"**
The Windows account running the Node process does not have access to the `PrepressWO` database. Grant `db_datareader` + `db_datawriter` in SSMS.

### Jobs created in browser but `/api/jobs` returns empty

The browser is using the localStorage data layer instead of the SQL API. This means the frontend files are from the wrong version (M: drive instead of server-sql). Replace `public/js/app.js` with the server-sql version and restart.
