\# Workflow and Delivery Rules



For every request:

1\. understand business intent

2\. inspect relevant module

3\. identify root cause or change scope

4\. implement minimal safe change

5\. summarize clearly



If fixing bugs:

\- reproduce logically

\- trace real root cause

\- avoid cosmetic-only fixes

\- avoid creating side effects



If adding features:

\- define users/roles

\- define DB impact

\- define API/service impact

\- define UI impact

\- define validation and edge cases



When finished, always state:

\- files changed

\- migrations required

\- env changes needed

\- manual verification steps

\- known limitations



For each task:

\- define exact scope

\- define exact files expected to change

\- avoid broad repo-wide edits unless explicitly requested

\- if new errors appear outside original scope, stop after identifying them and report separately



\## Continuous execution workflow



For implementation and fix tasks, the agent should execute end-to-end in one run whenever possible.



Standard execution chain:

1\. inspect

2\. identify root cause

3\. edit minimal related files

4\. run verification commands

5\. fix downstream errors in the same chain if directly related

6\. rerun verification

7\. commit

8\. push

9\. report result



Do not stop between these steps unless blocked by:

\- system approval gate

\- missing credentials

\- destructive ambiguity

