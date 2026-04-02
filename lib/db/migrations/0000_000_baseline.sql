CREATE TABLE "firm_bank_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"bank_name" text NOT NULL,
	"account_no" text NOT NULL,
	"account_type" text DEFAULT 'office' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firms" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"subscription_plan" text DEFAULT 'starter' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"address" text,
	"st_number" text,
	"tin_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firms_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"user_type" text DEFAULT 'firm_user' NOT NULL,
	"role_id" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"totp_secret" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"totp_last_used_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"role_id" integer NOT NULL,
	"module" text NOT NULL,
	"action" text NOT NULL,
	"allowed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"name" text NOT NULL,
	"is_system_role" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "developers" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"name" text NOT NULL,
	"company_reg_no" text,
	"address" text,
	"business_address" text,
	"contacts" text,
	"contact_person" text,
	"phone" text,
	"email" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"developer_id" integer NOT NULL,
	"name" text NOT NULL,
	"phase" text,
	"developer_name" text,
	"project_type" text DEFAULT 'highrise' NOT NULL,
	"title_type" text DEFAULT 'master' NOT NULL,
	"title_subtype" text,
	"master_title_number" text,
	"master_title_land_size" text,
	"mukim" text,
	"daerah" text,
	"negeri" text,
	"land_use" text,
	"development_condition" text,
	"unit_category" text,
	"extra_fields" jsonb DEFAULT '{}'::jsonb,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"name" text NOT NULL,
	"ic_no" text,
	"nationality" text,
	"address" text,
	"email" text,
	"phone" text,
	"created_by" integer,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer,
	"actor_id" integer,
	"actor_type" text DEFAULT 'firm_user' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" integer,
	"detail" text,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role_in_case" text DEFAULT 'lawyer' NOT NULL,
	"assigned_by" integer,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unassigned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "case_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"author_id" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_purchasers" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"role" text DEFAULT 'main' NOT NULL,
	"order_no" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_workflow_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"step_key" text NOT NULL,
	"step_name" text NOT NULL,
	"step_order" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"path_type" text DEFAULT 'common' NOT NULL,
	"completed_by" integer,
	"completed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"developer_id" integer NOT NULL,
	"reference_no" text NOT NULL,
	"purchase_mode" text DEFAULT 'cash' NOT NULL,
	"title_type" text DEFAULT 'master' NOT NULL,
	"spa_price" numeric(15, 2),
	"status" text DEFAULT 'File Opened / SPA Pending Signing' NOT NULL,
	"case_type" text,
	"parcel_no" text,
	"spa_details" text,
	"property_details" text,
	"loan_details" text,
	"company_details" text,
	"created_by" integer,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"firm_id" integer NOT NULL,
	"template_id" integer,
	"name" text NOT NULL,
	"document_type" text DEFAULT 'generated' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"object_path" text NOT NULL,
	"file_name" text NOT NULL,
	"file_size" integer,
	"is_uploaded" boolean DEFAULT false NOT NULL,
	"generated_by" integer,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"name" text NOT NULL,
	"document_type" text DEFAULT 'other' NOT NULL,
	"description" text,
	"object_path" text NOT NULL,
	"file_name" text NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_billing_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"firm_id" integer NOT NULL,
	"category" text DEFAULT 'disbursement' NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"is_paid" boolean DEFAULT false NOT NULL,
	"paid_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"case_id" integer,
	"invoice_id" integer,
	"credit_note_no" text NOT NULL,
	"reason" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"issued_date" date NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"description" text NOT NULL,
	"item_type" text DEFAULT 'disbursement' NOT NULL,
	"amount_excl_tax" numeric(18, 2) DEFAULT '0' NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"amount_incl_tax" numeric(18, 2) DEFAULT '0' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"case_id" integer,
	"quotation_id" integer,
	"invoice_no" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"subtotal" numeric(18, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"grand_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(18, 2) DEFAULT '0' NOT NULL,
	"amount_due" numeric(18, 2) DEFAULT '0' NOT NULL,
	"issued_date" date,
	"due_date" date,
	"notes" text,
	"version" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"case_id" integer,
	"entry_date" date NOT NULL,
	"entry_type" text NOT NULL,
	"account_type" text NOT NULL,
	"debit" numeric(18, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(18, 2) DEFAULT '0' NOT NULL,
	"balance_after" numeric(18, 2) DEFAULT '0' NOT NULL,
	"description" text NOT NULL,
	"reference_no" text,
	"source_type" text,
	"source_id" integer,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_voucher_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"voucher_id" integer NOT NULL,
	"description" text NOT NULL,
	"item_type" text DEFAULT 'disbursement' NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_vouchers" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"case_id" integer,
	"voucher_no" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"payee_name" text NOT NULL,
	"payee_bank" text,
	"payee_account_no" text,
	"payment_method" text DEFAULT 'bank_transfer' NOT NULL,
	"bank_account_id" integer,
	"account_type" text DEFAULT 'office' NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"purpose" text NOT NULL,
	"prepared_by" integer,
	"prepared_at" timestamp with time zone,
	"lawyer_approved_by" integer,
	"lawyer_approved_at" timestamp with time zone,
	"partner_approved_by" integer,
	"partner_approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"paid_by" integer,
	"notes" text,
	"version" integer DEFAULT 0 NOT NULL,
	"is_reversed" boolean DEFAULT false NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipt_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"receipt_id" integer NOT NULL,
	"invoice_id" integer,
	"amount" numeric(18, 2) NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"case_id" integer,
	"invoice_id" integer,
	"receipt_no" text NOT NULL,
	"payment_method" text DEFAULT 'bank_transfer' NOT NULL,
	"bank_account_id" integer,
	"account_type" text DEFAULT 'client' NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"received_date" date NOT NULL,
	"reference_no" text,
	"notes" text,
	"is_reversed" boolean DEFAULT false NOT NULL,
	"reversed_by" integer,
	"reversed_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_communications" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"firm_id" integer NOT NULL,
	"thread_id" integer,
	"type" text DEFAULT 'email' NOT NULL,
	"direction" text DEFAULT 'outgoing' NOT NULL,
	"recipient_name" text,
	"recipient_contact" text,
	"subject" text,
	"notes" text,
	"sent_at" timestamp with time zone,
	"logged_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_read_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"firm_id" integer NOT NULL,
	"subject" text NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'general' NOT NULL,
	"file_name" text NOT NULL,
	"file_type" text NOT NULL,
	"file_size" integer,
	"object_path" text NOT NULL,
	"firm_id" integer,
	"folder_id" integer,
	"pdf_mappings" jsonb,
	"uploaded_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_message_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"file_type" text NOT NULL,
	"file_size" integer,
	"object_path" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"from_firm_id" integer,
	"from_user_id" integer NOT NULL,
	"to_firm_id" integer,
	"parent_id" integer,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_folders" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parent_id" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotation_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"quotation_id" integer NOT NULL,
	"section" text NOT NULL,
	"category" text,
	"item_no" text,
	"sub_item_no" text,
	"description" text NOT NULL,
	"tax_code" text DEFAULT 'T' NOT NULL,
	"amount_excl_tax" numeric(18, 2) DEFAULT '0' NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '8' NOT NULL,
	"tax_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"amount_incl_tax" numeric(18, 2) DEFAULT '0' NOT NULL,
	"is_system_generated" boolean DEFAULT false NOT NULL,
	"item_type" text DEFAULT 'disbursement' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"case_id" integer,
	"reference_no" text NOT NULL,
	"st_no" text,
	"client_name" text NOT NULL,
	"property_description" text,
	"purchase_price" numeric(18, 2),
	"bank_name" text,
	"loan_amount" text,
	"loan_amount_num" numeric(18, 2),
	"rule_version_id" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"fee_override_reason" text,
	"fee_override_approved_by" integer,
	"accepted_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regulatory_rule_sets" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regulatory_rule_sets_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "regulatory_rule_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_set_id" integer NOT NULL,
	"version" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"rules" jsonb NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"case_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"assigned_to" integer,
	"due_date" date,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" integer,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"firm_id" integer NOT NULL,
	"case_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"entry_date" date NOT NULL,
	"description" text NOT NULL,
	"hours" numeric(6, 2) NOT NULL,
	"rate_per_hour" numeric(10, 2) DEFAULT '0' NOT NULL,
	"is_billable" boolean DEFAULT true NOT NULL,
	"is_billed" boolean DEFAULT false NOT NULL,
	"invoice_id" integer,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"founder_id" integer NOT NULL,
	"target_firm_id" integer NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"action_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE INDEX "idx_bank_accounts_firm" ON "firm_bank_accounts" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_users_firm" ON "users" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_users_status" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_permissions_role" ON "permissions" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "idx_roles_firm" ON "roles" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_clients_firm" ON "clients" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_clients_name" ON "clients" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_audit_firm" ON "audit_logs" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_audit_actor" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_audit_entity" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_audit_created_at" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_action" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_case_assignments_case" ON "case_assignments" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_case_assignments_user" ON "case_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_case_notes_case" ON "case_notes" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_case_purchasers_case" ON "case_purchasers" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_steps_case" ON "case_workflow_steps" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_steps_case_status" ON "case_workflow_steps" USING btree ("case_id","status");--> statement-breakpoint
CREATE INDEX "idx_cases_firm" ON "cases" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_cases_status" ON "cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_cases_created_at" ON "cases" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_cases_firm_status" ON "cases" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "idx_case_docs_firm_case" ON "case_documents" USING btree ("firm_id","case_id");--> statement-breakpoint
CREATE INDEX "idx_case_docs_case" ON "case_documents" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_case_docs_status" ON "case_documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_doc_templates_firm" ON "document_templates" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_billing_entries_firm_case" ON "case_billing_entries" USING btree ("firm_id","case_id");--> statement-breakpoint
CREATE INDEX "idx_billing_entries_case" ON "case_billing_entries" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_credit_notes_firm" ON "credit_notes" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "idx_credit_notes_invoice" ON "credit_notes" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_invoice_items_invoice" ON "invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_invoices_firm_status" ON "invoices" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "idx_invoices_due_date" ON "invoices" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "idx_invoices_status" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ledger_entry_date" ON "ledger_entries" USING btree ("firm_id","entry_date");--> statement-breakpoint
CREATE INDEX "idx_ledger_account_type" ON "ledger_entries" USING btree ("firm_id","account_type");--> statement-breakpoint
CREATE INDEX "idx_pv_items_voucher" ON "payment_voucher_items" USING btree ("voucher_id");--> statement-breakpoint
CREATE INDEX "idx_pvouchers_firm_status" ON "payment_vouchers" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "idx_receipt_alloc_receipt" ON "receipt_allocations" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "idx_receipts_received_date" ON "receipts" USING btree ("received_date");--> statement-breakpoint
CREATE INDEX "idx_receipts_account_type" ON "receipts" USING btree ("firm_id","account_type");--> statement-breakpoint
CREATE INDEX "idx_quotation_items_quotation" ON "quotation_items" USING btree ("quotation_id");--> statement-breakpoint
CREATE INDEX "idx_quotations_firm_status" ON "quotations" USING btree ("firm_id","status");--> statement-breakpoint
CREATE INDEX "idx_quotations_case" ON "quotations" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_quotations_created_at" ON "quotations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_support_sessions_founder" ON "support_sessions" USING btree ("founder_id");--> statement-breakpoint
CREATE INDEX "idx_support_sessions_firm" ON "support_sessions" USING btree ("target_firm_id");--> statement-breakpoint
CREATE INDEX "idx_support_sessions_started" ON "support_sessions" USING btree ("started_at");