# STS Work Order -- IT Runbook

A Node + Microsoft SQL Server web app. It runs on one server; everyone on the LAN uses it through a browser. Built and supported in-house by David Marra.

## Upgrade to 3.0.0: do these in order

About 30 minutes. Keep two hours clear. Nobody uses the app from step 2 to step 12.

**Have ready:** the zip from GitHub, `users.csv` and the pasted-path lines (both from David).

1. Tell David you are starting.
2. Stop the service **STS WorkOrder App**.
3. In SSMS, back up `STS_WorkOrder`.
4. Copy the whole `C:\Apps\STS_WorkOrder` folder to `C:\Apps\STS_WorkOrder_before_3.0.0`. This copy is the way back.
5. From the zip, copy every file in `DEPLOY_MANIFEST.md` into `C:\Apps\STS_WorkOrder`, replacing the old ones. Do not touch `.env`, `node_modules\` or `daemon\`.
6. In the app folder, run `npm install`. If it suggests `npm audit fix`, do not run it.
7. In SSMS, with your own admin login, run `sql\create-review-tables.sql` against `STS_WorkOrder`. The last result grid reads `ok` on every line.
8. Put `users.csv` in the app folder.
9. Open `.env`. Delete every line that starts with `NTLM_`. Add these lines:

   ```
   USER_LIST_FILE=users.csv
   USER_REMEMBER_MINUTES=720
   ```

   Add the three `MAPPED_DRIVE_` lines David sends, as he sends them (no quotes).

   Add the two email lines (the app never sends email itself: each press opens a ready message in the person's own Outlook; these two make the link and the addresses):

   ```
   APP_BASE_URL=http://<app server address>:3000
   USER_EMAIL_DOMAIN=compu-mail.com
   ```
10. Start the service.
11. Open `http://<app server address>:3000/api/health`. Check:
    - `"version":"3.0.0"`
    - `"startedAt"` is a minute or two ago
    - `"connected":true`, `"reviews":true`, `"users":"ok"`, `"mail":"on"`
12. Open `daemon\stsworkorderapp.out.log`. Below the newest `starting` line you see `Pasted paths: M: is ...`, `Email: opens in Outlook; links to ...`, `User list loaded` and `QC Review tables ready`.
13. Tell David it is up. He sets up the names in the app and tells everyone to close every browser window.

**If a step fails:** stop, and call David. Going back is: stop the service, rename `C:\Apps\STS_WorkOrder` to `C:\Apps\STS_WorkOrder_failed`, rename `C:\Apps\STS_WorkOrder_before_3.0.0` back to `C:\Apps\STS_WorkOrder`, start the service. Rehearsed on 2026-10-26: the old version runs as it did on a database 3.0.0 has written to (the QC Review tables are extra tables it never reads), and nothing is lost when 3.0.0 is put back later. The database backup from step 3 is not needed to go back; it is there in case something else goes wrong.

The rest of this file is reference: a first install on a new server, later updates, and what each setting and log line means.

## What you need

- Node.js 20 or newer on the app server
- MS SQL Server with TCP/IP enabled (port 1433)
- ODBC Driver 17 or 18 for SQL Server on the app server
- SSMS (or any tool) to run three SQL scripts

## First-time setup (in order)

**1. Copy the app folder onto the server.** The download is a zip with one folder inside, `prepress-server-main`: what is inside that folder is the app. Copy it to `C:\Apps\STS_WorkOrder` (the suggested location). Do not use `C:\Program Files` -- it blocks the app from reading its `.env` file.

