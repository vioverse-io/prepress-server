# Midnight (PrintReach) API Integration Plan

## Overview

Connect STS Work Order to PrintReach Midnight so jobs flow between systems instead of being manually re-keyed. This is a SQL Server version feature only -- the M: drive version runs from `file://` and cannot make API calls. UI changes are designed in prepress-mdrive/ first (the design source), then synced to server-sql/ via /prepress-deploy.

## How the Two Systems Relate (Joe's Whiteboard, 2026-06-10)

The Work Order app and Midnight serve different purposes and track different statuses. Understanding this prevents confusion about what "done" or "closed" means.

### The Work Order app is a pre-production planning tool

You figure out *how* to build something -- specs, file paths, instructions, signoffs. When everything is resolved, the plan is complete. This does NOT mean the physical work is done.

### Midnight is the production system

Midnight tracks the actual printing, cutting, finishing, and mailing. It has its own statuses independent of the Work Order app.

### Status independence

- "Plan Complete" in the Work Order app does NOT close the job in Midnight.
- A completed production run in Midnight does NOT mark the Work Order as done.
- The two systems serve different purposes and their statuses are intentionally independent.

### Key concepts

| Concept | What it means | How it connects |
|---------|--------------|-----------------|
| **Plan Complete** (was "Already Built / Closed") | "We figured it out" -- specs resolved, questions answered, plan is ready | Syncs a planning-resolved flag to Midnight. Midnight's production status stays independent. |
| **Send to Hot Folder** | Drop the job's files/data into a watched folder that Midnight monitors | Triggers automated pickup -- preflight, imposition, or workflow start in Midnight. |
| **Reopen Planning** (was "Return orders") | Pull the job back from the hot folder or reopen for re-planning | Removes the file from the hot folder or resets the planning-resolved flag in both systems. |
| **Attachments** | Reference files, notes, solution evidence | Stored locally but linked to Midnight's job via the shared job number / order ID. |
| **Job# / Versions** | Work order ID, job number, file revisions | The linking keys between the two systems. |
| **CSR list** | Customer Service Reps | Could be pulled from Midnight's user directory instead of hard-coded. |
| **Free text notes** | Notes about the planning solution | Sync as job comments in Midnight (non-production). |
| **Refresh / List orders** | Refresh the job list | Fetches latest metadata from Midnight (but not production status). |

### Proposed UI label changes (pending Joe's review)

| Current Label | Suggested Label | Reason |
|---------------|-----------------|--------|
| Already Built | **Plan Complete** | Avoids implying physical work is done |
| Closed | **Plan Complete** | Same clarification |
| Hot Folder | **Send to Hot Folder** | Already the correct term |
| Return orders | **Reopen Planning** | Clearer intent |

---

## Midnight API -- What We Know

PrintReach Midnight exposes **both REST and SOAP APIs** at `https://api.vsmidnight.com`.

| Protocol | Use For | Docs |
|----------|---------|------|
| REST | Job lookup, order search, customer data | Swagger: `api.vsmidnight.com/swagger`, Help: `api.vsmidnight.com/Help` |
| SOAP | File attachments (only way to upload files) | WSDL: `api.vsmidnight.com/service1.asmx` |

**Authentication:** Bearer token. Call `POST /v1/Token/UserAuthentication` with `{ DomainName, UserName, Password, IsPasswordEncrypted }`. Returns `{ access_token, refresh_token, expires_in }`. SOAP uses a `DevToken` from Admin Settings > Global Settings > Site Token.

**No webhooks.** Midnight is request/response only. If we need to detect changes, we poll with `OrderModifiedDate` filters.

**Rate limits:** Not documented publicly. Ask PrintReach.

### Key REST Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/Token/UserAuthentication | Get bearer token |
| POST | /v1/Token/RegenerateAuthToken | Refresh token |
| POST | /v1/Order/OrderList | Search/filter orders by number, date, status, customer |
| POST | /v1/Order/EntireOrderGet | Get complete order with all nested data |
| POST | /v1/Customer/CustomerList | Search customers |

### Key SOAP Endpoints

| Operation | Purpose |
|-----------|---------|
| OrderAddAttachment | Attach file to an order (base64-encoded content + fileName + documentTypeId) |
| RequestAddAttachment | Attach file to a request/ticket |

**File upload is SOAP only.** The REST API has no attachment endpoints for orders. This means the PDF push feature must use SOAP for the upload call (unless we use the hot folder approach -- see below).

