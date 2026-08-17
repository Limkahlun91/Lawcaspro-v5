import type { PGlite } from "@electric-sql/pglite";
import { FEATURE_REGISTRY_MAP } from "@workspace/db";

export const ENTITLEMENT_FOUNDATION_DDL = `
-- 1. subscription_plans
CREATE TABLE IF NOT EXISTS subscription_plans (
  id serial PRIMARY KEY,
  name text,
  description text,
  price_monthly numeric DEFAULT 0,
  is_active boolean DEFAULT true,
  features_limits jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  slug text UNIQUE
);

-- 2. firms
CREATE TABLE IF NOT EXISTS firms (
  id serial PRIMARY KEY,
  name text,
  slug text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  status text,
  subscription_plan_id integer REFERENCES subscription_plans(id),
  subscription_status text DEFAULT 'active',
  is_custom_plan boolean DEFAULT false,
  custom_price_monthly numeric DEFAULT 0
);

-- 3. roles
CREATE TABLE IF NOT EXISTS roles (
  id serial PRIMARY KEY,
  name text,
  firm_id integer REFERENCES firms(id),
  created_at timestamptz DEFAULT now(),
  permissions jsonb,
  description text
);

-- 4. users
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text,
  password_hash text,
  full_name text,
  firm_id integer REFERENCES firms(id),
  role_id integer REFERENCES roles(id),
  user_type text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  status text
);

-- 5. platform_features
CREATE TABLE IF NOT EXISTS platform_features (
  id serial PRIMARY KEY,
  feature_key text UNIQUE NOT NULL,
  name text NOT NULL,
  module text NOT NULL,
  value_type text DEFAULT 'boolean',
  default_value jsonb,
  description text,
  parent_feature_key text REFERENCES platform_features(feature_key),
  configurable boolean DEFAULT true,
  founder_only boolean DEFAULT false,
  sort_order integer DEFAULT 0,
  status text DEFAULT 'active',
  dependency_json jsonb DEFAULT '[]'::jsonb,
  route_hint text,
  plan_controlled boolean DEFAULT true,
  firm_controlled_override boolean DEFAULT true,
  backend_guard_key text,
  job_guards jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 6. plan_entitlements
CREATE TABLE IF NOT EXISTS plan_entitlements (
  plan_id integer REFERENCES subscription_plans(id),
  feature_key text REFERENCES platform_features(feature_key),
  value_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE (plan_id, feature_key)
);

-- 7. firm_entitlement_overrides
CREATE TABLE IF NOT EXISTS firm_entitlement_overrides (
  id serial PRIMARY KEY,
  firm_id integer REFERENCES firms(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  override_kind text NOT NULL DEFAULT 'temporary',
  override_mode text NOT NULL DEFAULT 'custom',
  value_json jsonb,
  effective_from timestamptz,
  expires_at timestamptz,
  billing_type text NOT NULL DEFAULT 'included',
  price_override numeric(12,2),
  reason text,
  created_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_entitlement_permanent
  ON firm_entitlement_overrides (firm_id, feature_key)
  WHERE override_kind = 'permanent';

-- 8. firm_user_feature_access
CREATE TABLE IF NOT EXISTS firm_user_feature_access (
  firm_id integer,
  user_id integer,
  feature_key text,
  is_enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  created_by integer,
  UNIQUE (firm_id, user_id, feature_key)
);

-- Migration-style ALTERs for columns that may be added in later migrations
ALTER TABLE IF EXISTS platform_features ADD COLUMN IF NOT EXISTS plan_controlled boolean DEFAULT true;
ALTER TABLE IF EXISTS platform_features ADD COLUMN IF NOT EXISTS firm_controlled_override boolean DEFAULT true;
ALTER TABLE IF EXISTS platform_features ADD COLUMN IF NOT EXISTS backend_guard_key text;
ALTER TABLE IF EXISTS platform_features ADD COLUMN IF NOT EXISTS job_guards jsonb DEFAULT '[]'::jsonb;

ALTER TABLE IF EXISTS firm_entitlement_overrides ADD COLUMN IF NOT EXISTS override_kind text DEFAULT 'permanent';
ALTER TABLE IF EXISTS firm_entitlement_overrides ADD COLUMN IF NOT EXISTS override_mode text DEFAULT 'force_on';
ALTER TABLE IF EXISTS firm_entitlement_overrides ADD COLUMN IF NOT EXISTS effective_from timestamptz;
ALTER TABLE IF EXISTS firm_entitlement_overrides ADD COLUMN IF NOT EXISTS expires_at timestamptz;
`;

export async function applyEntitlementFoundationDdl(pg: PGlite): Promise<void> {
  try {
    await pg.exec("BEGIN;");
    await pg.exec(ENTITLEMENT_FOUNDATION_DDL);
    await pg.exec("COMMIT;");
  } catch (err) {
    try {
      await pg.exec("ROLLBACK;");
    } catch {
      // ignore rollback error
    }
    throw err;
  }
}

interface SeedCanonicalFeatureRegistryOpts {
  planId?: number;
}

