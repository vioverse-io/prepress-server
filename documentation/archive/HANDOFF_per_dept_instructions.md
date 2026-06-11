# Per-Department Instructions Refactor — Shipped Reference

**Status:** SHIPPED 2026-04-20 (Bug 1). Prepress and Tech Services have independent Quill instruction editors, histories, and print outputs.

Kept as a reference in case the same pattern needs to extend to a future department or the migration logic needs to be inspected again.

---

## What shipped

- `comp.instructions` → `comp.instructions_prepress` + `comp.instructions_techservices`
- `comp.instructionsHistory` → dept-keyed equivalents
- `switchDepartment()` saves the outgoing dept's editor HTML to its dept-keyed field, then loads the incoming dept's field into the editor.
- `captureState()` / `restoreState()` carry `activeDepartment` so undo round-trips across dept transitions.
- One-time migration on job load moves legacy `comp.instructions` into `comp.instructions_prepress` (TS tab never shipped before the refactor, so there is no TS-side data at risk).
- Print output decision: each dept prints its own instructions; the active dept's content appears on the PDF for that dept's tab. Revisions stay per-dept (independent timelines).

## Legacy migration snippet

Preserved here because the same shape may be needed again for future registry-level state splits.

```js
function migrateInstructionsToPerDept(comp) {
    if (comp.instructions !== undefined
        && comp.instructions_prepress === undefined
        && comp.instructions_techservices === undefined) {
        comp.instructions_prepress = comp.instructions;
        delete comp.instructions;
    }
    if (comp.instructionsHistory !== undefined
        && comp.instructionsHistory_prepress === undefined
        && comp.instructionsHistory_techservices === undefined) {
        comp.instructionsHistory_prepress = comp.instructionsHistory;
        delete comp.instructionsHistory;
    }
    if (comp.instructions_prepress === undefined) comp.instructions_prepress = '';
    if (comp.instructions_techservices === undefined) comp.instructions_techservices = '';
    if (comp.instructionsHistory_prepress === undefined) comp.instructionsHistory_prepress = '';
    if (comp.instructionsHistory_techservices === undefined) comp.instructionsHistory_techservices = '';
}
```

Runs inside the same code path as `migrateJobToComponents`.

## Regression test plan

If you change anything that touches the editor-swap, undo, or migration paths, re-run:

1. **Independence.** New job → type in Prepress → switch to TS → editor empty → type in TS → switch back. Each tab shows its own text only.
2. **Persistence.** Reload on the same job URL. Both dept notes intact.
3. **Revisions.** Generate saves a revision to the active dept only. The other dept's history is unaffected.
4. **Undo across dept.** Type "A" in Prepress → switch to TS → type "B" → undo reverses "B" and keeps you on TS. Undo again brings you back to Prepress with "A". One more undo clears Prepress.
5. **JSON export/import.** Round-trip preserves both dept's notes.
6. **Legacy migration.** Load a pre-refactor job (stash a localStorage snapshot or inject `comp.instructions = 'legacy'` on a dev job). Prepress tab shows "legacy", TS is empty, `comp.instructions` key is gone, `comp.instructions_prepress = 'legacy'`.
7. **Print output.** Each dept tab prints its own instructions.

## What not to re-architect

- The undo infrastructure handles dept-aware state correctly via the `activeDepartment` field. Don't change the stack; only extend the state object if a new field needs to round-trip.
- `DEPT_REGISTRY` handles checklist fields. Instructions editor logic lives directly in `app.js` — it's not registry-driven because there's only one editor instance.
- No CSS changes. The Quill editor is visually shared; only backing data swaps on tab switch.
