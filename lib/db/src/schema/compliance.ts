import {
  pgTable, serial, text, integer, numeric, boolean, timestamp,
  jsonb, index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// parties
// A firm-scoped master party registry. Natural persons, companies, and trusts.
// ---------------------------------------------------------------------------
export const partiesTable = pgTable("parties", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  partyType: text("party_type").notNull().default("natural_person"), // natural_person | company | trust
  // Identity
  fullName: text("full_name").notNull(),
  nric: text("nric"),
  passportNo: text("passport_no"),
  companyRegNo: text("company_reg_no"),
  // Dates
  dob: text("dob"),                         // YYYY-MM-DD stored as text for flexibility
  incorporationDate: text("incorporation_date"),
  // Provenance
  nationality: text("nationality"),
  jurisdiction: text("jurisdiction"),
  address: text("address"),
  email: text("email"),
  phone: text("phone"),
  // Business / purpose
  occupation: text("occupation"),
  natureOfBusiness: text("nature_of_business"),
  transactionPurpose: text("transaction_purpose"),
  // Risk flags
  isPep: boolean("is_pep").notNull().default(false),
  pepDetails: text("pep_details"),
  isHighRiskJurisdiction: boolean("is_high_risk_jurisdiction").notNull().default(false),
  hasNomineeArrangement: boolean("has_nominee_arrangement").notNull().default(false),
  hasLayeredOwnership: boolean("has_layered_ownership").notNull().default(false),
  // Directors / controllers (JSONB array for companies)
  directors: jsonb("directors").default([]),   // [{ name, nric, role }]
  // Status
  status: text("status").notNull().default("active"), // active | inactive | blocked
  createdBy: integer("created_by"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_parties_firm").on(t.firmId),
  nameIdx: index("idx_parties_name").on(t.fullName),
  nricIdx: index("idx_parties_nric").on(t.nric),
  passportIdx: index("idx_parties_passport").on(t.passportNo),
  companyRegIdx: index("idx_parties_company_reg").on(t.companyRegNo),
}));

// ---------------------------------------------------------------------------
// case_parties
// Links parties to cases with specific roles.
// ---------------------------------------------------------------------------
export const casePartiesTable = pgTable("case_parties", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  caseId: integer("case_id").notNull(),
  partyId: integer("party_id").notNull(),
  // purchaser | vendor | borrower | guarantor | developer | bank | company |
  // beneficial_owner | adverse_party | other
  partyRole: text("party_role").notNull().default("purchaser"),
  orderNo: integer("order_no").notNull().default(1),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  caseIdx: index("idx_case_parties_case").on(t.caseId),
  partyIdx: index("idx_case_parties_party").on(t.partyId),
  firmIdx: index("idx_case_parties_firm").on(t.firmId),
}));

// ---------------------------------------------------------------------------
// compliance_profiles
// One compliance profile per party (firm-scoped). Tracks overall CDD status.
// ---------------------------------------------------------------------------
export const complianceProfilesTable = pgTable("compliance_profiles", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  partyId: integer("party_id").notNull(),
  // not_started | in_progress | pending_review | approved | rejected |
  // enhanced_due_diligence_required
  cddStatus: text("cdd_status").notNull().default("not_started"),
  // low | medium | high | very_high
  riskLevel: text("risk_level").notNull().default("low"),
  riskScore: integer("risk_score").notNull().default(0),
  eddTriggered: boolean("edd_triggered").notNull().default(false),
  eddReason: text("edd_reason"),
  assignedTo: integer("assigned_to"),
  approvedBy: integer("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  rejectedBy: integer("rejected_by"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_compliance_profiles_firm").on(t.firmId),
  partyIdx: index("idx_compliance_profiles_party").on(t.partyId),
  statusIdx: index("idx_compliance_profiles_status").on(t.cddStatus),
}));

// ---------------------------------------------------------------------------
// cdd_checks
// Individual CDD check records within a compliance profile.
// ---------------------------------------------------------------------------
export const cddChecksTable = pgTable("cdd_checks", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  complianceProfileId: integer("compliance_profile_id").notNull(),
  // identity | address | source_of_funds | beneficial_ownership |
  // sanctions | pep | other
  checkType: text("check_type").notNull(),
  // pending | passed | failed | requires_follow_up
  status: text("status").notNull().default("pending"),
  performedBy: integer("performed_by"),
  performedAt: timestamp("performed_at", { withTimezone: true }),
  result: text("result"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  profileIdx: index("idx_cdd_checks_profile").on(t.complianceProfileId),
  firmIdx: index("idx_cdd_checks_firm").on(t.firmId),
}));

