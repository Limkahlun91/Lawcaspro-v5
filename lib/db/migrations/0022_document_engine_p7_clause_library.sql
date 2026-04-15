-- Document Engine P7: Clause Library

CREATE TABLE IF NOT EXISTS platform_clauses (
  id serial PRIMARY KEY,
  clause_code text NOT NULL,
  title text NOT NULL,
  category text NOT NULL DEFAULT 'General',
  language text NOT NULL DEFAULT 'en',
  body text NOT NULL,
  notes text NULL,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  status text NOT NULL DEFAULT 'draft',
  is_system boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  applicability jsonb NULL,
  created_by integer NULL,
  updated_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_clauses_code ON platform_clauses (clause_code);
CREATE INDEX IF NOT EXISTS idx_platform_clauses_status ON platform_clauses (status);
CREATE INDEX IF NOT EXISTS idx_platform_clauses_category ON platform_clauses (category);
CREATE INDEX IF NOT EXISTS idx_platform_clauses_language ON platform_clauses (language);
CREATE INDEX IF NOT EXISTS idx_platform_clauses_tags ON platform_clauses USING gin (tags);

CREATE TABLE IF NOT EXISTS firm_clauses (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  source_platform_clause_id integer NULL,
  clause_code text NOT NULL,
  title text NOT NULL,
  category text NOT NULL DEFAULT 'General',
  language text NOT NULL DEFAULT 'en',
  body text NOT NULL,
  notes text NULL,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  status text NOT NULL DEFAULT 'draft',
  is_system boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  applicability jsonb NULL,
  created_by integer NULL,
  updated_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE firm_clauses
  DROP CONSTRAINT IF EXISTS fk_firm_clauses_firm;
ALTER TABLE firm_clauses
  ADD CONSTRAINT fk_firm_clauses_firm
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE;

ALTER TABLE firm_clauses
  DROP CONSTRAINT IF EXISTS fk_firm_clauses_source_platform;
ALTER TABLE firm_clauses
  ADD CONSTRAINT fk_firm_clauses_source_platform
  FOREIGN KEY (source_platform_clause_id) REFERENCES platform_clauses(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_clauses_code ON firm_clauses (firm_id, clause_code);
CREATE INDEX IF NOT EXISTS idx_firm_clauses_status ON firm_clauses (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_firm_clauses_category ON firm_clauses (firm_id, category);
CREATE INDEX IF NOT EXISTS idx_firm_clauses_language ON firm_clauses (firm_id, language);
CREATE INDEX IF NOT EXISTS idx_firm_clauses_tags ON firm_clauses USING gin (tags);

ALTER TABLE firm_clauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_clauses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON firm_clauses;
CREATE POLICY tenant_isolation ON firm_clauses FOR ALL TO PUBLIC
  USING (firm_id = nullif(current_setting('app.current_firm_id', true), '')::int)
  WITH CHECK (firm_id = nullif(current_setting('app.current_firm_id', true), '')::int);

