# Tech Services — Smoke Test Plan

Run every item before a `/prepress-deploy` that touches TS files. **Test 3 (required-field gating) is the non-negotiable shop-floor gate.** If it fails, do not ship — broken jobs can reach the press.

## 12-test plan

1. **Panel renders.** Open a fresh job, click the TS tab. All 5 sections appear with correct labels and sub-group headers. No console errors.
2. **Fields save.** Type into every text field, toggle every checkbox, pick every dropdown. Reload. Every value comes back.
3. **Required fields gate print.** Leave "Data file locations" empty. Click print. The warning modal fires naming the field.
4. **Per-dept isolation.** Put "PP-MARK" in Prepress instructions and "TS-MARK" in TS instructions. Each tab shows only its own fields and its own instructions.
5. **TS print output.** Print from the TS tab. Accent is TS midnight blue (not Prepress red), header says "Tech Services Instructions", only non-empty sections appear, instructions section shows only TS editor content.
6. **Prepress regression.** Print from the Prepress tab. Prepress fields, Prepress instructions, Prepress red accent — unchanged from before.
7. **Empty-section suppression.** Create a job, fill only Data Conversion. Print from TS. NCOA/Dedup/Presort/Print sections do not appear in the output.
8. **CASS reference link.** Click it under the NCOA/CASS header. Opens the xlsx on M-drive builds, silently fails on web — no console error either way.
9. **Checkbox-only rows.** CASS and its sub-items render as toggles with no text input alongside. NCOA sub-items (Movers w/ No New Address, Movers w/ New Address) have dropdown pickers.
10. **Dedup dropdown.** Click the dropdown arrow on "Deduplication method". All four options appear: Individual (Full Name + Address), Household (Last Name + Address), Merge Households (Last Name + Address), Residential (Address only). Picking one fills the text field with that exact label.
11. **NCOA Movers dropdowns.** "Movers w/ No New Address" offers Mail/Drop. "Movers w/ New Address" offers Mail to Original Address/Mail to Updated Address. Both are indented under the NCOA parent toggle.
12. **Meeting required.** The toggle at the top of Print looks visually distinct (⚠ icon, heavier weight). The attendees picker shows merged CSR + Prepress + TS names. Selected names chip-pill on the row and print on the PDF as a comma-joined list.

## Guardrails

- **Every TS field ID starts with `ts_`.** `app.js:2246` + `app.js:2260-2272` scope behavior off that prefix.
- **Don't edit `js/app.js`.** The registry in `js/techservices.js` is designed to handle TS-specific behavior. If you think you need an app.js change, stop and ask David.
- **Don't rewrite Prepress.** A diff showing Prepress changes means something went wrong — revert.
- **Presort dropdowns stay free-text** until Jason supplies option lists. Each fill = a new option array added to `js/techservices.js`.
- **Export active jobs to JSON before major deploys.** Insurance against any localStorage shape surprise.
