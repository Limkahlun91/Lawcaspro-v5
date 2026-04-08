import { Router, type IRouter } from "express";
import { eq, ilike, count, desc, and, sql } from "drizzle-orm";
import {
  db, casesTable, casePurchasersTable, caseAssignmentsTable,
  caseWorkflowStepsTable, caseNotesTable,
  projectsTable, developersTable, clientsTable, usersTable, auditLogsTable,
} from "@workspace/db";
import {
  CreateCaseBody, UpdateCaseBody, ListCasesQueryParams,
  GetCaseParams, UpdateCaseParams,
  GetCaseWorkflowParams, UpdateWorkflowStepParams, UpdateWorkflowStepBody,
  GetCaseNotesParams, CreateCaseNoteParams, CreateCaseNoteBody
} from "@workspace/api-zod";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth";
import { buildWorkflowSteps } from "../lib/workflow";

const router: IRouter = Router();

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

async function formatCaseDetail(r: DbConn, c: typeof casesTable.$inferSelect) {
  const [proj] = await r.select().from(projectsTable).where(eq(projectsTable.id, c.projectId));
  const [dev] = await r.select().from(developersTable).where(eq(developersTable.id, c.developerId));

  const purchaserRows = await r.select().from(casePurchasersTable).where(eq(casePurchasersTable.caseId, c.id));
  const purchasers = await Promise.all(
    purchaserRows.map(async (p) => {
      const [client] = await r.select().from(clientsTable).where(eq(clientsTable.id, p.clientId));
      return {
        id: p.id,
        clientId: p.clientId,
        clientName: client?.name ?? "Unknown",
        icNo: client?.icNo ?? null,
        role: p.role,
        orderNo: p.orderNo,
      };
    })
  );

  const assignRows = await r.select().from(caseAssignmentsTable)
    .where(and(eq(caseAssignmentsTable.caseId, c.id), sql`unassigned_at IS NULL`));
  const assignments = await Promise.all(
    assignRows.map(async (a) => {
      const [user] = await r.select().from(usersTable).where(eq(usersTable.id, a.userId));
      return {
        id: a.id,
        userId: a.userId,
        userName: user?.name ?? "Unknown",
        roleInCase: a.roleInCase,
        assignedAt: a.assignedAt.toISOString(),
      };
    })
  );

  let spaDetails: any = null;
  let propertyDetails: any = null;
  let loanDetails: any = null;
  let companyDetails: any = null;
  try { if (c.spaDetails) spaDetails = JSON.parse(c.spaDetails); } catch {}
  try { if (c.propertyDetails) propertyDetails = JSON.parse(c.propertyDetails); } catch {}
  try { if (c.loanDetails) loanDetails = JSON.parse(c.loanDetails); } catch {}
  try { if (c.companyDetails) companyDetails = JSON.parse(c.companyDetails); } catch {}

  return {
    id: c.id,
    firmId: c.firmId,
    referenceNo: c.referenceNo,
    projectId: c.projectId,
    projectName: proj?.name ?? "Unknown",
    developerId: c.developerId,
    developerName: dev?.name ?? "Unknown",
    purchaseMode: c.purchaseMode,
    titleType: c.titleType,
    spaPrice: c.spaPrice ? Number(c.spaPrice) : null,
    status: c.status,
    caseType: c.caseType,
    parcelNo: c.parcelNo,
    spaDetails,
    propertyDetails,
    loanDetails,
    companyDetails,
    purchasers,
    assignments,
    createdBy: c.createdBy ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

async function formatCaseSummary(r: DbConn, c: typeof casesTable.$inferSelect) {
  const [proj] = await r.select().from(projectsTable).where(eq(projectsTable.id, c.projectId));
  const [dev] = await r.select().from(developersTable).where(eq(developersTable.id, c.developerId));
  const [lawyerAssign] = await r.select().from(caseAssignmentsTable)
    .where(and(eq(caseAssignmentsTable.caseId, c.id), eq(caseAssignmentsTable.roleInCase, "lawyer"), sql`unassigned_at IS NULL`));
  let lawyerName: string | null = null;
  if (lawyerAssign) {
    const [lawyer] = await r.select().from(usersTable).where(eq(usersTable.id, lawyerAssign.userId));
    lawyerName = lawyer?.name ?? null;
  }
  return {
    id: c.id,
    referenceNo: c.referenceNo,
    projectName: proj?.name ?? "Unknown",
    developerName: dev?.name ?? "Unknown",
    purchaseMode: c.purchaseMode,
    titleType: c.titleType,
    spaPrice: c.spaPrice ? Number(c.spaPrice) : null,
    status: c.status,
    assignedLawyerName: lawyerName,
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/cases/stats/by-status", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const rows = await db
    .select({ status: casesTable.status, count: count() })
    .from(casesTable)
    .where(eq(casesTable.firmId, req.firmId!))
    .groupBy(casesTable.status);
  res.json(rows.map(r => ({ status: r.status, count: Number(r.count) })));
});

router.get("/cases/stats/by-type", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const rows = await db
    .select({ purchaseMode: casesTable.purchaseMode, count: count() })
    .from(casesTable)
    .where(eq(casesTable.firmId, req.firmId!))
    .groupBy(casesTable.purchaseMode);
  res.json(rows.map(r => ({ purchaseMode: r.purchaseMode, count: Number(r.count) })));
});

router.get("/cases/recent", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);
  const limitParam = req.query.limit ? Number(req.query.limit) : 5;
  const cases = await r.select().from(casesTable)
    .where(eq(casesTable.firmId, req.firmId!))
    .orderBy(desc(casesTable.updatedAt))
    .limit(limitParam);
  const summaries = await Promise.all(cases.map((c) => formatCaseSummary(r, c)));
  res.json(summaries);
});

