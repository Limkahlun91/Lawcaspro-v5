import type { ApiErrorLike } from "@/lib/error-message";
import { isApiFailure } from "@/lib/api-contract";

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export async function apiErrorFromResponse(res: Response): Promise<ApiErrorLike & { status: number; message: string }> {
  const text = await safeReadText(res);
  let message = text || res.statusText || "Request failed";
  let data: unknown = undefined;
  let code: string | undefined = undefined;
  let requestId: string | undefined = undefined;
  let stage: string | undefined = undefined;
  let retryable: boolean | undefined = undefined;
  let suggestion: string | undefined = undefined;

  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      data = parsed;
      if (isApiFailure(parsed)) {
        code = parsed.error.code;
        message = parsed.error.message || message;
        requestId = parsed.meta?.request_id;
        stage = parsed.error.stage;
        retryable = parsed.error.retryable;
        suggestion = parsed.error.suggestion;
      } else if (typeof (parsed as any)?.error === "string" && String((parsed as any).error).trim()) {
        message = String((parsed as any).error);
      } else if (typeof (parsed as any)?.message === "string" && String((parsed as any).message).trim()) {
        message = String((parsed as any).message);
      }
      if (!code && typeof (parsed as any)?.code === "string" && String((parsed as any).code).trim()) code = String((parsed as any).code);
      if (code) message = `${message} (${code})`;
    } catch {
    }
  }

  return { status: res.status, data, message, ...(code ? { code } : {}), ...(requestId ? { requestId } : {}), ...(stage ? { stage } : {}), ...(retryable !== undefined ? { retryable } : {}), ...(suggestion ? { suggestion } : {}) };
}

