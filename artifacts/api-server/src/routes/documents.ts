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

async function buildCaseContext(caseId: number, firmId: number): Promise<Record<string, unknown> | null> {
  const caseRows = await queryRows(sql`SELECT * FROM cases WHERE id = ${caseId} AND firm_id = ${firmId}`);
  if (!caseRows[0]) return null;
  const c = caseRows[0];

  const projectRows = await queryRows(sql`SELECT * FROM projects WHERE id = ${c.project_id}`);
  const developerRows = await queryRows(sql`SELECT * FROM developers WHERE id = ${c.developer_id}`);
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
  const lawyer = lawyerRows[0] ?? {};
  const clerk = clerkRows[0] ?? {};
  const mainPurchaser = purchaserRows.find((p) => p.role === "main") ?? purchaserRows[0] ?? {};

  const today = new Date();
  const dateStr = today.toLocaleDateString("en-MY", { day: "2-digit", month: "long", year: "numeric" });

  return {
    case_id: caseId,
    reference_no: c.reference_no,
    date: dateStr,
    spa_price: c.spa_price ? `RM ${Number(c.spa_price).toLocaleString("en-MY", { minimumFractionDigits: 2 })}` : "",
    spa_price_raw: c.spa_price ?? "",
    purchase_mode: c.purchase_mode,
    title_type: c.title_type,
    status: c.status,
    project_name: proj.name ?? "",
    project_type: proj.project_type ?? "",
    unit_category: proj.unit_category ?? "",
    developer_name: dev.name ?? "",
    developer_reg_no: dev.company_reg_no ?? "",
    developer_address: dev.address ?? "",
    developer_contact: dev.contact_person ?? "",
    purchaser_name: mainPurchaser.name ?? "",
    purchaser_ic: mainPurchaser.ic_no ?? "",
    purchaser_nationality: mainPurchaser.nationality ?? "",
    purchaser_address: mainPurchaser.address ?? "",
    purchaser_phone: mainPurchaser.phone ?? "",
    purchaser_email: mainPurchaser.email ?? "",
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
    lawyer_name: lawyer.user_name ?? "",
    lawyer_email: lawyer.user_email ?? "",
    clerk_name: clerk.user_name ?? "",
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
