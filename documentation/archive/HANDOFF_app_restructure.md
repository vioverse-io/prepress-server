# HANDOFF — App restructure session

This handoff is for a focused restructure session at home. The session does two things:

1. **Phase A — Registry-shape unification.** Finish the symmetry between Prepress and Tech Services so `app.js` dispatches through a uniform registry interface, with no Prepress-specific direct accesses. Small, surgical, ~1-3 hours.
2. **Phase B — Split `app.js` into modules.** Move the ~5,500-line single file into topical modules so the code is navigable and the next architectural step (the server cutover) has cleaner seams. Larger and riskier, ~4-8 hours.

**Explicitly out of scope** for this session: HTML sanitization (DOMPurify), schema typedefs, factory functions, FIELD_IDS catalog, JobsStore persistence abstraction, removing inline `onclick` handlers, writing automated tests. The reasoning for each is in the "Deferred work" section at the bottom. Don't bundle any of them in.

---

## Where things stand

The M-drive app (`prepress-mdrive/`) is in daily production use at work. The coworker copy at work runs on a stable, pre-restructure version. The home copy is being prepped for the restructure. The Node server version (`prepress/public/`) hosts the same code at `vioverse.io` and is the eventual deploy target via `/prepress-deploy`. **This session does not deploy.** The home version stays at home until it has soaked through 2-4 weeks of real use without regressions.

### What's already done in the codebase

- The `DEPT_REGISTRY` pattern is real and working. Both Prepress and Tech Services register field definitions, dropdowns, required fields, and `PRINT_SECTIONS` on `window.DEPT_REGISTRY`.
- Prepress already has its registry populated in `js/prepress.js` (PIECE_FORMAT_OPTIONS, FLAT_SIZES_STANDARD/ENVELOPE, PRESS_STANDARD/ENVELOPE, ENVELOPE_KEYWORDS, REQUIRED_FIELDS, REQUIRED_SKIP_ENVELOPE, `isEnvelopeComponent`, `getRequiredFields`, `updateDropdowns`, `autoCompleteFlatSize`, PRINT_SECTIONS, `printAccent`). Don't move those again — they're already where they need to be.
- Tech Services has the full extended registry shape in `js/techservices.js` (`summaryMarkerStart`, `summaryMarkerEnd`, `summaryFingerprint`, `validateSummary`, `generateSummary` plus everything Prepress has).
- The dept-swap orchestration in `app.js` around `function switchDepartment(deptId)` reads the active dept's registry and dispatches uniformly for most behaviors.

### The remaining asymmetry that Phase A fixes

Three pieces of Prepress logic still live in `app.js` as standalone functions and constants rather than as registry methods. They are defined in `app.js` (~lines 3305-3710) and assigned to the registry at runtime, but should move physically into `js/prepress.js` to match the TS pattern:

- `specsFingerprint(comp)` becomes `DEPT_REGISTRY.prepress.summaryFingerprint(comp)`
- `generateSpecsSummary(comp)` becomes `DEPT_REGISTRY.prepress.generateSummary(comp)`
- `validateSpecs(comp)` becomes `DEPT_REGISTRY.prepress.validateSummary(comp)`
- `SPECS_MARKER_START` and `SPECS_MARKER_END` constants become `summaryMarkerStart` and `summaryMarkerEnd` on the registry

And two pieces of dept-hardcoded knowledge still live outside the registry pattern:

- `updateRowVisibility()` in `app.js` (~line 2339) directly references `window.DEPT_REGISTRY.prepress` to handle the Indicia row's envelope-only enable/disable logic. Replaces with a `disabledFields(comp)` registry hook.
- `js/meeting-attendees.js` (lines 24-25) explicitly names `DEPT_REGISTRY.prepress` and `DEPT_REGISTRY.techservices` by string to pull their `ASSIGNEE_OPTIONS` rosters. Replaces with a generic `Object.values(DEPT_REGISTRY)` loop.

