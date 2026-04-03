/**
 * re-auth-dialog.tsx
 *
 * Dialog shown to the user when a sensitive API action returns 403 REAUTH_REQUIRED.
 * The user must click "Confirm" to proceed, which re-sends the request with the
 * current session token as the x-reauth-token header.
 *
 * Usage example:
 *
 *   const { wrapWithReAuth } = useReAuth();
 *
 *   async function handleVoid() {
 *     await wrapWithReAuth(
 *       (reAuthHeaders) => fetch(`/api/invoices/${id}/void`, {
 *         method: "POST",
 *         credentials: "include",
 *         headers: { "Content-Type": "application/json", ...reAuthHeaders },
 *       }),
 *       "This will permanently void the invoice and cannot be undone."
 *     );
 *   }
 */

import {
  createContext, useCallback, useContext, useRef, useState, ReactNode,
} from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/lib/auth-context";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReAuthHeaders = Record<string, string>;
type WrappedAction = (headers: ReAuthHeaders) => Promise<Response | unknown>;

interface ReAuthContextType {
  /**
   * Wrap a fetch/action with a re-auth confirmation dialog.
   *
   * @param action    Function that accepts re-auth headers and performs the request.
   * @param message   Optional description shown in the dialog body.
   * @returns The result of `action` after confirmation.
   */
  wrapWithReAuth: (action: WrappedAction, message?: string) => Promise<unknown>;
}

interface PendingState {
  message: string;
  resolve: (confirmed: boolean) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ReAuthContext = createContext<ReAuthContextType | undefined>(undefined);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ReAuthProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const [pending, setPending] = useState<PendingState | null>(null);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const wrapWithReAuth = useCallback(
    async (action: WrappedAction, message?: string): Promise<unknown> => {
      const dialogMessage = message ?? "This is a sensitive action that requires confirmation before proceeding.";

      return new Promise<unknown>((resolveOuter, rejectOuter) => {
        const resolve = (confirmed: boolean) => {
          setPending(null);
          resolverRef.current = null;

          if (!confirmed) {
            rejectOuter(new Error("Action cancelled by user"));
            return;
          }

          const reAuthHeaders: ReAuthHeaders = token
            ? { "x-reauth-token": token }
            : {};

          Promise.resolve()
            .then(() => action(reAuthHeaders))
            .then(resolveOuter)
            .catch(rejectOuter);
        };

        resolverRef.current = resolve;
        setPending({ message: dialogMessage, resolve });
      });
    },
    [token],
  );

  return (
    <ReAuthContext.Provider value={{ wrapWithReAuth }}>
      {children}

      <AlertDialog open={pending !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm sensitive action</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => resolverRef.current?.(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-slate-900 hover:bg-slate-800 text-white"
              onClick={() => resolverRef.current?.(true)}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ReAuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useReAuth(): ReAuthContextType {
  const ctx = useContext(ReAuthContext);
  if (!ctx) throw new Error("useReAuth must be used within a ReAuthProvider");
  return ctx;
}
