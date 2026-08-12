# STS Work Order -- IT Runbook

A Node + Microsoft SQL Server web app. It runs on one server; everyone on the LAN uses it through a browser. Built and supported in-house by David Marra.

## What you need

- Node.js 18 or newer on the app server
- MS SQL Server with TCP/IP enabled (port 1433)
- ODBC Driver 17 or 18 for SQL Server on the app server
- SSMS (or any tool) to run two SQL scripts

## First-time setup (in order)

**1. Copy the app folder onto the server.** Suggested location: `C:\Apps\STS_WorkOrder`. Do not use `C:\Program Files` -- it blocks the app from reading its `.env` file.

**2. Create the database** (in SSMS):
- Run `sql\create-database.sql` -- creates the `STS_WorkOrder` database.
- Make sure `STS_WorkOrder` is the active database (not `master`).
- Run `sql\create-tables.sql` -- creates the tables.
- Grant the Windows account that will run the app `db_datareader` + `db_datawriter` on `STS_WorkOrder`.

**3. Find the ODBC driver name.** Open `odbcad32` on the server, go to the Drivers tab, and copy the exact name (for example, `ODBC Driver 18 for SQL Server`). You will paste it into `.env`. If none is listed, install it from Microsoft first.

**4. Create the `.env` file.** Copy `.env.example` to `.env` and fill in real values:

```
SQL_SERVER=<sql-host-or-ip>
SQL_PORT=1433
SQL_DATABASE=STS_WorkOrder
SQL_AUTH=windows
SQL_ENCRYPT=false
SQL_TRUST_SERVER_CERT=true
SQL_ODBC_DRIVER=ODBC Driver 18 for SQL Server
NTLM_AUTH=true
NTLM_DOMAINCONTROLLER=ldap://your-domain-controller
PORT=3000
```

- **SQL_SERVER:** hostname or IP of the SQL Server. For a named instance (such as SQL Express), use `host\INSTANCENAME` and leave `SQL_PORT` blank.
- **SQL_ODBC_DRIVER:** the exact name from step 3.
- **NTLM_AUTH=true:** turns on the Windows login gate. Users must sign in with their real Windows username and password; a wrong password or a cancelled dialog is refused. Use `false` only for a dev machine with no domain.
- **NTLM_DOMAINCONTROLLER:** the domain controller that checks the password, as an LDAP address (for example `ldap://dc01.compumail.local` or `ldap://192.168.3.10`). **Required whenever NTLM_AUTH=true** -- the app will not start without it, because it refuses to run a login it cannot validate. Ask IT (Girard/Joe) for the host if you do not know it. Multiple controllers can be comma-separated for failover.
- **PORT:** the port the app listens on (for example, 3000).

**5. Install dependencies.** In the app folder, run `npm install`.

**6. Start and check.** Run `node server.js`. On the server, open `http://localhost:<PORT>/api/health` -- you want `{"connected": true}`. If not, see Troubleshooting.

**7. Open the firewall.** Allow inbound TCP on your `PORT`.

**8. Test from another PC.** Open `http://<server-ip>:<PORT>`. You should see the job table.

