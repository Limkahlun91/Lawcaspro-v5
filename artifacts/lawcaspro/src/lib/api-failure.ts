import { isApiFailure, type ApiFailure } from "@/lib/api-contract";

export type ApiFailureError = {
  status: number;
  data: ApiFailure;
  message: string;
  code: string;
  requestId?: string;
  stage?: string;
  retryable?: boolean;
  suggestion?: string;
};

export function throwIfApiFailure(v: unknown): void {
  if (!isApiFailure(v)) return;
  const e: ApiFailureError = {
    status: 200,
    data: v,
    message: v.error.message || "Request failed",
    code: v.error.code,
    requestId: v.meta?.request_id,
    stage: v.error.stage,
    retryable: v.error.retryable,
    suggestion: v.error.suggestion,
  };
  throw e;
}

export function getApiFailureCodeFromError(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const data = (err as any).data;
  if (isApiFailure(data)) return data.error.code;
  const code = (err as any).code;
  return typeof code === "string" ? code : null;
}
