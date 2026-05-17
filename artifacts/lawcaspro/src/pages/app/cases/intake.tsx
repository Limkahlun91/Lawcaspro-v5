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
import { FileUp, Sparkles } from "lucide-react";

type IntakePayload = {
  purchaserName?: string;
  purchaserIc?: string;
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);

  const [purchaserName, setPurchaserName] = useState("");
  const [purchaserIc, setPurchaserIc] = useState("");
  const [propertyAddress, setPropertyAddress] = useState("");
  const [parcelNo, setParcelNo] = useState("");
  const [price, setPrice] = useState("");
  const [loanBank, setLoanBank] = useState("");
  const [loanAmount, setLoanAmount] = useState("");

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
      /*
        Future AI extension point:
        - Send uploaded LOF/Booking Form PDF to:
          POST /api/ai/extract-data
        - The API returns structured fields to auto-fill this form and optionally write back to Case DB.
      */
      await new Promise((r) => setTimeout(r, 600));
      setPurchaserName((v) => v || "Ali Bin Abu");
      setPurchaserIc((v) => v || "900101-14-5678");
      setParcelNo((v) => v || "Z-005");
      setPrice((v) => v || "500000");
      setLoanBank((v) => v || "RHB Islamic Bank");
      setLoanAmount((v) => v || "450000");
      setPropertyAddress((v) => v || "No. 1, Jalan Example, 50000 Kuala Lumpur");
      toast({ title: "Auto-extract completed (mock)", description: "Please verify and edit the extracted fields before promoting." });
    } catch (e) {
      toastError(toast, e);
    } finally {
      setIsExtracting(false);
    }
  }

  function promoteToCase() {
    const payload: IntakePayload = {
      purchaserName: purchaserName.trim(),
      purchaserIc: purchaserIc.trim(),
      propertyAddress: propertyAddress.trim(),
      parcelNo: parcelNo.trim(),
      price: price.trim(),
      loanBank: loanBank.trim(),
      loanAmount: loanAmount.trim(),
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
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Purchaser Name</Label>
                      <Input value={purchaserName} onChange={(e) => setPurchaserName(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label>IC No.</Label>
                      <Input value={purchaserIc} onChange={(e) => setPurchaserIc(e.target.value)} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Property / Unit No</Label>
                      <Input value={parcelNo} onChange={(e) => setParcelNo(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Price (RM)</Label>
                      <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Loan Bank</Label>
                      <Input value={loanBank} onChange={(e) => setLoanBank(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Loan Amount (RM)</Label>
                      <Input value={loanAmount} onChange={(e) => setLoanAmount(e.target.value)} inputMode="decimal" />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label>Property Address</Label>
                    <Textarea value={propertyAddress} onChange={(e) => setPropertyAddress(e.target.value)} rows={4} />
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

