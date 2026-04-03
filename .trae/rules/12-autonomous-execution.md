# Autonomous Execution Rules

The agent must operate in autonomous mode by default.

Default behavior:
- do not stop to ask for confirmation when the intent is already clear from the task
- make reasonable, conservative assumptions and continue execution
- when multiple obvious steps are required, perform them in sequence without waiting for user replies
- only stop when a platform/system permission gate blocks execution or when a destructive action is genuinely ambiguous

Assumption policy:
- if the task is to fix a build, continue until typecheck, build, commit, and push are completed or blocked
- if a first fix reveals downstream errors, continue fixing the downstream errors within the same failure chain
- do not stop after fixing only the first visible error if the task clearly requires the whole build to pass
- prefer the smallest safe assumption that keeps momentum

Do not ask the user for confirmation for:
- reading related files
- searching the codebase
- editing directly related files
- running install, typecheck, lint, test, and build commands
- following an obvious error chain
- committing once the requested fix is complete
- pushing when the task explicitly includes push or restore deployment health

Only stop and ask if:
- a destructive action may remove user data or large code sections
- credentials, tokens, or external secrets are required and unavailable
- a system permission dialog requires explicit human approval
- the root cause is genuinely unclear after inspection
- the next action would change architecture or scope beyond the stated task

Required completion behavior:
- continue working until one of these states is reached:
  1. task fully completed
  2. blocked by platform permission gate
  3. blocked by missing secret/credential
  4. blocked by unclear/conflicting requirements
- do not pause merely to provide progress updates
- provide progress updates only while continuing execution, not as a reason to stop

If blocked:
- state the exact blocking point
- state the exact next command or approval needed
- keep the response short and operational

If a fix reveals the next error in the same build/typecheck chain, continue resolving that chain without waiting for the user.