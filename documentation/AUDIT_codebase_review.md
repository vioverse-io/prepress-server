# Codebase Audit — Prompt Spec

Read-only analysis of the STS Work Order codebase to surface dead code, duplication, inconsistencies, and hygiene issues. **The audit reports findings only. It does not change code.** David reviews and decides what to act on.

Run any time — end of a session, after a merge, or before a release. Not tied to any specific change.

---

## How to invoke

Paste this into a fresh Claude Code session:

> Run a codebase audit on `prepress-mdrive/` following the spec in `prepress-mdrive/documentation/AUDIT_codebase_review.md`. Read-only — do not modify any files. Output a structured findings report to `prepress-mdrive/documentation/AUDIT_FINDINGS_<today's-date>.md`. When finished, summarize the top 5 most important findings in chat.

---

## What to look for

Scan the entire `prepress-mdrive/` tree (index.html, js/, css/). Some duplication is legitimate (Prepress/TS registry parallelism, scoped print + dark-mode CSS). Flag with context — don't assume every match is fixable.

### Dead code
- Unused JS functions (cross-reference `function X`, `X = function`, `window.X =` against call sites)
- Unused variables (declared but never read)
- Unreachable branches (`if (false)`, code after unconditional return)
- Commented-out logic blocks more than a line or two
- Orphan CSS classes (no match in HTML class, `classList.*`, or JS template strings)
- Orphan IDs (CSS or `getElementById` for elements that don't exist)

### Dangling references
- Hardcoded field IDs in `app.js` that don't exist in HTML
- `querySelector` / `getElementById` calls for absent elements
- File paths in comments/strings pointing to missing files
- `<script>` / `<link>` tags for missing files

### Duplication
- Identical or near-identical function bodies in two places
- Code blocks >10 lines, >80% similar that could share a helper — **flag as "possible candidate," not "must fix"**
- Duplicated CSS declarations for the same selector across files
- Magic numbers/strings repeated more than 3 times
- Repeated DOM traversal patterns that could be extracted

### Inconsistencies
- Mixed naming conventions in the same layer (camelCase vs snake_case vs kebab-case)
- Inconsistent API shapes (one registry method returns, another mutates; parameter order drift)
- CSS variable usage vs hardcoded values (`var(--accent)` vs `#f26419`)
- Mixed event binding styles (inline `onclick` vs `addEventListener`) for similar interactions

### Hygiene
- `console.log` / `console.debug` leftovers (1 legit `console.error` exists at `app.js:1125` for localStorage parse failure — not dev debug)
- `alert()` / `confirm()` — all current uses are user-facing, not debug
- `debugger` statements — should never ship
- TODO / FIXME / HACK / XXX comments with file:line (flag stale ones per git blame)
- Empty CSS rule sets
- Inline styles on already-classed elements (most current `style="display:none"` uses are intentional FOUC defense — see MEMORY.md; flag only the inline typography/color cases)
- `!important` instance counts (quantity is the specificity smell)

### Size & complexity *(informational)*
- Files over 2000 lines (`js/app.js` is known large)
- Functions over 100 lines (refactor candidates)
- Functions with deep nesting (>4 levels)
- Selectors with >4 class chains

### Documentation drift
- Comments describing behavior that no longer matches the code
- Doc references to moved/deleted files
- Outdated version numbers or dates in headers

---

## What the audit does NOT do

- No file modifications. Findings only.
- No pull requests, commits, or deploys.
- No prescribed fixes — recommendations are guidance, David decides.
- No re-architecting. Flag design-pattern concerns, don't propose rewrites.
- No edits to `documentation/`. Only new file: the findings report itself.

---

## Output format

Write to `prepress-mdrive/documentation/AUDIT_FINDINGS_<YYYY-MM-DD>.md`:

```markdown
# Codebase Audit — <date>

**Scope:** `prepress-mdrive/` (excludes documentation/ and lib/)
**Files scanned:** <count>
**Findings:** <count> total

## Summary
- <N> critical (breaks or obviously wrong)
- <N> hygiene (cleanup candidates, low risk)
- <N> duplication (possible refactor, verify intent first)
- <N> informational (size/complexity, no action implied)

## Critical
### [C1] <short title>
- **Location:** `file.js:42`
- **Finding:** <1-2 sentences>
- **Why flagged:** <specific reason>
- **Recommendation:** <suggestion, non-binding>

## Hygiene
### [H1] ...

## Duplication
### [D1] ...

## Informational
### [I1] ...

## Notes
- <anything context-relevant>
```

### Severity definitions
- **Critical** — actively broken, misleading, or security-adjacent. Should be fixed.
- **Hygiene** — dead code, leftover artifacts, style drift. Clean up when convenient.
- **Duplication** — may or may not be intentional. Human judgment required.
- **Informational** — metrics only, no action implied.

---

## After the audit

1. Agent summarizes the top 5 findings in chat.
2. David reviews the findings file.
3. Fixes happen in a separate session that references the audit by filename.
4. Findings files stay in `documentation/` as dated snapshots. Never overwrite an existing findings file — create a new dated one.

---

## Rules for whoever runs the audit

- Use Grep for codebase scans, not Read. Large codebase + Read = context bloat.
- Cross-reference before flagging. A class that looks orphan in CSS might be used in a JS template string — check both.
- Don't flag runtime-generated classes. Quill generates `ql-*` classes at runtime; they're legitimate styling targets even without static references.
- Don't flag the Prepress/TS registry parallelism. It's intentional — both expose the same surface because they're alternative implementations of the same pattern.
- No destructive commands. Bash is for `grep`, `wc`, `git log --oneline`, `find -type f`. Nothing that mutates.
- When unsure whether something is dead, flag with a question mark in the recommendation rather than asserting.
