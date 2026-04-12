import type { ApiErrorLike } from "@/lib/error-message";

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

  if (text) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown; code?: unknown };
      data = parsed;
      if (typeof parsed.error === "string" && parsed.error.trim()) message = parsed.error;
      else if (typeof parsed.message === "string" && parsed.message.trim()) message = parsed.message;
      if (typeof parsed.code === "string" && parsed.code.trim()) message = `${message} (${parsed.code})`;
    } catch {
    }
  }

  return { status: res.status, data, message };
}