And one likely-dead fallback to investigate and remove:

- `const PRINT_SECTIONS = [...]` at `app.js:2388` is a Prepress-mirror fallback used only if `dept.PRINT_SECTIONS` is missing. Since `prepress.js` always ships its own `PRINT_SECTIONS`, this fallback is unreachable. Confirm with grep before deleting.

**Already resolved** (from prior cleanup sessions -- no longer in the codebase):
- `normalizeDim()` orphan -- removed
- `toggleGroup()` + `section-toggle-all` CSS orphan -- removed
- `updatePressDropdown` / `updateFlatSizeDropdown` wrappers -- removed
- `generateSpecsText` orphan on prepress registry -- removed
- `ts_sp7n` / `ts_ps3n` dangling references -- removed

`js/ui-toggles.js` has zero dept-specific logic. No work needed there.

---

## Hard rules

These are not negotiable.

1. **The app must work after every commit.** Not at the end of the session — after every commit. If a commit breaks the app, the rollback is `git reset --hard HEAD~1` and rewrite the commit. Do not patch forward.

2. **Use the existing data shape.** Existing localStorage state from users at work must load without migration. Don't rename keys (`prepressJobs` stays `prepressJobs`, `prepressActiveJob` stays `prepressActiveJob`, etc.). Don't change the `comp.checkboxes` / `comp.notes` / `comp.instructions_<deptId>` shape. The migrations (`migrateJobToComponents`, `migrateInstructionsToPerDept`) must continue to run on load.

3. **No UI changes.** No HTML restructuring, no CSS overhaul, no visual differences. The user-visible app should be byte-identical after the restructure.

4. **No bundler, no framework, no TypeScript compiler.** Stay with sequential `<script>` tags loaded from `index.html`. JSDoc `@typedef` blocks are fine if they help, but no compile step.

5. **Don't touch `prepress/public/` directly.** The home work happens in `prepress-mdrive/`. When the restructure is stable, `/prepress-deploy` syncs to `prepress/public/`. Editing the Node copy directly causes drift the deploy can't recover from.

6. **Small commits, with smoke tests between them.** The 12-step manual smoke test (below) runs after every meaningful commit. If a commit fails the smoke test, the commit reverts and gets rewritten. No "I'll fix it in the next commit."

7. **No deploy during this session.** `/prepress-deploy` is not run. The home version stays home until it has been used daily for 2-4 weeks without surfacing regressions.

---

## Pre-flight — do these BEFORE any code change

These six steps protect against rollback panic later. If any of them fails or surfaces something unexpected, stop and report to the user before touching code.

1. **Confirm the working directory.** You should be in `/home/avid_arrajeedavey/dev/prepress/prepress-mdrive/`. Verify with `pwd`. If you're not, navigate there before doing anything else.

2. **Confirm git is clean.** `git status` should show no uncommitted changes. If it shows changes, surface them to the user before continuing — those changes might be pending product edits the user shipped to work, and you'd lose them.

3. **Verify the work-side snapshot is in place.** Ask the user to confirm that the coworker copy at work is on a stable, known-good version that does NOT include the restructure. The whole point of this session is that home and work can diverge safely; that only works if work is on a stable base.

4. **Identify the wrapper structure.** Read the first 5 and last 5 lines of `js/app.js`. Confirm whether the ~5,500 lines are wrapped in an IIFE (e.g., `(function(){ ... })();`), in a `DOMContentLoaded` callback, or are at top-level script scope. This decides Phase B's splitting strategy. Report what you find before starting Phase B.

5. **Start a local dev server.** From `prepress-mdrive/`, run `python3 -m http.server 3000`. Open `http://localhost:3000` in a browser. Confirm the app loads, a job opens, the dept tabs switch, undo/redo works, and print produces a PDF. This is your "known good" baseline.

