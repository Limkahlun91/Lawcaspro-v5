-- Appendix: Platform runtime stability (documents + audit logs)
-- Safe for existing environments: uses IF NOT EXISTS.

-- Audit logs: optimize global founder view ORDER BY created_at DESC, id DESC LIMIT N
CREATE INDEX IF NOT EXISTS idx_audit_created_at_id_desc ON audit_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_firm_created_at_id_desc ON audit_logs(firm_id, created_at DESC, id DESC);

-- Platform documents: optimize system documents list ORDER BY created_at DESC, id DESC LIMIT N
CREATE INDEX IF NOT EXISTS idx_platform_documents_created_at_id_desc ON platform_documents(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_platform_documents_firm_created_at_id_desc ON platform_documents(firm_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_platform_documents_folder_created_at_id_desc ON platform_documents(folder_id, created_at DESC, id DESC);

