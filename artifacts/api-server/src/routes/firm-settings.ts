import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, firmsTable, firmBankAccountsTable, rolesTable } from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";
import type { Response, NextFunction } from "express";

const VALID_ACCOUNT_TYPES = ["office", "client"];

async function requirePartnerRole(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const roleId = req.roleId;
  if (!roleId) {
    res.status(403).json({ error: "Partner access required" });
    return;
  }
  const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, roleId));
  if (!role || role.name !== "Partner") {
    res.status(403).json({ error: "Partner access required" });
    return;
  }
  next();
}

const router: IRouter = Router();

router.get("/firm-settings", requireAuth, requireFirmUser, async (req, res) => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const [firm] = await db.select().from(firmsTable).where(eq(firmsTable.id, firmId));
    if (!firm) return res.status(404).json({ error: "Firm not found" });

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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/firm-settings", requireAuth, requireFirmUser, requirePartnerRole, async (req, res) => {
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/firm-settings/bank-accounts", requireAuth, requireFirmUser, requirePartnerRole, async (req, res) => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const { bankName, accountNo, accountType } = req.body;

    if (!bankName || !accountNo) {
      return res.status(400).json({ error: "Bank name and account number are required" });
    }

    const resolvedType = accountType || "office";
    if (!VALID_ACCOUNT_TYPES.includes(resolvedType)) {
      return res.status(400).json({ error: "Account type must be 'office' or 'client'" });
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/firm-settings/bank-accounts/:id", requireAuth, requireFirmUser, requirePartnerRole, async (req, res) => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid bank account ID" });
    }

    const [existing] = await db.select().from(firmBankAccountsTable)
      .where(and(eq(firmBankAccountsTable.id, id), eq(firmBankAccountsTable.firmId, firmId)));

    if (!existing) return res.status(404).json({ error: "Bank account not found" });

    await db.delete(firmBankAccountsTable).where(eq(firmBankAccountsTable.id, id));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
