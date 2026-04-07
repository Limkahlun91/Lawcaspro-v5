/**
 * re-auth-dialog.tsx
 *
 * Dialog shown when a sensitive action requires confirmation.
 *
 * Security design:
 *   - When the user clicks "Confirm", the dialog calls POST /auth/reauth-token
 *     (authenticated via the existing httpOnly session cookie).
 *   - The server returns a short-lived, single-use re-auth token (5 min TTL).
 *   - That token is held in React component state (memory) — never written to
 *     localStorage or sessionStorage — and discarded once the action completes.
 *   - The main session token is never exposed to frontend JavaScript.
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
import { getApiBaseUrl } from "@/lib/api";

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

          // Fetch a short-lived re-auth token from the server.
          // Authentication is proved by the existing httpOnly session cookie.
          // The token lives only in memory (local variable) — never persisted.
          const base = getApiBaseUrl();
          fetch(`${base}/auth/reauth-token`, {
            method: "POST",
            credentials: "include",
          })
            .then((r) => {
              if (!r.ok) throw new Error("Failed to obtain re-auth token");
              return r.json() as Promise<{ reAuthToken: string }>;
            })
            .then(({ reAuthToken }) => {
              const headers: ReAuthHeaders = { "x-reauth-token": reAuthToken };
              return action(headers);
            })
            .then(resolveOuter)
            .catch(rejectOuter);
        };

        resolverRef.current = resolve;
        setPending({ message: dialogMessage, resolve });
      });
    },
    [],
  );

  return (
    <ReAuthContext.Provider value={{ wrapWithReAuth }}>
      {children}

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) {
            resolverRef.current?.(false);
          }
        }}
      >
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
