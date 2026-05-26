import { useState } from "react";
import { useLocation } from "wouter";
import { apiFetchJson } from "@/lib/api-client";
import { CaseFormModal } from "./components/case-form/CaseFormModal";

export default function NewCasePage() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(true);

  return (
    <CaseFormModal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) navigate("/app/cases");
      }}
      mode="create"
      onSubmit={async (payload) => {
        try {
          const created = await apiFetchJson<any>("/cases", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          navigate(`/app/cases/${created.id}`);
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

