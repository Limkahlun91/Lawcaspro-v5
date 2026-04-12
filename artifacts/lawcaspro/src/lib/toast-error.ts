import type { useToast } from "@/hooks/use-toast";
import { getErrorMessage, getFriendlyErrorTitle } from "@/lib/error-message";

export function toastError(
  toast: ReturnType<typeof useToast>["toast"],
  err: unknown,
  title?: string,
) {
  toast({
    title: title ?? getFriendlyErrorTitle(err),
    description: getErrorMessage(err),
    variant: "destructive",
  });
}

