# Codebase Audit — 2026-04-20

**Scope:** `prepress-mdrive/` (excludes `documentation/` and `lib/`)
**Files scanned:** 9 (1 HTML, 5 JS, 3 CSS — 10,174 total lines)
**Findings:** 22 total

---

## Resolution status as of 2026-04-23

This file is a snapshot. A cleanup sweep between the audit date and 2026-04-23 resolved most of the Critical and Hygiene findings. Status below; run a fresh audit (per `AUDIT_codebase_review.md`) to get a current picture.

| Finding | Status |
|---|---|
| **C1** — `ts_sp7n` dangling | ✅ Resolved (no longer in `js/app.js`) |
| **C2** — `ts_ps3n` dangling | ✅ Resolved (no longer in `js/app.js`) |
| **H1** — `normalizeDim` orphan | ✅ Resolved |
| **H2** — `toggleGroup` + `section-toggle-all` CSS orphans | ✅ Resolved |
| **H3** — `updatePressDropdown` / `updateFlatSizeDropdown` wrappers | ✅ Resolved |
| **H4** — `generateSpecsText` orphan | ✅ Resolved |
| **H5** — 12 orphan CSS classes | ✅ Resolved (no matches in current CSS) |
| **H6** — TODO at index.html:1384 | ⚠ Still present (now at line 1288) |
| **H7** — Stale line-number comment at techservices.js:151 | ⚠ Unverified; comment may have been dropped with H2 cleanup |
| **H8** — 91 `!important` uses (83 styles + 8 techservices) | ⚠ Unchanged |
| **H9** — 29 inline styles in index.html | ⚠ Likely unchanged |
| **D1** — Mixed event binding (101 onclick vs 59 addEventListener) | ⚠ Unchanged |
| **D2** — Print-template inline CSS in app.js | ⚠ Unchanged |
| **D3** — Prepress/TS registry parallelism | By design, no change needed |
| **D4** — Repeated CSS for print/dark-mode scoped blocks | By design |
| **I1–I7** — Informational only, no status tracking |  |

The original body is preserved below for historical context.

---

## Summary

- **2 critical** — dangling DOM-selector targets that silently no-op
- **9 hygiene** — dead code, stale comments, orphan CSS, style inconsistencies
- **4 duplication** — intentional parallelism mostly; two patterns worth a look
- **7 informational** — size/complexity metrics; no action implied

## Critical

### [C1] Dangling data-id `ts_sp7n` in app.js

- **Location:** `js/app.js:2322`
- **Finding:** `['sp7n', 'ts_sp7n'].forEach(dataId => { … const indiciaInput = document.querySelector('[data-id="' + dataId + '"]'); if (!indiciaInput) return; … })` iterates over both the live Prepress `sp7n` and the removed Tech Services `ts_sp7n`. Only `sp7n` exists in `index.html` (line 746); `ts_sp7n` has no matching element.
- **Why flagged:** `querySelector` returns `null`, the early-return skips the loop body silently. The code reads as if both departments have an Indicia row; in reality only Prepress does. Misleads future readers and bloats the symbol surface.
- **Recommendation:** Known to the team — `documentation/WO_BACKLOG.md:57` explicitly tracks this ("audit app.js for TS-specific hardcoded IDs (`ts_sp7n`, `ts_ps3n`, etc.) and genericize via the registry"). Resolve together with C2.

### [C2] Dangling data-id `ts_ps3n` in app.js event listeners

