\## 🐞 BUG FIX EXECUTION CONTRACT



When fixing any reported bug:

1\. REPRODUCE FIRST: Write a targeted failing test that reproduces the bug on the existing codebase before changing any production code.

2\. MINIMAL BLAST RADIUS: Fix the root cause in the minimal possible scope.

3\. NO BYPASSING: If the fix uncovers an underlying route error (e.g. constraint mismatch), resolve the root cause directly.

4\. REVERT TEST POLLUTION: Ensure no debug logs, exported internal helpers, or untracked artifacts (e.g., temporary SQL files/folders) remain in `git status`.

