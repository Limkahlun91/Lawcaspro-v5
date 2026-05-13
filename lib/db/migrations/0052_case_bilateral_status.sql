ALTER TABLE cases
ADD COLUMN IF NOT EXISTS lawyer_status text;

ALTER TABLE cases
ADD COLUMN IF NOT EXISTS lawyer_status_updated_at timestamptz;

ALTER TABLE cases
ADD COLUMN IF NOT EXISTS developer_status text;

ALTER TABLE cases
ADD COLUMN IF NOT EXISTS developer_status_updated_at timestamptz;

