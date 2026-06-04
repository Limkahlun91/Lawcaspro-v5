import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { getListCasesQueryKey } from "@workspace/api-client-react";
import { CaseFormModal } from "./components/case-form/CaseFormModal";

export default function NewCasePage() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(true);
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();

  const roleLower = String((user as any)?.roleName ?? "").trim().toLowerCase();
  const canApproveCases =
    roleLower.includes("partner")
    || roleLower === "account admin"
    || roleLower === "account manager"
    || (roleLower.includes("account") && roleLower.includes("admin"))
    || (roleLower.includes("account") && roleLower.includes("manager"));

  return (
    <CaseFormModal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) navigate("/app/cases");
      }}
      mode="create"
      showSuccessToast={false}
      onSubmit={async (payload) => {
        try {
          const created = await apiFetchJson<any>("/cases", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          await Promise.all([
            qc.invalidateQueries({ queryKey: ["dashboard"] }),
            qc.invalidateQueries({ queryKey: ["cases"] }),
            qc.invalidateQueries({ queryKey: getListCasesQueryKey() }),
            qc.invalidateQueries({ queryKey: ["cases", "filter-options"] }),
            qc.invalidateQueries({ queryKey: ["case-files"] }),
          ]);
          toast({
            title: "Open file submitted for approval.",
            description: canApproveCases
              ? "Redirecting to Open File Pending Approval."
              : "Your open file request has been submitted for approval.",
          });
          navigate(canApproveCases
            ? "/app/accounting/file-listing?approvalStatus=pending_approval"
            : "/app/cases");
        } catch (err: any) {
          console.error("[cases/new] create failed", {
            status: err?.status,
            message: err?.message,
            data: err?.data,
          });
          throw err;
        }
      }}
    />
  );
}