### Reference Resources

| Resource | URL |
|----------|-----|
| REST Swagger UI | https://api.vsmidnight.com/swagger |
| OpenAPI spec (JSON) | https://api.vsmidnight.com/swagger/docs/v1 |
| SOAP WSDL | https://api.vsmidnight.com/service1.asmx |
| SOAP PDF guide | https://drive.google.com/file/d/1YEIF8Jxqo1EHYi1ZAvqC1lAYNnkFGDT0/view |
| .NET SOAP SDK (3rd party, MIT) | https://github.com/midnightmeshllc/Midnight.SOAP.SDK |
| PrintReach support | https://support.printreach.com/hc |

---

## What We Want To Do

### Feature 1: Job Lookup (Midnight -> Work Order)

When creating a new work order, instead of typing job details manually:

- User enters a 6-digit Midnight job number
- App calls Midnight's API via our Express server
- New Job form auto-fills with whatever Midnight returns
- User reviews, adjusts if needed, saves
- The Midnight order ID is stored so the two systems stay linked

### Feature 2: Send to Hot Folder / PDF Push (Work Order -> Midnight)

After planning is complete:

- User clicks "Send to Hot Folder" (or "Send to Midnight")
- Two delivery mechanisms (decide which to implement first):
  - **Hot folder (simpler):** Server generates a PDF and drops it into a watched network folder that Midnight monitors. Midnight picks it up automatically and triggers its workflow (preflight, imposition, etc.).
  - **SOAP API upload:** Server generates a PDF, base64-encodes it, and uploads via SOAP `OrderAddAttachment`. More control, but more complex.
- Confirmation toast on success, error message on failure

### Feature 3: Reopen Planning (Return from Hot Folder)

If the plan needs revision after being sent:

- User clicks "Reopen Planning"
- Removes the file from the hot folder (or resets the planning-resolved flag)
- Job reopens in the Work Order app for re-planning
- Does NOT affect Midnight's production status

### Feature 4: Linking Existing Jobs

Jobs already in the work order app have Midnight job numbers typed in by hand. The `jobNumber` field is already the 6-digit Midnight number -- it's the natural linking key. Old jobs are NOT excluded.

Options:

- **Passive link (recommended first):** Just start using the Midnight ID for new features (hot folder push, status display). Old jobs work as-is; they gain the ability to send to hot folder without any migration.
- **On-demand refresh:** "Refresh from Midnight" button on each job. Pulls current data, shows a diff of what would change, user confirms.
- **Bulk link:** One-time script. Risky if job number formats differ. Defer until passive + on-demand are proven.

### Feature 5: CSR Directory Sync (future)

Instead of hard-coding CSR names in the quick-pick dropdown, pull them from Midnight's user directory. Keeps the list in sync automatically.

---

## Data Mapping

The `EntireOrderGet` response returns deeply nested data. Here's what maps to our fields:

### Order-Level Fields

| Midnight Field | Work Order Field | Notes |
|---------------|-----------------|-------|
| OrderNumber | jobNumber | 6-digit, already matches |
| CustomerName | clientName | Spelling may differ (see Conflicts below) |
| ProjectName | jobDescription | |
| CSRName or SalesRepName | csrName | Confirm which field Compu-Mail uses |
| DueDate | dueDate | ISO format conversion needed |
| OrderDate | dateCreated | May want to preserve WO creation date instead |
| OrderID | midnightOrderId | Midnight's internal numeric ID (not the 6-digit number) |
| OrderStatus | (new field?) | Could show "Open"/"Closed" status in the WO |
| QuantityExpected | (no field yet) | We don't track quantity -- add if useful |
| UDF1-UDF30 | (custom) | 30 user-defined fields. Ask which ones Compu-Mail uses |

### OrderVersion-Level Fields

| Midnight Field | Work Order Field | Notes |
|---------------|-----------------|-------|
| Height, Width | component flat size? | Physical dimensions -- may map to piece specs |
| MailClassName | (presort data?) | Tech Services presort info |
| MailSortName | (presort data?) | Tech Services presort info |
| PermitNumber | Indicia note? | Could populate prepress indicia field |
| PostageAffixName | (presort) | Postage affix method |
| DPInStartDate, DPOutDate | (presort dates) | Data processing dates for TS |
| VersionComment | component notes? | Free text |
| UDF1-UDF30 per version | (custom) | 30 more user-defined fields per version |

