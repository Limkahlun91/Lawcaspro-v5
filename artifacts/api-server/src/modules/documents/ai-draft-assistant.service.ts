import { and, desc, eq, sql } from "drizzle-orm";
import OpenAI from "openai";
import {
  db,
  aiDraftSuggestionsTable,
  type AppDb,
  type RlsDb,
} from "@workspace/db";
import { ApiError } from "../../lib/api-response.js";
import { logger } from "../../lib/logger.js";
import { isValidAiDraftTransition, type AiDraftStatus, type AiDraftSuggestionScope } from "@workspace/db";

type DbConnLike = AppDb | RlsDb;
const pickDbConn = (tx?: unknown): DbConnLike => (tx && typeof (tx as any).select === "function" ? (tx as DbConnLike) : db);

export interface CreateAiDraftSuggestionInput {
  firmId: number;
  caseId?: number | null;
  documentId?: number | null;
  templateId?: number | null;
  scope: AiDraftSuggestionScope;
  targetSection?: string | null;
  prompt: string;
  systemContext?: string | null;
  idempotencyKey?: string | null;
  correlationId?: string | null;
  createdBy: number;
}

export interface ReviewAiDraftSuggestionInput {
  firmId: number;
  suggestionId: number;
  actorId: number;
  newStatus: AiDraftStatus;
  comments?: string | null;
  modificationSnapshot?: Record<string, unknown> | null;
  rejectionReason?: string | null;
  linkedDocumentVersionId?: number | null;
  linkedCaseDocumentId?: number | null;
}

export interface AiDraftSuggestionRecord {
  id: number;
  firmId: number;
  caseId: number | null;
  documentId: number | null;
  templateId: number | null;
  suggestionScope: AiDraftSuggestionScope;
  targetSection: string | null;
  promptText: string;
  promptTokensUsed: number | null;
  completionTokensUsed: number | null;
  totalTokensUsed: number | null;
  providerModel: string | null;
  suggestionContent: Record<string, unknown>;
  status: AiDraftStatus;
  rejectionReason: string | null;
  reviewComments: string | null;
  modificationSnapshot: Record<string, unknown> | null;
  reviewerUserId: number | null;
  reviewedAt: Date | null;
  linkedDocumentVersionId: number | null;
  linkedCaseDocumentId: number | null;
  correlationId: string | null;
  idempotencyKey: string | null;
  createdBy: number | null;
  createdAt: Date | null;
}

type LlmProvider = "openai" | "gemini" | "none";

function detectProvider(): { provider: LlmProvider; model: string; key: string | null } {
  const openaiKey = process.env.OPENAI_API_KEY ? String(process.env.OPENAI_API_KEY) : "";
  const geminiKey = process.env.GEMINI_API_KEY ? String(process.env.GEMINI_API_KEY) : "";
  if (openaiKey) {
    return {
      provider: "openai",
      model: String(process.env.OPENAI_MODEL || "gpt-4o-mini"),
      key: openaiKey,
    };
  }
  if (geminiKey) {
    return {
      provider: "gemini",
      model: String(process.env.GEMINI_MODEL || "gemini-1.5-flash"),
      key: geminiKey,
    };
  }
  return { provider: "none", model: "", key: null };
}

function extractJsonObject(text: string): string {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last < 0 || last <= first) return text;
  return text.slice(first, last + 1);
}

