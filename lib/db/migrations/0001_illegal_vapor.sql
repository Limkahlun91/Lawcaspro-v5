CREATE TABLE "beneficial_owners" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "party_id" integer NOT NULL,
        "owner_name" text NOT NULL,
        "owner_type" text DEFAULT 'natural_person' NOT NULL,
        "ownership_percentage" numeric(5, 2),
        "nric" text,
        "passport_no" text,
        "nationality" text,
        "address" text,
        "is_pep" boolean DEFAULT false NOT NULL,
        "is_ultimate_beneficial_owner" boolean DEFAULT false NOT NULL,
        "through_entity_name" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_parties" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "case_id" integer NOT NULL,
        "party_id" integer NOT NULL,
        "party_role" text DEFAULT 'purchaser' NOT NULL,
        "order_no" integer DEFAULT 1 NOT NULL,
        "notes" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cdd_checks" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "compliance_profile_id" integer NOT NULL,
        "check_type" text NOT NULL,
        "status" text DEFAULT 'pending' NOT NULL,
        "performed_by" integer,
        "performed_at" timestamp with time zone,
        "result" text,
        "notes" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cdd_documents" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "compliance_profile_id" integer NOT NULL,
        "document_type" text NOT NULL,
        "file_path" text,
        "file_name" text,
        "verified_by" integer,
        "verified_at" timestamp with time zone,
        "expires_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_profiles" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "party_id" integer NOT NULL,
        "cdd_status" text DEFAULT 'not_started' NOT NULL,
        "risk_level" text DEFAULT 'low' NOT NULL,
        "risk_score" integer DEFAULT 0 NOT NULL,
        "edd_triggered" boolean DEFAULT false NOT NULL,
        "edd_reason" text,
        "assigned_to" integer,
        "approved_by" integer,
        "approved_at" timestamp with time zone,
        "rejected_by" integer,
        "rejected_at" timestamp with time zone,
        "rejection_reason" text,
        "notes" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_retention_records" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "party_id" integer,
        "case_id" integer,
        "retention_period_years" integer DEFAULT 7 NOT NULL,
        "retention_start_date" text,
        "retention_end_date" text,
        "reason" text,
        "created_by" integer,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parties" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "party_type" text DEFAULT 'natural_person' NOT NULL,
        "full_name" text NOT NULL,
        "nric" text,
        "passport_no" text,
        "company_reg_no" text,
        "dob" text,
        "incorporation_date" text,
        "nationality" text,
        "jurisdiction" text,
        "address" text,
        "email" text,
        "phone" text,
        "occupation" text,
        "nature_of_business" text,
        "transaction_purpose" text,
        "is_pep" boolean DEFAULT false NOT NULL,
        "pep_details" text,
        "is_high_risk_jurisdiction" boolean DEFAULT false NOT NULL,
        "has_nominee_arrangement" boolean DEFAULT false NOT NULL,
        "has_layered_ownership" boolean DEFAULT false NOT NULL,
        "directors" jsonb DEFAULT '[]'::jsonb,
        "status" text DEFAULT 'active' NOT NULL,
        "created_by" integer,
        "deleted_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pep_flags" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "party_id" integer NOT NULL,
        "position" text NOT NULL,
        "country" text,
        "pep_category" text DEFAULT 'domestic' NOT NULL,
        "is_active" boolean DEFAULT true NOT NULL,
        "flagged_by" integer,
        "flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
        "verified_by" integer,
        "verified_at" timestamp with time zone,
        "source" text,
        "notes" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_assessments" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "party_id" integer NOT NULL,
        "compliance_profile_id" integer NOT NULL,
        "factor_is_pep" boolean DEFAULT false NOT NULL,
        "factor_high_risk_jurisdiction" boolean DEFAULT false NOT NULL,
        "factor_complex_ownership" boolean DEFAULT false NOT NULL,
        "factor_nominee_arrangement" boolean DEFAULT false NOT NULL,
        "factor_missing_source_of_funds" boolean DEFAULT false NOT NULL,
        "factor_suspicious_inconsistencies" boolean DEFAULT false NOT NULL,
        "risk_score" integer DEFAULT 0 NOT NULL,
        "risk_level" text DEFAULT 'low' NOT NULL,
        "edd_triggered" boolean DEFAULT false NOT NULL,
        "edd_reason" text,
        "assessed_by" integer,
        "assessed_at" timestamp with time zone,
        "notes" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sanctions_screenings" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "party_id" integer NOT NULL,
        "compliance_profile_id" integer,
        "screened_at" timestamp with time zone DEFAULT now() NOT NULL,
        "screened_by" integer,
        "screening_source" text DEFAULT 'manual' NOT NULL,
        "result" text DEFAULT 'unknown' NOT NULL,
        "match_details" jsonb DEFAULT '{}'::jsonb,
        "cleared_by" integer,
        "cleared_at" timestamp with time zone,
        "notes" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_of_funds_records" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "party_id" integer NOT NULL,
        "compliance_profile_id" integer,
        "source_type" text DEFAULT 'other' NOT NULL,
        "description" text,
        "amount_estimated" numeric(15, 2),
        "currency" text DEFAULT 'MYR' NOT NULL,
        "verified" boolean DEFAULT false NOT NULL,
        "verified_by" integer,
        "verified_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_of_wealth_records" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "party_id" integer NOT NULL,
        "compliance_profile_id" integer,
        "wealth_type" text DEFAULT 'other' NOT NULL,
        "description" text,
        "amount_estimated" numeric(15, 2),
        "currency" text DEFAULT 'MYR' NOT NULL,
        "verified" boolean DEFAULT false NOT NULL,
        "verified_by" integer,
        "verified_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suspicious_review_notes" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "party_id" integer NOT NULL,
        "compliance_profile_id" integer,
        "note_type" text DEFAULT 'internal' NOT NULL,
        "content" text NOT NULL,
        "created_by" integer NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conflict_checks" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "case_id" integer NOT NULL,
        "status" text DEFAULT 'pending' NOT NULL,
        "run_by" integer,
        "run_at" timestamp with time zone,
        "completed_at" timestamp with time zone,
        "overall_result" text,
        "notes" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conflict_matches" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "conflict_check_id" integer NOT NULL,
        "party_name" text NOT NULL,
        "party_identifier" text,
        "identifier_type" text,
        "matched_case_id" integer,
        "matched_case_ref" text,
        "matched_party_role" text,
        "matched_party_name" text,
        "match_type" text DEFAULT 'name_exact' NOT NULL,
        "match_score" integer DEFAULT 100 NOT NULL,
        "result" text DEFAULT 'warning' NOT NULL,
        "detail" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conflict_overrides" (
        "id" serial PRIMARY KEY NOT NULL,
        "firm_id" integer NOT NULL,
        "conflict_check_id" integer NOT NULL,
        "conflict_match_id" integer NOT NULL,
        "overridden_by" integer NOT NULL,
        "override_reason" text NOT NULL,
        "override_at" timestamp with time zone DEFAULT now() NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_beneficial_owners_party" ON "beneficial_owners" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "idx_beneficial_owners_firm" ON "beneficial_owners" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_case_parties_case" ON "case_parties" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_case_parties_party" ON "case_parties" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "idx_case_parties_firm" ON "case_parties" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_cdd_checks_profile" ON "cdd_checks" USING btree ("compliance_profile_id");--> statement-breakpoint
