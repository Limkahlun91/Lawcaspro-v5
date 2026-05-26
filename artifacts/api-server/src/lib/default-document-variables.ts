export type DefaultDocumentVariable = {
  key: string;
  label: string;
  description?: string | null;
  category: "case" | "purchaser" | "property" | "loan" | "developer" | "project" | "workflow" | "custom";
  valueType: "string" | "number" | "date" | "boolean" | "richtext" | "array";
  sourcePath?: string | null;
  formatter?: string | null;
  exampleValue?: string | null;
  sortOrder: number;
};

const KEY_DATE_BASES: string[] = [
  "spa_signed_date",
  "spa_forward_to_developer_execution_on",
  "spa_received_dev_return_spa_on",
  "spa_date",
  "spa_stamped_date",
  "stamped_spa_send_to_developer_on",
  "stamped_spa_received_from_developer_on",
  "stamped_spa_sent_to_purchaser_on",
  "li_date",
  "li_received_on",
  "letter_of_offer_date",
  "letter_of_offer_stamped_date",
  "supp_lo_date",
  "loan_docs_pending_date",
  "loan_docs_signed_date",
  "acting_letter_issued_date",
  "developer_confirmation_received_on",
  "developer_confirmation_date",
  "loan_sent_bank_execution_date",
  "loan_bank_executed_date",
  "differential_sum_settled_on",
  "bank_lu_dated",
  "bank_lu_received_date",
  "bank_lu_forward_to_developer_on",
  "developer_lu_received_on",
  "developer_lu_dated",
  "letter_disclaimer_received_on",
  "letter_disclaimer_dated",
  "bankruptcy_search_dated",
  "loan_agreement_dated",
  "loan_agreement_submitted_stamping_date",
  "loan_agreement_stamped_date",
  "received_executed_document_on_1",
  "received_unexecuted_document_on",
  "resent_bank_execution_dated",
  "received_executed_document_on_2",
  "statutory_declaration_dated",
  "statutory_declaration_stamped_on",
  "fa_date",
  "fa_stamp_on",
  "doa_date",
  "doa_stamp_on",
  "poa_date",
  "poa_stamp_on",
  "noa_dated",
  "register_pa_on",
  "register_poa_on",
  "noa_served_on",
  "advice_to_bank_date",
  "bank_1st_release_on",
  "discharge_title_received_on",
  "request_letter_no_objection",
  "received_letter_no_objection_on",
  "blanket_consent_transfer_req",
  "blanket_consent_transfer_approval",
  "consent_to_charge_req",
  "consent_to_charge_approval",
  "mot_received_date",
  "mot_signed_date",
  "mot_submit_stamping",
  "mot_stamped_date",
  "mot_registered_date",
  "charge_submit_stamping",
  "charge_stamped",
  "progressive_payment_date",
  "full_settlement_date",
  "completion_date",
];

const labelFromKey = (key: string): string => {
  const pretty = key
    .replace(/_raw$/, "")
    .replace(/_long$/, "")
    .replace(/_rm$/, " RM")
    .replace(/_/g, " ")
    .trim();
  return pretty.length ? pretty.replace(/\b\w/g, (m) => m.toUpperCase()) : key;
};

const keyDateVars: DefaultDocumentVariable[] = KEY_DATE_BASES.flatMap((base, i) => {
  const baseLabel = labelFromKey(base);
  const sortBase = 2000 + i * 10;
  return [
    { key: `${base}_raw`, label: `${baseLabel} (Raw)`, category: "workflow", valueType: "string", sourcePath: `${base}_raw`, sortOrder: sortBase },
    { key: base, label: baseLabel, category: "workflow", valueType: "string", sourcePath: base, sortOrder: sortBase + 1 },
    { key: `${base}_long`, label: `${baseLabel} (Long)`, category: "workflow", valueType: "string", sourcePath: `${base}_long`, sortOrder: sortBase + 2 },
  ];
});

