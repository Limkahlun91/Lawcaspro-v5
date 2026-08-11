import { pgTable, serial, text, integer, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const aiDraftSuggestionsTable = pgTable("ai_draft_suggestions", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id"),
  documentId: integer("document_id"),
  templateId: integer("template_id"),
  suggestionScope: text("suggestion_scope").notNull().default("document_clause"),
  targetSection: text("target_section"),
  promptText: text("prompt_text").notNull(),
  promptTokensUsed: integer("prompt_tokens_used"),
  completionTokensUsed: integer("completion_tokens_used"),
  totalTokensUsed: integer("total_tokens_used"),
  providerModel: text("provider_model"),
  suggestionContent: jsonb("suggestion_content").notNull().default({}),
  status: text("status").notNull().default("proposed"),
  rejectionReason: text("rejection_reason"),
  reviewComments: text("review_comments"),
  modificationSnapshot: jsonb("modification_snapshot"),
  reviewerUserId: integer("reviewer_user_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  linkedDocumentVersionId: integer("linked_document_version_id"),
  linkedCaseDocumentId: integer("linked_case_document_id"),
  correlationId: text("correlation_id"),
  idempotencyKey: text("idempotency_key"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_ai_draft_suggestions_firm").on(t.firmId),
  firmCaseIdx: index("idx_ai_draft_suggestions_firm_case").on(t.firmId, t.caseId),
  firmStatusIdx: index("idx_ai_draft_suggestions_firm_status").on(t.firmId, t.status),
  firmDocIdx: index("idx_ai_draft_suggestions_firm_document").on(t.firmId, t.documentId),
  firmScopeIdx: index("idx_ai_draft_suggestions_firm_scope").on(t.firmId, t.suggestionScope, t.createdAt),
  correlationIdx: index("idx_ai_draft_suggestions_correlation").on(t.firmId, t.correlationId).where(sql`correlation_id IS NOT NULL`),
  idempotencyUq: uniqueIndex("uq_ai_draft_suggestions_idempotency").on(t.firmId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  createdAtIdx: index("idx_ai_draft_suggestions_created_at").on(t.firmId, t.createdAt),
}));

export type AiDraftStatus = "proposed" | "accepted" | "rejected" | "modified_accepted" | "superseded" | "expired";

export type AiDraftSuggestionScope =
  | "document_clause"
  | "document_full"
  | "case_intake_summary"
  | "email_reply"
  | "invoice_narration"
  | "letter_opening"
  | "letter_closing"
  | "legal_research_note"
  | "custom";

export const INVALID_AI_DRAFT_TRANSITIONS: ReadonlyMap<AiDraftStatus, readonly AiDraftStatus[]> = (() => {
  const all: readonly AiDraftStatus[] = ["proposed", "accepted", "rejected", "modified_accepted", "superseded", "expired"];
  const m = new Map<AiDraftStatus, readonly AiDraftStatus[]>();
  m.set("proposed", []);
  m.set("accepted", ["rejected"]);
  m.set("rejected", []);
  m.set("modified_accepted", all.filter(s => s !== "superseded" && s !== "modified_accepted"));
  m.set("superseded", all.filter(s => s !== "superseded"));
  m.set("expired", all.filter(s => s !== "expired"));
  return m;
})();

export function isValidAiDraftTransition(from: AiDraftStatus, to: AiDraftStatus): boolean {
  if (from === to) return true;
  if (from === "proposed") return true;
  const forbidden = INVALID_AI_DRAFT_TRANSITIONS.get(from);
  if (!forbidden) return true;
  return !forbidden.includes(to);
}
