# Doc Automation Stable Baseline

- Baseline commit: 0de26b31acf320fec4868686287af68e07a0ef31
- Verified date (Asia/Shanghai): 2026-06-05

## Production Verification

- Batch generation: 5 cases × 3 templates (15 PDFs) completed successfully
- ZIP download succeeds
- ZIP folder structure is correct
  - purchaser/case folders created as expected
  - each case folder contains the expected template outputs
- No premature download-manifest call before job completion
- No run-next 504 causing job disappearance

## Stability Guardrails

- Do not change Doc Automation job lifecycle behavior without explicit approval:
  - job creation → run-next → finalize → download-manifest → client ZIP packaging → ZIP downloaded
  - run-next locking / timeout / heartbeat / stale recovery behavior
  - download-manifest readiness check semantics (409 JOB_NOT_READY_FOR_DOWNLOAD is retryable)
  - frontend localStorage job resume key: lawcaspro_doc_automation_last_job
  - current ZIP folder output structure

- Avoid unrelated UI refactors impacting Doc Automation:
  - sidebar/menu/dashboard refactors must not modify automation runner state machine
  - do not reset active jobId while job is still processing or while download has not completed

