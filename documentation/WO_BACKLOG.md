# STS Work Order -- Backlog

Open items, loose ends, and future work. Separate from any VioVerse backlog.

## Recently Completed

- [x] **Landing page redesign (2026-06-05).** Replaced card grid with sortable/filterable job table. My Jobs / All Jobs tabs, column sorting, search, pagination (15/page). Active job limit raised to 50. See `HANDOFF_landing_redesign.md`.

## Tech Services — Awaiting Jason

Placeholder-status items. Questions live in `TS_Open_Questions.docx`.

- [ ] **Presort dropdown options.** 6 fields are free-text until Jason supplies option lists. Each fill = a new option array added to `js/techservices.js` and wired to the corresponding field. Fields (all in Data Processing sub-section): DP Out Date, PO Drop, Canadian Records, Foreign Records, Unmailables, Data Checked. Sortation/Postage sub-section was removed entirely (per CSR direction); those 14 fields no longer exist.
- [ ] **Presort required fields.** Today only `ts_fp10n` is required (Input record count was absorbed into Data file locations). Jason may add more (Post Affix, Permit #, Mail date, etc.).
- [ ] **Envelope-only TS fields.** `isEnvelopeComponent` returns false for now. Flip when Jason defines fields that should auto-disable for non-envelope components.
- [x] **~~Movers/Deceased checkbox independence.~~** Resolved: NCOA movers replaced with two dropdown fields (Movers w/ No New Address: Mail/Drop; Movers w/ New Address: Mail to Original/Mail to Updated).
- [ ] **Client review required workflow.** If it should auto-trigger a counts-report step, scope and spec before building.
- [x] **~~NCOA Movers section nesting.~~** Resolved: two indented dropdown rows under the NCOA parent toggle.

## Tech Services — UX Revisits

- [ ] **Dedup method: dropdown vs. radio.** Shipped as dropdown (Individual / Household / Residential) so `app.js` stayed untouched. If operators want all three visible at once, switch to radios — requires adding radio save/restore support to `app.js`.
- [ ] **Required + filepath interaction.** `ts_fp10n` is required AND is a filepath (only prints when toggle ON). Operator can satisfy "required" while leaving the path off the printout. Options: auto-toggle the filepath ON when the field has text, or decouple "required" from the "filepath print gate."
- [ ] **Presort placeholder badge.** The remaining Presort sub-section (Data Processing) carries a "See Midnight For Specs" badge. Reconsider treatment once Jason fills in options — soften to a "BETA" label or remove entirely.

## Midnight (PrintReach) API Integration

Planned. Full spec in `MIDNIGHT_API_INTEGRATION.md` (and `.html`). Blocked on SQL Server deployment + API credentials.

- [ ] **Phase 1: Job lookup.** Type a Midnight job number, auto-fill the New Job form from the API. Requires REST bearer token auth against `api.vsmidnight.com`.
- [ ] **Phase 2: Refresh existing jobs.** "Refresh from Midnight" button pulls current data, shows diff, user accepts/rejects per field.
- [ ] **Phase 3: PDF push.** "Send to Midnight" generates a server-side PDF (Puppeteer) and uploads via SOAP `OrderAddAttachment`. Requires dev token + Chromium on the server.
- [ ] **Phase 4: Polish.** Mock mode, schema migration, README updates.

## Departments

- [ ] Consider adding Lettershop, Imaging departments using the same registration pattern (new CSS + JS file + HTML panel).

## Cross-Department Field Features

- [ ] **Cross-tab field copy.** Post-TS-rebuild the field overlap between Prepress and TS is minimal (Prepress owns Piece Specs / Flat Size / Press; TS owns Data / Postal / Presort). Re-evaluate priority — if CSRs rarely copy between tabs, this may be low value.

## Tech Services Field Flexibility *(forward-looking)*

- [ ] **Multi-line canned text blocks.** Some TS fields (File priorities, Splitting criteria) may benefit from pre-populated multi-line templates. Options: textarea with quick-pick insert, "Insert Template" modal, or field-level Quill editor.
- [ ] **Import functionality.** Scope TBD. Candidates: clipboard paste from Excel, drag-drop .txt/.csv, pull from a previous job, external system fetch (parked until internal server live).
- [ ] **Tables / structured data.** For suppression file lists, mailstream breakdowns, etc. Options: tab-separated textarea (low effort, ugly), repeating field rows (moderate), or mini-table component (highest cost).

## Repetitive Task Automation

Pattern: anything a CSR types 20 times a week is a candidate for automation.

- [ ] **Vendor-based defaults.** Dropdown of known data vendors, each pre-loads spec defaults.
- [ ] **Date calculations.** Mail date = drop date + lead time. Due date = mail date + SLA.
- [ ] **File metadata autofill.** When a path points to a known file, extract record count, format, size.
- [ ] **"Copy from Previous Job#".** When Previous Job# is filled, one click pulls all matching fields from that saved job. Data already available via `getActiveJobs()`.

## Job Locking *(client scaffolding in place, waiting on server)*

- [ ] Wire up tutorial section in Help modal when server locking goes live.
- [ ] Test lock banner with real server responses (POST/PUT/DELETE `/api/jobs/{id}/lock`).
- [ ] Verify read-only mode disables all interactive elements (version picker, inline edits, component tab drag).
- [ ] Decide: should "Edit Anyway" show a second confirmation?
- [ ] Decide: lock expiry timeout duration (scaffold uses 30s heartbeat; server decides expiry).

## UI / UX

- [ ] Audit read-only mode for any inputs not covered by `body.read-only` CSS selectors.
- [ ] Consider a visual indicator when the lock heartbeat is active (subtle pulse on lock icon).
- [ ] **Mobile/tablet audit.** TS panel has significantly more rows than Prepress, especially Presort. Check scrolling + collapsible behavior on narrow viewports.

## Sync Discipline

- [ ] Run the 12-test smoke plan in `HANDOFF_techservices_sections.md` before every TS `/prepress-deploy`. In a browser, not just by code inspection.
- [ ] Never edit `prepress/public/` directly — `/prepress-deploy` syncs from `prepress-mdrive/`.
- [ ] Never include `.bak` files in `prepress-mdrive.zip`.
- [ ] When adding a new department, sync CSS/JS files to both versions and update HTML `<head>` links.
