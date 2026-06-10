# STS Work Order -- IT Runbook

Node + MS SQL Server web app. Multi-user, LAN-accessible. Built and supported in-house by David Marra.

## What you need

- Node.js 18+ on the app server
- MS SQL Server with TCP/IP enabled (port 1433)
- ODBC Driver for SQL Server (17 or 18) on the app server
- SSMS or another way to run SQL scripts

## Deploy (follow in order)

### 1. Drop the app folder on the server

Suggested location: `C:\Apps\prepress-wo-sql`. Avoid `C:\Program Files` (UAC interferes with `.env` reads).

### 2. Create the database

In SSMS:

1. Open and run `sql\create-database.sql`. This creates the `PrepressWO` database.
2. Grant the Windows account that will run the Node service `db_datareader` + `db_datawriter` on `PrepressWO`.
3. Make sure `PrepressWO` is selected as the active database (not `master`).
4. Open and run `sql\create-tables.sql`.

### 3. Check the ODBC driver

The app connects to SQL Server using Windows Authentication through the ODBC driver. You need to know the exact driver name installed on the app server.

Open `odbcad32` on the app server and look under the **Drivers** tab. Write down the exact name -- it will be something like `ODBC Driver 18 for SQL Server`.

PowerShell alternative:

```powershell
Get-OdbcDriver | Where-Object Name -like '*SQL Server*' | Select-Object Name
```

If no ODBC Driver for SQL Server is listed, install it from [Microsoft's download page](https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server) before continuing. Machines running SQL Server typically have it already.

### 4. Create the `.env` file

Copy `.env.example` to `.env` and fill in real values:

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

- **SQL_SERVER:** Use the hostname or IP of the SQL Server (e.g. `192.168.1.50`). For a named instance (e.g. SQL Express), use `hostname\INSTANCENAME` and leave `SQL_PORT` blank.
- **SQL_ODBC_DRIVER:** Use the exact driver name from step 3.
- **PORT:** The port the web app will listen on (e.g. `3000`).

### 5. Install dependencies

Run `npm install` in the app folder.

### 6. Start and verify

Run `node server.js`. From the app server itself, open:

```
http://localhost:<port>/api/health
```

You should see `{"connected": true}`. If not, see **Troubleshooting** below.

### 7. Open the firewall

Open inbound TCP for the port you chose (the `PORT` value from `.env`) on the app server firewall.

### 8. Test from another machine

From any LAN machine, open `http://<app-server-hostname-or-ip>:<port>`. You should see the landing page with a job table.

### 9. Install as a Windows service

Use [NSSM](https://nssm.cc/) (the Non-Sucking Service Manager) to install as a Windows service:
- **Path:** `node.exe`
- **Arguments:** `server.js`
- **Startup directory:** app folder
- **Log On:** set the service to run as the Windows account that was granted SQL access in step 2 (not LocalSystem)

## Updating

Stop the service, replace files (keep `.env`), run `npm install` if `package.json` changed, restart.

## Troubleshooting

**"Data source name not found, no default driver specified"**
`SQL_ODBC_DRIVER` in `.env` does not match any installed driver. Go back to step 3 and check the exact name.

**"TCP Provider: target machine actively refused it"**
- SQL Server may not be running, or TCP/IP is not enabled (check SQL Server Configuration Manager > Protocols).
- `SQL_SERVER` or `SQL_PORT` in `.env` may be wrong.
- For named instances (SQL Express), use `hostname\INSTANCENAME` as `SQL_SERVER` and leave `SQL_PORT` blank. The SQL Server Browser service must be running.

**"Login failed"**
The Windows account running the Node process does not have access to `PrepressWO`. Grant `db_datareader` + `db_datawriter` in SSMS.

**Jobs show in browser but `/api/jobs` returns empty**
The browser is using localStorage instead of the SQL API. This means the frontend files are from the M: drive version instead of server-sql. Replace `public/js/app.js` with the server-sql version and restart.

## Contact

David Marra
