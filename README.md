# Prepress Work Order App -- SQL Server Version

Internal work order instructions app backed by MS SQL Server. Multiple users on the LAN can view and edit jobs simultaneously.

---

## Local Testing (Docker)

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine in WSL2).

2. Start a SQL Server container:
   ```
   docker run -e "ACCEPT_EULA=Y" -e "SA_PASSWORD=YourPassword123!" \
     -p 1433:1433 --name sqlserver -d mcr.microsoft.com/mssql/server:2022-latest
   ```

3. Create the database. From the repo root:
   ```
   docker exec -i sqlserver /opt/mssql-tools*/bin/sqlcmd -U sa -P "YourPassword123!" < sql/create-database.sql
   ```

4. Create the tables:
   ```
   docker exec -i sqlserver /opt/mssql-tools*/bin/sqlcmd -U sa -P "YourPassword123!" -d PrepressWO < sql/create-tables.sql
   ```

5. Copy `.env.example` to `.env` and set the Docker test values:
   ```
   cp .env.example .env
   ```
   Edit `.env`:
   ```
   SQL_SERVER=localhost
   SQL_USER=sa
   SQL_PASSWORD=YourPassword123!
   ```

6. Install dependencies:
   ```
   npm install
   ```

7. Start the server:
   ```
   node server.js
   ```

8. Open http://localhost:3000

9. Verify the database connection: http://localhost:3000/api/health should return `{"connected": true}`.

---

## IT Production Deployment

1. **Prerequisites:**
   - Node.js LTS (v18 or newer) on the server that will run the app
   - SQL Server instance with TCP/IP enabled (port 1433)

2. Create the database. Open SSMS, connect as sysadmin, and run:
   ```
   sql/create-database.sql
   ```
   This creates the `PrepressWO` database and a `prepress_app` login. **Change the password in the script before running.**

3. Create the tables. In SSMS, switch to the `PrepressWO` database and run:
   ```
   sql/create-tables.sql
   ```

4. Copy `.env.example` to `.env` and fill in the real values:
   ```
   cp .env.example .env
   ```
   Edit `.env`:
   ```
   SQL_SERVER=192.168.1.x      <- your SQL Server IP
   SQL_PORT=1433
   SQL_USER=prepress_app
   SQL_PASSWORD=<the password you set in step 2>
   SQL_DATABASE=PrepressWO
   ```

5. Install dependencies:
   ```
   npm install
   ```

6. Start the server:
   ```
   node server.js
   ```

7. Open http://server-ip:3000 from any machine on the LAN.

8. **Firewall:** Open port 3000 inbound on the app server so other LAN machines can connect.

9. Verify: http://server-ip:3000/api/health should return `{"connected": true}`.

10. **Optional -- run as a Windows service** so the app starts automatically on reboot:
    - Install [NSSM](https://nssm.cc/): `nssm install PrepressWO`
    - Path: `C:\Program Files\nodejs\node.exe`
    - Arguments: `C:\path\to\server-sql\server.js`
    - Startup directory: `C:\path\to\server-sql`

---

## Stopping / Cleanup

- **Stop server:** Ctrl+C in the terminal (or stop the NSSM service)
- **Stop Docker container:** `docker stop sqlserver`
- **Remove Docker container:** `docker rm sqlserver`
- **Data** lives in SQL Server, not in any local file. Nothing to back up on the app server side.

---

## How It Works

| IT configures | Just works |
|---|---|
| SQL Server IP/port/credentials (.env) | Frontend (all in the browser) |
| Node.js installation | Job locking (in-memory, no config) |
| Network/firewall access to port 3000 | Print/PDF (browser print dialog) |
| | Dark mode, profiles (browser localStorage) |

**Optimistic locking:** When two people edit the same job, the second save shows a conflict message and reloads the latest version. No silent overwrites.
