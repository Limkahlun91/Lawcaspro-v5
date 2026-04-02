import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db, documentTemplatesTable, caseDocumentsTable } from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";

const router: IRouter = Router();
const storage = new ObjectStorageService();

async function queryRows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await db.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if ("rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

function safeJson(str: unknown): Record<string, unknown> {
  if (!str || typeof str !== "string") return {};
  try { return JSON.parse(str); } catch { return {}; }
}

function fmtRM(val: unknown): string {
  if (!val) return "";
  const n = Number(val);
  if (isNaN(n)) return String(val);
  return `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;
}

async function buildCaseContext(caseId: number, firmId: number): Promise<Record<string, unknown> | null> {
  const caseRows = await queryRows(sql`SELECT * FROM cases WHERE id = ${caseId} AND firm_id = ${firmId}`);
  if (!caseRows[0]) return null;
  const c = caseRows[0];

  const projectRows = await queryRows(sql`SELECT * FROM projects WHERE id = ${c.project_id}`);
  const developerRows = await queryRows(sql`SELECT * FROM developers WHERE id = ${c.developer_id}`);
  const firmRows = await queryRows(sql`SELECT * FROM firms WHERE id = ${firmId}`);
  const bankRows = await queryRows(sql`SELECT * FROM firm_bank_accounts WHERE firm_id = ${firmId} ORDER BY is_default DESC`);
  const purchaserRows = await queryRows(sql`
    SELECT cp.*, cl.name, cl.ic_no, cl.nationality, cl.address, cl.phone, cl.email
    FROM case_purchasers cp JOIN clients cl ON cp.client_id = cl.id
    WHERE cp.case_id = ${caseId} ORDER BY cp.order_no`);
  const lawyerRows = await queryRows(sql`
    SELECT ca.*, u.name as user_name, u.email as user_email
    FROM case_assignments ca JOIN users u ON ca.user_id = u.id
    WHERE ca.case_id = ${caseId} AND ca.role_in_case = 'lawyer' AND ca.unassigned_at IS NULL
    LIMIT 1`);
  const clerkRows = await queryRows(sql`
    SELECT ca.*, u.name as user_name
    FROM case_assignments ca JOIN users u ON ca.user_id = u.id
    WHERE ca.case_id = ${caseId} AND ca.role_in_case = 'clerk' AND ca.unassigned_at IS NULL
    LIMIT 1`);

  const proj = projectRows[0] ?? {};
  const dev = developerRows[0] ?? {};
  const firm = firmRows[0] ?? {};
  const lawyer = lawyerRows[0] ?? {};
  const clerk = clerkRows[0] ?? {};
  const mainPurchaser = purchaserRows.find((p) => p.role === "main") ?? purchaserRows[0] ?? {};

  const spa = safeJson(c.spa_details);
  const prop = safeJson(c.property_details);
  const loan = safeJson(c.loan_details);
  const comp = safeJson(c.company_details);
  const devContacts = typeof dev.contacts === "string" ? (() => { try { return JSON.parse(dev.contacts as string); } catch { return []; } })() : [];

  const today = new Date();
  const dateStr = today.toLocaleDateString("en-MY", { day: "2-digit", month: "long", year: "numeric" });
  const dateShort = today.toLocaleDateString("en-MY", { day: "2-digit", month: "2-digit", year: "numeric" });

  const officeBanks = bankRows.filter((b) => b.account_type === "office");
  const clientBanks = bankRows.filter((b) => b.account_type === "client");

  return {
    case_id: caseId,
    reference_no: c.reference_no ?? "",
    date: dateStr,
    date_short: dateShort,
    case_type: c.case_type ?? "",
    parcel_no: c.parcel_no ?? "",
    spa_price: fmtRM(c.spa_price),
    spa_price_raw: c.spa_price ?? "",
    purchase_mode: c.purchase_mode ?? "",
    title_type: c.title_type ?? "",
    status: c.status ?? "",

    // SPA Details
    spa_purchaser1_name: (spa.purchasers as any)?.[0]?.name ?? "",
    spa_purchaser1_ic: (spa.purchasers as any)?.[0]?.ic ?? "",
    spa_purchaser2_name: (spa.purchasers as any)?.[1]?.name ?? "",
    spa_purchaser2_ic: (spa.purchasers as any)?.[1]?.ic ?? "",
    spa_address_line1: spa.addressLine1 ?? "",
    spa_address_line2: spa.addressLine2 ?? "",
    spa_address_line3: spa.addressLine3 ?? "",
    spa_address_line4: spa.addressLine4 ?? "",
    spa_address_line5: spa.addressLine5 ?? "",
    spa_mailing_address: spa.mailingAddress ?? "",
    spa_contact_number: spa.contactNumber ?? "",
    spa_email: spa.emailAddress ?? "",

    // Property Details
    property_parcel_no: prop.parcelNo ?? "",
    property_floor_no: prop.floorNo ?? "",
    property_building_no: prop.buildingNo ?? "",
    property_car_park_no: prop.carParkNo ?? "",
    property_type: prop.propertyType ?? "",
    property_area_sqm: prop.areaSqm ?? "",
    property_purchase_price: fmtRM(prop.purchasePrice),
    property_purchase_price_raw: prop.purchasePrice ?? "",
    property_progress_payment: prop.progressPayment ?? "",
    property_dev_discount: fmtRM(prop.devDiscount),
    property_dev_discount_raw: prop.devDiscount ?? "",
    property_bumi_discount: fmtRM(prop.bumiDiscount),
    property_bumi_discount_raw: prop.bumiDiscount ?? "",
    property_approved_price: fmtRM(prop.approvedPurchasePrice),
    property_approved_price_raw: prop.approvedPurchasePrice ?? "",

    // Loan Details
    borrower1_name: loan.borrower1Name ?? "",
    borrower1_ic: loan.borrower1Ic ?? "",
    borrower2_name: loan.borrower2Name ?? "",
    borrower2_ic: loan.borrower2Ic ?? "",
    end_financier: loan.endFinancier ?? "",
    bank_ref: loan.bankRef ?? "",
    bank_branch: loan.bankBranch ?? "",
    financing_sum: fmtRM(loan.financingSum),
    financing_sum_raw: loan.financingSum ?? "",
    other_charges: fmtRM(loan.otherCharges),
    other_charges_raw: loan.otherCharges ?? "",
    total_loan: fmtRM(loan.totalLoan),
    total_loan_raw: loan.totalLoan ?? "",

    // Company Details
    director1_name: comp.director1Name ?? "",
    director1_ic: comp.director1Ic ?? "",
    director2_name: comp.director2Name ?? "",
    director2_ic: comp.director2Ic ?? "",

    // Project Details
    project_name: proj.name ?? "",
    project_phase: proj.phase ?? "",
    project_type: proj.project_type ?? "",
    project_title_type: proj.title_type ?? "",
    project_title_subtype: proj.title_subtype ?? "",
    project_master_title_no: proj.master_title_number ?? "",
    project_master_title_size: proj.master_title_land_size ?? "",
    project_mukim: proj.mukim ?? "",
    project_daerah: proj.daerah ?? "",
    project_negeri: proj.negeri ?? "",
    project_land_use: proj.land_use ?? "",
    project_development_condition: proj.development_condition ?? "",
    project_developer_name: proj.developer_name ?? "",
    unit_category: proj.unit_category ?? "",
    project_property_types: (() => {
      const ef = proj.extra_fields;
      const parsed = typeof ef === "string" ? (() => { try { return JSON.parse(ef); } catch { return {}; } })() : (ef ?? {});
      const pts = Array.isArray(parsed.propertyTypes) ? parsed.propertyTypes : [];
      return pts.map((pt: any, i: number) => ({ index: i + 1, building_type: pt.buildingType ?? "" }));
    })(),

    // Developer Details
    developer_name: dev.name ?? "",
    developer_reg_no: dev.company_reg_no ?? "",
    developer_address: dev.address ?? "",
    developer_business_address: dev.business_address ?? "",
    developer_contact: dev.contact_person ?? "",
    developer_phone: dev.phone ?? "",
    developer_email: dev.email ?? "",
    developer_contacts: Array.isArray(devContacts) ? devContacts.map((dc: any, i: number) => ({
      index: i + 1,
      department: dc.department ?? "",
      phone: dc.phone ?? "",
      ext: dc.ext ?? "",
      email: dc.email ?? "",
    })) : [],

    // Purchaser (Main)
    purchaser_name: mainPurchaser.name ?? "",
    purchaser_ic: mainPurchaser.ic_no ?? "",
    purchaser_nationality: mainPurchaser.nationality ?? "",
    purchaser_address: mainPurchaser.address ?? "",
    purchaser_phone: mainPurchaser.phone ?? "",
    purchaser_email: mainPurchaser.email ?? "",

    // All Purchasers (loop)
    purchasers: purchaserRows.map((p, i) => ({
      index: i + 1,
      name: p.name ?? "",
      ic: p.ic_no ?? "",
      nationality: p.nationality ?? "",
      address: p.address ?? "",
      phone: p.phone ?? "",
      email: p.email ?? "",
      role: p.role ?? "",
    })),

    // Assignments
    lawyer_name: lawyer.user_name ?? "",
    lawyer_email: lawyer.user_email ?? "",
    clerk_name: clerk.user_name ?? "",

    // Firm Details
    firm_name: firm.name ?? "",
    firm_address: firm.address ?? "",
    firm_st_number: firm.st_number ?? "",
    firm_tin_number: firm.tin_number ?? "",

    // Bank Accounts
    office_bank_name: officeBanks[0]?.bank_name ?? "",
    office_bank_account_no: officeBanks[0]?.account_no ?? "",
    client_bank_name: clientBanks[0]?.bank_name ?? "",
    client_bank_account_no: clientBanks[0]?.account_no ?? "",
    bank_accounts: bankRows.map((b, i) => ({
      index: i + 1,
      bank_name: b.bank_name ?? "",
      account_no: b.account_no ?? "",
      account_type: b.account_type ?? "",
    })),
  };
}

router.get("/document-templates", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const rows = await queryRows(
    sql`SELECT * FROM document_templates WHERE firm_id = ${req.firmId!} ORDER BY created_at DESC`
  );
  res.json(rows);
});

router.post("/document-templates", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const { name, documentType, description, objectPath, fileName } = req.body as {
    name: string;
    documentType?: string;
    description?: string;
    objectPath: string;
    fileName: string;
  };

  if (!name || !objectPath || !fileName) {
    res.status(400).json({ error: "name, objectPath, and fileName are required" });
    return;
  }

  const rows = await queryRows(
    sql`INSERT INTO document_templates (firm_id, name, document_type, description, object_path, file_name, created_by)
        VALUES (${req.firmId!}, ${name}, ${documentType ?? "other"}, ${description ?? null}, ${objectPath}, ${fileName}, ${req.userId!})
        RETURNING *`
  );

  res.status(201).json(rows[0]);
});

router.delete("/document-templates/:templateId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const templateId = Number(req.params.templateId);
  const rows = await queryRows(
    sql`DELETE FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!} RETURNING *`
  );
  if (!rows[0]) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  res.sendStatus(204);
});

router.get("/cases/:caseId/documents", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const rows = await queryRows(sql`
    SELECT cd.*, dt.name as template_name, u.name as generated_by_name
    FROM case_documents cd
    LEFT JOIN document_templates dt ON cd.template_id = dt.id
    LEFT JOIN users u ON cd.generated_by = u.id
    WHERE cd.case_id = ${caseId} AND cd.firm_id = ${req.firmId!}
    ORDER BY cd.created_at DESC`
  );
  res.json(rows);
});

router.post("/cases/:caseId/documents/generate", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const { templateId, documentName } = req.body as { templateId: number; documentName?: string };

  if (!templateId) {
    res.status(400).json({ error: "templateId is required" });
    return;
  }

  const templateRows = await queryRows(
    sql`SELECT * FROM document_templates WHERE id = ${templateId} AND firm_id = ${req.firmId!}`
  );
  if (!templateRows[0]) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  const template = templateRows[0];

  const context = await buildCaseContext(caseId, req.firmId!);
  if (!context) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  try {
    const objectFile = await storage.getObjectEntityFile(template.object_path as string);
    const [fileContents] = await objectFile.download();

    const zip = new PizZip(fileContents);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

    doc.render(context);

    const buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });

    const uploadURL = await storage.getObjectEntityUploadURL();

    const uploadRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      body: buffer,
    });

    if (!uploadRes.ok) {
      const detail = await uploadRes.text();
      res.status(500).json({ error: "Failed to upload generated document", detail });
      return;
    }

    const normalizedPath = storage.normalizeObjectEntityPath(uploadURL.split("?")[0]);
    const docName = documentName ?? `${template.name} - ${context.reference_no}`;
    const fileName = `${docName.replace(/[^a-zA-Z0-9 \-_]/g, "_")}.docx`;

    const docRows = await queryRows(sql`
      INSERT INTO case_documents (case_id, firm_id, template_id, name, document_type, status, object_path, file_name, generated_by)
      VALUES (${caseId}, ${req.firmId!}, ${templateId}, ${docName}, ${template.document_type as string}, 'generated', ${normalizedPath}, ${fileName}, ${req.userId!})
      RETURNING *`
    );

    res.status(201).json(docRows[0]);
  } catch (err: unknown) {
    console.error("Document generation error:", err);
    res.status(500).json({
      error: "Failed to generate document",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

router.post("/cases/:caseId/documents/generate-from-master", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const { masterDocId, documentName } = req.body as { masterDocId: number; documentName?: string };

  if (!masterDocId) {
    res.status(400).json({ error: "masterDocId is required" });
    return;
  }

  const docRows2 = await queryRows(
    sql`SELECT * FROM platform_documents WHERE id = ${masterDocId} AND (firm_id IS NULL OR firm_id = ${req.firmId!})`
  );
  if (!docRows2[0]) {
    res.status(404).json({ error: "Master document not found" });
    return;
  }
  const masterDoc = docRows2[0];
  const masterFileName = masterDoc.file_name as string;
  const isDocx = masterFileName.toLowerCase().endsWith(".docx") || masterFileName.toLowerCase().endsWith(".doc");

  const context = await buildCaseContext(caseId, req.firmId!);
  if (!context) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  try {
    const objectFile = await storage.getObjectEntityFile(masterDoc.object_path as string);
    const [fileContents] = await objectFile.download();

    let buffer: Buffer;
    let outputMime: string;
    let outputExt: string;

    if (isDocx) {
      const zip = new PizZip(fileContents);
      const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
      doc.render(context);
      buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
      outputMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      outputExt = ".docx";
    } else {
      buffer = Buffer.from(fileContents);
      outputMime = masterDoc.file_type as string;
      outputExt = "." + masterFileName.split(".").pop();
    }

    const uploadURL = await storage.getObjectEntityUploadURL();

    const uploadRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": outputMime },
      body: buffer,
    });

    if (!uploadRes.ok) {
      const detail = await uploadRes.text();
      res.status(500).json({ error: "Failed to upload generated document", detail });
      return;
    }

    const normalizedPath = storage.normalizeObjectEntityPath(uploadURL.split("?")[0]);
    const docName = documentName ?? `${masterDoc.name} - ${context.reference_no}`;
    const fileName = `${docName.replace(/[^a-zA-Z0-9 \-_]/g, "_")}${outputExt}`;

    const savedRows = await queryRows(sql`
      INSERT INTO case_documents (case_id, firm_id, name, document_type, status, object_path, file_name, generated_by)
      VALUES (${caseId}, ${req.firmId!}, ${docName}, ${(masterDoc.category as string) || "other"}, 'generated', ${normalizedPath}, ${fileName}, ${req.userId!})
      RETURNING *`
    );

    res.status(201).json(savedRows[0]);
  } catch (err: unknown) {
    console.error("Master document generation error:", err);
    res.status(500).json({
      error: "Failed to generate document from master template",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

router.get("/document-variables", requireAuth, async (_req: AuthRequest, res): Promise<void> => {
  const variables = [
    { group: "General", vars: [
      { key: "reference_no", label: "Case Reference No" },
      { key: "date", label: "Today's Date (long format)" },
      { key: "date_short", label: "Today's Date (DD/MM/YYYY)" },
      { key: "case_type", label: "Case Type" },
      { key: "parcel_no", label: "Parcel No" },
      { key: "spa_price", label: "SPA Price (formatted RM)" },
      { key: "spa_price_raw", label: "SPA Price (number only)" },
      { key: "purchase_mode", label: "Purchase Mode (cash/loan)" },
      { key: "title_type", label: "Title Type" },
      { key: "status", label: "Case Status" },
    ]},
    { group: "SPA Details", vars: [
      { key: "spa_purchaser1_name", label: "SPA Purchaser 1 Name" },
      { key: "spa_purchaser1_ic", label: "SPA Purchaser 1 IC" },
      { key: "spa_purchaser2_name", label: "SPA Purchaser 2 Name" },
      { key: "spa_purchaser2_ic", label: "SPA Purchaser 2 IC" },
      { key: "spa_address_line1", label: "Address Line 1" },
      { key: "spa_address_line2", label: "Address Line 2" },
      { key: "spa_address_line3", label: "Address Line 3" },
      { key: "spa_address_line4", label: "Address Line 4" },
      { key: "spa_address_line5", label: "Address Line 5" },
      { key: "spa_mailing_address", label: "Mailing Address" },
      { key: "spa_contact_number", label: "Contact Number" },
      { key: "spa_email", label: "Email Address" },
    ]},
    { group: "Property", vars: [
      { key: "property_parcel_no", label: "Parcel No" },
      { key: "property_floor_no", label: "Floor No" },
      { key: "property_building_no", label: "Building No" },
      { key: "property_car_park_no", label: "Car Park No" },
      { key: "property_type", label: "Property Type" },
      { key: "property_area_sqm", label: "Area (sqm)" },
      { key: "property_purchase_price", label: "Purchase Price (RM)" },
      { key: "property_purchase_price_raw", label: "Purchase Price (number)" },
      { key: "property_progress_payment", label: "Progress Payment" },
      { key: "property_dev_discount", label: "Developer Discount (RM)" },
      { key: "property_bumi_discount", label: "Bumi Discount (RM)" },
      { key: "property_approved_price", label: "Approved Price (RM)" },
    ]},
    { group: "Loan / Financing", vars: [
      { key: "borrower1_name", label: "Borrower 1 Name" },
      { key: "borrower1_ic", label: "Borrower 1 IC" },
      { key: "borrower2_name", label: "Borrower 2 Name" },
      { key: "borrower2_ic", label: "Borrower 2 IC" },
      { key: "end_financier", label: "End Financier (Bank)" },
      { key: "bank_ref", label: "Bank Reference" },
      { key: "bank_branch", label: "Bank Branch" },
      { key: "financing_sum", label: "Financing Sum (RM)" },
      { key: "other_charges", label: "Other Charges (RM)" },
      { key: "total_loan", label: "Total Loan (RM)" },
    ]},
    { group: "Company", vars: [
      { key: "director1_name", label: "Director 1 Name" },
      { key: "director1_ic", label: "Director 1 IC" },
      { key: "director2_name", label: "Director 2 Name" },
      { key: "director2_ic", label: "Director 2 IC" },
    ]},
    { group: "Purchaser (Main)", vars: [
      { key: "purchaser_name", label: "Name" },
      { key: "purchaser_ic", label: "IC No" },
      { key: "purchaser_nationality", label: "Nationality" },
      { key: "purchaser_address", label: "Address" },
      { key: "purchaser_phone", label: "Phone" },
      { key: "purchaser_email", label: "Email" },
    ]},
    { group: "Project", vars: [
      { key: "project_name", label: "Project Name" },
      { key: "project_phase", label: "Phase" },
      { key: "project_type", label: "Project Type" },
      { key: "project_title_type", label: "Title Type" },
      { key: "project_title_subtype", label: "Title Subtype" },
      { key: "project_master_title_no", label: "Master Title Number" },
      { key: "project_master_title_size", label: "Master Title Land Size" },
      { key: "project_mukim", label: "Mukim" },
      { key: "project_daerah", label: "Daerah" },
      { key: "project_negeri", label: "Negeri" },
      { key: "project_land_use", label: "Land Use" },
      { key: "project_development_condition", label: "Development Condition" },
      { key: "project_developer_name", label: "Developer Name (on Project)" },
      { key: "unit_category", label: "Unit Category" },
    ]},
    { group: "Project Property Types (Loop)", vars: [
      { key: "project_property_types", label: "Property Types List", type: "loop" },
      { key: "building_type", label: "Building Type (inside loop)", type: "loopField" },
      { key: "index", label: "Index (inside loop)", type: "loopField" },
    ]},
    { group: "Developer", vars: [
      { key: "developer_name", label: "Developer Name" },
      { key: "developer_reg_no", label: "Registration No" },
      { key: "developer_address", label: "Registered Address" },
      { key: "developer_business_address", label: "Business Address" },
      { key: "developer_contact", label: "Contact Person" },
      { key: "developer_phone", label: "Phone" },
      { key: "developer_email", label: "Email" },
    ]},
    { group: "Lawyer & Clerk", vars: [
      { key: "lawyer_name", label: "Lawyer Name" },
      { key: "lawyer_email", label: "Lawyer Email" },
      { key: "clerk_name", label: "Clerk Name" },
    ]},
    { group: "Firm", vars: [
      { key: "firm_name", label: "Firm Name" },
      { key: "firm_address", label: "Firm Address" },
      { key: "firm_st_number", label: "ST Number" },
      { key: "firm_tin_number", label: "TIN Number" },
      { key: "office_bank_name", label: "Office Bank Name" },
      { key: "office_bank_account_no", label: "Office Bank Account No" },
      { key: "client_bank_name", label: "Client Bank Name" },
      { key: "client_bank_account_no", label: "Client Bank Account No" },
    ]},
    { group: "Loops (use with {#name}...{/name})", vars: [
      { key: "purchasers", label: "All Purchasers", type: "loop", fields: "index, name, ic, nationality, address, phone, email, role" },
      { key: "bank_accounts", label: "All Bank Accounts", type: "loop", fields: "index, bank_name, account_no, account_type" },
      { key: "developer_contacts", label: "Developer Contacts", type: "loop", fields: "index, department, phone, ext, email" },
    ]},
  ];
  res.json(variables);
});

router.post("/cases/:caseId/documents/upload", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const { name, documentType, objectPath, fileName, fileSize } = req.body as {
    name: string;
    documentType?: string;
    objectPath: string;
    fileName: string;
    fileSize?: number;
  };

  if (!name || !objectPath || !fileName) {
    res.status(400).json({ error: "name, objectPath, and fileName are required" });
    return;
  }

  const rows = await queryRows(sql`
    INSERT INTO case_documents (case_id, firm_id, name, document_type, status, object_path, file_name, file_size, is_uploaded, generated_by)
    VALUES (${caseId}, ${req.firmId!}, ${name}, ${documentType ?? "other"}, 'uploaded', ${objectPath}, ${fileName}, ${fileSize ?? null}, true, ${req.userId!})
    RETURNING *`
  );

  res.status(201).json(rows[0]);
});

router.get("/cases/:caseId/documents/:docId/download", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const docId = Number(req.params.docId);

  const rows = await queryRows(
    sql`SELECT * FROM case_documents WHERE id = ${docId} AND case_id = ${caseId} AND firm_id = ${req.firmId!}`
  );

  if (!rows[0]) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const doc = rows[0];

  try {
    const objectFile = await storage.getObjectEntityFile(doc.object_path as string);
    const nodeStream = objectFile.createReadStream();
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      nodeStream.on("data", (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      nodeStream.on("end", resolve);
      nodeStream.on("error", reject);
    });

    const buffer = Buffer.concat(chunks);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.file_name}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.send(buffer);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found in storage" });
      return;
    }
    throw err;
  }
});

router.delete("/cases/:caseId/documents/:docId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const docId = Number(req.params.docId);

  const rows = await queryRows(
    sql`DELETE FROM case_documents WHERE id = ${docId} AND case_id = ${caseId} AND firm_id = ${req.firmId!} RETURNING *`
  );

  if (!rows[0]) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