// ---------------------------------------------------------------------------
// cdd_documents
// Documents uploaded as evidence for a CDD check.
// ---------------------------------------------------------------------------
export const cddDocumentsTable = pgTable("cdd_documents", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  complianceProfileId: integer("compliance_profile_id").notNull(),
  // nric | passport | utility_bill | bank_statement | company_cert | other
  documentType: text("document_type").notNull(),
  filePath: text("file_path"),
  fileName: text("file_name"),
  verifiedBy: integer("verified_by"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  profileIdx: index("idx_cdd_docs_profile").on(t.complianceProfileId),
  firmIdx: index("idx_cdd_docs_firm").on(t.firmId),
}));

// ---------------------------------------------------------------------------
// beneficial_owners
// Beneficial ownership records linked to a party (typically a company).
// ---------------------------------------------------------------------------
export const beneficialOwnersTable = pgTable("beneficial_owners", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  partyId: integer("party_id").notNull(),
  ownerName: text("owner_name").notNull(),
  ownerType: text("owner_type").notNull().default("natural_person"), // natural_person | company
  ownershipPercentage: numeric("ownership_percentage", { precision: 5, scale: 2 }),
  nric: text("nric"),
  passportNo: text("passport_no"),
  nationality: text("nationality"),
  address: text("address"),
  isPep: boolean("is_pep").notNull().default(false),
  isUltimateBeneficialOwner: boolean("is_ultimate_beneficial_owner").notNull().default(false),
  throughEntityName: text("through_entity_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  partyIdx: index("idx_beneficial_owners_party").on(t.partyId),
  firmIdx: index("idx_beneficial_owners_firm").on(t.firmId),
}));

// ---------------------------------------------------------------------------
// sanctions_screenings
// Records of sanctions screening runs against a party.
// ---------------------------------------------------------------------------
export const sanctionsScreeningsTable = pgTable("sanctions_screenings", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  partyId: integer("party_id").notNull(),
  complianceProfileId: integer("compliance_profile_id"),
  screenedAt: timestamp("screened_at", { withTimezone: true }).notNull().defaultNow(),
  screenedBy: integer("screened_by"),
  // OFAC | UN | INTERPOL | Malaysia_BNM | manual
  screeningSource: text("screening_source").notNull().default("manual"),
  // clear | hit | potential_hit | unknown
  result: text("result").notNull().default("unknown"),
  matchDetails: jsonb("match_details").default({}),
  clearedBy: integer("cleared_by"),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  partyIdx: index("idx_sanctions_party").on(t.partyId),
  firmIdx: index("idx_sanctions_firm").on(t.firmId),
  profileIdx: index("idx_sanctions_profile").on(t.complianceProfileId),
}));

// ---------------------------------------------------------------------------
// pep_flags
// Politically Exposed Person flags for a party.
// ---------------------------------------------------------------------------
export const pepFlagsTable = pgTable("pep_flags", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  partyId: integer("party_id").notNull(),
  position: text("position").notNull(),
  country: text("country"),
  // domestic | foreign | international_organization
  pepCategory: text("pep_category").notNull().default("domestic"),
  isActive: boolean("is_active").notNull().default(true),
  flaggedBy: integer("flagged_by"),
  flaggedAt: timestamp("flagged_at", { withTimezone: true }).notNull().defaultNow(),
  verifiedBy: integer("verified_by"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  source: text("source"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  partyIdx: index("idx_pep_flags_party").on(t.partyId),
  firmIdx: index("idx_pep_flags_firm").on(t.firmId),
}));

// ---------------------------------------------------------------------------
// risk_assessments
// Structured risk scoring for a compliance profile.
// ---------------------------------------------------------------------------
export const riskAssessmentsTable = pgTable("risk_assessments", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  partyId: integer("party_id").notNull(),
  complianceProfileId: integer("compliance_profile_id").notNull(),
  // Scoring factors (each factor adds to riskScore)
  factorIsPep: boolean("factor_is_pep").notNull().default(false),
  factorHighRiskJurisdiction: boolean("factor_high_risk_jurisdiction").notNull().default(false),
  factorComplexOwnership: boolean("factor_complex_ownership").notNull().default(false),
  factorNomineeArrangement: boolean("factor_nominee_arrangement").notNull().default(false),
  factorMissingSourceOfFunds: boolean("factor_missing_source_of_funds").notNull().default(false),
  factorSuspiciousInconsistencies: boolean("factor_suspicious_inconsistencies").notNull().default(false),
  // Computed
  riskScore: integer("risk_score").notNull().default(0),
  riskLevel: text("risk_level").notNull().default("low"), // low | medium | high | very_high
  eddTriggered: boolean("edd_triggered").notNull().default(false),
  eddReason: text("edd_reason"),
  assessedBy: integer("assessed_by"),
  assessedAt: timestamp("assessed_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  profileIdx: index("idx_risk_assessments_profile").on(t.complianceProfileId),
  firmIdx: index("idx_risk_assessments_firm").on(t.firmId),
  partyIdx: index("idx_risk_assessments_party").on(t.partyId),
}));