const extraVars: DefaultDocumentVariable[] = [
  { key: "letter_disclaimer_reference_nos", label: "Letter Disclaimer Reference Nos", category: "workflow", valueType: "string", sourcePath: "letter_disclaimer_reference_nos", sortOrder: 2500 },
  { key: "registered_poa_registration_number", label: "Registered POA Registration Number", category: "workflow", valueType: "string", sourcePath: "registered_poa_registration_number", sortOrder: 2510 },
  { key: "fa_adjudication_number", label: "FA Adjudication Number", category: "workflow", valueType: "string", sourcePath: "fa_adjudication_number", sortOrder: 2515 },
  { key: "pa_no", label: "PA No", category: "workflow", valueType: "string", sourcePath: "pa_no", sortOrder: 2516 },
  { key: "redemption_sum_raw", label: "Redemption Sum (Raw)", category: "loan", valueType: "number", sourcePath: "redemption_sum_raw", sortOrder: 2520 },
  { key: "redemption_sum", label: "Redemption Sum (RM)", category: "loan", valueType: "string", sourcePath: "redemption_sum", sortOrder: 2521 },
  { key: "first_release_amount_rm_raw", label: "First Release Amount (Raw)", category: "loan", valueType: "number", sourcePath: "first_release_amount_rm_raw", sortOrder: 2530 },
  { key: "first_release_amount_rm", label: "First Release Amount (RM)", category: "loan", valueType: "string", sourcePath: "first_release_amount_rm", sortOrder: 2531 },
  { key: "differential_sum_rm_raw", label: "Differential Sum (Raw)", category: "loan", valueType: "number", sourcePath: "differential_sum_rm_raw", sortOrder: 2540 },
  { key: "differential_sum_rm", label: "Differential Sum (RM)", category: "loan", valueType: "string", sourcePath: "differential_sum_rm", sortOrder: 2541 },
  { key: "balance_sum_less_last_5_rm_raw", label: "Balance Sum Less Last 5% (Raw)", category: "loan", valueType: "number", sourcePath: "balance_sum_less_last_5_rm_raw", sortOrder: 2550 },
  { key: "balance_sum_less_last_5_rm", label: "Balance Sum Less Last 5% (RM)", category: "loan", valueType: "string", sourcePath: "balance_sum_less_last_5_rm", sortOrder: 2551 },
];