**2. Create the database** (in SSMS):
- Run `sql\create-database.sql` -- creates the `STS_WorkOrder` database.
- Make sure `STS_WorkOrder` is the active database (not `master`).
- Run `sql\create-tables.sql` -- creates the tables.
- Run `sql\create-review-tables.sql` -- creates the QC Review tables. Safe to run again. Its last result grid should read `ok` on every line.
- Grant the Windows account that will run the app `db_datareader` + `db_datawriter` on `STS_WorkOrder`. If the service runs as LocalSystem (as the shop's does, step 9), SQL Server sees the server's computer account, `DOMAIN\SERVERNAME$`: grant that.

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
USER_LIST_FILE=users.csv
USER_REMEMBER_MINUTES=720
PORT=3000
```

- **SQL_SERVER:** hostname or IP of the SQL Server. For a named instance (such as SQL Express), use `host\INSTANCENAME` and leave `SQL_PORT` blank.
- **SQL_ODBC_DRIVER:** the exact name from step 3.
- **USER_LIST_FILE:** the user list people pick their name from (see "The user list" below). A path relative to the app folder (`users.csv` means `C:\Apps\STS_WorkOrder\users.csv`) or an absolute path. **Required:** without a readable list nobody can get into the app.
- **USER_REMEMBER_MINUTES:** how long a browser remembers the picked name without the app being used. `720` (12 hours) is the setting to keep.
- **PORT:** the port the app listens on (for example, 3000).
- **A value with a `#` in it** (a password, for example) goes in single quotes: `SQL_PASSWORD='Kq7#vR2!mP'`. Without quotes everything from the `#` on is ignored.

**5. Install dependencies.** In the app folder, run `npm install`. It may end with "N moderate severity vulnerabilities ... run `npm audit fix`". **Do not run `npm audit fix`**: it changes the package versions the app was tested with. David updates packages in a release.

**5b. Create the user list.** Copy `users.example.csv` to `users.csv` (the name in `USER_LIST_FILE`) and replace the made-up rows with real people. See "The user list" below.

**6. Start and check.** Run `node server.js`. On the server, open `http://localhost:<PORT>/api/health` -- you want `"connected": true`, `"users": "ok"` and `"reviews": true`. If not, see Troubleshooting.

**7. Open the firewall.** Allow inbound TCP on your `PORT`.

**8. Test from another PC.** Open `http://<server-ip>:<PORT>`. You should see "Choose your name", then the job table once a name is picked.

**9. Run it as a Windows service** so it stays up after reboots and closed windows. The shop's service, **STS WorkOrder App**, was installed once with `nodeService.js` (node-windows, installed globally with `npm install -g node-windows`, then `node nodeService.js`). It runs `C:\Apps\STS_WorkOrder\server.js` as **LocalSystem**, starting in the app folder, and keeps its files in `C:\Apps\STS_WorkOrder\daemon` (see "Where the log is"). An update never installs it again: stop it, swap the files, start it. On a brand-new server either do the same, or use [NSSM](https://nssm.cc/) (Program `node.exe`, Arguments `server.js`, Startup directory the app folder, Log On the account you granted SQL access in step 2).

## Updating to a new version

**Do NOT overwrite these -- you will lose data or config:**
- **`.env`** -- your live connection settings. The update zip does not contain it. Keep your existing `.env` in place; do not delete the whole app folder. Back it up first if unsure.
- **The user list** (`users.csv`) -- the real names. The update zip does not contain it (only `users.example.csv`).
- **The database** -- never re-run `create-database.sql` to reset it; your jobs live there. Run only the migrations under "New steps by version" below. (`create-tables.sql` is guarded and safe to re-run, but unnecessary on an existing install.)
- **`node_modules/`** -- leave it; refresh with `npm install`. Do not copy it from the zip.
- **`daemon\`** -- the Windows service's own files and its logs. Not in the zip; leave it where it is.

Steps, in order:

1. Stop the service.
2. Back up `STS_WorkOrder`, and copy the whole app folder aside (the copy is the way back).
3. Replace the app files from `DEPLOY_MANIFEST.md` with the new ones -- keep your `.env`.
4. Run `npm install` (picks up new or changed packages). Do not run `npm audit fix` if it suggests it.
5. Do that version's items under "New steps by version" below.
6. Start the service, and check `/api/health` shows the new `version` (see "Checking which version is running").
7. **On every PC, close every browser window** (Chrome and Edge, every window on every monitor) and open the app again. A page left open from before the update keeps the old app: it cannot save into a job somebody else has open, and says "Job updated on the server" when it tries (the server log names it: `OLD PAGE: ...`). Someone who is away gets the same when they come back; restarting the PC also does it.

### New steps by version

- **3.0.0:** everything is in "Upgrade to 3.0.0: do these in order" at the top of this file.
- **Older builds:** the job status column (June 2026) and the CSR / assignee roster table (August 2026) came before 2.8.0. If either is missing, `sql\create-tables.sql` adds the status column and `sql\create-review-tables.sql` (step 7 of "Upgrade to 3.0.0") adds the roster table; both files are safe to run again. `sql\fix-user-names.sql` is a one-time cleanup: run it only if David asks.

## Troubleshooting

- **"Data source name not found, no default driver specified"** -- `SQL_ODBC_DRIVER` does not match an installed driver. Recheck the exact name (step 3).
- **"TCP Provider: target machine actively refused it"** -- SQL Server is not running or TCP/IP is off (SQL Server Configuration Manager > Protocols), or `SQL_SERVER`/`SQL_PORT` is wrong. For named instances, use `host\INSTANCENAME`, leave `SQL_PORT` blank, and make sure SQL Server Browser is running.
- **"Login failed"** -- the Windows account running Node lacks access. Grant `db_datareader` + `db_datawriter` in SSMS.
- **Everyone sees "The user list is unavailable..."** -- the app has not read a usable user list since it started. `/api/health` shows `"users": "unavailable"`, and the service log says why (see "The user list").
- **Someone's name is not in the list** -- add their row to the user list and save. It appears the next time they open the picker; no restart.
- **A browser still shows a Windows sign-in box** -- an old `server.js` is still running. Check `startedAt` in `/api/health` (below), then restart the service.
- **Jobs appear in the browser but `/api/jobs` is empty** -- an old `public/js/app.js` is in place. Re-copy the current files (see `DEPLOY_MANIFEST.md`) and restart.
- **`/api/health` shows `"reviews": false`** -- the log line `QC REVIEW TABLES UNAVAILABLE` says why: `sql\create-review-tables.sql` has not been run (or did not finish), or the app's login cannot read and write the new tables. `could not reach SQL Server` means SQL was down at that moment; it retries by itself. The rest of the app keeps working.
- **`QC REVIEW EMAIL SWITCH UNAVAILABLE` in the log** -- an older copy of `create-review-tables.sql` was run. Run this copy: it adds only what is missing.
- **A pasted path keeps its drive letter** -- that letter has no `MAPPED_DRIVE_` line in `.env`. The log line `Pasted paths: M: is ...` lists the drives in use and names any line it could not use. A value goes in without double quotes.
- **The app looks like an older version** (for example, the Archived panel shows only 5 jobs with a "+N more" link instead of a per-page dropdown and Prev/Next) -- the file swap did not take. Either the new `public/js/app.js` was not copied, or browsers are still serving the cached old one. Re-copy the files from `DEPLOY_MANIFEST.md`, restart the service, then hard-refresh (Ctrl+F5) on each PC. Check the date on `public\js\app.js` in the app folder to confirm which build is actually installed.

## The user list

People pick their own name from this list when they open the app. **This is an approved honor-system user picker, not authentication:** nothing proves who anyone is, and the app never asks for, stores, sends or logs a Windows password. Everything a person does is recorded under the name they picked.

**Where:** the file named by `USER_LIST_FILE` in `.env`. Keep it in the app folder (`C:\Apps\STS_WorkOrder\users.csv`): the service can always read its own folder, while a shared folder needs its own permission and fails when that breaks.

**Format:** a CSV file, easiest to edit in Excel (save as "CSV UTF-8") or Notepad.

```
User,Note
David.Marra,Prepress
Stephanie.Tarpy,CSR
```

- The first line holds the headings; one column must be headed `User`. Other columns (a note, a department) are ignored.
- One person per row: `Firstname.Lastname`, as in their mailbox. Letters, digits, apostrophes and hyphens, with at least one dot. The name shows in the app with spaces: "David Marra".
- Blank rows are ignored. A row with a space, an `@` address or no dot is skipped, and so is a second row for the same person (any capitals); the log names each.
- At most 1 MB and 5,000 people.

**Changes need no restart.** Save the file: within a few seconds a new person can pick their name, and someone taken off the list sees the picker again within a minute. Their typing on an open work order still saves.

**If the file breaks after it loaded** (the heading renamed, the file emptied or moved, or a save goes wrong), the app keeps the last list it read and keeps working, and `/api/health` shows `"users": "stale"` until the file is right again. Only when no good list was read since the service started does everyone see "The user list is unavailable. An administrator or IT must fix the settings or the file."

**Log lines** (the file's path is only ever written in the log, never on a screen):

| Log says | Meaning |
|---|---|
| `User list loaded: 25 users (<path>)` | read and in use |
| `USER LIST NOT SET: add USER_LIST_FILE=<path> to .env and restart.` | no setting |
| `USER LIST NOT FOUND: <path>` | no file at that path |
| `USER LIST CANNOT BE READ: <path> (<reason>)` | a folder, or the service may not read it |
| `USER LIST HAS NO USERS: <path>` | empty, or no valid rows |
| `USER LIST HAS NO 'User' COLUMN: <path>` | the heading is missing or misspelled |
| `USER LIST IS TOO LARGE` / `HAS TOO MANY USERS` | over 1 MB or 5,000 people: probably the wrong file |
| `User list: skipped row 7 ('Stef Tarpy'): not in Firstname.Lastname form.` | that row is ignored |
| `USER LIST COULD NOT BE RELOADED: ... keeping the last good list (25 users).` | a broken save after a good read; still working |

**Linking to the CSR and assignee lists.** Jobs name people by their list name ("Stef Tarpy"), and QC Review needs to know which user that is (`Stephanie.Tarpy`). In Manage CSRs & Assignees each name has a **User** box: choose the user and Save (admin password). **Link matching names** does every name whose words match a user exactly (David Marra and `David.Marra`) in one go, and lists the rest.

**The Local Intranet zone change (Group Policy)** made for the Windows sign-in is no longer needed. Leaving it in place does no harm.

**Sign-in lockout (retired).** The Windows sign-in this list replaced counted a mistyped password against the domain account (threshold 3, never expiring), which locked people out of Windows itself. The app no longer asks for a password, so it can no longer cause a lockout.

## Email (QC Review)

**The app never sends an email.** When a QC Review press would tell somebody
(a CSR handing a new job to Prepress or Tech Services, and a short "ignore
that" if she takes it back; a job sent for review; corrections needed; a fix
ready for re-review; a job signed back in for another round; a request to
send the files to the CSR; a checklist passed; the finished outputs sent on
to the CSR), a new Outlook message opens on that person's own screen with To,
Subject and the words filled in, and they press Send. The email leaves from
their own mailbox, exactly like one they wrote by hand. So there is no mail
server, no password and no sign-in anywhere in the app (IT's decision,
2026-10-26). Every email carries a link that opens the app on that job's QC
Review window.

Two lines in `.env` make it work: `APP_BASE_URL` (the address people open the
app at, for the link) and `USER_EMAIL_DOMAIN` (`compu-mail.com`, the part after
the @). **With both empty nothing opens anywhere and the rest of the app is
the same.** One missing or malformed is logged `EMAIL SETTINGS INCOMPLETE:
<what> ... Email is off until it is fixed and the service restarted.` The log
says `Email: opens in Outlook; links to <APP_BASE_URL>; addresses at
<domain>.` or `Email off: APP_BASE_URL and USER_EMAIL_DOMAIN are not set.`, and
`GET /api/health` shows `"mail"`: `"on"` or `"off"`.

Every PC needs Outlook (classic Outlook desktop) as its mail program, which the
shop has. The browser opens the message through a hidden frame; Chrome asks
nothing. The app records in the job's QC Review activity which email was
opened and for whom ("Email opened in Outlook for Sue Foster and Don
Marcotte."). It cannot know whether Send was pressed in Outlook, and the person
may add a name or a line before sending: the record of the QC itself is in the
app either way.

### Addresses

Nobody types an address in. An address is the person's user from the user list
plus `USER_EMAIL_DOMAIN`, so `David.Marra` becomes
`david.marra@compu-mail.com`. That means two things:

- a name on a job must be **linked to a user** in Manage CSRs & Assignees, and
- the user list must use each person's **mailbox name**. Someone whose mailbox
  is not `Firstname.Lastname` cannot be emailed until the list says so.

Nobody is ever left out silently: when the app cannot work out an address, the
job's QC Review activity says who was not emailed and why, in plain words.
Nobody is put in To for their own press.

### Switching one person's email off

In Manage CSRs & Assignees ("..." menu, admin password) every name has an
**Email** switch beside its User box. **Off means that person is never put in
To by QC Review**: not on the emails that go to their department's list, and
not on the ones that would be theirs alone (as operator, as whoever sent a
piece back, as the job's CSR). They stay on the list and can still be assigned
and work the checklist. A new name starts with email on, and the switch follows
the person onto every list they are on. Nothing in `.env` and no restart.

- An email for a whole department leaves a switched-off person out and says
  nothing about it. An email that was for that one person opens for nobody,
  and the job's QC Review activity says "<name> was not emailed: email turned
  off in Manage CSRs & Assignees."
- The switch is stored in `roster.emailOff`, which `sql\create-review-tables.sql`
  adds. On a database where an older copy of that file was run, the switch is
  not shown and everyone is emailed until this copy has been run.
- A department address (`DEPT_EMAIL_PREPRESS`, `DEPT_EMAIL_TECHSERVICES`) is
  one address in To instead of every name on that list: when one is set, the
  app cannot leave a member of that group out. None is set as shipped.

## Checking which version is running

`GET /api/health` returns the build:

```
{"version":"3.0.0","startedAt":"2026-10-01T12:00:00.000Z","reviews":true,"reviewForms":{"csr":"v5673ae6c","prepress":"vf1d573c2","techservices":"ve2c9fa06"},"users":"ok","userCount":25,"mail":"on","connected":true}
```

- **`version`** changes with every release. 3.0.0 is the build with QC Review and the user list. 2.8.0 is the build before it, with the Windows sign-in. **No `version` field** means the build is older than 2.8.0.
- **`reviews`** is the result of the last QC Review table check, made at startup and again (at most once a minute) whenever QC Review is used: `true` when the tables are in place and usable, `false` when not (the log line says why), `"pending"` until the first check succeeds, for example if SQL Server was down when the service started. No `reviews` field means a build from before QC Review.
- **`reviewForms`** is a short code for each QC Review checklist the service loaded from `public\js\review-items.js` at startup. Any change to a checklist changes its code. `false` means the file could not be loaded: the log line `QC REVIEW CHECKLIST UNAVAILABLE` says why. QC Review is then switched off (its window says the checklists could not be loaded) until the file is fixed and the service restarted. The rest of the app keeps working. **After swapping `review-items.js`, restart the service and have users press Ctrl+F5**: the service keeps the checklist it read at startup, while browsers load the new file, and the two must match.
- **`users`** is the user list: `"ok"`, `"stale"` (a bad change since it last read well; it keeps the old list) or `"unavailable"` (nobody can pick a name). `userCount` is how many people are on it.
- **`mail`** is email: `"on"` (each press opens a ready Outlook message) or `"off"` (see "Email (QC Review)").
- **`startedAt`** is when the service last started. If it is earlier than your file swap, the service did not actually restart. Stop it, confirm it has stopped, check for a leftover `node.exe` in Task Manager (the service runs two: a small wrapper and the app; stopping the service stops both), then start it again.

This route answers even when the user list is broken, so it is the first thing to check. `version` comes from `package.json`, so copy `package.json` whenever you copy `server.js`.

## Where the log is

Wherever this guide says "the log" or "the service log", it means the files the
service writes in `C:\Apps\STS_WorkOrder\daemon`:

- **`stsworkorderapp.out.log`**: the normal lines. Each start begins with
  `STS Work Order v3.0.0 starting (<date and time>)`, then the port, `Email:
  opens in Outlook` or `Email off`, `User list loaded`, `QC Review tables
  ready`.
- **`stsworkorderapp.err.log`**: the problem lines in capitals this guide
  names (`QC REVIEW TABLES UNAVAILABLE`, `QC REVIEW EMAIL SWITCH UNAVAILABLE`,
  `USER LIST NOT FOUND`, `EMAIL ...`, `OLD PAGE: ...`). Each start writes its `starting (<date and time>)` line here
  too: a problem line above the newest one is from an earlier start.
- **`stsworkorderapp.wrapper.log`**, and Event Viewer (source "STS WorkOrder
  App wrapper"): when the service started, stopped or crashed. It gives up
  after three crashes in a minute.

The app's own lines carry no time of day: read from the newest `starting`
line down. Running `node server.js` by hand prints the same lines in the
window instead.

## Contact

David Marra
