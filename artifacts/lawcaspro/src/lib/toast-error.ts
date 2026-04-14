import type { useToast } from "@/hooks/use-toast";
import { getErrorMessage, getFriendlyErrorTitle, isAbortError, isRequestTimeoutError } from "@/lib/error-message";

const recent = new Map<string, number>();
const WINDOW_MS = 2500;

export function toastError(
  toast: ReturnType<typeof useToast>["toast"],
  err: unknown,
  title?: string,
) {
  if (isAbortError(err) && !isRequestTimeoutError(err)) return;
  const t = title ?? getFriendlyErrorTitle(err);
  const d = getErrorMessage(err);
  const key = `${t}::${d}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < WINDOW_MS) return;
  recent.set(key, now);

  toast({
    title: t,
    description: d,
    variant: "destructive",
  });
}