CREATE INDEX "idx_cdd_checks_firm" ON "cdd_checks" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_cdd_docs_profile" ON "cdd_documents" USING btree ("compliance_profile_id");--> statement-breakpoint
CREATE INDEX "idx_cdd_docs_firm" ON "cdd_documents" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_compliance_profiles_firm" ON "compliance_profiles" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_compliance_profiles_party" ON "compliance_profiles" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "idx_compliance_profiles_status" ON "compliance_profiles" USING btree ("cdd_status");--> statement-breakpoint
CREATE INDEX "idx_retention_firm" ON "compliance_retention_records" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_retention_case" ON "compliance_retention_records" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_parties_firm" ON "parties" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_parties_name" ON "parties" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "idx_parties_nric" ON "parties" USING btree ("nric");--> statement-breakpoint
CREATE INDEX "idx_parties_passport" ON "parties" USING btree ("passport_no");--> statement-breakpoint
CREATE INDEX "idx_parties_company_reg" ON "parties" USING btree ("company_reg_no");--> statement-breakpoint
CREATE INDEX "idx_pep_flags_party" ON "pep_flags" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "idx_pep_flags_firm" ON "pep_flags" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_risk_assessments_profile" ON "risk_assessments" USING btree ("compliance_profile_id");--> statement-breakpoint
CREATE INDEX "idx_risk_assessments_firm" ON "risk_assessments" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_risk_assessments_party" ON "risk_assessments" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "idx_sanctions_party" ON "sanctions_screenings" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "idx_sanctions_firm" ON "sanctions_screenings" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_sanctions_profile" ON "sanctions_screenings" USING btree ("compliance_profile_id");--> statement-breakpoint
CREATE INDEX "idx_sof_party" ON "source_of_funds_records" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "idx_sof_firm" ON "source_of_funds_records" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_sow_party" ON "source_of_wealth_records" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "idx_sow_firm" ON "source_of_wealth_records" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_srn_party" ON "suspicious_review_notes" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "idx_srn_firm" ON "suspicious_review_notes" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_srn_profile" ON "suspicious_review_notes" USING btree ("compliance_profile_id");--> statement-breakpoint
CREATE INDEX "idx_conflict_checks_firm" ON "conflict_checks" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_conflict_checks_case" ON "conflict_checks" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_conflict_checks_status" ON "conflict_checks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_conflict_matches_check" ON "conflict_matches" USING btree ("conflict_check_id");--> statement-breakpoint
CREATE INDEX "idx_conflict_matches_firm" ON "conflict_matches" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_conflict_overrides_check" ON "conflict_overrides" USING btree ("conflict_check_id");--> statement-breakpoint
CREATE INDEX "idx_conflict_overrides_firm" ON "conflict_overrides" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_rule_versions_set" ON "regulatory_rule_versions" USING btree ("rule_set_id");