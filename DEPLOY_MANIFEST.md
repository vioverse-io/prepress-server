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
- js/meeting-attendees.js
- js/ui-toggles.js
- lib/quill.js
- lib/quill.snow.css

## Backend -- server-sql/
- server.js
- db.js
- nodeService.js
- package.json
- package-lock.json
- .env.example

## Database -- server-sql/sql/
- create-database.sql
- create-tables.sql

## Docs -- server-sql/
- README.md
- DEPLOY_MANIFEST.md  (this file)

## Never copy, never overwrite (you will lose data or config)
- `.env` -- the server's real configuration, created once by IT. The deploy never includes it. Keep the existing one in place; do not delete the app folder wholesale.
- The database (`STS_WorkOrder`) -- never re-run `create-database.sql` to reset it; the jobs live there. Run only the migrations listed in README.md. (`create-tables.sql` is guarded and safe to re-run, just unnecessary on an existing install.)
- `node_modules/` -- regenerated on the server by `npm install`; do not hand-copy.
- `.gitignore` -- per repo.

## When a file is added or removed
If you add a file under `server-sql/`, add it here AND to the copy list in `.claude/skills/prepress-deploy/SKILL.md`. If you delete a file, remove it from both and delete it from the public repo as well -- the deploy copies files, it does not auto-delete.
