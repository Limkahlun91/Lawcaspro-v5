-- Snapshot governance extensions: pin/unpin and soft-delete metadata

ALTER TABLE platform_snapshots
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz NULL;
ALTER TABLE platform_snapshots
  ADD COLUMN IF NOT EXISTS pinned_by integer NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE platform_snapshots
  ADD COLUMN IF NOT EXISTS pinned_reason text NULL;

CREATE INDEX IF NOT EXISTS idx_platform_snapshots_pinned_at
  ON platform_snapshots (firm_id, pinned_at DESC);

ALTER TABLE platform_snapshots
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;
ALTER TABLE platform_snapshots
  ADD COLUMN IF NOT EXISTS deleted_by integer NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE platform_snapshots
  ADD COLUMN IF NOT EXISTS deleted_reason text NULL;

CREATE INDEX IF NOT EXISTS idx_platform_snapshots_deleted_at
  ON platform_snapshots (firm_id, deleted_at DESC);

