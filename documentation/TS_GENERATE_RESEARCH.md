# Tech Services sentence-generator research report

Research basis for a "Generate" button on the Tech Services tab that mirrors the Prepress `generateSpecsSummary` pattern: read the operator's checkboxes and notes, write one tight operator-to-operator paragraph in the same voice as Prepress. Field IDs reference `prepress-mdrive/js/techservices.js` `PRINT_SECTIONS`.

Produced 2026-05-04 by research subagent. Inputs: registry at `js/techservices.js`, panel HTML at `index.html` lines 920-1230, prepress sentence-builder at `js/app.js:3322-3470`, and public-source vendor / USPS documentation listed in section 4.

---

## 1. Vocabulary table

| TS field | Phrase variant | Use when | Source |
|---|---|---|---|
| `ts_fp10` Data file locations | "input files staged at {path}, including seed and suppression files" | Always when checked; multiline note may include record counts | Anchor [1], operator convention |
| `ts_sp21` Number of mailstreams | "split into {N} mailstreams" / "single mailstream" | N>1 trips the "split" wording | Operator convention |
| `ts_sp22` Splitting criteria | "split by {criteria}" (e.g., "by package type", "by donor segment") | Always after sp21 when N>1 | Operator convention |
| `ts_sp23` Addressing fields used | "addressing pulls from {fields}" | Always when checked | Operator convention |
| `ts_sp24` Multiple address fields | "multiple address fields present, using {chosen}" | When the source file has overlapping address sets | Operator convention |
| `ts_cb30` CASS | "CASS-certified address standardization with DPV" / "CASS pass with delivery-point validation" | Always when checked | USPS PostalPro [2] (98.5% ZIP+4, 100% DP coding); Firstlogic [3] |
| `ts_cb30a` Drop vacants | "drop USPS-flagged vacants" | Checked | USPS DPV [2] |
| `ts_cb30b` Drop phantom carrier routes (R777, R778) | "drop phantom carrier routes (R777, R778)" | Checked | Use the registry label verbatim |
| `ts_cb30c` Drop CASS errors over 90 | "drop CASS errors over 90 (typically missing secondary, undeliverable)" | Checked. Pull the "typically missing secondary..." gloss from `index.html:996` field-help-text | In-app help text |
| `ts_cb31` NCOA | "NCOALink move update against the 48-month database" / "NCOA-Link refresh" | Always when checked | Anchor [1], Peachtree [4] |
| `ts_cb31a` Client review required | "client review required before mail file is finalized" | Checked, gates downstream presort | Operator convention |
| `ts_cb31b_nna` Movers w/ No New Address | "movers w/ no new address: mail" or "movers w/ no new address: drop" | Checked + dropdown value (Mail / Drop) | Peachtree return-code language [4] |
| `ts_cb31b_new` Movers w/ New Address | "movers w/ new address: mail to original address" or "movers w/ new address: mail to updated address" | Checked + dropdown value | Operator convention |
| `ts_cb31c` Deceased | "deceased suppression" / "deceased flagging via DDNC" | Checked | DMA Deceased Do Not Contact [5] |
| `ts_cb31c_drop` Drop deceased | "drop deceased records" | Checked (vs flag-and-keep) | Operator convention |
| `ts_sp30` Deduplication method | "deduped at the {individual / household / residential} level" | Always when checked. Use registry's exact dropdown text | `DEDUP_METHODS` in registry [6] |
| `ts_sp41` File priorities | "file priority {hierarchy} (e.g., VIP > General)" | Checked. Use the hint string from `index.html:1057` | In-app placeholder |
| `ts_sp40` Suppression file match | "suppress against client-supplied DNM list, matched by {address / ID}" | Checked | Lorton [7], DMA [5] |
| `ts_sp42` Rollup logic | "rolled up at the {household / account} level per {logic}" | Checked | Operator convention |
| `ts_sp70` DP in Start | "data processing started {date}" | Checked | Operator convention |
| `ts_sp71` DP Out Date / `ts_sp72` Time | "DP completed {date} {time}" | Both checked, single clause | Operator convention |
| `ts_sp73` PO Drop | "post office drop scheduled {date}" | Checked | USPS DMM [8] |
| `ts_sp74`-`ts_sp77` Weight / Thickness / H / W | "piece dimensions: {H}x{W}, {thickness}, {weight} oz" | Combine; only print clauses for checked fields | Operator convention |
| `ts_sp78` Canadian Records / `ts_sp79` Foreign Records | "{N} Canadian records {handled how}" / "{N} foreign records {handled how}" | Checked | Operator convention |
| `ts_sp80` Unmailables | "{N} unmailables {handled how}" | Checked | Operator convention |
| `ts_sp81` Act $ Billed | "actual postage billed {$amount}" | Checked | Operator convention |
| `ts_sp82` DP Initials | "DP by {initials}" | Checked | Operator convention |
| `ts_sp83` Data Checked | "QC by {name/method}" | Checked | Operator convention |
| `ts_sp84` Actual Qty DP | "{N} records out to print" | Checked | Operator convention |
| `ts_cb90` Meeting required | "Meeting required before kickoff (attendees: {list})" | Checked. Lead the paragraph with this. | In-app warning row |
| `ts_sp91` Variables beyond address | "variable fields beyond address: {list}" | Checked. Use placeholder example "ask amount, gift" framing | `index.html:1194` |
| `ts_sp92` Number of letter versions / `ts_sp93a` Signoffs | "{N} letter versions, {M} signoffs per version" | Checked | Operator convention |
| `ts_sp95` Samples per letter version / `ts_sp94` Samples address | "{N} samples per version addressed to {sample address}" | Checked | Operator convention |

