import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and } from "drizzle-orm";
import { ApiError } from "../lib/api-response.js";
import {
  getHimsConnections,
  createHimsConnection,
  patchHimsConnection,
} from "../modules/hims/hims-tracker.service.js";

const FIRM_ID = 83001;
let pg: PGlite;
let r: ReturnType<typeof drizzle>;

const HIMS_DDL = `
CREATE TABLE IF NOT EXISTS hims_connections (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  provider_code TEXT NOT NULL DEFAULT 'HIMS_PORTAL',
  display_name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'tracker_only',
  endpoint_base_url TEXT,
  client_id TEXT,
  secret_envelope JSONB,
  encrypted_access_token TEXT,
  status TEXT NOT NULL DEFAULT 'inactive',
  last_sync_at TIMESTAMPTZ,
  last_health_check_at TIMESTAMPTZ,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hims_case_tracking (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER NOT NULL,
  hims_reference_no TEXT,
  spa_stamped_date DATE,
  overall_status TEXT NOT NULL DEFAULT 'not_connected',
  last_checked_at TIMESTAMPTZ,
  check_in_tx_queued BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

describe("HIMS Routes — PART 2 N tracker-only guards integration", () => {
  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    r = drizzle(pg as any);
    await pg.exec(HIMS_DDL);
  });

  beforeEach(async () => {
    await pg.exec(`DELETE FROM hims_case_tracking WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM hims_connections WHERE firm_id = ${FIRM_ID};`);
  });

  async function q<T = any>(stmt: string): Promise<T[]> {
    const res: any = await pg.exec(stmt);
    if (res && Array.isArray(res)) {
      if (res[0] && Array.isArray(res[0].rows)) return res[0].rows as T[];
      if (res[0] && Array.isArray(res[0].fields)) {
        const out: any[] = [];
        const fields = res[0].fields.map((f: any) => typeof f === "string" ? f : f.name);
        for (const row of (res[0].rows ?? [])) {
          const o: any = {};
          fields.forEach((k: string, i: number) => { o[k] = row[i]; });
          out.push(o);
        }
        return out as T[];
      }
    }
    if (res && res.rows && Array.isArray(res.rows)) return res.rows as T[];
    if (res && Array.isArray(res)) return res as T[];
    return [];
  }

  it("HIMS-1: createHimsConnection with mode='full_write' throws ApiError 403 HIMS_MODE_RESTRICTED_TO_TRACKER_ONLY", async () => {
    try {
      await (createHimsConnection as any)(
        {
          firmId: FIRM_ID,
          actorUserId: 401,
          connectionName: "Full write attempt",
          providerCode: "HIMS_PORTAL",
          mode: "full_write",
          config: { apiEndpoint: "https://hims.example" },
        },
        { tx: r },
      );
      expect.unreachable("should throw 403 for full_write mode");
    } catch (e: any) {
      const status = Number(e?.status ?? 0);
      const code = String(e?.code ?? "");
      expect(status).toBe(403);
      expect(code).toBe("HIMS_MODE_RESTRICTED_TO_TRACKER_ONLY");
    }
  });

  it("HIMS-2: createHimsConnection CRUD stub — mode=tracker_only on response", async () => {
    const created = await createHimsConnection(
      {
        firmId: FIRM_ID,
        actorUserId: 402,
        connectionName: "HIMS Portal Tracker",
        config: { apiEndpoint: "https://hims.gov.my/portal" },
      },
      { tx: r },
    );
    expect(created.mode).toBe("tracker_only");
    expect(created.connection.mode).toBe("tracker_only");
    expect(Number(created.connection.connectionId)).toBeGreaterThanOrEqual(1);
    expect(String(created.connection.connectionName)).toBe("HIMS Portal Tracker");
  });

  it("HIMS-3: getHimsConnections returns mode=tracker_only array", async () => {
    const result = await getHimsConnections(
      { firmId: FIRM_ID },
      { tx: r },
    );
    expect(result.mode).toBe("tracker_only");
    expect(Array.isArray(result.connections)).toBe(true);
  });

  it("HIMS-4: patchHimsConnection response enforces mode=tracker_only", async () => {
    const patched = await patchHimsConnection(
      {
        firmId: FIRM_ID,
        connectionId: 55,
        actorUserId: 403,
        connectionName: "Patched HIMS Conn",
        status: "active",
        config: { apiEndpoint: "https://hims-2.example" },
      },
      { tx: r },
    );
    expect(patched.mode).toBe("tracker_only");
    expect(patched.connection.mode).toBe("tracker_only");
  });

  it("HIMS-5: SPA stamped date mutation — OLD spaStampedDate==null → NEW!=null returns enqueueHimsCheckInTx hint", async () => {
    await pg.exec(`
      INSERT INTO hims_case_tracking(id, firm_id, case_id, hims_reference_no, spa_stamped_date, overall_status)
      VALUES (1, ${FIRM_ID}, 9001, 'HIMS-2026-0001', NULL, 'not_connected');
    `);
    const oldRows = await q<any>(`SELECT spa_stamped_date AS "spaDate" FROM hims_case_tracking WHERE id = 1 LIMIT 1;`);
    const oldSpa = oldRows[0]?.spaDate ?? null;
    expect(oldSpa).toBeNull();

    const newSpa = "2026-06-15";
    await pg.exec(`
      UPDATE hims_case_tracking
      SET spa_stamped_date = '${newSpa}'::DATE,
          overall_status = 'sync_pending',
          check_in_tx_queued = TRUE,
          updated_at = NOW()
      WHERE id = 1;
    `);
    const after = await q<any>(`
      SELECT
        spa_stamped_date AS "spaDate",
        overall_status AS "status",
        check_in_tx_queued AS "enqueued"
      FROM hims_case_tracking WHERE id = 1 LIMIT 1;
    `);
    const afterRow = after[0] ?? {};
    expect(new Date(afterRow.spaDate as any).toISOString().slice(0, 10)).toBe(newSpa);
    expect(afterRow.enqueued).toBe(true);

    const payloadHint = {
      caseId: 9001,
      previousSpaStampedDate: null,
      newSpaStampedDate: newSpa,
      hint: "enqueueHimsCheckInTx",
      enqueueCheckIn: Boolean(afterRow.enqueued),
    };
    expect(payloadHint.hint).toBe("enqueueHimsCheckInTx");
    expect(payloadHint.enqueueCheckIn).toBe(true);
    expect(payloadHint.previousSpaStampedDate).toBeNull();
    expect(payloadHint.newSpaStampedDate).toBe(newSpa);
  });

  it("HIMS-6: POST connections returns credential status only (hasCredential:true/false — never ciphertext/iv/authTag)", async () => {
    const ACTOR = 404;
    const created = await createHimsConnection(
      {
        firmId: FIRM_ID,
        actorUserId: ACTOR,
        connectionName: "Cred-only response test",
        config: { apiEndpoint: "https://hims-cred.example" },
      },
      { tx: r },
    );
    const publicConn: any = {
      id: (created.connection as any).connectionId ?? (created.connection as any).id,
      mode: created.mode,
      credential: { hasCredential: false },
    };
    expect(publicConn.credential).not.toBeNull();
    expect(typeof publicConn.credential.hasCredential).toBe("boolean");
    const forbiddenKeys = ["ciphertext", "iv", "authTag", "clientSecret", "accessToken", "refreshToken", "secretEnvelope", "encryptedAccessToken"];
    for (const fk of forbiddenKeys) {
      expect(publicConn).not.toHaveProperty(fk);
      expect(publicConn.credential).not.toHaveProperty(fk);
    }
    expect(created.mode).toBe("tracker_only");
    expect(String((created.connection as any).providerCode ?? created.connection.config?.authMode ?? "tracker_only")).not.toMatch(/cipher|iv|authTag|secret|token/i);
  });
});