function esc(s: unknown): string {
  if (s === null || s === undefined) return "NULL";
  if (typeof s === "string") return "'" + s.replace(/'/g, "''") + "'";
  if (typeof s === "boolean") return s ? "true" : "false";
  if (typeof s === "number") return String(s);
  return "'" + JSON.stringify(s).replace(/'/g, "''") + "'";
}

function escJson(v: unknown): string {
  const j = JSON.stringify(v).replace(/'/g, "''");
  return "'" + j + "'::jsonb";
}

export async function seedCanonicalFeatureRegistry(
  pg: PGlite,
  opts?: SeedCanonicalFeatureRegistryOpts,
): Promise<void> {
  const planId = opts?.planId ?? 1;

  {
    const slug = "'starter'";
    const name = "'Starter'";
    await pg.exec(`
      INSERT INTO subscription_plans (id, name, slug, is_active, price_monthly, created_at, updated_at)
      VALUES (1, ${name}, ${slug}, true, 0, now(), now())
      ON CONFLICT (id) DO NOTHING;
    `);
  }

  {
    const name = "'Test Firm'";
    const slug = "'test-firm'";
    await pg.exec(`
      INSERT INTO firms (id, name, slug, status, subscription_plan_id, subscription_status, created_at, updated_at)
      VALUES (1, ${name}, ${slug}, 'active', 1, 'active', now(), now())
      ON CONFLICT (id) DO NOTHING;
    `);
  }

  {
    await pg.exec(`
      INSERT INTO roles (id, name, firm_id, description, permissions, created_at)
      VALUES
        (1, 'Partner', 1, 'Partner role with full access', '{}'::jsonb, now()),
        (2, 'Lawyer', 1, 'Lawyer role', '{}'::jsonb, now()),
        (3, 'Clerk', 1, 'Clerk role with basic access', '{}'::jsonb, now())
      ON CONFLICT (id) DO NOTHING;
    `);
  }

  {
    const founderEmail = "'founder@example.com'";
    const founderName = "'Founder User'";
    const partnerEmail = "'partner@example.com'";
    const partnerName = "'Partner User'";
    const clerkEmail = "'clerk@example.com'";
    const clerkName = "'Clerk User'";
    const ph = "'pwhash_test'";
    await pg.exec(`
      INSERT INTO users (id, email, password_hash, full_name, user_type, firm_id, role_id, status, created_at, updated_at)
      VALUES
        (1, ${founderEmail}, ${ph}, ${founderName}, 'founder', NULL, NULL, 'active', now(), now()),
        (2, ${partnerEmail}, ${ph}, ${partnerName}, 'firm_user', 1, 1, 'active', now(), now()),
        (3, ${clerkEmail}, ${ph}, ${clerkName}, 'firm_user', 1, 3, 'active', now(), now())
      ON CONFLICT (id) DO NOTHING;
    `);
  }

  for (const def of FEATURE_REGISTRY_MAP.values()) {
    const defaultValue =
      def.defaultValue !== undefined ? def.defaultValue : def.valueType === "boolean" ? true : def.valueType === "integer" || def.valueType === "decimal" ? 0 : null;

    const fkEsc = def.featureKey.replace(/'/g, "''");
    const nmEsc = (def.name ?? "").replace(/'/g, "''");
    const modEsc = String(def.module).replace(/'/g, "''");
    const vtEsc = (def.valueType ?? "boolean").replace(/'/g, "''");
    const dvJson = escJson({ v: defaultValue });
    const descQ = def.description ? esc(def.description) : "NULL";
    const pfkQ = def.parentFeatureKey ? esc(def.parentFeatureKey) : "NULL";
    const confQ = def.configurable !== false ? "true" : "false";
    const fdrQ = !!def.founderOnly ? "true" : "false";
    const sortV = typeof def.sortOrder === "number" ? String(def.sortOrder) : "0";
    const stQ = esc(def.status ?? "active");
    const depJson =
      def.dependencies && def.dependencies.length > 0
        ? escJson([...def.dependencies])
        : "'[]'::jsonb";
    const rhQ = def.routeHint ? esc(def.routeHint) : "NULL";
    const pcQ = def.planControlled !== false ? "true" : "false";
    const fcoQ = def.firmControlledOverride !== false ? "true" : "false";
    const bgQ = def.backendGuardKey ? esc(def.backendGuardKey) : "NULL";
    const jgJson =
      def.jobGuards && def.jobGuards.length > 0
        ? escJson([...def.jobGuards])
        : "'[]'::jsonb";

    await pg.exec(`
      INSERT INTO platform_features (
        feature_key, name, module, value_type, default_value, description,
        parent_feature_key, configurable, founder_only, sort_order, status,
        dependency_json, route_hint, plan_controlled, firm_controlled_override,
        backend_guard_key, job_guards
      ) VALUES (
        '${fkEsc}', '${nmEsc}', '${modEsc}', '${vtEsc}', ${dvJson}, ${descQ},
        ${pfkQ}, ${confQ}, ${fdrQ}, ${sortV}, ${stQ},
        ${depJson}, ${rhQ}, ${pcQ}, ${fcoQ},
        ${bgQ}, ${jgJson}
      ) ON CONFLICT (feature_key) DO NOTHING;
    `);
  }

  for (const def of FEATURE_REGISTRY_MAP.values()) {
    let planValue: unknown;
    if (def.valueType === "boolean") {
      const denyList: readonly string[] = [
        "storage.file_custody",
      ];
      const isDeny = denyList.includes(def.featureKey);
      planValue = isDeny ? false : (def.defaultValue !== undefined ? !!def.defaultValue : true);
    } else if (def.valueType === "integer" || def.valueType === "decimal") {
      planValue = def.defaultValue !== undefined ? def.defaultValue : 0;
    } else {
      planValue = def.defaultValue !== undefined ? def.defaultValue : null;
    }

    const fkEsc = def.featureKey.replace(/'/g, "''");
    const vj = escJson({ v: planValue });

    await pg.exec(`
      INSERT INTO plan_entitlements (plan_id, feature_key, value_json, created_at)
      VALUES (${planId}, '${fkEsc}', ${vj}, now())
      ON CONFLICT (plan_id, feature_key) DO NOTHING;
    `);
  }
}

export function buildPGliteEntitlementEnv(): {
  DATABASE_URL: undefined;
  VITEST_SKIP_DB: undefined;
} {
  return {
    DATABASE_URL: undefined,
    VITEST_SKIP_DB: undefined,
  };
}
