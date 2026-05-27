# Prepress App -- Update Procedures

## Scenario 1: CSS, HTML, or JS change (most common)

What changed: Styling, layout, or frontend behavior.

1. Make changes at home in the `prepress/public/` folder
2. Copy the changed file(s) to vioverse.io or cloud storage
3. At work, replace the file(s) in the server's `public/` folder:
   - `public/index.html`
   - `public/css/styles.css`
   - `public/js/app.js`
4. Refresh the browser. Done. No server restart needed.

## Scenario 2: Backend logic change (server.js)

What changed: API routes, server behavior, request handling.

1. Make changes at home to `server.js`
2. Get the file to work (same as above)
3. Replace `server.js` in the app folder (not inside `public/`)
4. Restart the server:
   - Stop: `Ctrl+C` in the terminal (or stop the Windows service)
   - Start: `node server.js` (or restart the Windows service)

## Scenario 3: Database schema change (db.js)

What changed: New fields, new tables, changed data structure.

1. Make changes at home to `db.js`
2. Get the file to work
3. Replace `db.js` in the app folder
4. Decision point:
   - If the change only ADDS new columns/tables: restart the server. Existing data is preserved.
   - If the change RENAMES or REMOVES columns: back up `prepress.db` first, then restart. Data migration may be needed.
5. Restart the server (same as Scenario 2)

## Scenario 4: New dependency added (package.json)

What changed: A new npm package is required.

1. Send the updated `package.json` and `package-lock.json`
2. Replace both files in the app folder
3. Run `npm install` in the app folder
4. Restart the server

## Scenario 5: Full app replacement

What changed: Major overhaul, too many files to track individually.

1. Build a new zip at home
2. Push to `vioverse.io/prepress-app.zip`
3. At work:
   - Back up the current `prepress.db` (this is the data)
   - Unzip the new version to a new folder
   - Run `npm install`
   - Copy the backed-up `prepress.db` into the new folder
   - Start the server
4. Verify data is intact

## What NEVER needs updating

- `prepress.db` -- this is your data, not app code. Never overwrite it.
- `node_modules/` -- rebuilt automatically by `npm install`

## Quick reference

| What changed | Replace | Restart server? |
|---|---|---|
| CSS / HTML / JS | File(s) in `public/` | No |
| server.js | `server.js` | Yes |
| db.js | `db.js` | Yes |
| package.json | `package.json` + `npm install` | Yes |
| Everything | Full zip + restore `prepress.db` | Yes |