### Data Conflict Resolution

When Midnight data disagrees with what's already in the work order:

- **On import (new job):** Midnight data fills the form. User reviews before saving. No conflict -- Midnight is the source of truth for initial data.
- **On refresh (existing job):** Show a side-by-side diff. Left column = current WO values, right column = Midnight values. User picks which to keep per field, or "Accept All."
- **Name mismatches:** Midnight might say "Acme Corp" while the WO quick-pick list has "ACME Corporation." The form auto-fills with Midnight's exact string. If it doesn't match the quick-pick list, the field still works (it's a text input with dropdown suggestions, not a strict enum).
- **Date formats:** Midnight returns ISO dates. Convert to the WO's display format (`MM/DD/YYYY`) on the client side.

---

## Frontend UI Changes

All changes designed in prepress-mdrive/index.html first, synced to server-sql/ via deploy.

### New Job Modal Changes

Current layout (index.html ~line 367): two-column form. Left = Job Number, Project Name, Client, CSR, Components. Right = dept assignees and signoff dates.

**Add "Import from Midnight" to the Job Number row:**

```
[ Job Number ___________] [Lookup] <-- new button

  (status line: "Found: Acme Corp - Direct Mail Campaign" or "Not found" or spinner)

[ Project Name _________ ]  <-- auto-filled, editable
[ Client Name __________ ]  <-- auto-filled, editable
[ CSR Name _____________ ]  <-- auto-filled, editable
```

- "Lookup" button appears next to the Job Number input
- On click: validates input is a number, calls `GET /api/midnight/job/:jobNumber`
- On success: fills Project Name, Client, CSR, Due Date fields. Shows green status line with summary.
- On not found: shows red status line "Job not found in Midnight"
- On error: shows red status line with error message
- All auto-filled fields remain editable (user can override)
- The form still works without lookup -- manual entry is still supported
- On the M: drive version (no server), the Lookup button is hidden or disabled

### Print Dropdown Addition

Current dropdown (index.html ~line 39): Print Current, Print All Components, Print All as One PDF.

**Add separator + "Send to Hot Folder":**

```
Print Current
Print All Components
Print All as One PDF
-----------------------
Send to Hot Folder      <-- generates PDF, drops to watched folder
```

- Click shows a confirmation: "Send work order PDF for Job #123456 to hot folder?"
- On confirm: spinner/progress indicator, then success toast or error message
- Disabled (grayed out) if: no job loaded, job has no job number, or hot folder path not configured
- Hidden entirely on the M: drive version

### Job Header Indicators

Current billboard (index.html ~line 117): Job#, Customer, CSR, Component, plus badges.

**Add link status indicator next to Job#:**

```
Job# 123456 [M]     <-- small "M" badge = linked to Midnight
```

- `[M]` badge (styled like the existing READ-ONLY badge, but smaller) appears when `midnightOrderId` is populated
- Tooltip on hover: "Linked to Midnight - Last synced: Jun 10, 2026"
- No badge = not linked (no visual noise for unlinked jobs)

**Add planning status indicator (pending Joe's review):**

```
Job# 123456 [M] [Plan Complete]     <-- when planning is resolved
```

### More Menu Addition

Current "..." dropdown (index.html ~line 51): Edit Job Details, Duplicate, Archive, etc.

**Add Midnight actions:**

```
Edit Job Details
-----------------------
Duplicate Job
...
-----------------------
Refresh from Midnight   <-- pull latest data from Midnight
Reopen Planning         <-- pull back from hot folder, reopen for changes
```

- Both items only shown when job has a job number
- Hidden on M: drive version

### Landing Page Table

Current columns: Job#, Client, Project, CSR, Assigned, Modified, Status, Depts.

**No new columns needed initially.** The `[M]` badge next to job numbers in the table is sufficient. Avoids table width bloat. Revisit if users want to filter/sort by link status.

---

## Architecture

```
Browser (Work Order App)
    |
    v
Express Server (server-sql/server.js)
    |
    +--> SQL Server (job data, WO storage)
    |
    +--> Midnight REST API (job lookup via bearer token)
    |
    +--> Midnight SOAP API (file upload via dev token)
    |
    +--> Hot Folder (network path -- watched by Midnight)
```

All Midnight API calls go through the Express server:

- Keeps credentials off the client
- Handles CORS (Midnight API likely blocks browser-origin requests)
- Lets us cache, log, and rate-limit
- Works behind the company firewall
- Lets us enable/disable the integration via environment variable

### Two paths for file delivery

| Approach | How it works | Pros | Cons |
|----------|-------------|------|------|
| **Hot folder** | Server writes PDF to a network folder Midnight watches | Simple, no SOAP complexity, Midnight picks it up automatically | Requires network path access from the server, less control over confirmation |
| **SOAP API** | Server calls `OrderAddAttachment` with base64-encoded PDF | Explicit confirmation, attachment linked to specific order | Requires SOAP client library, more complex auth |

Recommendation: Start with the hot folder approach if Midnight already has one configured. Fall back to SOAP API if more control is needed.

### New Express Routes

| Method | Path | Purpose | Midnight Call |
|--------|------|---------|---------------|
| GET | /api/midnight/status | Test connectivity + auth | POST /v1/Token/UserAuthentication |
| GET | /api/midnight/job/:jobNumber | Look up a job | POST /v1/Order/OrderList + /v1/Order/EntireOrderGet |
| POST | /api/midnight/job/:jobNumber/attach | Upload PDF (SOAP path) | SOAP OrderAddAttachment |
| POST | /api/midnight/job/:jobNumber/hotfolder | Send to hot folder | Write PDF to network path |
| POST | /api/midnight/job/:jobNumber/reopen | Reopen planning | Remove from hot folder / reset flag |

**Route details:**

`GET /api/midnight/job/:jobNumber`:
- Validate jobNumber is numeric, 1-10 digits
- Call Midnight `OrderList` with `{ OrderNumber: jobNumber }` to find the order
- If found, call `EntireOrderGet` to get full details
- Return mapped subset: `{ orderNumber, customerName, projectName, csrName, dueDate, midnightOrderId, status, versions[] }`
- Cache token in memory (refresh when expired)
- Return 404 if not found, 502 if Midnight unreachable, 401 if auth fails

`POST /api/midnight/job/:jobNumber/hotfolder`:
- Generate PDF server-side (see PDF Generation below)
- Write PDF to the configured hot folder path: `HOT_FOLDER_PATH/<jobNumber>_WO.pdf`
- Return success/failure

`POST /api/midnight/job/:jobNumber/reopen`:
- Delete the PDF from the hot folder (if it exists)
- Reset planning status flag on the job record
- Return success/failure

### Feature Toggle

Add `MIDNIGHT_ENABLED=true|false` to `.env`. When false:
- All `/api/midnight/*` routes return 404
- Frontend hides Midnight-related UI elements (Lookup button, Send to Hot Folder, Refresh, Reopen, [M] badge)
- Zero impact on core work order functionality

This acts as a kill switch if Midnight integration causes problems in production.

### New .env Variables

Add to `server-sql/.env.example`:

```
# -- Midnight API Integration (optional) --
MIDNIGHT_ENABLED=false
MIDNIGHT_API_URL=https://api.vsmidnight.com
MIDNIGHT_DOMAIN=compumail
MIDNIGHT_USERNAME=
MIDNIGHT_PASSWORD=
MIDNIGHT_DEV_TOKEN=
HOT_FOLDER_PATH=
```

`MIDNIGHT_DOMAIN`, `MIDNIGHT_USERNAME`, `MIDNIGHT_PASSWORD` are for REST bearer token auth. `MIDNIGHT_DEV_TOKEN` is for SOAP calls (file upload). `HOT_FOLDER_PATH` is the network path to the watched folder Midnight monitors. All come from Midnight admin settings / IT.

### New Database Columns

```sql
ALTER TABLE jobs ADD midnightOrderId NVARCHAR(36) NULL;
ALTER TABLE jobs ADD midnightLastSync NVARCHAR(30) NULL;
ALTER TABLE jobs ADD planningStatus NVARCHAR(20) NULL;
```

Note: `midnightOrderId` is referenced in CLAUDE.md's data model but does NOT currently exist in `server-sql/sql/create-tables.sql`. This ALTER adds it. `midnightLastSync` tracks last pull/push time. `planningStatus` tracks whether planning is resolved ('complete') or open (NULL).

Update `create-tables.sql` to include these columns for fresh installs.

### New npm Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `soap` or `strong-soap` | SOAP client for OrderAddAttachment (if using SOAP path) | ~200 KB |
| `puppeteer` or `playwright` | Server-side PDF generation (see below) | ~300 MB (includes Chromium) |

The PDF library is the heavy one. See next section. If using the hot folder approach exclusively, the SOAP package may not be needed initially.

---

## Server-Side PDF Generation

**This is the biggest technical challenge in the integration.**

The current print system is 100% browser-based. `buildPrintHTML()` in app.js (~line 2699) constructs a full HTML document, `printViaIframe()` writes it to a hidden iframe, and the browser's `window.print()` dialog handles output. The app never produces an actual PDF file.

To send a PDF to a hot folder or upload via SOAP, the server must generate one. Options:

### Option A: Puppeteer (recommended)

- Install Puppeteer on the server (`npm install puppeteer`)
- Puppeteer downloads a bundled Chromium (~300 MB)
- Server receives the print HTML from the client (or reconstructs it from job data)
- Puppeteer launches headless Chromium, loads the HTML, calls `page.pdf()`
- Result: actual PDF file in memory, ready to write to hot folder or base64-encode for SOAP

**Pros:** Pixel-perfect match with browser print output. Same CSS, same fonts, same layout.
**Cons:** Large dependency. IT must ensure the server has enough RAM (~500 MB for Chromium). First PDF generation is slow (~2-3 sec); subsequent ones are faster if Chromium stays running.

### Option B: Client sends PDF

- User clicks "Send to Hot Folder"
- Browser generates PDF via the print dialog (user must "Save as PDF")
- User uploads the saved PDF file back to the app
- App sends it to the server, server writes it to the hot folder

**Pros:** No server-side PDF library needed. Lightweight.
**Cons:** Terrible UX. User has to save a file, then upload it. Two manual steps instead of one click. Error-prone.

### Option C: html-pdf-node or pdf-lib

- Lighter-weight PDF generation without full Chromium
- Limited CSS support (no flexbox, no grid, no custom fonts in some libraries)
- Print output may not match browser version exactly

**Pros:** Small footprint. Fast.
**Cons:** Visual fidelity risk. Print layout uses custom fonts (Bitter, DM Sans, JetBrains Mono) and CSS that lighter libraries may not render correctly.

**Recommendation:** Option A (Puppeteer). The print output is the user-facing deliverable -- it must look right. The server already runs Node.js; adding Chromium is a deployment step, not an architecture change. IT installs it once.

### PDF Generation Flow (Hot Folder Path)

```
1. Client clicks "Send to Hot Folder"
2. Client calls POST /api/midnight/job/:jobNumber/hotfolder
   Body: { printHtml: buildPrintHTML() }   <-- same HTML the browser prints
3. Server receives HTML
4. Puppeteer loads HTML, calls page.pdf({ format: 'Letter' })
5. PDF written to HOT_FOLDER_PATH/<jobNumber>_WO.pdf
6. Midnight detects the new file and triggers its workflow
7. Server updates job record: planningStatus = 'complete', midnightLastSync = now
8. Return success to client
9. Client shows toast: "Work order sent to hot folder for Job #123456"
```

### PDF Generation Flow (SOAP API Path)

```
1. Client clicks "Send to Midnight"
2. Client calls POST /api/midnight/job/:jobNumber/attach
   Body: { printHtml: buildPrintHTML() }
3. Server receives HTML
4. Puppeteer loads HTML, calls page.pdf({ format: 'Letter' })
5. PDF stored in memory (Buffer), NOT written to disk
6. Base64-encode the buffer
7. SOAP call: OrderAddAttachment(fileContent, fileName, documentTypeId, orderId)
8. Return success/failure to client
9. Client shows toast: "PDF sent to Midnight" or error
```

---

## Error Handling

### Job Lookup Errors

| Scenario | Server Response | Client UI |
|----------|----------------|-----------|
| Job found | 200 + job data | Green status: "Found: Client - Description". Form fills. |
| Job not found | 404 | Red status: "Job #123456 not found in Midnight" |
| Midnight unreachable | 502 | Red status: "Cannot reach Midnight. Try again later." |
| Auth failure (bad credentials) | 401 | Red status: "Midnight authentication failed. Contact IT." |
| Invalid job number format | 400 (client-side) | Red status: "Enter a valid job number" |
| Rate limited | 429 | Red status: "Too many requests. Wait a moment." |
| Timeout (>10 sec) | 504 | Red status: "Midnight is not responding. Try again." |

### Hot Folder / PDF Push Errors

| Scenario | Server Response | Client UI |
|----------|----------------|-----------|
| Success | 200 | Green toast: "Work order sent for Job #123456" |
| Hot folder path not accessible | 500 | Red toast: "Cannot write to hot folder. Contact IT." |
| Midnight rejects file (SOAP path) | 400/500 | Red toast: "Midnight rejected the upload. Try again." |
| PDF generation fails | 500 | Red toast: "Could not generate PDF. Try printing manually." |
| Job not linked | 400 (client-side) | Button disabled with tooltip: "Job must have a job number" |
| SOAP auth failure | 401 | Red toast: "Midnight authentication failed. Contact IT." |
| File too large | 413 | Red toast: "PDF too large for Midnight" |

### General

- All Midnight errors are non-fatal. The work order app works fine without Midnight -- it's an enhancement, not a dependency.
- Network errors retry once automatically, then surface to the user.
- Auth token is cached in memory on the server. Auto-refreshed when expired. If refresh fails, next request triggers a fresh login.

---

## Security

- **Credentials stored server-side only** in `.env`. Never sent to the browser.
- **Input validation:** Job number input sanitized to numeric characters only, max 10 digits, before any API call.
- **HTTPS:** Midnight API is HTTPS. Our server-to-Midnight calls are encrypted in transit.
- **Hot folder path:** Validated at startup -- server checks the path is writable. Path injection prevented by only using the configured base path + sanitized job number.
- **Dev token rotation:** If the Midnight dev token is compromised, regenerate in Midnight admin settings and update `.env`. No code change needed.
- **No secrets in git:** `.env` is in `.gitignore`. `.env.example` has placeholder values only.
- **Feature toggle:** `MIDNIGHT_ENABLED=false` completely disables all Midnight routes and hides UI.

---

## Testing Strategy

### Development (no Midnight access)

- Mock the Midnight API responses on the server side with a `MIDNIGHT_MOCK=true` env variable
- Mock returns realistic data for 3-5 fake job numbers
- Hot folder can point to a local temp directory for testing
- Lets us build and test the full UI flow without real API credentials

### Integration Testing

- Pick 5-10 known real job numbers from Midnight
- Verify lookup returns correct data for each
- Verify hot folder delivery: PDF appears in the folder, Midnight picks it up
- Verify SOAP upload (if used): PDF appears as an attachment in Midnight
- Test with edge cases: very old jobs, closed jobs, jobs with special characters in names
- Test Reopen Planning: verify file is removed from hot folder

### Acceptance Criteria

- [ ] Lookup: enter job number in New Job modal, form auto-fills correctly
- [ ] Lookup: unknown job number shows "not found" message
- [ ] Lookup: network failure shows appropriate error, form still works manually
- [ ] Hot folder: PDF appears in the watched folder with correct filename
- [ ] Hot folder: Midnight picks up the file and starts its workflow
- [ ] Reopen: file removed from hot folder, job reopened for editing
- [ ] SOAP (if used): PDF appears as attachment in Midnight with correct job association
- [ ] PDF output matches browser print output visually
- [ ] Toggle: MIDNIGHT_ENABLED=false hides all Midnight UI and disables routes
- [ ] M: drive version: no Midnight UI visible, no errors in console

---

## Implementation Order

### Phase 0: Prerequisites

- SQL Server version deployed and running at Compu-Mail
- Get Midnight API credentials (username, password, domain, dev token) from IT/PrintReach admin
- Verify API access: hit `POST /v1/Token/UserAuthentication` from the server and confirm a token comes back
- Read the OpenAPI spec at `api.vsmidnight.com/swagger/docs/v1` to confirm field names match what's documented here
- Identify the hot folder path on the network (ask Joe / IT)

### Phase 1: Job Lookup

1. Add `.env` variables for Midnight
2. Build `/api/midnight/status` health check route
3. Build `/api/midnight/job/:jobNumber` lookup route
4. Add Lookup button to New Job modal in prepress-mdrive/index.html
5. Wire frontend: button click -> fetch -> auto-fill form
6. Add `[M]` badge to job header when `midnightOrderId` is populated
7. Test with real job numbers

### Phase 2: Refresh Existing Jobs

1. Add "Refresh from Midnight" to the More dropdown
2. Build diff modal (current values vs. Midnight values)
3. Wire accept/reject per field
4. Update job record with accepted changes + set `midnightLastSync`
5. Test with jobs that were manually entered

### Phase 3: Send to Hot Folder / PDF Push

1. Install Puppeteer on the server
2. Build PDF generation endpoint (receives print HTML, returns PDF buffer)
3. Build hot folder delivery route (write PDF to network path)
4. Optionally: build SOAP client for `OrderAddAttachment` as backup delivery method
5. Add "Send to Hot Folder" to print dropdown
6. Wire frontend: confirmation dialog -> generate PDF -> deliver -> toast
7. Test: verify PDF appears in hot folder, Midnight picks it up
8. Verify IT's server has enough RAM for Puppeteer/Chromium

### Phase 4: Reopen Planning

1. Add "Reopen Planning" to the More dropdown
2. Build reopen route (remove from hot folder, reset planning status)
3. Add `planningStatus` column to jobs table
4. Add "Plan Complete" badge to job header when status is set
5. Test round-trip: send to hot folder -> reopen -> re-send

### Phase 5: Polish

1. Add mock mode for development (`MIDNIGHT_MOCK=true`)
2. Add `midnightOrderId`, `midnightLastSync`, and `planningStatus` columns to SQL schema
3. Update `create-tables.sql` for fresh installs
4. Evaluate CSR directory sync from Midnight (Feature 5)
5. Sync all changes to server-sql/ via /prepress-deploy
6. Update README.md with Midnight configuration section
7. Update WO_BACKLOG.md

---

## Remaining Questions for David / IT / PrintReach

### Must Answer Before Phase 1

1. **Credentials:** Who has admin access to Midnight to generate the dev token and create API user credentials?
2. **Domain name:** What is Compu-Mail's Midnight domain name (the `DomainName` parameter for auth)?
3. **CSR field:** Does Compu-Mail use `CSRName` or `SalesRepName` in Midnight? Or are they the same person?
4. **UDF fields:** Which of the 30 user-defined fields (UDF1-UDF30) does Compu-Mail actually use? Any of them map to work order fields?
5. **Job number format:** Are all Compu-Mail job numbers exactly 6 digits? Any with leading zeros, prefixes, or alphanumeric characters?

### Must Answer Before Phase 3

6. **Hot folder path:** Where is the hot folder on the network? Does Midnight already have one configured? What's the expected filename format?
7. **Hot folder vs. SOAP:** Does Joe prefer hot folder delivery, SOAP API upload, or both as options?
8. **Server resources:** Does the IT server running the SQL Server version have enough RAM for Puppeteer? (~500 MB additional for Chromium.) If not, consider Option B (client-side PDF save + upload).
9. **File size limits:** Any maximum file size for Midnight attachments or hot folder files?
10. **Document type ID:** If using SOAP upload, what `documentTypeId` should we use? (Check Midnight admin settings for the list of document types.)

### Must Answer Before Phase 4

11. **Reopen behavior:** When we "reopen planning," does Midnight need to be notified? Or is removing the file from the hot folder sufficient?
12. **Planning status labels:** Confirm the UI label renames with Joe (Plan Complete, Send to Hot Folder, Reopen Planning).

### Nice to Know

13. **Rate limits:** How many API calls per minute/hour does Midnight allow?
14. **Sandbox/test environment:** Does Compu-Mail's Midnight instance have a staging environment? Or do we test against production with care?
15. **Order versions:** Midnight orders have versions (suffixes). Do work orders always correspond to the latest version, or could they reference a specific one?
16. **CSR directory:** Can we pull the CSR list from Midnight's API instead of hard-coding it?
17. **Future:** Should job creation eventually originate in Midnight only? (i.e., phase out manual job creation in the work order app entirely)

---

## Dependencies

- SQL Server version deployed first (all phases are server-sql only)
- Midnight API credentials from PrintReach admin or IT
- Hot folder path from IT (Phase 3)
- Puppeteer/Chromium installable on the IT server (Phase 3)
- npm packages: `puppeteer` (PDF generation), optionally `soap` or `strong-soap` (SOAP client)

## Not In Scope (Yet)

- Real-time sync / polling for Midnight changes (no webhooks available)
- Creating jobs in Midnight from the work order app (one-way pull only)
- Pulling production status or job costing data
- Inventory or invoicing integration
- Estimate-to-order workflow
- Multi-system workflow orchestration
- Automatic status sync between the two systems (statuses are intentionally independent)
