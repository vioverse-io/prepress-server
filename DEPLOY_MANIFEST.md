# Deploy Manifest -- files to copy on every deploy

The complete list of files the app needs. On each `/prepress-deploy` (and each manual IT update), copy and replace ALL of these. They are plain files that use the same code in both repos, so re-copying the full set every time guarantees the deployed app matches the source. Nothing gets missed, even if an earlier deploy was incomplete.

## Frontend -- server-sql/public/
- index.html
- css/styles.css
- css/prepress.css
- css/techservices.css
- js/app.js
- js/prepress.js
- js/techservices.js
- js/review-items.js  (QC Review checklists; server.js also reads it at startup, so restart the service after swapping it)
- js/review-board.js  (the job list's QC column: which step each job shows; a browser file only, so Ctrl+F5 picks it up)
- js/paste-path.js  (a path pasted into a path box comes out in its server form; it reads the drives from a route in server.js, so swap the two together and restart the service, then Ctrl+F5)
- js/review.js  (QC Review window. It reads a signed sheet through a route added in server.js, so swap the two together and restart the service, then Ctrl+F5)
- js/user-picker.js  (the user picker: who is using the app; loaded before app.js)
- js/meeting-attendees.js
- js/ui-toggles.js
- lib/quill.js
- lib/quill.snow.css
- lib/purify.min.js  (DOMPurify 3.4.16, unchanged from the npm package: cleans stored instructions before the page draws them; loaded before app.js and review.js)

## Backend -- server-sql/
- server.js
- db.js
- user-list.js  (reads the user list named by USER_LIST_FILE)
- review-mail.js  (QC Review email: the two settings, the addresses, who is in To, the wording and the mailto link each press hands to Outlook; the app never sends email itself)
- review-words.js  (QC Review: whether a passed block's instructions changed since, and the Revisions as the freeze reads them; the app does not start without it, as without review-mail.js)
- nodeService.js
- package.json
- package-lock.json
- .env.example
- users.example.csv  (the user list's shape, with made-up names)

## Database -- server-sql/sql/
- create-database.sql
- create-tables.sql
- create-review-tables.sql  (QC Review tables; run once by hand in SSMS, see README.md. The app never runs it)
- fix-user-names.sql  (one-time cleanup, run by hand in SSMS, not by the app)

## Docs -- server-sql/
- README.md
- DEPLOY_MANIFEST.md  (this file)

## Never copy, never overwrite (you will lose data or config)
- `.env` -- the server's real configuration, created once by IT. The deploy never includes it. Keep the existing one in place; do not delete the app folder wholesale.
- The database (`STS_WorkOrder`) -- never re-run `create-database.sql` to reset it; the jobs live there. Run only the migrations listed in README.md. (`create-tables.sql` is guarded and safe to re-run, just unnecessary on an existing install.)
- The user list (`USER_LIST_FILE`, for example `users.csv` in the app folder) -- the real names people pick from, kept up to date by an admin or IT on the server. The deploy never includes it; `users.example.csv` only shows its shape.
- `node_modules/` -- regenerated on the server by `npm install`; do not hand-copy.
- `daemon\` -- the Windows service's own files and its logs (made by node-windows when the service was installed); not in the download.
- `.gitignore` -- per repo.
- `dev/` -- local Docker test instance and seed script. Development only, never deployed. See `dev/README.md`.

## Every release carries a new version
`package.json` (and the two matching lines at the top of `package-lock.json`) gets a new `version` in every release, because `/api/health` shows it and that is how IT tells which build is running after a swap. The `/prepress-deploy` skill stops when it did not change.

## When a file is added or removed
If you add a file under `server-sql/`, add it here AND to the copy list in `.claude/skills/prepress-deploy/SKILL.md`. If you delete a file, remove it from both and delete it from the public repo as well -- the deploy copies files, it does not auto-delete.
