# Handoff — Continue STS Work Order Build

Start here. Pull whichever doc you need from the list at the bottom.

## Where things stand

- **Per-dept instructions** shipped. Prepress + Tech Services have separate editors, histories, and print outputs. Registry pattern: `js/prepress.js` + `js/techservices.js`, orchestrated by `js/app.js` through `DEPT_REGISTRY`.
- **Tech Services 5-section checklist** shipped: Data Conversion, NCOA/CASS, Deduplication, Presort *(placeholder — "See Midnight For Specs")*, Print.
- **Meeting Required widget** live. Attendees picker merges Prepress + TS + CSR quick-pick rosters at runtime.
- **Docs** live under `prepress-mdrive/documentation/`.

No Prepress structural changes. No `js/app.js` changes. The registry pattern carried everything.

## Primary focus — finish the TS specs

Structure is in place. Presort is still placeholder pending Jason. The work left is: get Jason's answers, wire them in.

### Blocked on Jason / Sally

Plain-language versions for them in `TS_Open_Questions.docx`. Summary:

1. **Presort dropdown options** — 14 free-text combo-boxes until Jason supplies option lists. Each fill = one-line registry edit.
2. **Presort required fields** — today only `ts_fp10n` is required (Input record count was absorbed into Data file locations). Jason may add more.
3. **Envelope-only fields** — `isEnvelopeComponent` returns false for now. Flip when Jason defines which TS fields don't apply to non-envelope jobs.
4. ~~**Movers/Deceased checkbox semantics**~~ — Resolved: NCOA movers replaced with two dropdown fields (Movers w/ No New Address: Mail/Drop; Movers w/ New Address: Mail to Original/Mail to Updated).
5. ~~**NCOA Movers section nesting**~~ — Resolved: two indented dropdown rows under the NCOA parent toggle.
6. **"Client review required" workflow** — if it should auto-trigger a counts-report step, needs spec before building.

### When answers arrive

1. Update `TS_Sections_Spec.docx` first. The spec is the living contract; code follows.
2. Update `js/techservices.js` — usually one-line registry edits.
3. If adding fields, pick IDs that don't collide with the master list (or the retired list) in the spec.
4. Run the 12-test smoke plan in `HANDOFF_techservices_sections.md`.
5. `/prepress-deploy`.

### Side tasks (from WO_BACKLOG.md)

Only tackle if David asks:
- Dedup dropdown → revisit as radios if operators want all three visible at once.
- Filepath + required interaction — toggle-off still passes the required check.
- Presort badge downgrade once Jason fills the option lists.
- Multi-column grid for TS once field set stabilizes.

## Hard rules

- **Every TS field ID starts with `ts_`.** `app.js:2246` + `app.js:2260-2272` depend on it.
- **Don't edit `js/app.js`.** The registry handles TS-specific behavior. If you think you need an app.js change, pause and ask David.
- **Don't rewrite Prepress.** TS is the active surface.
- **Spec before code.** `TS_Sections_Spec.docx` is the source of truth.
- **Never edit `prepress/public/` directly.** `/prepress-deploy` syncs `prepress-mdrive/` → `prepress/public/`; editing the deploy copy causes drift.

## Key files

| File | Purpose |
|---|---|
| `TS_Sections_Spec.docx` | Living contract — field layout, IDs, rules |
| `TS_Open_Questions.docx` | Plain-language questions for Jason / Sally |
| `HANDOFF_techservices_sections.md` | 12-test smoke plan + guardrails |
| `WO_BACKLOG.md` | Open items, forward-looking work |
| `reference/ts_sally_responses.md` | Sally's April 2026 spec responses |
| `js/techservices.js` | TS registry (`PRINT_SECTIONS`, required fields, dropdowns) |
| `js/meeting-attendees.js` | Meeting Required widget |
| `index.html` (~line 843) | TS checklist markup |
| `css/techservices.css` | TS accent + section styling |

## Done when

- Every Presort dropdown either has an option list or is explicitly free-text by Jason's call
- Required fields match Jason's list
- Envelope-only rules defined (or explicitly "none" with sign-off)
- 12-test smoke plan passes in a browser
- `TS_Open_Questions.docx` has no unanswered items
- `TS_Sections_Spec.docx` has no TBD markers
- Deployed via `/prepress-deploy` and verified live