6. **Export an active-jobs JSON.** Use the More dropdown → Export. Save the resulting JSON somewhere outside the project folder (e.g., `~/wo-backup-pre-restructure-<date>.json`). This is the data rollback path if a commit corrupts localStorage somehow.

---

## Phase A — Registry-shape unification

Estimated effort: 1-3 hours. Likely 6-8 commits. The smoke test runs after every numbered step below.

### A1. Move `specsFingerprint` → `prepress.summaryFingerprint`

- Find `function specsFingerprint(comp)` in `app.js`. Note its body.
- Find all call sites in `app.js` (grep for `specsFingerprint(`).
- Add `summaryFingerprint: function(comp) { ... }` to the `DEPT_REGISTRY.prepress` object in `js/prepress.js` with the same body.
- Update each call site in `app.js` to dispatch through the active dept's registry: `DEPT_REGISTRY[activeDepartment].summaryFingerprint(comp)`. If the call site already has a `dept` local variable in scope, prefer `dept.summaryFingerprint(comp)`.
- Delete the original `function specsFingerprint` from `app.js`.
- Commit: `Move Prepress specsFingerprint to registry as summaryFingerprint`
- Smoke test: open a job, fill in some fields, switch components, switch depts. No console errors.

### A2. Move `generateSpecsSummary` → `prepress.generateSummary`

- Same procedure as A1 but for the larger function. This function is significant (~150 lines based on its position at `app.js:3339-3489`).
- This function references several Prepress-specific helpers (`val`, `cleanVal`, `parseDims`, etc.). Decide for each: does it move with the function or stay as a shared utility in `app.js`? Default rule: helpers that are ONLY used by this function move with it. Helpers used by other code stay.
- Commit: `Move Prepress generateSpecsSummary to registry as generateSummary`
- Smoke test: trigger the Generate button if exposed in the UI; otherwise call the function from the browser console with a real component. Output should match pre-move output byte-for-byte.

### A3. Move `validateSpecs` → `prepress.validateSummary`

- Same procedure as A1 and A2.
- Commit: `Move Prepress validateSpecs to registry as validateSummary`
- Smoke test: any QC validation flow should still fire and show the same warnings.

### A4. Move `SPECS_MARKER_START` / `SPECS_MARKER_END` → `prepress.summaryMarkerStart` / `summaryMarkerEnd`

- These are string constants. Find them in `app.js`. Add `summaryMarkerStart: '...'` and `summaryMarkerEnd: '...'` to the `DEPT_REGISTRY.prepress` registry object.
- Update consuming code (search for `SPECS_MARKER_START` and `SPECS_MARKER_END`). The relevant consumer is the `stripSpecsMarkers` function inside `buildPrintHTML` (which already iterates `Object.values(DEPT_REGISTRY).forEach(d => ... d.summaryMarkerStart ...)` per `app.js:2434-2437`). That code is already shape-correct for TS; once Prepress also has the new keys, the function works for both without change.
- Delete the constants from `app.js`.
- Commit: `Move Prepress specs markers to registry`
- Smoke test: print a Prepress component that has a Generate-summary block in its instructions. The marker lines should be stripped from the print output, same as before.

### A5. Add `disabledFields(comp)` hook; rewrite `updateRowVisibility`

- Add to `js/prepress.js` registry:
  ```js
  disabledFields: function(comp) {
      if (comp && this.isEnvelopeComponent(comp.name)) return new Set();
      return new Set(['sp7n']); // Indicia disabled for non-envelope components
  },
  ```
- Add to `js/techservices.js` registry:
  ```js
  disabledFields: function(comp) {
      return new Set(); // No envelope-only rules yet (TBD pending Jason)
  },
  ```