- **Location:** `js/app.js:106`, `js/app.js:109`
- **Finding:** Two global event listeners use `e.target.matches('[data-id="ps3n"], [data-id="ts_ps3n"]')` to trigger flat-size autocomplete. `ts_ps3n` is not present in `index.html` and cannot be reached. The comment at `js/techservices.js:151` confirms: *"No-op: TS no longer has a flat-size field. app.js:100 calls this on every keyup."* (The comment's line reference is also stale — see H7.)
- **Why flagged:** Same class of defect as C1 — selectors that can't match; code documentation suggests this was once wired up and got partially removed.
- **Recommendation:** Remove `, [data-id="ts_ps3n"]` from both selectors (?). If TS flat-size is planned to come back, leave a comment stating intent rather than a dead matcher.

## Hygiene

### [H1] Orphan helper `normalizeDim()` in app.js

- **Location:** `js/app.js:93`
- **Finding:** Function is defined but no caller anywhere. `prepress.js:131` owns its own `_normalizeDim` method on the registry; that version is used (`prepress.js:114`, `prepress.js:124`). The top-level `normalizeDim` appears to be leftover from before the registry extraction.
- **Recommendation:** Likely safe to delete (?). Confirm no external script/tool consumes it.

### [H2] Orphan function `toggleGroup()` + related orphan CSS class

- **Location:** `js/app.js:1730` (function), `css/styles.css` (class `section-toggle-all` with no HTML referent)
- **Finding:** `toggleGroup(groupCheckbox, forceToggle)` has no callers. Its own body comment says *"When called from 'Toggle All' span, flip the checkbox manually"* — suggesting a planned span UI that was never wired. The orphan CSS class `section-toggle-all` (no HTML or `classList.add('section-toggle-all')` callsites) looks like the missing counterpart.
- **Recommendation:** Either complete the "Toggle All" feature (wire HTML + CSS + JS) or remove both (?). Flagging to make the decision explicit rather than leaving three artifacts from an abandoned feature.

### [H3] Orphan legacy wrappers `updatePressDropdown` / `updateFlatSizeDropdown`

- **Location:** `js/app.js:89`, `js/app.js:90`
- **Finding:** Two 1-line wrapper functions marked by comment `// Legacy wrappers — delegate to department registry`. Neither has a caller. Both reduce to `updateDeptDropdowns()`.
- **Recommendation:** Looks like forward-compat shim that was never needed after the registry refactor. Safe to delete if no tooling references them (?).

### [H4] Orphan registry method `generateSpecsText` on Prepress

- **Location:** `js/prepress.js:171-202` (~32 lines)
- **Finding:** Method builds a structured "specs block" array from 11 field values (`flatSize`, `presswork`, `press`, `indicia`, etc.). No caller in `app.js`, `techservices.js`, or HTML. TS registry has no equivalent (asymmetry).
- **Recommendation:** If this is staged for an upcoming "insert specs block" feature, leave it with a `// Staged for: <feature>` comment so it's not mistaken for dead code. Otherwise remove, together with parallel stub on TS (?).

### [H5] Orphan CSS classes with no HTML/JS referent

- **Location:** `css/styles.css`, `css/techservices.css`
- **Finding:** 12 class selectors with no match in HTML, no `classList.add/toggle/remove`, and no JS template-string reference:
  - `badge-update`
  - `checklist-grid`
  - `component-tab-actions`
  - `csr-history-entry`
  - `csr-history-ts`
  - `job-field-value--due`
  - `job-filters`
  - `job-search-match`
  - `master-checkbox` (note: HTML uses `id="masterCheckbox"`, not class)
  - `nav-job-name`
  - `print-value--due`
  - `section-toggle-all` (see H2)
- **Why flagged:** Pure CSS with no consumers — rules don't style anything.
- **Recommendation:** Spot-check each before deletion; a few look like BEM modifiers (`--due`) whose base rule may have been refactored out from under them (?).
- **Not flagged here:** 11 `ql-*` classes (`ql-active`, `ql-container`, `ql-editor`, `ql-toolbar`, etc.) are generated at runtime by Quill — legitimate styling targets even without static references.

### [H6] Single TODO comment

- **Location:** `index.html:1384`
- **Finding:** `<!-- TODO: Add "Shared Editing" tutorial section when internal server goes live. …heartbeat/auto-expire behavior, what happens on tab close. -->`
- **Why flagged:** Intentional deferred feature, but worth listing so David can confirm it's still desired.
- **Recommendation:** Leave as-is unless the "internal server" plan has shifted. No action implied.

### [H7] Stale line-number reference in comment

- **Location:** `js/techservices.js:151`
- **Finding:** Comment reads *"app.js:100 calls this on every keyup."* Actual callers are at `js/app.js:106` and `js/app.js:109`.
- **Why flagged:** Documentation drift. Code moves; line-number comments rot. If C2 is resolved, this comment becomes obsolete anyway.
- **Recommendation:** Replace line reference with symbolic reference (e.g., "the blur/keydown listeners near the top of app.js") or drop the line number (?).

### [H8] Heavy `!important` usage

- **Location:** `css/styles.css` (83 uses), `css/techservices.css` (8 uses) — **91 total**
- **Why flagged:** Quantity is a specificity smell. Not individually wrong, but a high count suggests selector-override fights rather than systematic cascade ordering.
- **Recommendation:** Informational for now. If a future CSS refactor is on the table, this is the metric to track (aim to drop it).

### [H9] Inline styles on elements that have a class

- **Location:** `index.html` — 29 instances of `style="…"`
- **Finding:** Vast majority are `style="display:none;"` for FOUC defense on toggleable elements (`printHeader`, `lockBanner`, `readonlyBadge`, various hidden inputs). A few carry brand styling inline, e.g., `index.html:186` uses `style="font-weight:600;color:var(--accent);"` on a print-header span. This is the documented pattern from MEMORY.md ("CSS `display:none` FOUC defense vs JS toggle" — use `element.style.display = 'block'`, not `= ''`).
- **Why flagged:** The `display:none` uses are intentional. The inline `font-weight`/`color` on already-classed spans could be hoisted to CSS.
- **Recommendation:** Inline `display:none` is correct; flag the ~5 lines with inline typography/color for future cleanup (?). No action required.

## Duplication

### [D1] Mixed event-binding style (inline handlers vs addEventListener)

- **Location:** Whole project
- **Finding:** `index.html` has **101 inline `onclick=`**, **18 inline `on(change|input|blur|focus|keydown|keyup)=`** handlers. `app.js` uses **59 `addEventListener`** calls. Inline handlers are preferred for simple button actions and component panels; event delegation is used for `.notes`, `.toggle-switch`, `.field-row`, etc.
- **Why flagged:** Not a bug — both styles coexist intentionally. Worth knowing the split: new contributors often assume one convention; the truth is "inline for named button actions, delegation for form/checklist interactions."
- **Recommendation:** Possibly document the rule in a CSS/JS conventions section, or migrate simple onclick handlers to delegated listeners. Low priority.

### [D2] Print-template inline CSS strings in app.js

- **Location:** `js/app.js:2466-2523` (and other print-HTML builders around line 4243)
- **Finding:** Print-time HTML is built with large template literals carrying inline styles — `font-weight:700`, `font-size`, `color`, `padding`, `border-radius` repeated across many lines. `font-weight:700` alone appears 21 times in app.js.
- **Why flagged:** Repeated magic values; also bypasses `--accent` tokens in some spots (though most hit `${accentColor}` correctly).
- **Recommendation:** Possible refactor candidate — a dedicated `css/print.css` with print-scoped rules, referenced from a minimal print HTML skeleton. Not a bug. Substantive enough that it should be a planned piece of work, not a cleanup (?).

### [D3] Prepress vs Tech Services registry parallelism

- **Location:** `js/prepress.js` vs `js/techservices.js`
- **Finding:** Both registries expose the same surface: `id`, `label`, `panelId`, `sidebarTitle`, `printAccent`, `printHeading`, `ASSIGNEE_OPTIONS`, `PRINT_SECTIONS`, `REQUIRED_FIELDS`, `REQUIRED_SKIP_ENVELOPE`, `getRequiredFields()`, `isEnvelopeComponent()`, `updateDropdowns()`, `autoCompleteFlatSize()`. Prepress has five domain-specific extras (`ENVELOPE_KEYWORDS`, `FLAT_SIZES_*`, `PIECE_FORMAT_OPTIONS`, `PRESS_*`, `_normalizeDim`, `flatSizeFieldId`, `pressFieldId`, `generateSpecsText`); TS has two (`DEDUP_METHODS`, `PRESORT_OPTIONS`).
- **Why flagged (and noted as "not a problem"):** Per the audit spec, this is **intentional** parallelism. Flagging only so future audits don't re-raise it. The asymmetry is domain-driven: flat-size/press concepts don't apply to TS.
- **Recommendation:** None. This is by design.

### [D4] Repeated CSS selectors across scoped blocks

- **Location:** `css/styles.css`, `css/techservices.css`
- **Finding:** Several selectors declared twice (base + `@media print`, base + `[data-theme="dark"]`). Examples: `.meeting-chip`, `.dept-tab`, `.resize-handle.dragging::after`.
- **Why flagged:** These are legitimate scoped overrides (dark mode, print mode). Listed so they don't trip a future automated duplication check.
- **Recommendation:** None.

## Informational

### [I1] `js/app.js` is 5,171 lines

- **Why listed:** Known large file (called out in audit spec). Documented for metric tracking.
- **Recommendation:** None.

### [I2] `css/styles.css` is 2,539 lines

- **Why listed:** Over the 2,000-line informational threshold.
- **Recommendation:** None; consistent with a single-main-stylesheet pattern.

### [I3] Functions approximately >100 lines in app.js

Approximate measurements (line count between successive `function` declarations; may over-count when a function contains nested helpers):

| Line | Function | Approx. length |
|-----:|----------|----:|
| 259 | `autoResizeAllTextareas` | ~116 |
| 990 | `renderRecentJobs` | ~129 |
| 2430 | `stripSpecsMarkers` | ~142 |
| 3326 | `cleanVal` | ~139 |
| 3471 | `val` | ~226 |
| 3697 | `selectQuickPick` | ~125 |
| 4243 | `printHelpGuide` | ~138 |

- **Recommendation:** None; informational only.

### [I4] Long CSS selector chain

- **Location:** `css/techservices.css:128`
- **Finding:** `.dept-techservices .section-group.placeholder-section.collapsed .section-title { … }` — 5 classes chained.
- **Recommendation:** None; slightly fragile to refactor but a single occurrence.

### [I5] JS indentation >6 levels

- **Location:** Several lines in `js/app.js` (e.g., `170`, `203-205`, `781`, `888-889`, `3294-3295`, `3612`, and others) reach 6+ levels of indentation.
- **Why listed:** Spec threshold is >4 levels. Does not appear to reflect structural problems — mostly multi-line object-literal positioning and deeply-chained promise handlers. Included for metric awareness.
- **Recommendation:** None; informational.

### [I6] Quill runtime classes

- **Why listed:** 11 `ql-*` classes (`ql-active`, `ql-blank`, `ql-container`, `ql-editor`, `ql-fill`, `ql-picker`, `ql-picker-item`, `ql-picker-label`, `ql-size-large`, `ql-size-small`, `ql-snow`, `ql-stroke`, `ql-toolbar`) appear in the CSS but never in static HTML/JS. They are generated at runtime by Quill and are legitimate styling targets.
- **Recommendation:** None; do NOT flag these as orphan CSS in future audits.

### [I7] Alert/confirm usage

- **Why listed:** `app.js` uses `alert()` (17 call sites) and `confirm()` (12 call sites). All are user-facing dialogs (delete confirmations, error messages, max-limit warnings), not debug leftovers. Only 1 `console.*` call exists (a legitimate `console.error` at `js/app.js:1125` for localStorage parse failure).
- **Recommendation:** None. Eventual replacement with a styled modal/toast would be a UX decision, not a hygiene issue.

## Notes

- **`ts_sp7n` / `ts_ps3n`** are already tracked in `documentation/WO_BACKLOG.md:57` as a known cleanup item ("audit app.js for TS-specific hardcoded IDs … and genericize via the registry"). C1/C2 are this audit's codification of that backlog item against the current tree.
- **Prepress/TS registry asymmetry** is intentional per the audit spec. D3 calls it out only so future audits don't re-flag it.
- **The Prepress `generateSpecsText` orphan (H4), the `toggleGroup` orphan (H2), the `section-toggle-all` orphan CSS (H5), and the `updatePressDropdown`/`updateFlatSizeDropdown` wrappers (H3) together suggest ~3 partially-landed or planned features that never got fully wired up**. Cleaning these is independent of product work.
- **No `debugger` statements, no `console.log/debug`, no commented-out code blocks** — code hygiene at the line level is strong.
- **No broken `<script>`/`<link>` tags**; all script and stylesheet references resolve.
- **Directory is clean** — no backup files, stray zips, or orphan artifacts in the tree.