router.get("/cases", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);
  const params = ListCasesQueryParams.safeParse(req.query);
  const search = params.success ? params.data.search : undefined;
  const status = params.success ? params.data.status : undefined;
  const projectId = params.success ? params.data.projectId : undefined;
  const developerId = params.success ? params.data.developerId : undefined;
  const purchaseMode = params.success ? params.data.purchaseMode : undefined;
  const titleType = params.success ? params.data.titleType : undefined;
  const page = params.success ? (params.data.page ?? 1) : 1;
  const limit = params.success ? (params.data.limit ?? 20) : 20;
  const offset = (page - 1) * limit;

  const conditions = [eq(casesTable.firmId, req.firmId!)];
  if (status) conditions.push(eq(casesTable.status, status));
  if (projectId) conditions.push(eq(casesTable.projectId, projectId));
  if (developerId) conditions.push(eq(casesTable.developerId, developerId));
  if (purchaseMode) conditions.push(eq(casesTable.purchaseMode, purchaseMode));
  if (titleType) conditions.push(eq(casesTable.titleType, titleType));

  const cases = await r.select().from(casesTable)
    .where(and(...conditions))
    .orderBy(desc(casesTable.updatedAt))
    .limit(limit).offset(offset);

  const [totalRes] = await r.select({ c: count() }).from(casesTable).where(and(...conditions));

  const summaries = await Promise.all(cases.map((c) => formatCaseSummary(r, c)));
  res.json({ data: summaries, total: Number(totalRes?.c ?? 0), page, limit });
});

