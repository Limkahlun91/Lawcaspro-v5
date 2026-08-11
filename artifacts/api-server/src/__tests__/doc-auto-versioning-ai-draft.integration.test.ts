import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql, eq, and, desc } from "drizzle-orm";
import {
  documentTemplateVersionsTable,
  documentGenerationRunsTable,
  caseDocumentsTable,
  documentTemplatesTable,
  aiDraftSuggestionsTable,
} from "@workspace/db";
import {
  getCaseDocumentTraceBundle,
  getTemplateVersionHistory,
  getDocumentGenerationTraceForCaseDocument,
} from "../modules/documents/document-traceability.service.js";
import {
  createAiDraftSuggestion,
  reviewAiDraftSuggestion,
  listAiDraftSuggestions,
  type CreateAiDraftSuggestionInput,
  type ReviewAiDraftSuggestionInput,
} from "../modules/documents/ai-draft-assistant.service.js";

const FIRM_ID = 90001;

const DOC_DDL = `
CREATE TABLE IF NOT EXISTS document_templates (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'template',
  document_type TEXT NOT NULL DEFAULT 'other',
  is_active BOOLEAN NOT NULL DEFAULT true,
  print_mode TEXT NOT NULL DEFAULT 'double',
  document_group TEXT NOT NULL DEFAULT 'Others',
  sort_order INTEGER NOT NULL DEFAULT 0,
  object_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_template_versions (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  source_object_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  template_kind TEXT,
  category TEXT,
  document_group TEXT,
  variables_snapshot JSONB,
  pdf_mappings_snapshot JSONB,
  applicability_rules_snapshot JSONB,
  readiness_rules_snapshot JSONB,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_by INTEGER,
  published_at TIMESTAMPTZ,
  archived_by INTEGER,
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS case_documents (
  id SERIAL PRIMARY KEY,
  case_id INTEGER,
  firm_id INTEGER NOT NULL,
  template_id INTEGER,
  template_source TEXT,
  name TEXT NOT NULL,
  document_type TEXT NOT NULL DEFAULT 'generated',
  status TEXT NOT NULL DEFAULT 'draft',
  object_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  generated_by INTEGER,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  clause_snapshot JSONB,
  naming_snapshot JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_generation_runs (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER NOT NULL,
  template_source TEXT NOT NULL,
  template_id INTEGER,
  template_version_id INTEGER,
  case_document_id INTEGER,
  document_name TEXT NOT NULL,
  render_mode TEXT NOT NULL DEFAULT 'docx',
  status TEXT NOT NULL DEFAULT 'pending',
  request_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  rendered_variables_snapshot JSONB,
  checklist_snapshot JSONB,
  readiness_snapshot JSONB,
  triggered_by INTEGER,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

describe("Document Version Traceability (PART 3A)", () => {
  let pg: PGlite;
  let r: any;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    r = drizzle(pg as any);
    await pg.exec(DOC_DDL);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("DVT-1: traces WHO created WHICH template version + published/archived actors preserved exactly", async () => {
    await pg.exec(`
      INSERT INTO document_templates (id, firm_id, name, object_path, file_name)
      VALUES (501, ${FIRM_ID}, 'SPA Sale Agreement', '/tpl/spa_v1.docx', 'spa_v1.docx');

      INSERT INTO document_template_versions
        (firm_id, template_id, version_no, status, source_object_path, filename, category,
         created_by, created_at, published_by, published_at)
      VALUES
        (${FIRM_ID}, 501, 1, 'published', '/v1/spa.docx', 'spa.docx', 'SPA',
         101, NOW() - INTERVAL '20 days', 102, NOW() - INTERVAL '19 days'),
        (${FIRM_ID}, 501, 2, 'draft',     '/v2/spa.docx', 'spa.docx', 'SPA',
         103, NOW() - INTERVAL '1 day', NULL, NULL);
    `);
    const history = await getTemplateVersionHistory(FIRM_ID, 501, { tx: r });
    expect(history.length).toBe(2);
    const [latestV2, v1] = history;
    expect(latestV2.versionNo).toBe(2);
    expect(latestV2.status).toBe("draft");
    expect(latestV2.createdBy).toBe(103);
    expect(latestV2.publishedBy).toBeNull();
    expect(v1.versionNo).toBe(1);
    expect(v1.status).toBe("published");
    expect(v1.createdBy).toBe(101);
    expect(v1.publishedBy).toBe(102);
    expect(v1.templateName).toBe("SPA Sale Agreement");
  });

  it("DVT-2: case_document = case_document_id → generations[] with triggered_by actor + template_versions[]", async () => {
    await pg.exec(`
      INSERT INTO case_documents
        (id, firm_id, case_id, template_id, template_source, name, object_path, file_name, generated_by)
      VALUES (2001, ${FIRM_ID}, 88001, 501, 'firm', 'Generated SPA', '/cases/88001/spa.docx', 'spa.docx', 201);

      INSERT INTO document_generation_runs
        (firm_id, case_id, template_source, template_id, case_document_id, document_name, status,
         triggered_by, triggered_at, started_at, finished_at)
      VALUES
        (${FIRM_ID}, 88001, 'firm', 501, 2001, 'SPA attempt 1', 'failed',  202, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '118 minutes'),
        (${FIRM_ID}, 88001, 'firm', 501, 2001, 'SPA final',     'success', 201, NOW() - INTERVAL '1 hour',  NOW() - INTERVAL '1 hour',  NOW() - INTERVAL '58 minutes');
    `);
    const bundle = await getCaseDocumentTraceBundle(FIRM_ID, 2001, { tx: r });
    expect(bundle.caseDocument?.id).toBe(2001);
    expect(bundle.caseDocument?.generatedBy).toBe(201);
    expect(bundle.templateVersions.length).toBeGreaterThanOrEqual(2);
    expect(bundle.generations.length).toBe(2);
    const [firstGen, secondGen] = bundle.generations;
    expect(firstGen.status).toBe("success");
    expect(firstGen.triggeredBy).toBe(201);
    expect(secondGen.status).toBe("failed");
    expect(secondGen.triggeredBy).toBe(202);
    expect(bundle.linkedTemplateName).toBe("SPA Sale Agreement");
    // Verify getDocumentGenerationTrace directly
    const direct = await getDocumentGenerationTraceForCaseDocument(FIRM_ID, 2001, { tx: r, limit: 1 });
    expect(direct.length).toBe(1);
    expect(direct[0].status).toBe("success");
  });

  it("DVT-3: 404 for out-of-firm case document — isolation intact", async () => {
    const OTHER_FIRM = 90002;
    await expect(getCaseDocumentTraceBundle(OTHER_FIRM, 2001, { tx: r }))
      .rejects
      .toThrow(/CASE_DOCUMENT_NOT_FOUND|not found/i);
  });

  it("DVT-4: idempotent key preserves actor for document generation runs", async () => {
    const runs = (await r
      .select({ triggeredBy: documentGenerationRunsTable.triggeredBy as any, status: documentGenerationRunsTable.status, caseDocumentId: documentGenerationRunsTable.caseDocumentId as any })
      .from(documentGenerationRunsTable)
      .where(and(eq((documentGenerationRunsTable as any).firmId, FIRM_ID), eq(documentGenerationRunsTable.caseDocumentId as any, 2001)))
      .orderBy(desc((documentGenerationRunsTable as any).triggeredAt as any))) as any[];
    expect(runs.length).toBe(2);
    expect(runs.map((x) => x.triggeredBy)).toEqual([201, 202]);
  });
});

describe("AI Draft Review Lifecycle (PART 3B)", () => {
  let pg: PGlite;
  let r: any;

  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    r = drizzle(pg as any);
    const AI_DDL = `
      CREATE TABLE IF NOT EXISTS ai_draft_suggestions (
        id SERIAL PRIMARY KEY,
        firm_id INTEGER NOT NULL,
        case_id INTEGER,
        document_id INTEGER,
        template_id INTEGER,
        suggestion_scope TEXT NOT NULL DEFAULT 'document_clause',
        target_section TEXT,
        prompt_text TEXT NOT NULL,
        prompt_tokens_used INTEGER,
        completion_tokens_used INTEGER,
        total_tokens_used INTEGER,
        provider_model TEXT,
        suggestion_content JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'proposed',
        rejection_reason TEXT,
        review_comments TEXT,
        modification_snapshot JSONB,
        reviewer_user_id INTEGER,
        reviewed_at TIMESTAMPTZ,
        linked_document_version_id INTEGER,
        linked_case_document_id INTEGER,
        correlation_id TEXT,
        idempotency_key TEXT,
        created_by INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_draft_suggestions_idempotency
        ON ai_draft_suggestions (firm_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `;
    await pg.exec(AI_DDL);
  });

  afterAll(async () => {
    await pg.close?.();
  });

  it("AID-1: create suggestion → status=proposed, AI NOT_CONFIGURED returns skeleton with assistant_note", async () => {
    const input: CreateAiDraftSuggestionInput = {
      firmId: FIRM_ID,
      caseId: 88001,
      scope: "document_clause",
      targetSection: "Clause 12 Indemnity",
      prompt: "Draft a standard Malaysian SPA indemnity clause for purchaser's defect liability period.",
      createdBy: 201,
      idempotencyKey: "AI-DRAFT-UNIT-1001",
    };
    const result = await createAiDraftSuggestion(input, { tx: r, skipLlm: true });
    expect(result.firmId).toBe(FIRM_ID);
    expect(result.status).toBe("proposed");
    expect(result.createdBy).toBe(201);
    expect(result.suggestionScope).toBe("document_clause");

    // Idempotency: same key → same row back
    const dup = await createAiDraftSuggestion(input, { tx: r, skipLlm: true });
    expect(dup.id).toBe(result.id);

    // With LLM but no keys: offline skeleton returned
    const offlineInput: CreateAiDraftSuggestionInput = {
      firmId: FIRM_ID, caseId: 88001,
      scope: "document_clause",
      prompt: "Short draft", createdBy: 201,
      idempotencyKey: "AI-DRAFT-OFFLINE-1002",
    };
    const offline = await createAiDraftSuggestion(offlineInput, { tx: r });
    expect(offline.status).toBe("proposed");
    const content = offline.suggestionContent as any;
    expect(content?.warning_code === "AI_NOT_CONFIGURED" || content?.created_without_llm === true).toBe(true);
  });

  it("AID-2: proposed → ACCEPTED  →  actor=reviewer;  reviewer_user_id / reviewed_at stamped", async () => {
    const created = await createAiDraftSuggestion({
      firmId: FIRM_ID, caseId: 88001, scope: "document_clause",
      prompt: "Acceptance case", createdBy: 201,
      idempotencyKey: "AI-DRAFT-REVIEW-2001",
    }, { tx: r, skipLlm: true });

    const review: ReviewAiDraftSuggestionInput = {
      firmId: FIRM_ID, suggestionId: created.id, actorId: 302,
      newStatus: "accepted",
      comments: "Looks good; minor tweak in subsection d.",
      linkedCaseDocumentId: 2001,
    };
    const accepted = await reviewAiDraftSuggestion(review, { tx: r });
    expect(accepted.status).toBe("accepted");
    expect(accepted.reviewerUserId).toBe(302);
    expect(accepted.reviewComments).toBe("Looks good; minor tweak in subsection d.");
    expect(accepted.reviewedAt).toBeInstanceOf(Date);
    expect(accepted.linkedCaseDocumentId).toBe(2001);
  });

  it("AID-3: proposed → REJECTED  →  rejectionReason captured", async () => {
    const created = await createAiDraftSuggestion({
      firmId: FIRM_ID, scope: "custom", prompt: "Reject me", createdBy: 201,
      idempotencyKey: "AI-DRAFT-REJECT-3001",
    }, { tx: r, skipLlm: true });
    const rejected = await reviewAiDraftSuggestion({
      firmId: FIRM_ID, suggestionId: created.id, actorId: 302,
      newStatus: "rejected", rejectionReason: "Unenforceable in Malaysia; cite Contracts Act 1950 s.28.",
    }, { tx: r });
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionReason).toMatch(/Contracts Act/);
  });

  it("AID-4: INVALID transitions blocked — accepted→rejected (reversal) & terminal→any", async () => {
    const created = await createAiDraftSuggestion({
      firmId: FIRM_ID, scope: "document_full", prompt: "Transition test", createdBy: 201,
      idempotencyKey: "AI-DRAFT-TRANS-4001",
    }, { tx: r, skipLlm: true });

    await reviewAiDraftSuggestion({
      firmId: FIRM_ID, suggestionId: created.id, actorId: 302, newStatus: "accepted",
      comments: "Initial acceptance",
    }, { tx: r });

    // INVALID: accepted → rejected (reversal forbidden)
    await expect(reviewAiDraftSuggestion({
      firmId: FIRM_ID, suggestionId: created.id, actorId: 302, newStatus: "rejected",
      rejectionReason: "Change mind",
    }, { tx: r })).rejects.toThrow(/INVALID_TRANSITION|cannot change|cannot revert/i);

    // VALID: accepted → superseded (terminal)
    const superseded = await reviewAiDraftSuggestion({
      firmId: FIRM_ID, suggestionId: created.id, actorId: 302, newStatus: "superseded",
    }, { tx: r });
    expect(superseded.status).toBe("superseded");

    // INVALID: superseded → accepted (terminal no exit)
    await expect(reviewAiDraftSuggestion({
      firmId: FIRM_ID, suggestionId: created.id, actorId: 302, newStatus: "accepted",
    }, { tx: r })).rejects.toThrow(/INVALID_TRANSITION|cannot change|terminal/i);
  });

  it("AID-5: list filter by scope/status/caseId respects firm scope (404 on wrong firm)", async () => {
    const byCase = await listAiDraftSuggestions(FIRM_ID, { caseId: 88001, status: "proposed" as any, limit: 10 }, { tx: r });
    expect(byCase.totalCount).toBeGreaterThanOrEqual(1);
    for (const row of byCase.items) {
      expect(row.caseId).toBe(88001);
      expect(row.firmId).toBe(FIRM_ID);
    }
    const otherFirm = await listAiDraftSuggestions(99999, { caseId: 88001 }, { tx: r });
    expect(otherFirm.totalCount).toBe(0);
  });
});
