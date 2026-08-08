import crypto from "node:crypto";

export type EInvoiceStatus =
  | "DRAFT"
  | "READY"
  | "SUBMITTING"
  | "SUBMITTED"
  | "VALID"
  | "INVALID"
  | "CANCELLED"
  | "ERROR"
  | "RETRY_PENDING";

export type SandboxSubmitResult = {
  status: EInvoiceStatus;
  externalSubmissionId: string;
  responseJson: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
};

export type SandboxValidateResult = {
  status: EInvoiceStatus;
  responseJson: Record<string, unknown>;
};

export function isSandboxEnabled(): boolean {
  const v = process.env.EINVOICE_SANDBOX;
  return v === "1" || v === "true" || v === "TRUE";
}

function randHex(len: number) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

export async function sandboxSubmitInvoice(
  _firmId: number,
  _invoiceId: number,
  payload: Record<string, unknown>,
): Promise<SandboxSubmitResult> {
  const shouldError = Math.random() < 0.05;
  const externalId = `SBX-${Date.now().toString(36).toUpperCase()}-${randHex(6).toUpperCase()}`;

  if (shouldError) {
    return {
      status: "ERROR",
      externalSubmissionId: externalId,
      responseJson: {
        sandbox: true,
        submittedAt: new Date().toISOString(),
        errorReason: "SIMULATED_TEMPORARY_DOWNSTREAM",
      },
      errorCode: "SBX_TEMP_001",
      errorMessage: "Sandbox simulated temporary downstream error. Retry allowed.",
    };
  }

  return {
    status: "SUBMITTED",
    externalSubmissionId: externalId,
    responseJson: {
      sandbox: true,
      submittedAt: new Date().toISOString(),
      ack: "RECEIVED",
      payloadHash: sha256(JSON.stringify(payload)),
      validationHints: [],
    },
  };
}

export async function sandboxValidateSubmission(
  _externalSubmissionId: string,
): Promise<SandboxValidateResult> {
  const shouldInvalid = Math.random() < 0.03;
  if (shouldInvalid) {
    return {
      status: "INVALID",
      responseJson: {
        sandbox: true,
        validatedAt: new Date().toISOString(),
        errors: [
          { code: "SBX_V_003", message: "Sandbox simulated invalid classification" },
        ],
      },
    };
  }
  return {
    status: "VALID",
    responseJson: {
      sandbox: true,
      validatedAt: new Date().toISOString(),
      lhdnReference: `LHDN-SBX-${randHex(10).toUpperCase()}`,
      digitalSignature: `SIG:${randHex(32)}`,
    },
  };
}

export function buildSubmissionIdempotencyKey(firmId: number, invoiceId: number, version = 1): string {
  return `firm_${firmId}_inv_${invoiceId}_submission_v${version}`;
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export const VALID_TRANSITIONS: Record<EInvoiceStatus, EInvoiceStatus[]> = {
  DRAFT: ["READY", "ERROR"],
  READY: ["SUBMITTING", "DRAFT", "ERROR"],
  SUBMITTING: ["SUBMITTED", "ERROR", "RETRY_PENDING"],
  SUBMITTED: ["VALID", "INVALID", "ERROR", "RETRY_PENDING"],
  VALID: ["CANCELLED"],
  INVALID: ["RETRY_PENDING", "CANCELLED"],
  CANCELLED: [],
  ERROR: ["RETRY_PENDING", "SUBMITTING"],
  RETRY_PENDING: ["SUBMITTING", "ERROR"],
};

export function isTransitionAllowed(from: EInvoiceStatus, to: EInvoiceStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}
