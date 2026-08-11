export type LegacyDuplicateActionDisposition =
  | "hidden_from_staff"
  | "admin_diagnostics_only"
  | "removed";

export interface LegacyDuplicateActionEntry {
  readonly canonicalSourceAction: string;
  readonly legacyButton: string;
  readonly legacyRoute?: string;
  readonly disposition: LegacyDuplicateActionDisposition;
}

export const LEGACY_DUPLICATE_ACTION_CATALOG: ReadonlyArray<LegacyDuplicateActionEntry> = [
  {
    canonicalSourceAction: "Case approval",
    legacyButton: "Sync Case to Ledger",
    legacyRoute: "/cases/:id/sync-ledger",
    disposition: "removed",
  },
  {
    canonicalSourceAction: "Document confirmation",
    legacyButton: "Post Document to Accounting",
    legacyRoute: "/documents/:id/post-accounting",
    disposition: "hidden_from_staff",
  },
  {
    canonicalSourceAction: "Quotation approval",
    legacyButton: "Send Quotation to Billing",
    legacyRoute: "/quotations/:id/send-billing",
    disposition: "removed",
  },
  {
    canonicalSourceAction: "Invoice issue",
    legacyButton: "Send to Accounting",
    legacyRoute: "/invoices/:id/send-accounting",
    disposition: "removed",
  },
  {
    canonicalSourceAction: "Receipt confirmation",
    legacyButton: "Refresh Case Ledger",
    legacyRoute: "/receipts/:id/refresh-ledger",
    disposition: "removed",
  },
  {
    canonicalSourceAction: "PV approval/payment",
    legacyButton: "Post Payment Voucher",
    legacyRoute: "/payment-vouchers/:id/post",
    disposition: "removed",
  },
  {
    canonicalSourceAction: "Claim approval/payment",
    legacyButton: "Sync Claim to Payable",
    legacyRoute: "/claims/:id/sync-payable",
    disposition: "hidden_from_staff",
  },
  {
    canonicalSourceAction: "Payroll finalisation",
    legacyButton: "Update Ledger",
    legacyRoute: "/payroll/:id/update-ledger",
    disposition: "admin_diagnostics_only",
  },
  {
    canonicalSourceAction: "Leave approval",
    legacyButton: "Sync Leave to Payroll",
    legacyRoute: "/leave/:id/sync-payroll",
    disposition: "hidden_from_staff",
  },
  {
    canonicalSourceAction: "Employee termination",
    legacyButton: "Finalise Offboarding Ledger",
    legacyRoute: "/employees/:id/finalise-offboarding-ledger",
    disposition: "admin_diagnostics_only",
  },
];

export interface ActionAllowedCaller {
  readonly isAdmin?: boolean;
  readonly isPlatformOps?: boolean;
  readonly roleName?: string;
}

export interface ActionAllowedResult {
  readonly allowed: boolean;
  readonly reason: string;
}

const REASON_REMOVED =
  "Legacy action removed. It was replaced by canonical source action automation.";

const REASON_HIDDEN_ADMIN =
  "Admin-only technical retry. Regular staff rely on canonical source action automatic propagation.";

const REASON_UNKNOWN =
  "Unknown legacy action. Use canonical source action if available.";

const REASON_ROLE_REQUIRED =
  "Admin diagnostics only. Caller role must include 'Admin' or 'Platform' for technical retry access.";

function roleIncludesAdminOrPlatform(roleName: string | undefined): boolean {
  if (!roleName || typeof roleName !== "string") return false;
  const normalized = roleName.toLowerCase().trim();
  return normalized.includes("admin") || normalized.includes("platform");
}

export function isActionAllowedForCaller(
  legacyButton: string,
  caller: ActionAllowedCaller,
): ActionAllowedResult {
  const lookupName = typeof legacyButton === "string" ? legacyButton : "";

  const entry = LEGACY_DUPLICATE_ACTION_CATALOG.find(
    (row) => row.legacyButton === lookupName,
  );

  if (!entry) {
    return { allowed: false, reason: REASON_UNKNOWN };
  }

  switch (entry.disposition) {
    case "removed":
      return { allowed: false, reason: REASON_REMOVED };

    case "hidden_from_staff": {
      const privileged = Boolean(caller?.isAdmin) || Boolean(caller?.isPlatformOps);
      if (privileged) {
        return { allowed: true, reason: REASON_HIDDEN_ADMIN };
      }
      return { allowed: false, reason: REASON_HIDDEN_ADMIN };
    }

    case "admin_diagnostics_only": {
      const privileged = Boolean(caller?.isAdmin) || Boolean(caller?.isPlatformOps);
      const roleOk = roleIncludesAdminOrPlatform(caller?.roleName);
      if (privileged && roleOk) {
        return { allowed: true, reason: REASON_HIDDEN_ADMIN };
      }
      if (privileged && !roleOk) {
        return { allowed: false, reason: REASON_ROLE_REQUIRED };
      }
      return { allowed: false, reason: REASON_HIDDEN_ADMIN };
    }

    default:
      return { allowed: false, reason: REASON_UNKNOWN };
  }
}