- In `app.js` `updateRowVisibility()`, replace the hardcoded Indicia block (around lines 2316-2331) with a generic loop that asks the active dept for its disabled set and applies it uniformly. For each `data-id` in the disabled set, find its closest `.field-row`, disable the input + checkbox + quick-pick button. Either keep the existing `indicia-disabled` CSS class for Prepress (verify it still matches in `css/styles.css` and `css/prepress.css`) or rename it to a generic `field-disabled` class (your call, but it's a UI change if you rename — review whether the existing class name is referenced anywhere else first).
- Commit: `Replace hardcoded Indicia disable with disabledFields registry hook`
- Smoke test: create a Letter component (non-envelope). Indicia field should be disabled. Create a No. 10 Envelope component. Indicia should be enabled. Switch to TS tab. No fields disabled.

### A6. Delete the dead-letter `PRINT_SECTIONS` fallback

- Grep for the `const PRINT_SECTIONS` declaration at `app.js:2388`. Confirm the fallback `dept.PRINT_SECTIONS || PRINT_SECTIONS` is the ONLY reference.
- Confirm Prepress's registry ships `PRINT_SECTIONS` (it does, at `js/prepress.js:139-169`) and TS does too (`js/techservices.js:44-99`). So the fallback is unreachable in production.
- Delete the local `const PRINT_SECTIONS = [...]` at `app.js:2388`. Replace `dept.PRINT_SECTIONS || PRINT_SECTIONS` with `dept.PRINT_SECTIONS || []` (the empty-array fallback prevents a crash if some future dept ships without PRINT_SECTIONS; the original prepress-mirror fallback was just dead defensive code).
- Commit: `Remove dead-letter PRINT_SECTIONS fallback in app.js`
- Smoke test: print from Prepress, print from TS. Both should produce the same output as before.

### A7. Make meeting-attendees dept-agnostic

- Open `js/meeting-attendees.js`. Find the `getCombinedRoster` function (lines 12-46).
- Replace the explicit `DEPT_REGISTRY.prepress` and `DEPT_REGISTRY.techservices` references (lines 24-27) with a generic loop:
  ```js
  Object.values(window.DEPT_REGISTRY || {}).forEach(d => {
      add(d.ASSIGNEE_OPTIONS, d.label || 'Dept');
  });
  ```
- Keep the CSR roster pull unchanged (lines 29-40). That comes from the DOM, not the registry.
- Commit: `Make meeting-attendees roster build dept-agnostic`
- Smoke test: open a TS component, click the "Meeting Required" attendees button. The list should show every Prepress assignee, every TS assignee, and every CSR — same as before, but the code now scales to a third department automatically.

### Phase A done when

- Grep `'prepress'` (the string literal) in `app.js`. The only matches should be either literal string IDs that legitimately need the dept name (e.g., `instructions_prepress` storage keys are fine because that IS the dept ID), or generic dispatch through `DEPT_REGISTRY[activeDepartment]`.
- Both Prepress and Tech Services expose the same surface: `summaryMarkerStart`, `summaryMarkerEnd`, `summaryFingerprint`, `generateSummary`, `validateSummary`, `disabledFields`, `isEnvelopeComponent`, `getRequiredFields`, `updateDropdowns`, `autoCompleteFlatSize`, `PRINT_SECTIONS`, `printAccent`, plus their labels.
- `js/meeting-attendees.js` doesn't name any specific dept by string.
- The 12-step smoke test (below) passes.

---

## Phase B — Split `app.js` into modules

Estimated effort: 4-8 hours. Likely 10-20 commits. This is the larger and riskier piece.

### B0. Decide the state-sharing strategy

Based on what you found in pre-flight step 4 (the wrapper check):

**If `app.js` IS wrapped in an IIFE:** the simplest no-bundler approach is to introduce a `window.WO` namespace object at the top of a new `core.js` module. Shared mutable state moves to `window.WO.state.<name>`. Each module's IIFE attaches its public functions either to `window.WO.<modulename>.<fnname>` (preferred for internal calls) or directly to `window.<name>` (required for functions called from inline HTML `onclick` handlers, since those run in the global scope).

**If `app.js` is at top-level script scope (no IIFE):** the shared variables are already globals. Split files just need to be loaded in the right order so dependencies are defined before consumers. No `window.WO` namespace is strictly needed, but adding one is still good hygiene.

Pick the strategy. Document it in a one-paragraph comment at the top of `core.js`. Stick to it throughout — no mixing.

### B1. Create `core.js` with the shared state

The first new module. Contains:

- The `window.WO` namespace initialization (if using namespace strategy)
- Theme toggle and FOUC guard wiring (the `toggleTheme` function and the inline FOUC script in `index.html` head stay as-is; only the `toggleTheme` function moves)
- Text size toggle
- IDB open (`openIDB`)
- Holiday/greeting helpers (`getHolidayGreetings`, `isFridayThe13th`, `pickGreeting`)
- DOMContentLoaded setup and `setupListeners`
- Whatever shared variables existed at the top of the IIFE: `activeDepartment`, `currentJobId`, `currentComponentId`, `jobsCache`, `undoStacks`, `redoStacks`, `fieldDirty`, `focusSnapshot`, the Quill instance reference, etc.

This module loads early in the script tag order (after the dept registries; see load order at the end of Phase B).

Commit: `Extract core.js with shared state and init`
Smoke test: app loads, theme toggle works, no console errors.

### B2-B12. Extract topical modules one at a time

Order matters — extract dependency-free modules first, leaf modules last.

Suggested module breakdown. The next session can revise this if it sees a cleaner cut after reading the full file:

1. **`profile.js`** — photo upload/crop, user name, greeting display. ~17 functions, mostly self-contained.
2. **`quick-pick.js`** — the dropdown widget logic. `toggleQuickPick`, `getFilterText`, `filterQuickPickOptions`, `selectQuickPick`. Used by many other places, so extract early to define the dependency boundary.
3. **`templates.js`** — template CRUD and apply-to-component logic.
4. **`undo-redo.js`** — `captureState`, `restoreState`, `pushToUndo`, `undo`, `redo`, `updateUndoRedoButtons`, `saveJobStateWithoutHistory`. Tightly coupled to shared state but has a clear external API.
5. **`required-fields.js`** — `getActiveRequiredFields`, `getDeptRequiredFields`, `getRequiredStatus`, `updateRequiredBadge`, `updateRequiredIndicators`, status helpers.
6. **`print.js`** — `buildPrintHTML`, `printViaIframe`, `printChecklist`, `printAllComponents`, `printAllComponentsCombined`, filename helpers.
7. **`jobs.js`** — job CRUD, list, search, filters, archive, export, import, the no-job state. Largest extracted module probably.
8. **`components.js`** — component CRUD, tabs, switching, rename, duplicate.
9. **`departments.js`** — `switchDepartment`, `updateDeptDropdowns`, `updateRowVisibility`.
10. **`quill-editor.js`** — Quill init, paste matchers, the swap-on-dept-switch helper, revision timeline building.
11. **`modals.js`** — `showToast`, `showWarningModal`, `showQcWarning`, help modal, version picker.
12. **`inline-edit.js`** — inline field editing (job header fields, assignee).

After each extraction:

- Commit with a descriptive message naming the module (e.g., `Extract profile.js (photo crop + greeting)`).
- Run the full 12-step smoke test below.
- If smoke test fails, `git reset --hard HEAD~1` and rewrite the commit. The branch stays committable.

### B-final. Update `index.html` script load order

Once all modules are extracted, the bottom of `index.html` loads them in dependency order. Rough order (adjust based on what dependencies actually surface):

```html
<script src="js/prepress.js"></script>
<script src="js/techservices.js"></script>
<script src="js/core.js"></script>
<script src="js/profile.js"></script>
<script src="js/quick-pick.js"></script>
<script src="js/templates.js"></script>
<script src="js/undo-redo.js"></script>
<script src="js/required-fields.js"></script>
<script src="js/print.js"></script>
<script src="js/jobs.js"></script>
<script src="js/components.js"></script>
<script src="js/departments.js"></script>
<script src="js/quill-editor.js"></script>
<script src="js/modals.js"></script>
<script src="js/inline-edit.js"></script>
<script src="js/meeting-attendees.js"></script>
<script src="js/ui-toggles.js"></script>
```

What's now in `js/app.js`? Either delete it (if everything moved out) or leave it as a thin bootstrap file with only DOMContentLoaded entry-point wiring. Handler's call — but the file shrinks from 5,500 lines to either 0 or under ~100.

### Phase B done when

- `js/app.js` is gone (or is a thin bootstrap file under ~100 lines).
- 12-step smoke test passes.
- The app behaves byte-identically to the pre-restructure version.

---

## 12-step manual smoke test

Run after every commit. Yes, every commit. The discipline is what protects against regression accumulation.

1. **Load.** App loads at `http://localhost:3000`. No console errors. Landing page shows recent jobs.
2. **Theme.** Toggle dark mode. Toggle back. No FOUC. No console errors.
3. **Open a job.** Click a recent job. It opens. Both dept tabs visible. Component tabs visible.
4. **Field save.** Type into a text field, toggle a checkbox. Wait 2 seconds. Reload the page. Job reopens with values preserved.
5. **Dept switch.** Click TS tab. Click Prepress tab. Each shows its own fields. Each shows its own Quill content. Each remembers its own checkboxes.
6. **Component switch.** Click a different component tab. Different fields and values. Click back. Original state preserved.
7. **Undo/redo.** Type into a field, then `Ctrl+Z`. Field reverts. `Ctrl+Y`. Field redoes.
8. **New job.** Click + New Work Order. Fill in required fields. Save. Job appears in list. Opens correctly.
9. **Add component.** Click + on the component tab strip. Add a "Letter". Verify it gets default field state. Add a "No. 10 Envelope". Verify Indicia is enabled (and was disabled for the Letter).
10. **Print.** Click Print → Print Current. Print preview opens. Active dept's color used (red for Prepress, blue for TS). Filename matches `<jobnum> - <component>`. Cancel the print dialog.
11. **Export/import.** Export a job to JSON. Delete that job. Import the JSON back. Job restored with all state.
12. **Archive/restore.** Archive a job. It moves to the archived list. Click restore. It comes back.

If any step fails, the most recent commit caused it. Revert (`git reset --hard HEAD~1`) and start the affected step over.

---

## Risk-bearing places to test extra carefully

1. **Dept-switch orchestration in `switchDepartment` (currently at `app.js:2197`).** Coordinates the Quill content swap, per-dept storage read/write, `instructionsDisplay` update, `instructionsHistory` update, revision timeline rebuild, QC strip reset. After Phase B, this function lives in `departments.js` and calls into `quill-editor.js` for the Quill piece. Test by switching depts five times in a row, then editing on each side, then switching back. If any state bleeds between depts, something is wrong.

2. **The IDB mirror's auto-recovery on empty localStorage.** If localStorage is empty on boot, the app pulls from IDB and rehydrates. To test: in DevTools, run `localStorage.clear()` while a job is loaded. Reload the page. The app should recover the job list from IDB without losing data.

3. **Inline `onclick` handlers in `index.html`.** Dozens of these (`onclick="openNewJobModal()"`, `onclick="undo()"`, etc.). After Phase B, those functions must remain reachable from global scope. The simplest way: each module that exposes an `onclick`-target function attaches it to `window.<fnname>` explicitly at the bottom of the module file. Audit by grepping `index.html` for `onclick="` and confirming every named function is reachable from `window`.

4. **`meeting-attendees.js` and `ui-toggles.js` interactions.** These two are already separate today, but `meeting-attendees.js` touches `DEPT_REGISTRY` (modified in Phase A7) and `ui-toggles.js` toggles the sidebar footer. Confirm both still work after Phase B by running the meeting-attendees picker on a TS job and toggling the revision timeline.

5. **The `migrateInstructionsToPerDept` and `migrateJobToComponents` paths.** These run on load when an older-shape job is opened. To test: in DevTools, manually edit a job's localStorage entry to remove the `instructions_prepress` key and add a plain `instructions` key (the legacy shape). Reload. The migration should run and restore the per-dept shape.

---

## When the session is done

1. Final 12-step smoke test pass at home.
2. **Do NOT run `/prepress-deploy`.** The work-side coworkers are running on the pre-restructure version. The home version stays home until it has been used daily for 2-4 weeks of real shop-floor work without finding regressions.
3. Update `documentation/WO_BACKLOG.md` if the restructure incidentally closed any items, and add a note under "Sync Discipline" recording the home/work divergence and the projected sync date.
4. Write a session-summary note at the top of this handoff (or as a separate `HANDOFF_app_restructure_complete.md`) with: number of commits made, modules created, anything that surfaced unexpectedly, anything the next session needs to know.
5. When the home version has been used daily for 2-4 weeks without regressions, run `/prepress-deploy` to sync to `prepress/public/`. Don't sync sooner just because "it seems fine" — the regression tail on architectural refactors is longer than intuition suggests.

---

## Deferred work — what's NOT in this session, and why

A prior plan (written by a Claude instance with partial codebase access) included additional phases. Those are deliberately deferred. Each one is the right work at the wrong time for this session.

**HTML sanitization via DOMPurify.** The threat model is stored-XSS through shared JSON imports. Today the app is a single-user M-drive copy — there's no sharing, no multi-user, no server. An attacker would have to craft a malicious JSON file and import it on their own machine, attacking themselves. The XSS surface opens up the moment the server lands and users share data via the server. **Bundle DOMPurify with the server cutover, not before.**

**Schema typedefs, factory functions, FIELD_IDS catalog.** Factory functions for `createJob` / `createComponent` are a real win (eliminates "I forgot to initialize field X" bugs). JSDoc typedefs and FIELD_IDS catalog are overengineered for a two-department app — they pay for themselves when there are 5+ departments. **The right time is when you add a third department** (Lettershop or Imaging from the WO_BACKLOG). At that point, the registry pattern starts to feel rough and factories pay for themselves immediately.

**JobsStore persistence abstraction.** Right shape, wrong time. Building an abstraction before its second implementation exists ships a wrong abstraction. **The right time is the server cutover**, when both `LocalJobsStore` and `RemoteJobsStore` can be designed together against the actual server API shape.

**Removing inline `onclick` handlers in favor of event delegation.** Stylistic noise, not a functional problem. Defer until you've migrated to a component framework, or until the inline-handler pattern is actively causing bugs you can name.

**Writing automated tests.** Manual smoke-test discipline is the working model for now. Adding a test suite is its own session with its own scope. **The right time is when a regression slips through the manual smoke test and costs real shop-floor time.** That pain is what unlocks the budget for test infrastructure.

**Splitting modules further than Phase B's first cut.** If a year of use surfaces that a particular module is still too big or too coupled, that's a separate, smaller session. Don't over-fragment in the first split.

---

## What you (next session) should do FIRST

1. Read this handoff top to bottom. Confirm you understand the two-tree reality (`prepress-mdrive/` vs `prepress/public/`), the hard rules, and the deferred work.
2. Run the six pre-flight steps. Report what you find — especially the wrapper-structure check from step 4.
3. Surface anything in the current codebase that contradicts what's in this handoff. This document was written from a careful read of the live tree, but the codebase is the source of truth — if something doesn't match, the codebase wins.
4. **Wait for the user's go-ahead before starting Phase A.**
5. Work the phases in order: A1 → A7, then B0 → B-final. Commit per logical step. Smoke-test after every commit.
6. If you find that a phase needs to be larger or smaller than described, say so before doing it.

The whole point of this session is "small reversible changes between known-good states." Resist the temptation to bundle work. One thing at a time. If you feel rushed, you're moving too fast.
