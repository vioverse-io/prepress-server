# Handoff: Landing Page Redesign for Server Version

**Date:** 2026-06-04
**Status:** Mockup approved, partial implementation in place, full layout rebuild needed
**Mockup:** `prepress-mdrive/documentation/mockup-landing-server.html` (open at localhost:3000/documentation/mockup-landing-server.html)

---

## Goal

Redesign the landing page (`#noJobState` in index.html) to handle multi-user scale. The current layout is a 5-column grid (archived | templates | center CTA | filters | recent list) designed for one person with ~20 jobs. The server version will have 13 CSRs creating 4-5 jobs/day, so the landing needs to handle 50-300+ active jobs.

## What exists now

### Already built (commit 15ec2ea):

1. **My Jobs / All Jobs tabs** -- `landingViewTab` state in app.js, `setLandingViewTab()`, `isMyJob()` helper. Filters on `assignedToPrepress` or `assignedToTechservices` matching `getUserName()`. Working, tested.

2. **Tab CSS** -- `.landing-view-tabs`, `.landing-view-tab` styles in styles.css. Matches existing design tokens.

3. **Mockup HTML** -- `documentation/mockup-landing-server.html`. Static throwaway file showing the target layout. Not functional, just visual reference.

### What the mockup shows (approved by David):

- **Top header bar**: greeting (left), search + refresh button + new work order button (right)
- **View tabs**: My Jobs / All Jobs with count badges (already built, just needs repositioning)
- **Filter pills**: department toggles (All Depts / Prepress / Tech Services), multi-select dropdowns for CSR + Assignee + Client (checkbox list with search inside a popup), time range pills (Today / This Week / This Month / All Time)
- **Job table (list view)**: columns are Job#, Client, Project, CSR, Assigned, Modified, Status, Depts. Sortable headers. Rows assigned to the current user get a red left border. "Sue is editing" badges inline.
- **Pagination**: "Showing 1-10 of 67 jobs", page number buttons (1 2 3 4 5 6 7), prev/next arrows, per-page selector (10/25/50)
- **Bottom row**: Archive and Templates in collapsed panels (same data, new layout)

## What to build

Replace the `#noJobState` div contents in `prepress-mdrive/index.html`. The new layout is full-width (no 5-column grid).

### Phase 1: Layout + list view

1. Replace the center CTA area, sidebar filters, and right-column recent list with:
   - Full-width header row (greeting + actions)
   - View tabs (reuse existing JS logic)
   - Filter bar with pills
   - Job table (sortable, clickable rows open the job)
   - Pagination controls
   - Archive + Templates panels at bottom

2. The job table replaces `renderRecentJobs()`. Each row needs: job number, client, project description, CSR, assignee, last modified date, status badge (New / In Progress / Complete based on required fields), department dots.

3. Pagination: client-side. All jobs are already in memory (`getActiveJobs()`). Paginate the filtered/sorted array. Store `currentPage` and `pageSize` in state.

### Phase 2: Multi-select filter dropdowns

The filter pills for CSR, Assignee, and Client should open a dropdown with:
- Search input at top (filters the checkbox list)
- Checkbox list of all unique values from the current job data
- "Clear all" and "Apply" buttons at bottom
- When selections are active, the pill highlights and shows a count badge

### Phase 3: Sorting

Column headers in the table should be clickable to sort. Default: most recently modified first. Click toggles ascending/descending. Arrow indicator on active sort column.

## Critical constraints

- **ALL existing functionality must keep working.** The landing page is the entry point for: creating jobs, opening jobs, searching jobs, browsing/selecting jobs (dropdown), archiving, unarchiving, deleting, templates, import/export. Every one of these must still work after the redesign.
- **Work ONLY in `prepress-mdrive/`.** Do not edit `server-sql/public/` directly.
- **`loadJob()`, `openNewJobModal()`, `archiveJob()`, `unarchiveJob()`, `deleteJob()`, `deleteSingleJob()`, `saveAsTemplate()`, `deleteTemplate()`** -- all must remain callable. The new layout just calls them differently (table row click instead of list button click, etc.).
- **The job search (`#jobSearchInput`)** and the browse dropdown (`#jobSelectorDropdown`) can be replaced by the new search bar and table, but make sure the same search behavior exists (search by job#, client name, description).
- **`applyLandingFilters()`** will need to be rewritten to work with the new filter pills instead of the old sidebar selects/inputs. The existing filter element IDs (`filterCSR`, `filterClient`, `filterDateFrom`, `filterDateTo`) can be removed if replaced by equivalent functionality.
- **`renderArchivedJobs()` and `renderTemplatesCol()`** should still work -- just rendered into the new bottom panels instead of left columns.
- **Do not touch anything outside the landing page.** The nav bar, job header billboard, checklist panels, department tabs, Quill editor, print system, component tabs, version picker, inline edit -- all untouched.

## Files to edit

| File | What changes |
|------|-------------|
| `prepress-mdrive/index.html` | Replace `#noJobState` div contents with new layout |
| `prepress-mdrive/css/styles.css` | Replace `.no-job` grid styles + add table/filter/pagination styles |
| `prepress-mdrive/js/app.js` | Rewrite `renderRecentJobs()` into `renderJobTable()`, add pagination state, add sort state, add multi-select filter logic, update `applyLandingFilters()` |

## Files NOT to edit

- `prepress-mdrive/js/prepress.js` -- department config, no changes
- `prepress-mdrive/js/techservices.js` -- department config, no changes
- `prepress-mdrive/js/meeting-attendees.js` -- attendee picker, no changes
- `prepress-mdrive/js/ui-toggles.js` -- sidebar chrome, no changes
- `server-sql/` -- synced by deploy, never edited directly

## Design reference

All styles should use existing design tokens from styles.css:
- Fonts: `--font-body` (DM Sans), `--font-mono` (JetBrains Mono), `--font-display` (Bitter)
- Colors: `--ink`, `--ink-soft`, `--ink-muted`, `--accent` (#CB333B), `--surface`, `--border`, etc.
- Radii: `--radius-sm`, `--radius-md`
- Shadows: `--shadow-sm`, `--shadow-md`

The mockup HTML (`documentation/mockup-landing-server.html`) already uses these tokens. Copy the CSS from there as a starting point.

## Test plan

After the redesign, verify:
- [ ] Creating a new job from the landing page
- [ ] Opening a job by clicking a table row
- [ ] My Jobs tab shows only jobs assigned to current user
- [ ] All Jobs tab shows all active jobs
- [ ] Search filters the table in real time
- [ ] Multi-select CSR/Assignee/Client filters work and stack
- [ ] Department pill filters work
- [ ] Time range pills filter by date
- [ ] Pagination shows correct page counts and navigates
- [ ] Per-page selector (10/25/50) works
- [ ] Column sorting works (click header to toggle)
- [ ] Archive section shows archived jobs with restore button
- [ ] Templates section shows saved templates
- [ ] Delete job (admin password still required)
- [ ] Import/Export still accessible
- [ ] Dark mode still works on the new layout
- [ ] Print from landing page (if a job is not open, these buttons are disabled -- verify still disabled)