export const DEFAULT_DOCUMENT_VARIABLES: DefaultDocumentVariable[] = [
  { key: "reference_no", label: "Case Reference No.", category: "case", valueType: "string", sourcePath: "reference_no", sortOrder: 10 },
  { key: "case_id", label: "Case ID", category: "case", valueType: "number", sourcePath: "case_id", sortOrder: 20 },
  { key: "case_type", label: "Case Type", category: "case", valueType: "string", sourcePath: "case_type", sortOrder: 30 },
  { key: "status", label: "Case Status", category: "case", valueType: "string", sourcePath: "status", sortOrder: 40 },
  { key: "purchase_mode", label: "Purchase Mode", category: "case", valueType: "string", sourcePath: "purchase_mode", sortOrder: 50 },
  { key: "title_type", label: "Title Type", category: "case", valueType: "string", sourcePath: "title_type", sortOrder: 60 },
  { key: "parcel_no", label: "Parcel No.", category: "case", valueType: "string", sourcePath: "parcel_no", sortOrder: 70 },
  { key: "date", label: "Document Date", category: "case", valueType: "string", sourcePath: "date", sortOrder: 80 },
  { key: "date_short", label: "Document Date (Short)", category: "case", valueType: "string", sourcePath: "date_short", sortOrder: 90 },
  { key: "spa_price", label: "SPA Price (RM)", category: "case", valueType: "string", sourcePath: "spa_price", sortOrder: 100 },
  { key: "spa_price_raw", label: "SPA Price (Raw)", category: "case", valueType: "number", sourcePath: "spa_price_raw", sortOrder: 110 },

  { key: "purchaser_name", label: "Purchaser Name", category: "purchaser", valueType: "string", sourcePath: "purchaser_name", sortOrder: 200 },
  { key: "purchaser_ic", label: "Purchaser NRIC", category: "purchaser", valueType: "string", sourcePath: "purchaser_ic", sortOrder: 210 },
  { key: "purchaser_address", label: "Purchaser Address", category: "purchaser", valueType: "string", sourcePath: "purchaser_address", sortOrder: 220 },
  { key: "purchaser_email", label: "Purchaser Email", category: "purchaser", valueType: "string", sourcePath: "purchaser_email", sortOrder: 230 },
  { key: "purchaser_phone", label: "Purchaser Phone", category: "purchaser", valueType: "string", sourcePath: "purchaser_phone", sortOrder: 240 },
  { key: "purchasers_inline", label: "Purchasers (Inline)", description: "Formatted purchaser list: A (NRIC NO.: X) & B (NRIC NO.: Y)", category: "purchaser", valueType: "string", sourcePath: "purchasers_inline", exampleValue: "Ali (NRIC NO.: 900101-14-5678) & Abu (NRIC NO.: 880202-10-1234)", sortOrder: 245 },
  { key: "is_joint_purchaser", label: "Is Joint Purchaser", description: "True if more than one purchaser", category: "purchaser", valueType: "boolean", sourcePath: "is_joint_purchaser", sortOrder: 246 },
  { key: "purchaser_pronoun", label: "Purchaser Pronoun", description: "I / We based on purchaser count", category: "purchaser", valueType: "string", sourcePath: "purchaser_pronoun", exampleValue: "We", sortOrder: 247 },
  { key: "purchaser_verb", label: "Purchaser Verb", description: "am / are based on purchaser count", category: "purchaser", valueType: "string", sourcePath: "purchaser_verb", exampleValue: "are", sortOrder: 248 },

  { key: "borrower1_name", label: "Borrower 1 Name", category: "loan", valueType: "string", sourcePath: "borrower1_name", sortOrder: 300 },
  { key: "borrower1_ic", label: "Borrower 1 NRIC", category: "loan", valueType: "string", sourcePath: "borrower1_ic", sortOrder: 310 },
  { key: "borrower2_name", label: "Borrower 2 Name", category: "loan", valueType: "string", sourcePath: "borrower2_name", sortOrder: 320 },
  { key: "borrower2_ic", label: "Borrower 2 NRIC", category: "loan", valueType: "string", sourcePath: "borrower2_ic", sortOrder: 330 },
  { key: "borrower1_address", label: "Borrower 1 Address", category: "loan", valueType: "string", sourcePath: "borrower1_address", sortOrder: 332 },
  { key: "borrower2_address", label: "Borrower 2 Address", category: "loan", valueType: "string", sourcePath: "borrower2_address", sortOrder: 333 },
  { key: "borrower_1_address", label: "Borrower 1 Address (Legacy)", category: "loan", valueType: "string", sourcePath: "borrower_1_address", sortOrder: 334 },
  { key: "borrower_2_address", label: "Borrower 2 Address (Legacy)", category: "loan", valueType: "string", sourcePath: "borrower_2_address", sortOrder: 334 },
  { key: "borrower_addresses", label: "Borrower Addresses", category: "loan", valueType: "string", sourcePath: "borrower_addresses", sortOrder: 334 },
  { key: "borrowers_inline", label: "Borrowers (Inline)", description: "Formatted borrower list: A (NRIC NO.: X) & B (NRIC NO.: Y)", category: "loan", valueType: "string", sourcePath: "borrowers_inline", exampleValue: "Ali (NRIC NO.: 900101-14-5678)", sortOrder: 335 },
  { key: "end_financier", label: "Bank Name / End Financier", category: "loan", valueType: "string", sourcePath: "end_financier", sortOrder: 340 },
  { key: "financing_sum", label: "Loan Amount (RM)", category: "loan", valueType: "string", sourcePath: "financing_sum", sortOrder: 350 },
  { key: "financing_sum_raw", label: "Loan Amount (Raw)", category: "loan", valueType: "number", sourcePath: "financing_sum_raw", sortOrder: 360 },
  { key: "bank_ref", label: "Bank Reference", category: "loan", valueType: "string", sourcePath: "bank_ref", sortOrder: 370 },
  { key: "bank_branch", label: "Bank Branch", category: "loan", valueType: "string", sourcePath: "bank_branch", sortOrder: 380 },

  { key: "property_parcel_no", label: "Property Parcel No.", category: "property", valueType: "string", sourcePath: "property_parcel_no", sortOrder: 400 },
  { key: "property_type", label: "Property Type", category: "property", valueType: "string", sourcePath: "property_type", sortOrder: 410 },
  { key: "property_area_sqm", label: "Land Area (sqm)", category: "property", valueType: "string", sourcePath: "property_area_sqm", sortOrder: 420 },
  { key: "property_purchase_price", label: "Property Purchase Price (RM)", category: "property", valueType: "string", sourcePath: "property_purchase_price", sortOrder: 430 },
  { key: "property_purchase_price_raw", label: "Property Purchase Price (Raw)", category: "property", valueType: "number", sourcePath: "property_purchase_price_raw", sortOrder: 440 },

  { key: "developer_name", label: "Developer Name", category: "developer", valueType: "string", sourcePath: "developer_name", sortOrder: 500 },
  { key: "developer_reg_no", label: "Developer Registration No.", category: "developer", valueType: "string", sourcePath: "developer_reg_no", sortOrder: 510 },
  { key: "developer_address", label: "Developer Address", category: "developer", valueType: "string", sourcePath: "developer_address", sortOrder: 520 },
  { key: "developer_phone", label: "Developer Phone", category: "developer", valueType: "string", sourcePath: "developer_phone", sortOrder: 530 },
  { key: "developer_email", label: "Developer Email", category: "developer", valueType: "string", sourcePath: "developer_email", sortOrder: 540 },
  { key: "contact_1_salutation", label: "Contact 1 Salutation", category: "developer", valueType: "string", sourcePath: "contact_1_salutation", sortOrder: 545 },

  { key: "project_name", label: "Project Name", category: "project", valueType: "string", sourcePath: "project_name", sortOrder: 600 },
  { key: "project_type", label: "Project Type", category: "project", valueType: "string", sourcePath: "project_type", sortOrder: 610 },
  { key: "project_development_condition", label: "Development Condition", category: "project", valueType: "string", sourcePath: "project_development_condition", sortOrder: 620 },
  { key: "unit_category", label: "Unit Category", category: "project", valueType: "string", sourcePath: "unit_category", sortOrder: 630 },

  { key: "vendor_name", label: "Vendor Name", category: "custom", valueType: "string", sourcePath: "vendor_name", sortOrder: 900 },
  { key: "vendor_ic", label: "Vendor NRIC", category: "custom", valueType: "string", sourcePath: "vendor_ic", sortOrder: 910 },
  { key: "vendor_address", label: "Vendor Address", category: "custom", valueType: "string", sourcePath: "vendor_address", sortOrder: 920 },
  { key: "vendor_email", label: "Vendor Email", category: "custom", valueType: "string", sourcePath: "vendor_email", sortOrder: 930 },
  { key: "vendor_phone", label: "Vendor Phone", category: "custom", valueType: "string", sourcePath: "vendor_phone", sortOrder: 940 },
  { key: "vendors_inline", label: "Vendors (Inline)", description: "Formatted vendor list: A (NRIC NO.: X) & B (NRIC NO.: Y)", category: "custom", valueType: "string", sourcePath: "vendors_inline", exampleValue: "Vendor A (NRIC NO.: 900101-14-5678)", sortOrder: 945 },

  ...extraVars,
  ...keyDateVars,
];
