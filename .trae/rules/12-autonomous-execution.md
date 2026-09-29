# Autonomous Execution Rules

\## 🔒 TWO-PHASE HUMAN-IN-THE-LOOP PROTOCOL



When given a task involving production changes or recovery verification:



PHASE 1 — SCOPE REPORT \& STOP (MANDATORY):

Before writing or modifying ANY production/test code, you MUST return:

1\. Problem \& Root Cause

2\. Proposed Solution \& Exact files to modify

3\. Migration / Schema impact (YES/NO)

4\. Potential Side-effects or Reversals needed

5\. Exact Acceptance Test Plan



STOP HERE IMMEDIATELY. Do NOT proceed to write code.

Wait for explicit user approval (e.g. "APPROVED" / "PROCEED").



PHASE 2 — EXECUTION \& VERIFICATION:

Only after receiving explicit approval:

1\. Implement minimal changes according to the approved Scope Report.

2\. Run targeted tests and verify against the exact acceptance criteria.

3\. Return the Final Verification Report with pre-fix vs post-fix evidence.