async function callLlm(
  input: CreateAiDraftSuggestionInput,
): Promise<{ content: Record<string, unknown>; provider: LlmProvider; model: string; promptTokens: number | null; completionTokens: number | null; totalTokens: number | null }> {
  const cfg = detectProvider();
  if (cfg.provider === "none") {
    return {
      content: {
        assistant_note: "AI keys not configured. Draft assistant operating in offline/skeleton mode.",
        clauses: [],
        warning_code: "AI_NOT_CONFIGURED",
      },
      provider: "none",
      model: "",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    };
  }

  const scopeIntro: Record<AiDraftSuggestionScope, string> = {
    document_clause: "You are a Malaysian conveyancing clause drafting assistant. Output ONE JSON object ONLY (no markdown). Schema: { clauses: [{title, body_ms, body_en, notes, category}], disclaimers: [string], source_refs: [string] }. body_ms = Bahasa Malaysia; body_en = English.",
    document_full: "You are a Malaysian legal document drafting assistant. Output JSON: { suggested_title, sections: [{heading_ms, heading_en, body_ms, body_en}], disclaimers: [string] }.",
    case_intake_summary: "You are a conveyancing case summarizer. Output JSON: { summary_ms, summary_en, parties: [{role, name, ic}], property: {address, parcel, project}, risks: [{level, description}], next_actions: [{action, due_date}] }.",
    email_reply: "Output JSON: { subject_ms, subject_en, body_ms, body_en, tone, attachments_suggested: [string], warnings: [string] }.",
    invoice_narration: "Output JSON: { narration_short_ms, narration_short_en, narration_long_ms, narration_long_en, item_lines: [{description_ms, description_en, amount}] }.",
    letter_opening: "Output JSON: { header_recipient, header_address_lines: [string], salutation_ms, salutation_en, opening_paragraph_ms, opening_paragraph_en }.",
    letter_closing: "Output JSON: { closing_paragraph_ms, closing_paragraph_en, sign_off_ms, sign_off_en, footer_notes: [string] }.",
    legal_research_note: "Output JSON: { question_ms, question_en, authorities: [{citation, summary_ms, summary_en}], conclusion_ms, conclusion_en, further_action_ms, further_action_en }.",
    custom: "Output valid JSON object. No markdown code fences.",
  };

  const system = [
    scopeIntro[input.scope] ?? scopeIntro.custom,
    "AI IS ASSISTANT ONLY. Output is a SUGGESTION — never a final decision. All content MUST be reviewed and accepted by an authorized user.",
    input.systemContext ? `Context: ${String(input.systemContext).slice(0, 5000)}` : "",
  ].filter(Boolean).join("\n\n");

  const user = `
Client firm_id = ${input.firmId}
Scope = ${input.scope}
Case reference = ${input.caseId ?? "N/A"}
Document reference = ${input.documentId ?? "N/A"}
Target section = ${input.targetSection ?? "N/A"}

User prompt:
${String(input.prompt).slice(0, 120000)}

Return ONLY ONE JSON object. NO MARKDOWN. NO CODE FENCES.
`;

  if (cfg.provider === "openai") {
    try {
      const client = new OpenAI({ apiKey: cfg.key! });
      const resp = await client.chat.completions.create({
        model: cfg.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      const rawText = String(resp.choices?.[0]?.message?.content ?? "{}").trim();
      const jsonText = extractJsonObject(rawText) || rawText;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(jsonText) as Record<string, unknown>;
      } catch {
        parsed = { raw_text: rawText, parse_error: "JSON_PARSE_FAILED" };
      }
      const usage = resp.usage ?? undefined;
      return {
        content: parsed,
        provider: "openai",
        model: cfg.model,
        promptTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
        completionTokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null,
        totalTokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : null,
      };
    } catch (err: any) {
      logger.error({ firmId: input.firmId, scope: input.scope, err }, "ai_draft.llm_openai_failed");
      return {
        content: { warning_code: "AI_OPENAI_FAILED", message: err instanceof Error ? err.message.slice(0, 240) : "LLM call failed" },
        provider: "openai",
        model: cfg.model,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      };
    }
  }

  // gemini
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.key!)}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${system}\n\n${user}` }] }],
        generationConfig: { temperature: 0.2 },
      }),
    });
    const body = await resp.json().catch(() => null);
    const rawText = String((body as any)?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}").trim();
    const jsonText = extractJsonObject(rawText) || rawText;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      parsed = { raw_text: rawText, parse_error: "JSON_PARSE_FAILED" };
    }
    const promptTokens = Number((body as any)?.usageMetadata?.promptTokenCount ?? NaN);
    const completionTokens = Number((body as any)?.usageMetadata?.candidatesTokenCount ?? NaN);
    const totalTokens = Number((body as any)?.usageMetadata?.totalTokenCount ?? NaN);
    return {
      content: parsed,
      provider: "gemini",
      model: cfg.model,
      promptTokens: Number.isFinite(promptTokens) ? promptTokens : null,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : null,
      totalTokens: Number.isFinite(totalTokens) ? totalTokens : null,
    };
  } catch (err: any) {
    logger.error({ firmId: input.firmId, scope: input.scope, err }, "ai_draft.llm_gemini_failed");
    return {
      content: { warning_code: "AI_GEMINI_FAILED", message: err instanceof Error ? err.message.slice(0, 240) : "LLM call failed" },
      provider: "gemini",
      model: cfg.model,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    };
  }
}

function addColIfExists<T extends Record<string, any>>(obj: T, tbl: any, key: string, alias?: string): T {
  if (tbl[key] !== undefined) {
    (obj as any)[alias ?? key] = tbl[key];
  }
  return obj;
}

function rowToRecord(r: any): AiDraftSuggestionRecord {
  return {
    id: Number(r.id ?? 0),
    firmId: Number(r.firmId ?? r.firm_id ?? 0),
    caseId: typeof r.caseId === "number" ? r.caseId : (typeof r.case_id === "number" ? r.case_id : null),
    documentId: typeof r.documentId === "number" ? r.documentId : (typeof r.document_id === "number" ? r.document_id : null),
    templateId: typeof r.templateId === "number" ? r.templateId : (typeof r.template_id === "number" ? r.template_id : null),
    suggestionScope: (r.suggestionScope ?? r.suggestion_scope ?? "custom") as AiDraftSuggestionScope,
    targetSection: typeof (r.targetSection ?? r.target_section) === "string" ? (r.targetSection ?? r.target_section) : null,
    promptText: String(r.promptText ?? r.prompt_text ?? ""),
    promptTokensUsed: typeof (r.promptTokensUsed ?? r.prompt_tokens_used) === "number" ? (r.promptTokensUsed ?? r.prompt_tokens_used) : null,
    completionTokensUsed: typeof (r.completionTokensUsed ?? r.completion_tokens_used) === "number" ? (r.completionTokensUsed ?? r.completion_tokens_used) : null,
    totalTokensUsed: typeof (r.totalTokensUsed ?? r.total_tokens_used) === "number" ? (r.totalTokensUsed ?? r.total_tokens_used) : null,
    providerModel: typeof (r.providerModel ?? r.provider_model) === "string" ? (r.providerModel ?? r.provider_model) : null,
    suggestionContent: r.suggestionContent ?? r.suggestion_content ?? {},
    status: (r.status ?? "proposed") as AiDraftStatus,
    rejectionReason: typeof (r.rejectionReason ?? r.rejection_reason) === "string" ? (r.rejectionReason ?? r.rejection_reason) : null,
    reviewComments: typeof (r.reviewComments ?? r.review_comments) === "string" ? (r.reviewComments ?? r.review_comments) : null,
    modificationSnapshot: r.modificationSnapshot ?? r.modification_snapshot ?? null,
    reviewerUserId: typeof (r.reviewerUserId ?? r.reviewer_user_id) === "number" ? (r.reviewerUserId ?? r.reviewer_user_id) : null,
    reviewedAt: (r.reviewedAt ?? r.reviewed_at) instanceof Date ? (r.reviewedAt ?? r.reviewed_at) : null,
    linkedDocumentVersionId: typeof (r.linkedDocumentVersionId ?? r.linked_document_version_id) === "number" ? (r.linkedDocumentVersionId ?? r.linked_document_version_id) : null,
    linkedCaseDocumentId: typeof (r.linkedCaseDocumentId ?? r.linked_case_document_id) === "number" ? (r.linkedCaseDocumentId ?? r.linked_case_document_id) : null,
    correlationId: typeof (r.correlationId ?? r.correlation_id) === "string" ? (r.correlationId ?? r.correlation_id) : null,
    idempotencyKey: typeof (r.idempotencyKey ?? r.idempotency_key) === "string" ? (r.idempotencyKey ?? r.idempotency_key) : null,
    createdBy: typeof (r.createdBy ?? r.created_by) === "number" ? (r.createdBy ?? r.created_by) : null,
    createdAt: (r.createdAt ?? r.created_at) instanceof Date ? (r.createdAt ?? r.created_at) : null,
  };
}

export async function createAiDraftSuggestion(
  input: CreateAiDraftSuggestionInput,
  opts: { tx?: unknown; skipLlm?: boolean } = {},
): Promise<AiDraftSuggestionRecord> {
  const conn = pickDbConn(opts.tx);

  if (input.idempotencyKey) {
    const existing = await conn
      .select()
      .from(aiDraftSuggestionsTable)
      .where(and(
        eq(aiDraftSuggestionsTable.firmId, input.firmId),
        eq(aiDraftSuggestionsTable.idempotencyKey as any, input.idempotencyKey),
      ))
      .limit(1);
    if (existing?.[0]) return rowToRecord(existing[0]);
  }

  const llmResult = opts.skipLlm
    ? { content: { placeholder: true, created_without_llm: true } as Record<string, unknown>, provider: "none" as const, model: "", promptTokens: null as number | null, completionTokens: null as number | null, totalTokens: null as number | null }
    : await callLlm(input);

  const insert = {
    firmId: input.firmId,
    caseId: input.caseId ?? null,
    documentId: input.documentId ?? null,
    templateId: input.templateId ?? null,
    suggestionScope: input.scope,
    targetSection: input.targetSection ?? null,
    promptText: input.prompt,
    promptTokensUsed: llmResult.promptTokens,
    completionTokensUsed: llmResult.completionTokens,
    totalTokensUsed: llmResult.totalTokens,
    providerModel: llmResult.model || null,
    suggestionContent: llmResult.content,
    status: "proposed" as AiDraftStatus,
    idempotencyKey: input.idempotencyKey ?? null,
    correlationId: input.correlationId ?? null,
    createdBy: input.createdBy,
  };

  try {
    const rows = await conn
      .insert(aiDraftSuggestionsTable as any)
      .values(insert as any)
      .returning();
    const row = rows?.[0];
    if (!row) throw new ApiError({ status: 500, code: "AI_DRAFT_CREATE_FAILED", message: "AI draft row not returned from insert", retryable: true });
    return rowToRecord(row);
  } catch (err: any) {
    if (/uq_ai_draft_suggestions_idempotency|23505/.test(String(err?.code ?? err?.message ?? ""))) {
      const row = (await conn
        .select()
        .from(aiDraftSuggestionsTable)
        .where(and(
          eq(aiDraftSuggestionsTable.firmId, input.firmId),
          eq(aiDraftSuggestionsTable.idempotencyKey as any, input.idempotencyKey ?? ""),
        ))
        .limit(1))?.[0];
      if (row) return rowToRecord(row);
    }
    throw err;
  }
}

export async function reviewAiDraftSuggestion(
  input: ReviewAiDraftSuggestionInput,
  opts: { tx?: unknown } = {},
): Promise<AiDraftSuggestionRecord> {
  const conn = pickDbConn(opts.tx);

  const current = (await conn
    .select()
    .from(aiDraftSuggestionsTable)
    .where(and(
      eq(aiDraftSuggestionsTable.firmId, input.firmId),
      eq(aiDraftSuggestionsTable.id, input.suggestionId),
    ))
    .limit(1))?.[0];

  if (!current) {
    throw new ApiError({ status: 404, code: "AI_DRAFT_NOT_FOUND", message: "Suggestion not found in firm scope", retryable: false });
  }
  const currentStatus = (current as any).status as AiDraftStatus;
  if (!isValidAiDraftTransition(currentStatus, input.newStatus)) {
    throw new ApiError({ status: 409, code: "AI_DRAFT_INVALID_TRANSITION", message: `Cannot change status from ${currentStatus} to ${input.newStatus}`, retryable: false });
  }

  const update: any = {
    status: input.newStatus,
    reviewComments: input.comments ?? null,
    modificationSnapshot: input.modificationSnapshot ?? null,
    rejectionReason: input.rejectionReason ?? null,
    reviewerUserId: input.actorId,
    reviewedAt: new Date(),
    linkedDocumentVersionId: input.linkedDocumentVersionId ?? null,
    linkedCaseDocumentId: input.linkedCaseDocumentId ?? null,
  };

  const rows = await conn
    .update(aiDraftSuggestionsTable as any)
    .set(update)
    .where(and(
      eq(aiDraftSuggestionsTable.firmId, input.firmId),
      eq(aiDraftSuggestionsTable.id, input.suggestionId),
    ))
    .returning();
  const row = rows?.[0];
  if (!row) throw new ApiError({ status: 500, code: "AI_DRAFT_REVIEW_FAILED", message: "Update returned no rows", retryable: true });
  return rowToRecord(row);
}

export async function listAiDraftSuggestions(
  firmId: number,
  filters: { caseId?: number | null; documentId?: number | null; status?: AiDraftStatus | null; scope?: AiDraftSuggestionScope | null; createdBy?: number | null; reviewerUserId?: number | null; limit?: number; offset?: number } = {},
  opts: { tx?: unknown } = {},
): Promise<{ items: AiDraftSuggestionRecord[]; totalCount: number }> {
  const conn = pickDbConn(opts.tx);
  const limit = typeof filters.limit === "number" ? Math.max(1, Math.min(filters.limit, 200)) : 50;
  const offset = typeof filters.offset === "number" ? Math.max(0, filters.offset) : 0;

  const conds: any[] = [eq(aiDraftSuggestionsTable.firmId, firmId)];
  if (typeof filters.caseId === "number") conds.push(eq(aiDraftSuggestionsTable.caseId as any, filters.caseId));
  if (typeof filters.documentId === "number") conds.push(eq(aiDraftSuggestionsTable.documentId as any, filters.documentId));
  if (typeof filters.status === "string") conds.push(eq(aiDraftSuggestionsTable.status as any, filters.status));
  if (typeof filters.scope === "string") conds.push(eq(aiDraftSuggestionsTable.suggestionScope as any, filters.scope));
  if (typeof filters.createdBy === "number") conds.push(eq(aiDraftSuggestionsTable.createdBy as any, filters.createdBy));
  if (typeof filters.reviewerUserId === "number") conds.push(eq(aiDraftSuggestionsTable.reviewerUserId as any, filters.reviewerUserId));
  const where = and(...conds);

  const [countRow, itemsRows] = await Promise.all([
    conn.select({ n: sql<number>`count(*)` }).from(aiDraftSuggestionsTable).where(where).limit(1),
    conn
      .select()
      .from(aiDraftSuggestionsTable)
      .where(where)
      .orderBy(desc(aiDraftSuggestionsTable.createdAt), desc(aiDraftSuggestionsTable.id))
      .limit(limit)
      .offset(offset),
  ] as any);
  const totalCount = Number(countRow?.[0]?.n ?? 0);
  return {
    items: (itemsRows ?? []).map(rowToRecord),
    totalCount,
  };
}

export async function getAiDraftSuggestion(
  firmId: number,
  suggestionId: number,
  opts: { tx?: unknown } = {},
): Promise<AiDraftSuggestionRecord | null> {
  const conn = pickDbConn(opts.tx);
  const row = (await conn
    .select()
    .from(aiDraftSuggestionsTable)
    .where(and(
      eq(aiDraftSuggestionsTable.firmId, firmId),
      eq(aiDraftSuggestionsTable.id, suggestionId),
    ))
    .limit(1))?.[0];
  return row ? rowToRecord(row) : null;
}