---

## 2. Five sample sentences

### Sample A. Full hygiene pass: NCOA + CASS + suppression + dedup + presort

> ProgramName runs a full hygiene pass against the input files staged at G:\jobs\2026\NP-4421\. Address pass is CASS-certified with DPV, dropping vacants, phantom carrier routes (R777, R778), and CASS errors over 90. NCOALink move update against the 48-month database, forwarding to new address on MoveFootnote 0/91/92/A and dropping undeliverable movers on 1/2/3/5/14/19/66. Deceased suppression via DDNC; deceased records dropped. Suppress against the client DNM file matched by address. Deduped at the Household (Last Name + Address) level with file priority VIP > General, rolled up at the household per gift-recency logic. DP completed 2026-05-04 14:30, post office drop 2026-05-06. 87,432 records out to print.

Fields: `ts_fp10/n` (file path) -> `ts_cb30/30a/30b/30c` (CASS clauses) -> `ts_cb31/31b_mail/31b_drop` (NCOA + footnotes) -> `ts_cb31c/31c_drop` (deceased) -> `ts_sp40/40n` (suppression) -> `ts_sp30/30n + sp41/41n + sp42/42n` (dedup + priority + rollup) -> `ts_sp71/71n + sp72/72n + sp73/73n` (DP out + drop) -> `ts_sp84/84n` (qty out).

### Sample B. NCOA-only refresh

> ProgramName is an NCOALink-only refresh on the file staged at G:\refresh\Q2-2026\. Move update against the 48-month database; movers with no new address (MLNA) flagged for client review required before release. Client review required before the file is finalized. No CASS, no dedup, no suppression on this pass. DP by AUT, completed 2026-05-04.

Fields: `ts_fp10/n` -> `ts_cb31` -> `ts_cb31b_nna` -> `ts_cb31a` -> `ts_sp82/82n + sp71/71n`.

### Sample C. Presort and mail only - data already clean

> ProgramName goes straight to presort. Data arrived pre-hygiened from the client; no CASS, NCOA, or dedup pass on our side. Piece dimensions: 8.5x11, 0.012 thickness, 0.8 oz. Post office drop scheduled 2026-05-07. Actual postage billed $14,902.18. DP by JC, QC by RM. 41,200 records out to print.

Fields: `ts_sp74/74n + sp75/75n + sp76/76n + sp77/77n` -> `ts_sp73/73n` -> `ts_sp81/81n` -> `ts_sp82/82n + sp83/83n` -> `ts_sp84/84n`.

### Sample D. Deceased suppression run

> ProgramName is a deceased-suppression-only pass against the file at G:\donor\spring-2026\. Deceased flagging via DDNC; deceased records dropped from the mail file. Deduped at the Individual (Full Name + Address) level. No CASS, no NCOA, no other suppression. DP by LM, 92,118 records out.

Fields: `ts_fp10/n` -> `ts_cb31c/31c_drop` -> `ts_sp30/30n` -> `ts_sp82/82n + sp84/84n`.

### Sample E. Bare-bones data conversion only

> ProgramName is data conversion only. Input file staged at G:\import\new-client\, split into 3 mailstreams by package type. Addressing pulls from addr1, addr2, city, state, zip; multiple address fields present, using primary (home) over secondary (mailing). No postal touch on this pass; file handed back to client for downstream processing.

Fields: `ts_fp10/n` -> `ts_sp21/21n + sp22/22n` -> `ts_sp23/23n + sp24/24n`. Closing "no postal touch" clause is a fixed string when sections 2-5 produce no clauses.

---

## 3. Recommended template structure