router.post("/cases", requireAuth, requireFirmUser, requirePermission("cases", "create"), async (req: AuthRequest, res): Promise<void> => {
  try {
    const r = req.rlsDb;
    if (!r) {
      (req as any).log?.error?.({ route: "POST /api/cases", userId: req.userId, firmId: req.firmId }, "missing req.rlsDb");
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    const parsed = CreateCaseBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", fields: parsed.error.flatten().fieldErrors });
      return;
    }

    const { projectId, developerId: clientDeveloperId, purchaseMode, titleType, spaPrice, assignedLawyerId, assignedClerkId, purchaserIds, purchasers } = parsed.data;

    // ── 1. Resolve developerId server-side from projectId ─────────────────────
    const [project] = await r.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (project.firmId !== req.firmId) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!project.developerId) {
      res.status(422).json({ error: "The selected project has no linked developer. Please edit the project first." });
      return;
    }
    // If caller sent developerId, validate it matches the project
    if (clientDeveloperId !== undefined && clientDeveloperId !== project.developerId) {
      res.status(409).json({
        error: "developerId does not match the project's developer",
        expected: project.developerId,
        received: clientDeveloperId,
      });
      return;
    }
    const developerId = project.developerId;

    // ── 2. Resolve purchaser client IDs with dedupe ───────────────────────────
    let resolvedPurchaserIds: number[] = purchaserIds ?? [];
    let purchasersCreated = 0;
    let purchasersReused = 0;

    if (resolvedPurchaserIds.length === 0 && purchasers && purchasers.length > 0) {
      for (const p of purchasers) {
        const trimmedName = p.name.trim();
        if (!trimmedName) continue;
        const trimmedIc = p.ic?.trim() || null;

        let existingClientId: number | null = null;

        if (trimmedIc) {
          // IC is present — look up by firmId + icNo (most reliable match)
          const [byIc] = await r
            .select()
            .from(clientsTable)
            .where(and(eq(clientsTable.firmId, req.firmId!), eq(clientsTable.icNo, trimmedIc)));
          if (byIc) {
            existingClientId = byIc.id;
          }
        }

        if (!existingClientId) {
          // No IC or no IC match — try exact case-insensitive name match
          const byName = await r
            .select()
            .from(clientsTable)
            .where(and(
              eq(clientsTable.firmId, req.firmId!),
              sql`LOWER(${clientsTable.name}) = LOWER(${trimmedName})`
            ));
          // Only reuse if exactly one match (ambiguous → create new)
          if (byName.length === 1) {
            existingClientId = byName[0].id;
          }
        }

        if (existingClientId) {
          resolvedPurchaserIds.push(existingClientId);
          purchasersReused++;
        } else {
          const insertBase = {
            firmId: req.firmId!,
            name: trimmedName,
            icNo: trimmedIc,
          };

          let client: typeof clientsTable.$inferSelect;
          [client] = await r
            .insert(clientsTable)
            .values(insertBase as any)
            .returning();

          try {
            await r
              .update(clientsTable)
              .set({ createdBy: req.userId } as any)
              .where(and(eq(clientsTable.id, client.id), eq(clientsTable.firmId, req.firmId!)));
          } catch {
          }
          resolvedPurchaserIds.push(client.id);
          purchasersCreated++;
        }
      }
    }

    if (resolvedPurchaserIds.length === 0) {
      res.status(400).json({ error: "At least one purchaser name is required" });
      return;
    }

    // ── 3. Build extra fields from body (not in Zod schema) ───────────────────
    const { caseType, parcelNo, spaDetails, propertyDetails, loanDetails, companyDetails } = req.body as {
      caseType?: string;
      parcelNo?: string;
      spaDetails?: object;
      propertyDetails?: object;
      loanDetails?: object;
      companyDetails?: object;
    };

    const requestedRef = typeof (req.body as any).referenceNo === "string"
      ? String((req.body as any).referenceNo).trim()
      : "";

    if (requestedRef.length > 80) {
      res.status(400).json({ error: "Invalid referenceNo" });
      return;
    }

    const refNo = requestedRef || `LCP-${req.firmId}-${Date.now()}`;

    const insertCaseBase = {
      firmId: req.firmId!,
      projectId,
      developerId,
      referenceNo: refNo,
      purchaseMode,
      titleType,
      spaPrice: spaPrice ? String(spaPrice) : null,
      status: "File Opened / SPA Pending Signing",
      caseType: caseType ?? null,
      parcelNo: parcelNo ?? null,
      spaDetails: spaDetails ? JSON.stringify(spaDetails) : null,
      propertyDetails: propertyDetails ? JSON.stringify(propertyDetails) : null,
      loanDetails: loanDetails ? JSON.stringify(loanDetails) : null,
      companyDetails: companyDetails ? JSON.stringify(companyDetails) : null,
    };

    let ctxFirmId: string | null = null;
    let ctxIsFounder: string | null = null;
    try {
      const result = await r.execute(sql`
        select
          current_setting('app.current_firm_id', true) as firm_id,
          current_setting('app.is_founder', true) as is_founder
      `);
      const rows = Array.isArray(result)
        ? result
        : ("rows" in (result as any) ? (result as any).rows : []);
      const row = rows?.[0] as any;
      ctxFirmId = typeof row?.firm_id === "string" ? row.firm_id : null;
      ctxIsFounder = typeof row?.is_founder === "string" ? row.is_founder : null;
    } catch {
    }
    (req as any).log?.info?.({
      route: "POST /api/cases",
      userId: req.userId,
      firmId: req.firmId,
      insertFirmId: insertCaseBase.firmId,
      ctxFirmId,
      ctxIsFounder,
    }, "create route tenant context");

    let newCase: typeof casesTable.$inferSelect;
    [newCase] = await r
      .insert(casesTable)
      .values(insertCaseBase as any)
      .returning();

    try {
      await r
        .update(casesTable)
        .set({ createdBy: req.userId } as any)
        .where(and(eq(casesTable.id, newCase.id), eq(casesTable.firmId, req.firmId!)));
    } catch {
    }

    for (let i = 0; i < resolvedPurchaserIds.length; i++) {
      await r.insert(casePurchasersTable).values({
        caseId: newCase.id,
        clientId: resolvedPurchaserIds[i],
        role: i === 0 ? "main" : "joint",
        orderNo: i + 1,
      });
    }

    await r.insert(caseAssignmentsTable).values({
      caseId: newCase.id,
      userId: assignedLawyerId,
      roleInCase: "lawyer",
      assignedBy: req.userId,
    });

    if (assignedClerkId) {
      await r.insert(caseAssignmentsTable).values({
        caseId: newCase.id,
        userId: assignedClerkId,
        roleInCase: "clerk",
        assignedBy: req.userId,
      });
    }

    const workflowSteps = buildWorkflowSteps(purchaseMode, titleType);
    if (workflowSteps.length > 0) {
      await r.insert(caseWorkflowStepsTable).values(
        workflowSteps.map((s) => ({
          caseId: newCase.id,
          stepKey: s.stepKey,
          stepName: s.stepName,
          stepOrder: s.stepOrder,
          pathType: s.pathType,
          status: "pending",
        }))
      );
    }

    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: "firm_user",
      action: "cases.create",
      entityType: "case",
      entityId: newCase.id,
      detail: `referenceNo=${refNo} purchasersCreated=${purchasersCreated} purchasersReused=${purchasersReused}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    const detail = await formatCaseDetail(r, newCase);
    res.status(201).json({ ...detail, purchasersCreated, purchasersReused });
    return;
  } catch (e) {
    const pg = (() => {
      let cur: any = e;
      for (let i = 0; i < 6 && cur; i++) {
        if (typeof cur?.code === "string" || typeof cur?.message === "string" || typeof cur?.detail === "string" || typeof cur?.constraint === "string") {
          const code = typeof cur.code === "string" ? cur.code : undefined;
          const message = typeof cur.message === "string" ? cur.message : undefined;
          const detail = typeof cur.detail === "string" ? cur.detail : undefined;
          const constraint = typeof cur.constraint === "string" ? cur.constraint : undefined;
          return { code, message, detail, constraint };
        }
        cur = cur?.cause;
      }
      return {};
    })();
    (req as any).log?.error?.({ err: e, pg }, "cases.create failed");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.get("/cases/:caseId", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = GetCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [c] = await r
    .select()
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!c) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  res.json(await formatCaseDetail(r, c));
});

router.patch("/cases/:caseId", requireAuth, requireFirmUser, requirePermission("cases", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = UpdateCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateCaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;
  if (parsed.data.purchaseMode !== undefined) updates.purchaseMode = parsed.data.purchaseMode;
  if (parsed.data.titleType !== undefined) updates.titleType = parsed.data.titleType;
  if (parsed.data.spaPrice !== undefined) updates.spaPrice = String(parsed.data.spaPrice);

  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  if (parsed.data.assignedLawyerId !== undefined) {
    await r.update(caseAssignmentsTable)
      .set({ unassignedAt: new Date() })
      .where(and(eq(caseAssignmentsTable.caseId, params.data.caseId), eq(caseAssignmentsTable.roleInCase, "lawyer"), sql`unassigned_at IS NULL`));
    await r.insert(caseAssignmentsTable).values({
      caseId: params.data.caseId,
      userId: parsed.data.assignedLawyerId,
      roleInCase: "lawyer",
      assignedBy: req.userId,
    });
  }

  const [c] = await r
    .update(casesTable)
    .set(updates)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)))
    .returning();

  if (!c) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  await r.insert(auditLogsTable).values({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: "firm_user",
    action: "case.updated",
    entityType: "case",
    entityId: c.id,
    detail: JSON.stringify(updates),
  });

  res.json(await formatCaseDetail(r, c));
});

router.get("/cases/:caseId/workflow", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = GetCaseWorkflowParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const steps = await r.select().from(caseWorkflowStepsTable)
    .where(eq(caseWorkflowStepsTable.caseId, params.data.caseId))
    .orderBy(caseWorkflowStepsTable.stepOrder);

  const enriched = await Promise.all(
    steps.map(async (s) => {
      let completedByName: string | null = null;
      if (s.completedBy) {
        const [user] = await r.select().from(usersTable).where(eq(usersTable.id, s.completedBy));
        completedByName = user?.name ?? null;
      }
      return {
        id: s.id,
        caseId: s.caseId,
        stepKey: s.stepKey,
        stepName: s.stepName,
        stepOrder: s.stepOrder,
        status: s.status,
        pathType: s.pathType,
        completedBy: s.completedBy ?? null,
        completedByName,
        completedAt: s.completedAt?.toISOString() ?? null,
        notes: s.notes ?? null,
      };
    })
  );

  res.json(enriched);
});

router.patch("/cases/:caseId/workflow/:stepId", requireAuth, requireFirmUser, requirePermission("cases", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = UpdateWorkflowStepParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateWorkflowStepBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.status !== undefined) {
    updates.status = parsed.data.status;
    if (parsed.data.status === "completed") {
      updates.completedBy = req.userId;
      updates.completedAt = new Date();
    }
  }
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;

  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const [step] = await r
    .update(caseWorkflowStepsTable)
    .set(updates)
    .where(and(eq(caseWorkflowStepsTable.id, params.data.stepId), eq(caseWorkflowStepsTable.caseId, params.data.caseId)))
    .returning();

  if (!step) {
    res.status(404).json({ error: "Workflow step not found" });
    return;
  }

  await r.insert(auditLogsTable).values({
    firmId: req.firmId,
    actorId: req.userId,
    actorType: "firm_user",
    action: "workflow.step_updated",
    entityType: "case_workflow_step",
    entityId: step.id,
    detail: `Step ${step.stepName} -> ${step.status}`,
  });

  let completedByName: string | null = null;
  if (step.completedBy) {
    const [user] = await r.select().from(usersTable).where(eq(usersTable.id, step.completedBy));
    completedByName = user?.name ?? null;
  }

  res.json({
    id: step.id,
    caseId: step.caseId,
    stepKey: step.stepKey,
    stepName: step.stepName,
    stepOrder: step.stepOrder,
    status: step.status,
    pathType: step.pathType,
    completedBy: step.completedBy ?? null,
    completedByName,
    completedAt: step.completedAt?.toISOString() ?? null,
    notes: step.notes ?? null,
  });
});

router.get("/cases/:caseId/notes", requireAuth, requireFirmUser, requirePermission("cases", "read"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = GetCaseNotesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const notes = await r.select().from(caseNotesTable)
    .where(eq(caseNotesTable.caseId, params.data.caseId))
    .orderBy(desc(caseNotesTable.createdAt));

  const enriched = await Promise.all(
    notes.map(async (n) => {
      const [author] = await r.select().from(usersTable).where(eq(usersTable.id, n.authorId));
      return {
        id: n.id,
        caseId: n.caseId,
        authorId: n.authorId,
        authorName: author?.name ?? "Unknown",
        content: n.content,
        createdAt: n.createdAt.toISOString(),
      };
    })
  );

  res.json(enriched);
});

router.post("/cases/:caseId/notes", requireAuth, requireFirmUser, requirePermission("cases", "update"), async (req: AuthRequest, res): Promise<void> => {
  const r = req.rlsDb;
  if (!r) {
    res.status(500).json({ error: "Missing tenant database context" });
    return;
  }
  const params = CreateCaseNoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = CreateCaseNoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [caseRow] = await r
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(and(eq(casesTable.id, params.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!caseRow) {
    res.status(404).json({ error: "Case not found" });
    return;
  }

  const [note] = await r
    .insert(caseNotesTable)
    .values({
      caseId: params.data.caseId,
      authorId: req.userId!,
      content: parsed.data.content,
    })
    .returning();

  const [author] = await r.select().from(usersTable).where(eq(usersTable.id, note.authorId));

  res.status(201).json({
    id: note.id,
    caseId: note.caseId,
    authorId: note.authorId,
    authorName: author?.name ?? "Unknown",
    content: note.content,
    createdAt: note.createdAt.toISOString(),
  });
});

export default router;
