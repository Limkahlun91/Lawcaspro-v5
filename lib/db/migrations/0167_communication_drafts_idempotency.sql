DROP INDEX IF EXISTS idx_communication_drafts_idem;

CREATE UNIQUE INDEX IF NOT EXISTS
  uq_communication_drafts_firm_idem
  ON communication_drafts(
    firm_id,
    idempotency_key
  )
  WHERE idempotency_key IS NOT NULL;