// ---------------------------------------------------------------------------
// source_of_funds_records
// ---------------------------------------------------------------------------
export const sourceOfFundsRecordsTable = pgTable("source_of_funds_records", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  partyId: integer("party_id").notNull(),
  complianceProfileId: integer("compliance_profile_id"),
  // employment | business_income | investment | inheritance | gift |
  // loan | sale_of_asset | other
  sourceType: text("source_type").notNull().default("other"),
  description: text("description"),
  amountEstimated: numeric("amount_estimated", { precision: 15, scale: 2 }),
  currency: text("currency").notNull().default("MYR"),
  verified: boolean("verified").notNull().default(false),
  verifiedBy: integer("verified_by"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  partyIdx: index("idx_sof_party").on(t.partyId),
  firmIdx: index("idx_sof_firm").on(t.firmId),
}));

// ---------------------------------------------------------------------------
// source_of_wealth_records
// ---------------------------------------------------------------------------
export const sourceOfWealthRecordsTable = pgTable("source_of_wealth_records", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  partyId: integer("party_id").notNull(),
  complianceProfileId: integer("compliance_profile_id"),
  // employment | business | investment | inheritance | other
  wealthType: text("wealth_type").notNull().default("other"),
  description: text("description"),
  amountEstimated: numeric("amount_estimated", { precision: 15, scale: 2 }),
  currency: text("currency").notNull().default("MYR"),
  verified: boolean("verified").notNull().default(false),
  verifiedBy: integer("verified_by"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  partyIdx: index("idx_sow_party").on(t.partyId),
  firmIdx: index("idx_sow_firm").on(t.firmId),
}));

// ---------------------------------------------------------------------------
// suspicious_review_notes
// Internal notes for suspicious activity / STR consideration.
// ---------------------------------------------------------------------------
export const suspiciousReviewNotesTable = pgTable("suspicious_review_notes", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  partyId: integer("party_id").notNull(),
  complianceProfileId: integer("compliance_profile_id"),
  // internal | str_consideration | escalated
  noteType: text("note_type").notNull().default("internal"),
  content: text("content").notNull(),
  createdBy: integer("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  partyIdx: index("idx_srn_party").on(t.partyId),
  firmIdx: index("idx_srn_firm").on(t.firmId),
  profileIdx: index("idx_srn_profile").on(t.complianceProfileId),
}));

// ---------------------------------------------------------------------------
// compliance_retention_records
// Retention metadata for compliance records post-file-closing.
// ---------------------------------------------------------------------------
export const complianceRetentionRecordsTable = pgTable("compliance_retention_records", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  partyId: integer("party_id"),
  caseId: integer("case_id"),
  retentionPeriodYears: integer("retention_period_years").notNull().default(7),
  retentionStartDate: text("retention_start_date"),   // YYYY-MM-DD
  retentionEndDate: text("retention_end_date"),        // YYYY-MM-DD
  reason: text("reason"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  firmIdx: index("idx_retention_firm").on(t.firmId),
  caseIdx: index("idx_retention_case").on(t.caseId),
}));

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------
export type Party = typeof partiesTable.$inferSelect;
export type CaseParty = typeof casePartiesTable.$inferSelect;
export type ComplianceProfile = typeof complianceProfilesTable.$inferSelect;
export type CddCheck = typeof cddChecksTable.$inferSelect;
export type CddDocument = typeof cddDocumentsTable.$inferSelect;
export type BeneficialOwner = typeof beneficialOwnersTable.$inferSelect;
export type SanctionsScreening = typeof sanctionsScreeningsTable.$inferSelect;
export type PepFlag = typeof pepFlagsTable.$inferSelect;
export type RiskAssessment = typeof riskAssessmentsTable.$inferSelect;
export type SourceOfFundsRecord = typeof sourceOfFundsRecordsTable.$inferSelect;
export type SourceOfWealthRecord = typeof sourceOfWealthRecordsTable.$inferSelect;
export type SuspiciousReviewNote = typeof suspiciousReviewNotesTable.$inferSelect;
export type ComplianceRetentionRecord = typeof complianceRetentionRecordsTable.$inferSelect;
