import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { apiRequest } from "@/lib/api-client";
import { isApiSuccess, unwrapApiData } from "@/lib/api-contract";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { FileUp, Sparkles } from "lucide-react";

type Purchaser = { name: string; ic: string };

type IntakePayload = {
  purchasers?: Purchaser[];
  purchaserName?: string;
  purchaserIc?: string;
  projectName?: string;
  propertyAddress?: string;
  parcelNo?: string;
  price?: string;
  loanBank?: string;
  loanAmount?: string;
};

function encodePayload(payload: IntakePayload): string {
  const json = JSON.stringify(payload ?? {});
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export default function CaseIntakeInboxPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const intakeEnabled = isFeatureEnabled("intake_inbox");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);

  const [purchasers, setPurchasers] = useState<Purchaser[]>([{ name: "", ic: "" }]);
  const [projectName, setProjectName] = useState("");
  const [propertyAddress, setPropertyAddress] = useState("");
  const [parcelNo, setParcelNo] = useState("");
  const [price, setPrice] = useState("");
  const [loanBank, setLoanBank] = useState("");
  const [loanAmount, setLoanAmount] = useState("");

  if (!intakeEnabled) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Intake Inbox</h1>
          <p className="text-slate-500">This feature is coming soon / temporarily disabled.</p>
        </div>
        <Card className="border-slate-200">
          <CardContent className="p-6">
            <div className="flex items-center justify-between gap-4">
              <div className="text-sm text-slate-700">
                Please use Cases for now.
              </div>
              <Button onClick={() => setLocation("/app/cases")} variant="outline">
                Back to Cases
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const isPdf = useMemo(() => (file?.type || "").toLowerCase().includes("pdf") || (file?.name || "").toLowerCase().endsWith(".pdf"), [file]);

  async function handleAutoExtract() {
    if (!file) {
      toast({ title: "Please upload a PDF first" });
      return;
    }
    setIsExtracting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiRequest("/ai/extract", { method: "POST", body: fd });
      const raw = (await res.json()) as unknown;
      const data = unwrapApiData<Record<string, unknown>>(raw) ?? {};
      const warnings = isApiSuccess(raw) && Array.isArray(raw.warnings) ? raw.warnings : [];

      const p = Array.isArray((data as any).purchasers) ? ((data as any).purchasers as any[]) : null;
      const cleanedPurchasers: Purchaser[] | null = p
        ? p
            .map((x) => ({
              name: typeof x?.name === "string" ? x.name.trim() : "",
              ic: typeof x?.ic === "string" ? x.ic.trim() : "",
            }))
            .filter((x) => x.name || x.ic)
        : null;

      if (cleanedPurchasers && cleanedPurchasers.length > 0) {
        setPurchasers(cleanedPurchasers);
      } else {
        const n = typeof (data as any).purchaserName === "string" ? (data as any).purchaserName.trim() : "";
        const ic = typeof (data as any).purchaserIc === "string" ? (data as any).purchaserIc.trim() : "";
        if (n || ic) {
          setPurchasers([{ name: n, ic }]);
        }
      }

      const s = (v: unknown): string => (typeof v === "string" ? v : "");
      setProjectName((v) => v || s((data as any).projectName).trim());
      setParcelNo((v) => v || s((data as any).parcelNo).trim());
      setPrice((v) => v || s((data as any).price).trim());
      setLoanBank((v) => v || s((data as any).loanBank).trim());
      setLoanAmount((v) => v || s((data as any).loanAmount).trim());
      setPropertyAddress((v) => v || s((data as any).propertyAddress).trim());

      const warningText = warnings.map((w) => w?.message).filter((m): m is string => typeof m === "string" && m.trim()).join("\n");
      toast({
        title: "Auto-extract completed",
        description: warningText || "Please verify and edit the extracted fields before promoting.",
      });
    } catch (e) {
      toastError(toast, e);
    } finally {
      setIsExtracting(false);
    }
  }

  function promoteToCase() {
    const cleanPurchasers = purchasers
      .map((p) => ({ name: p.name.trim(), ic: p.ic.trim() }))
      .filter((p) => p.name || p.ic);

    if (cleanPurchasers.length === 0) {
      toast({ title: "Please add at least one purchaser", variant: "destructive" });
      return;
    }
    for (const [i, p] of cleanPurchasers.entries()) {
      if (!p.name) {
        toast({ title: `Purchaser #${i + 1}: Name is required`, variant: "destructive" });
        return;
      }
      if (!p.ic) {
        toast({ title: `Purchaser #${i + 1}: IC No. is required`, variant: "destructive" });
        return;
      }
    }

    const project = projectName.trim();
    const address = propertyAddress.trim();
    if (!project && !address) {
      toast({ title: "Property Address is required when Project Name is empty", variant: "destructive" });
      return;
    }

    const payload: IntakePayload = {
      purchasers: cleanPurchasers,
      purchaserName: cleanPurchasers[0]?.name,
      purchaserIc: cleanPurchasers[0]?.ic,
      projectName: project || undefined,
      propertyAddress: address || undefined,
      parcelNo: parcelNo.trim() || undefined,
      price: price.trim() || undefined,
      loanBank: loanBank.trim() || undefined,
      loanAmount: loanAmount.trim() || undefined,
    };
    const encoded = encodePayload(payload);
    setLocation(`/app/cases?mode=create&intake=${encodeURIComponent(encoded)}`);
  }

  function acceptFile(f: File) {
    if (!f) return;
    const name = (f.name || "").toLowerCase();
    const mime = (f.type || "").toLowerCase();
    const ok = mime.includes("pdf") || name.endsWith(".pdf");
    if (!ok) {
      toast({ title: "Unsupported file", description: "Please upload a PDF file.", variant: "destructive" });
      return;
    }
    setFile(f);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Case Intake Inbox</h1>
        <p className="text-slate-500">Upload LOF / Booking Form PDFs, verify extracted fields, and promote into a real case.</p>
      </div>

      <Card className="border-slate-200">
        <CardContent className="p-0">
          <ResizablePanelGroup direction="horizontal" className="h-[760px]">
            <ResizablePanel defaultSize={52} minSize={35}>
              <div className="h-full flex flex-col bg-white">
                <div className="p-4 border-b">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="font-semibold text-slate-900">Document Viewer</div>
                      <div className="text-xs text-slate-500">Drag & drop a PDF or click to upload</div>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="application/pdf,.pdf"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) acceptFile(f);
                        e.currentTarget.value = "";
                      }}
                    />
                    <Button type="button" variant="outline" className="border-slate-200" onClick={() => fileInputRef.current?.click()}>
                      <FileUp className="h-4 w-4 mr-2" />
                      Upload PDF
                    </Button>
                  </div>
                </div>

                <div className="flex-1 p-4">
                  <div
                    className={cn(
                      "h-full w-full rounded-lg border border-dashed border-slate-200 bg-slate-50/50 overflow-hidden",
                      isDragging && "border-slate-400 bg-slate-50"
                    )}
                    onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }}
                    onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setIsDragging(false);
                      const f = e.dataTransfer.files?.[0];
                      if (f) acceptFile(f);
                    }}
                    onClick={() => fileInputRef.current?.click()}
                    role="button"
                    tabIndex={0}
                  >
                    {!previewUrl || !isPdf ? (
                      <div className="h-full flex flex-col items-center justify-center text-center px-6">
                        <div className="text-slate-900 font-semibold">Drop a PDF here</div>
                        <div className="text-xs text-slate-500 mt-1">Booking Form / Letter of Offer / any scanned PDF</div>
                      </div>
                    ) : (
                      <iframe title="pdf-preview" src={previewUrl} className="h-full w-full bg-white" />
                    )}
                  </div>
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel defaultSize={48} minSize={35}>
              <div className="h-full flex flex-col bg-white">
                <div className="p-4 border-b flex items-start justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="font-semibold text-slate-900">Data Extraction Form</div>
                    <div className="text-xs text-slate-500">Review, correct, then promote into a case</div>
                  </div>
                  <Button type="button" disabled={isExtracting || !file} onClick={() => { void handleAutoExtract(); }}>
                    <Sparkles className="h-4 w-4 mr-2" />
                    {isExtracting ? "Extracting..." : "Auto-Extract with AI"}
                  </Button>
                </div>

                <div className="flex-1 overflow-auto p-4 space-y-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <Label>Purchasers</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setPurchasers((prev) => [...prev, { name: "", ic: "" }])}
                      >
                        + Add Purchaser
                      </Button>
                    </div>
                    {purchasers.map((p, idx) => (
                      <div key={idx} className="grid grid-cols-2 gap-3 items-end">
                        <div className="space-y-1.5">
                          <Label>Purchaser Name</Label>
                          <Input
                            value={p.name}
                            onChange={(e) => {
                              const v = e.target.value;
                              setPurchasers((prev) => prev.map((x, i) => (i === idx ? { ...x, name: v } : x)));
                            }}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label>IC No.</Label>
                          <Input
                            value={p.ic}
                            onChange={(e) => {
                              const v = e.target.value;
                              setPurchasers((prev) => prev.map((x, i) => (i === idx ? { ...x, ic: v } : x)));
                            }}
                          />
                        </div>
                        {purchasers.length > 1 && (
                          <div className="col-span-2 flex justify-end">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setPurchasers((prev) => prev.filter((_, i) => i !== idx))}
                            >
                              Remove
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Project Name</Label>
                      <Input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Optional if address is provided" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Property / Unit No</Label>
                      <Input value={parcelNo} onChange={(e) => setParcelNo(e.target.value)} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Price (RM)</Label>
                      <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Loan Bank</Label>
                      <Input value={loanBank} onChange={(e) => setLoanBank(e.target.value)} />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label>Property Address{!projectName.trim() ? " (Required if Project Name is empty)" : ""}</Label>
                    <Textarea value={propertyAddress} onChange={(e) => setPropertyAddress(e.target.value)} rows={4} />
                  </div>

                  <div className="space-y-1.5">
                    <Label>Loan Amount (RM)</Label>
                    <Input value={loanAmount} onChange={(e) => setLoanAmount(e.target.value)} inputMode="decimal" />
                  </div>
                </div>

                <div className="p-4 border-t bg-white">
                  <Button
                    type="button"
                    className="w-full"
                    onClick={() => {
                      try {
                        promoteToCase();
                      } catch (e) {
                        toastError(toast, e);
                      }
                    }}
                  >
                    Promote to Case
                  </Button>
                  <div className="text-[11px] text-slate-500 mt-2">
                    Promotes the verified data into the new case form for final review.
                  </div>
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </CardContent>
      </Card>
    </div>
  );
}