**9. Run it as a Windows service** so it stays up after reboots and closed windows. Use [NSSM](https://nssm.cc/):
- Program: `node.exe`  -- Arguments: `server.js`  -- Startup directory: the app folder.
- Log On: the same Windows account you granted SQL access in step 2 (not LocalSystem).

## Updating to a new version

**Do NOT overwrite these -- you will lose data or config:**
- **`.env`** -- your live connection settings. The update zip does not contain it. Keep your existing `.env` in place; do not delete the whole app folder. Back it up first if unsure.
- **The database** -- never re-run `create-database.sql` to reset it; your jobs live there. Run only the migrations under "New steps by version" below. (`create-tables.sql` is guarded and safe to re-run, but unnecessary on an existing install.)
- **`node_modules/`** -- leave it; refresh with `npm install`. Do not copy it from the zip.

Steps:

1. Stop the service.
2. Replace the app files from `DEPLOY_MANIFEST.md` with the new ones -- keep your `.env`.
3. Run `npm install` (picks up new or changed packages).
4. Apply any items under "New steps by version" that you have not run before.
5. Start the service. On each PC, hard-refresh the browser (Ctrl+F5) so the new files load.

### New steps by version (run once each, in order)

- **Windows login gate (NTLM) -- REQUIRED, do this before starting:** this build makes the Windows login a real gate. Two `.env` keys must both be set: `NTLM_AUTH=true` and `NTLM_DOMAINCONTROLLER=ldap://<your-domain-controller>` (ask IT for the host; see the config table above). Then run `npm install` (installs `express-ntlm`). **The app will not start if `NTLM_AUTH=true` and the domain controller is missing** -- on purpose, because an unchecked login only looks secure. If it will not start, open `http://localhost:<PORT>/api/health` (still works) and check the server console: it prints exactly what to add. Earlier builds accepted any typed name, or let a user cancel the login and get in anyway; this build validates the actual Windows password and refuses both.
- **Job status:** add the status column in SSMS against `STS_WorkOrder`:
  ```sql
  ALTER TABLE jobs ADD status NVARCHAR(20) DEFAULT 'new';
  ```
  This is also at the bottom of `sql\create-tables.sql`, guarded and safe to re-run. Without it, job status changes do not persist across reloads.
- **Old user names (run once, only if needed):** jobs imported from the pre-database version carry whatever name the user typed at the time, so one person can appear as several ("Stef", "STEF", "Stephanie"). Open `sql\fix-user-names.sql` in SSMS and follow the sections in order. Stop the service first. It audits, previews, backs up and then updates, and it is safe to re-run. Skip this if the audit in section 1 shows no duplicates.
- **CSR / assignee lists (automatic, one check):** the CSR and assignee lists are now editable in the app, under the "..." menu > Manage CSRs & Assignees (admin password required). They live in a `roster` table the server creates by itself on first start. Nothing to run. If, on first start after this update, the server log prints "Roster table unavailable", the service account lacks permission to create a table: either grant it `db_ddladmin` on `STS_WorkOrder` and restart, or run the single `CREATE TABLE roster (...)` statement the log prints. The app works either way; without the table it just falls back to its built-in lists and the manage screen is read-only. That same Manage screen also lets a manager merge old duplicate names (e.g. "Brandy" and "Brandi" onto "Brandilee Czajkowski") across all jobs at once, so `fix-user-names.sql` is only needed for the "created by" column, which the app does not edit.

## Troubleshooting

- **"Data source name not found, no default driver specified"** -- `SQL_ODBC_DRIVER` does not match an installed driver. Recheck the exact name (step 3).
- **"TCP Provider: target machine actively refused it"** -- SQL Server is not running or TCP/IP is off (SQL Server Configuration Manager > Protocols), or `SQL_SERVER`/`SQL_PORT` is wrong. For named instances, use `host\INSTANCENAME`, leave `SQL_PORT` blank, and make sure SQL Server Browser is running.
- **"Login failed"** -- the Windows account running Node lacks access. Grant `db_datareader` + `db_datawriter` in SSMS.
- **App will not start, or every page shows "Server misconfigured... NTLM_DOMAINCONTROLLER is not set"** -- `NTLM_AUTH=true` but no domain controller was configured. This is intentional: the app refuses to run a login it cannot validate. Add `NTLM_DOMAINCONTROLLER=ldap://<your-domain-controller>` to `.env` (ask IT for the host) and restart. `/api/health` still works while this is being fixed.
- **Login dialog rejects a CORRECT password** -- **check whether the account is locked before anything else.** A correct password returning 403 is the signature of an Active Directory lockout, not a misconfiguration. On 2026-08-10 this was chased as an LDAP problem for hours; it was lockout. Only if the account is confirmed unlocked should you check that the `NTLM_DOMAINCONTROLLER` address is right, the LDAP port is open from the app server, and the domain controller is reachable (`ping`/`Test-NetConnection`).
- **A user says they are locked out of Windows after mistyping in this app** -- see "Sign-in lockout" below.
- **Jobs appear in the browser but `/api/jobs` is empty** -- an old `public/js/app.js` is in place. Re-copy the current files (see `DEPLOY_MANIFEST.md`) and restart.
- **The app looks like an older version** (for example, the Archived panel shows only 5 jobs with a "+N more" link instead of a per-page dropdown and Prev/Next) -- the file swap did not take. Either the new `public/js/app.js` was not copied, or browsers are still serving the cached old one. Re-copy the files from `DEPLOY_MANIFEST.md`, restart the service, then hard-refresh (Ctrl+F5) on each PC. Check the date on `public\js\app.js` in the app folder to confirm which build is actually installed.

## Sign-in lockout

A failed sign-in here counts against the user's **domain** account, so enough failures lock them out of Windows itself, not just this app.

The app already limits the damage. NTLM authenticates per connection, and one page load spans about six connections, so a single typo used to spend about six attempts. A burst guard in `server.js` now answers directly for 5 seconds after a failure instead of re-asking the domain controller, which brings one mistyped sign-in down to one attempt. Live since 2026-08-11.

**What to tell a user who mistypes:**

- Reloading does nothing. It does not bring the sign-in box back and does not cost an attempt.
- Hard refresh and clearing site data do not help either.
- The only way to try again is to **quit the browser completely and reopen it**.
- A wrong username costs an attempt exactly as a wrong password does.
- Switching browsers grants no extra attempts.
- The threshold on this domain is **3**, and locked accounts do not unlock on their own.

Once locked, the user can keep working in every other program until their screen locks. After that they cannot get back into Windows until IT unlocks the account.

**The permanent fix is a Group Policy change, not an app change.** Add the app URL to the **Local Intranet zone** for domain PCs. Browsers then sign in silently with the logged-in Windows account, nobody types a password, and nothing can be mistyped.

## Checking which version is running

`GET /api/health` returns the build:

```
{"version":"2.8.0","startedAt":"2026-08-12T00:58:22.121Z","connected":true}
```

- **No `version` field** means the build is older than 2.8.0.
- **`startedAt`** is when the service last started. If it is earlier than your file swap, the service did not actually restart. Stop it, confirm it has stopped, check for a leftover `node.exe` in Task Manager, then start it again.

This route stays open in front of the login gate, so it answers even when a login problem is blocking the app. `version` comes from `package.json`, so copy `package.json` whenever you copy `server.js`.

## Contact

David Marra
