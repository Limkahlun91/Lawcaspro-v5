import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, firmsTable, firmBankAccountsTable } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const VALID_ACCOUNT_TYPES = ["office", "client"];

const router: IRouter = Router();

router.get("/firm-settings", requireAuth, requireFirmUser, async (req, res) => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const [firm] = await db.select().from(firmsTable).where(eq(firmsTable.id, firmId));
    if (!firm) { res.status(404).json({ error: "Firm not found" }); return; }

    const bankAccounts = await db.select().from(firmBankAccountsTable)
      .where(eq(firmBankAccountsTable.firmId, firmId));

    res.json({
      id: firm.id,
      name: firm.name,
      slug: firm.slug,
      address: firm.address || "",
      stNumber: firm.stNumber || "",
      tinNumber: firm.tinNumber || "",
      bankAccounts: bankAccounts.map(b => ({
        id: b.id,
        bankName: b.bankName,
        accountNo: b.accountNo,
        accountType: b.accountType,
        isDefault: b.isDefault,
      })),
    });
    return;
  } catch (err: any) {
    res.status(500).json({ error: err.message });
    return;
  }
});

router.patch("/firm-settings", requireAuth, requireFirmUser, requirePermission("settings", "update"), async (req, res): Promise<void> => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const { name, address, stNumber, tinNumber } = req.body;

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (address !== undefined) updates.address = address;
    if (stNumber !== undefined) updates.stNumber = stNumber;
    if (tinNumber !== undefined) updates.tinNumber = tinNumber;

    const [updated] = await db.update(firmsTable)
      .set(updates)
      .where(eq(firmsTable.id, firmId))
      .returning();

    const bankAccounts = await db.select().from(firmBankAccountsTable)
      .where(eq(firmBankAccountsTable.firmId, firmId));

    res.json({
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      address: updated.address || "",
      stNumber: updated.stNumber || "",
      tinNumber: updated.tinNumber || "",
      bankAccounts: bankAccounts.map(b => ({
        id: b.id,
        bankName: b.bankName,
        accountNo: b.accountNo,
        accountType: b.accountType,
        isDefault: b.isDefault,
      })),
    });
    await writeAuditLog({ firmId, actorId: (req as AuthRequest).userId, actorType: (req as AuthRequest).userType, action: "settings.update", entityType: "firm", entityId: firmId, detail: `fields=${Object.keys(updates).join(",")}`, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    return;
  } catch (err: any) {
    res.status(500).json({ error: err.message });
    return;
  }
});

router.post("/firm-settings/bank-accounts", requireAuth, requireFirmUser, requirePermission("settings", "update"), async (req, res): Promise<void> => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const { bankName, accountNo, accountType } = req.body;

    if (!bankName || !accountNo) {
      res.status(400).json({ error: "Bank name and account number are required" });
      return;
    }

    const resolvedType = accountType || "office";
    if (!VALID_ACCOUNT_TYPES.includes(resolvedType)) {
      res.status(400).json({ error: "Account type must be 'office' or 'client'" });
      return;
    }

    const [account] = await db.insert(firmBankAccountsTable).values({
      firmId,
      bankName,
      accountNo,
      accountType: resolvedType,
    }).returning();

    res.status(201).json({
      id: account.id,
      bankName: account.bankName,
      accountNo: account.accountNo,
      accountType: account.accountType,
      isDefault: account.isDefault,
    });
    await writeAuditLog({ firmId, actorId: (req as AuthRequest).userId, actorType: (req as AuthRequest).userType, action: "settings.bank_account.create", entityType: "firm_bank_account", entityId: account.id, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    return;
  } catch (err: any) {
    res.status(500).json({ error: err.message });
    return;
  }
});

router.delete("/firm-settings/bank-accounts/:id", requireAuth, requireFirmUser, requirePermission("settings", "update"), async (req, res): Promise<void> => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;

    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid bank account ID" });
      return;
    }

    const [existing] = await db.select().from(firmBankAccountsTable)
      .where(and(eq(firmBankAccountsTable.id, id), eq(firmBankAccountsTable.firmId, firmId)));

    if (!existing) { res.status(404).json({ error: "Bank account not found" }); return; }

    await db.delete(firmBankAccountsTable).where(eq(firmBankAccountsTable.id, id));
    res.json({ success: true });
    await writeAuditLog({ firmId, actorId: (req as AuthRequest).userId, actorType: (req as AuthRequest).userType, action: "settings.bank_account.delete", entityType: "firm_bank_account", entityId: id, ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    return;
  } catch (err: any) {
    res.status(500).json({ error: err.message });
    return;
  }
});

export default router;
