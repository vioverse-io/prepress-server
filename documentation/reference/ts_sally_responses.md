# Tech Services — Sally's Responses (Spec Clarifications)

Source: `responses.docx` from Sally during the TS spec-gathering session on 2026-04-20. Converted to markdown for reference by the implementation session.

---

## S1 — Mover policy (Mail / Drop)

**Question:** Is there a third real-world option like "flag for client review" or "case-by-case" that should be in the radio group, or is it strictly Mail vs Drop?

**Sally's response:**

> (to me this could be on a counts report supplied by TS for a client to review and decide)

**Movers:**
- Mail to Movers? (Out_MoveFootnote: 0, 91, 92, A)
- Drop movers? (Out_MoveFootnote: 1, 2, 3, 5, 14, 19, 66 — undeliverable)

**Deceased (checkbox):**
- Mail to Deceased?
- Drop Deceased?

**Implementation implication:** Mail and Drop are TWO INDEPENDENT CHECKBOXES, not a radio group. If both are unchecked, the implicit state is "send to client for review on a counts report." Overrides the radio-group default.

---

## S2 — Deduplication method

**Question:** Is exactly one method picked per job, or can multiple apply?

**Sally's response:**

> Select ONE:
>
> - Individual (Full Name + Address) OR referred to as 1 per person
> - Household (Last Name + Address) OR referred to as 1 per household
> - Residential (Address Only) OR referred to as 1 per address

**Implementation implication:** Radio group with three options. Short-form labels ("1 per person", "1 per household", "1 per address") are the primary display text; the technical description is a hint.

---

## S3 — Presort fields

**Question:** What does Tech Services actually need captured for presort on a work order?

**Sally's response:** Pasted a screenshot of Midnight's "Data/Postage" tab with two subsections: Sortation/Postage and Data Processing. See `responses.docx` (same folder) for image. The full field list decoded from the screenshot is in the handoff (`../HANDOFF_techservices_sections.md`, Section 4).

**Key fields transcribed from screenshot:**

**Sortation/Postage:** Sort, Classification Type, Post Affix, Post $ Reqd, Geo, Cat, Permit #, Postage Due, Ghost #, NonProfit Auth#, Holder, Post Status, MailerID, Cust Reg ID, Meter #

**Data Processing:** DP in Start, DP Out Date, DP Out Time, PO Drop, Weight (Oz), Thickness, Height, Width, Canadian Records, Foreign Records, Unmailables, Act $ Billed, DP Initials, Data Checked, Actual Qty DP

**Implementation implication:** These are PLACEHOLDER fields derived from a UI screenshot, not a finalized spec. Must be marked `STATUS: PLACEHOLDER — pending TS team review` in the spec file.

---

## S4 — Envelope-only fields

**Question:** Are any TS fields only relevant for envelope jobs (like Prepress's Indicia row)?

**Sally's response:**

> I am not sure — let TS answer — as there are scenarios where it can vary.

**Implementation implication:** TBD. Flag for Jason/TS team. Do not guess.

---

## S5 — Required fields

**Question:** Anything else Sally considers non-negotiable to fill in before a job can move forward?

**Sally's response:**

> Talk to Jason on these.

**Implementation implication:** First-pass required fields = Data file locations + Input record count (per David). Additional required fields TBD with Jason.

---

## S6 — "Client review required" appearing twice

**Question:** Is this the same thing in NCOA and Print, or two different things?

**Sally's response:**

> I only see this occurring once — review NCOA counts.
>
> Yes potentially a 2nd round of counts could be done after the client makes their choice on what to mail & not mail; therefore another review of final counts could be submitted so they can verify we did what they asked for correctly.

**Implementation implication:** "Client review required" is a single NCOA-specific checkbox. It's a workflow trigger (flags the job for counts-report generation), not duplicated elsewhere. The "Meeting required" checkbox under Print is a SEPARATE concept for complex jobs needing a huddle.

---

## S7 — Deceased default

**Question:** Is Drop the usual default, or Mail, or case-by-case?

**Sally's response:**

> See response to S1 above.

**Implementation implication:** Same pattern as Movers — two independent checkboxes (Mail / Drop). No default. Unchecked state = flag for client review.
