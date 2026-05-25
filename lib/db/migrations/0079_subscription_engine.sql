CREATE TABLE IF NOT EXISTS subscription_plans (
  id serial PRIMARY KEY,
  name varchar(200) NOT NULL,
  price_monthly numeric(12,2) NOT NULL,
  max_users integer,
  max_cases_per_month integer,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS subscription_plans_name_key ON subscription_plans(name);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_plans_name_lower_key ON subscription_plans(lower(name));

INSERT INTO subscription_plans (name, price_monthly, is_active)
VALUES ('starter', 0, true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO subscription_plans (name, price_monthly, is_active)
SELECT DISTINCT f.subscription_plan, 0, true
FROM firms f
WHERE f.subscription_plan IS NOT NULL AND length(trim(f.subscription_plan)) > 0
ON CONFLICT (name) DO NOTHING;

ALTER TABLE firms ADD COLUMN IF NOT EXISTS subscription_plan_id integer REFERENCES subscription_plans(id);
ALTER TABLE firms ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'active';
ALTER TABLE firms ADD COLUMN IF NOT EXISTS custom_price_monthly numeric(12,2);
ALTER TABLE firms ADD COLUMN IF NOT EXISTS is_custom_plan boolean NOT NULL DEFAULT false;

UPDATE firms f
SET subscription_plan_id = p.id
FROM subscription_plans p
WHERE f.subscription_plan_id IS NULL
  AND p.name = f.subscription_plan;

UPDATE firms f
SET subscription_plan_id = p.id
FROM subscription_plans p
WHERE f.subscription_plan_id IS NULL
  AND p.name = 'starter';

ALTER TABLE firms ALTER COLUMN subscription_plan_id SET NOT NULL;

ALTER TABLE firms DROP COLUMN IF EXISTS subscription_plan;

CREATE TABLE IF NOT EXISTS firm_invoices (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id),
  billing_month varchar(7) NOT NULL,
  amount numeric(12,2) NOT NULL,
  status text NOT NULL DEFAULT 'unpaid',
  paid_at timestamptz,
  payment_method varchar(50),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firm_invoices_status_check CHECK (status IN ('unpaid','paid','overdue'))
);

CREATE UNIQUE INDEX IF NOT EXISTS firm_invoices_firm_month_key ON firm_invoices(firm_id, billing_month);
CREATE INDEX IF NOT EXISTS idx_firm_invoices_firm ON firm_invoices(firm_id);