- **Single paragraph, section-ordered.** Match Prepress voice. One tight paragraph, sentences delimited by periods, no bullets. Order clauses by registry section: file/conversion -> CASS -> NCOA -> deceased -> dedup -> suppression -> presort/DP -> print. Operators read left-to-right through the workflow; the sentence should follow that.
- **Skip unchecked fields entirely.** Do not write "no NCOA" or "not applicable" by default. Silence is the default. Exception: when an entire downstream section (CASS, NCOA, dedup, suppression) is OFF on a job that obviously could have used them, emit one closing fixed string like "data arrived pre-hygiened from the client; no CASS, NCOA, or dedup pass on our side" (Sample C) or "no postal touch on this pass" (Sample E). This matches Prepress's pattern of staying quiet on absent fields except where absence is itself the story.
- **Lead with meeting-required when checked.** `ts_cb90` is a warning row in the UI. When checked, the generated sentence opens with "Meeting required before kickoff (attendees: {list})." before any other clause.
- **Counts and dates inline, not in their own clause.** "DP completed 2026-05-04 14:30" beats "DP date: 2026-05-04. DP time: 14:30." Combine `ts_sp71n` + `ts_sp72n` into one clause; combine `ts_sp74-77` dimensions into one clause.
- **Use registry labels verbatim where the label is already operator-readable.** "Drop phantom carrier routes (R777, R778)" is good as-is; don't rewrite to "drop phantoms." Pull MoveFootnote codes from the in-app `field-hint` strings (`index.html:1020`, `:1025`); those are already the canonical wording operators see on screen.

---

## 4. Citations

1. Anchor Computer, NCOALink Service Provider page (could not retrieve; 403). Used for the "48-month database" framing per training knowledge confirmed by WebSearch summary that listed the Limited (18-month) vs Full (48-month) distinction.
2. USPS PostalPro, CASS certification: https://postalpro.usps.com/certifications/cass (retrieved). Verbatim: "5-digit coding," "ZIP + 4/ delivery point (DP) coding," "Carrier route coding," "DPV or DSF2," "LACSLink," "SuiteLink," "98.5 percent for ZIP + 4, carrier route, Five-Digit ZIP and LACSLink," "100 percent for delivery point coding."
3. Firstlogic Data Quality Glossary: https://firstlogic.com/resources/glossary (retrieved). Verbatim: "CASS stands for Coding Accuracy Support System. CASS improves delivery accuracy by matching mailing list entries to USPS-defined address ranges on a street." "DPV is the process that determines whether an address exists and accepts mail." "Presorting is the process a mail owner or mail preparer uses to arrange the sequence of the mail thereby reducing the USPS labor required to route and deliver it."
4. Peachtree Data, NCOALink page: https://www.peachtreedata.com/services/ncoalink/ (retrieved). Verbatim: "Found COA: Moved Left No Address(MLNA)" (Return Code 02), "Found COA: Box Closed No Order(BCNO)" (Return Code 03), "Found COA: New Address not ZIP + 4 coded...or Temporary Change Of Address" (Return Code 19), "89.68% Forwardable moves containing delivery point confirmed New addresses."
5. DMAchoice / DMA Mail Preference Service: https://www.dmachoice.org/ (search summary; not direct fetch). Used for "DDNC deceased file" (Deceased Do Not Contact list) language.
6. `prepress-mdrive/js/techservices.js` `DEDUP_METHODS` array (line 25): "Individual (Full Name + Address)", "Household (Last Name + Address)", "Merge Households (Last Name + Address)", "Residential (Address only)" - these strings are already operator-canonical and should be quoted verbatim in generated sentences.
7. Lorton Data Suppression Services: https://www.lortondata.com/services/database-hygiene-services/suppression-services/ (could not retrieve; content truncated). Reference for "client-supplied DNM list" framing.
8. USPS Domestic Mail Manual / PostalPro Marketing Mail presort tier language: search summary (Pitney Bowes, Federal Register, USPS DMM 245). Reference for "Mixed AADC," "AADC," "5-digit," "3-digit" presort tier names if `ts_sp83n` (Data Checked) note ever needs to surface presort tier in generated text.
9. Data-Mail.com Data Processing page: https://www.data-mail.com/data-processing/ (retrieved via search; cert error on direct fetch). Verbatim from Mailpro fetch: "Dedup, Merge/Purge, Suppression," "Multi-list merge/purge + DSF2," "Deceased + prison suppression."
10. In-app field hints from `prepress-mdrive/index.html` lines 988, 996, 1020, 1025, 1057, 1194 - the registry's own field labels and hints are the highest-fidelity source for operator-canonical phrasing on shop-specific items (R777/R778, MoveFootnote codes, "VIP > General," "ask amount, gift").
