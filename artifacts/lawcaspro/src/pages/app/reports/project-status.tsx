import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DateOnlyInput } from "@/components/date-only-input";
import { ArrowLeft, Download, FileText, Sparkles } from "lucide-react";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { downloadFromApi } from "@/lib/download";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useListProjects, useListUsers } from "@workspace/api-client-react";
import { exportElementToPdf } from "@/lib/pdf-export";

type Stage = {
  label: string;
  count: number;
};

type Row = {
  fileRef: string;
  projectName: string;
  unitNo: string;
  purchaserName: string;
  assignedStaff: string;
  currentStatus: string;
  milestoneStage: string;
  totalFeesRm: number;
  amountPaidRm: number;
  balanceDueRm: number;
};

type ReportResponse = {
  kpi: {
    totalCases: number;
    totalInvoiced: number;
    totalCollected: number;
    outstandingBalance: number;
  };
  milestoneStages: Stage[];
  rows: Row[];
};

function fmtAmt(v: unknown) {
  return Number(v ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ymd(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default function ProjectStatusReport() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const pageRef = useRef<HTMLDivElement>(null);

  const [projectId, setProjectId] = useState("");
  const [staffId, setStaffId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [applied, setApplied] = useState({ projectId: "", staffId: "", startDate: "", endDate: "" });

  const [instruction, setInstruction] = useState("");
  const [aiHtml, setAiHtml] = useState<string>("");
  const [aiLoading, setAiLoading] = useState(false);

  const projectsQuery = useListProjects({ page: 1, limit: 200 }, { query: { retry: false } });
  const usersQuery = useListUsers({ page: 1, limit: 200 }, { query: { retry: false } });
  const projects = projectsQuery.data?.data ?? [];
  const users = usersQuery.data?.data ?? [];

  const queryKey = useMemo(() => ["report-project-status", applied], [applied]);
  const reportQuery = useQuery<ReportResponse>({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams();
      if (applied.projectId) params.set("projectId", applied.projectId);
      if (applied.staffId) params.set("staffId", applied.staffId);
      if (applied.startDate) params.set("startDate", applied.startDate);
      if (applied.endDate) params.set("endDate", applied.endDate);
      return apiFetchJson<ReportResponse>(`/reports/project-status?${params.toString()}`);
    },
    retry: false,
  });

  const data = reportQuery.data;
  const kpi = data?.kpi ?? { totalCases: 0, totalInvoiced: 0, totalCollected: 0, outstandingBalance: 0 };
  const stages = data?.milestoneStages ?? [];
  const rows = data?.rows ?? [];

  function applyDates(nextStart: string, nextEnd: string) {
    setStartDate(nextStart);
    setEndDate(nextEnd);
    setApplied({ projectId: projectId.trim(), staffId: staffId.trim(), startDate: nextStart, endDate: nextEnd });
  }

  function applyPreset(preset: "1W" | "2W" | "1M" | "3M" | "6M" | "1Y" | "2Y" | "3Y" | "ALL") {
    if (preset === "ALL") {
      applyDates("", "");
      return;
    }
    const today = new Date();
    const end = ymd(today);
    const startBase = new Date(today);
    if (preset === "1W") startBase.setDate(startBase.getDate() - 7);
    if (preset === "2W") startBase.setDate(startBase.getDate() - 14);
    if (preset === "1M") startBase.setMonth(startBase.getMonth() - 1);
    if (preset === "3M") startBase.setMonth(startBase.getMonth() - 3);
    if (preset === "6M") startBase.setMonth(startBase.getMonth() - 6);
    if (preset === "1Y") startBase.setFullYear(startBase.getFullYear() - 1);
    if (preset === "2Y") startBase.setFullYear(startBase.getFullYear() - 2);
    if (preset === "3Y") startBase.setFullYear(startBase.getFullYear() - 3);
    applyDates(ymd(startBase), end);
  }

  async function download(kind: "csv" | "xlsx") {
    try {
      const params = new URLSearchParams();
      if (applied.projectId) params.set("projectId", applied.projectId);
      if (applied.staffId) params.set("staffId", applied.staffId);
      if (applied.startDate) params.set("startDate", applied.startDate);
      if (applied.endDate) params.set("endDate", applied.endDate);
      params.set("format", kind);
      await downloadFromApi(`/reports/project-status?${params.toString()}`, `project-status-report.${kind}`);
    } catch (e: unknown) {
      toastError(toast, e, "Download failed");
    }
  }

  async function downloadPdf() {
    try {
      const el = pageRef.current;
      if (!el) return;
      await exportElementToPdf({ element: el, filename: "project-status-report.pdf" });
    } catch (e: unknown) {
      toastError(toast, e, "PDF export failed");
    }
  }

  async function runAi() {
    const text = instruction.trim();
    if (!text) return;
    setAiLoading(true);
    try {
      const body: any = { instruction: text };
      if (applied.projectId) body.projectId = Number(applied.projectId);
      if (applied.staffId) body.staffId = Number(applied.staffId);
      if (applied.startDate) body.startDate = applied.startDate;
      if (applied.endDate) body.endDate = applied.endDate;
      const resp = await apiFetchJson<{ html: string }>("/reports/project-status/ai-make", { method: "POST", body: JSON.stringify(body) });
      setAiHtml(String(resp?.html ?? ""));
    } catch (e: unknown) {
      toastError(toast, e, "AI generation failed");
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <div className="space-y-6" ref={pageRef}>
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" className="h-8" onClick={() => setLocation("/app/reports")}>
          <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Project Status & Case Analytics</h1>
          <p className="text-slate-500 text-sm mt-0.5">Commercial-grade case progress and financial exposure overview</p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" className="h-8" onClick={() => download("csv")}>
            <Download className="h-3.5 w-3.5 mr-1" /> CSV
          </Button>
          <Button size="sm" variant="outline" className="h-8" onClick={() => download("xlsx")}>
            <Download className="h-3.5 w-3.5 mr-1" /> Excel
          </Button>
          <Button size="sm" variant="outline" className="h-8" onClick={() => downloadPdf()}>
            <FileText className="h-3.5 w-3.5 mr-1" /> PDF
          </Button>
        </div>
      </div>

      <Card className="border-slate-200">
        <CardHeader className="py-3 px-4 border-b">
          <CardTitle className="text-sm font-medium text-slate-700">Filters</CardTitle>
        </CardHeader>
        <CardContent className="py-4 px-4">
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
            <div className="space-y-1.5">
              <div className="text-xs text-slate-500">Project</div>
              <Select value={projectId} onValueChange={(v) => setProjectId(v === "__all__" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="All projects" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All projects</SelectItem>
                  {projects.map((p: any) => (
                    <SelectItem key={p.id} value={String(p.id)}>{String(p.name ?? `Project #${p.id}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs text-slate-500">Assigned Staff</div>
              <Select value={staffId} onValueChange={(v) => setStaffId(v === "__all__" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="All staff" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All staff</SelectItem>
                  {users.map((u: any) => (
                    <SelectItem key={u.id} value={String(u.id)}>{String(u.name ?? `User #${u.id}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs text-slate-500">Start Date</div>
              <DateOnlyInput valueYmd={startDate} onChangeYmd={setStartDate} />
            </div>
            <div className="space-y-1.5">
              <div className="text-xs text-slate-500">End Date</div>
              <DateOnlyInput valueYmd={endDate} onChangeYmd={setEndDate} />
            </div>
            <div className="md:col-span-2 space-y-2">
              <div className="flex flex-wrap gap-2">
                {(["1W", "2W", "1M", "3M", "6M", "1Y", "2Y", "3Y", "ALL"] as const).map((p) => (
                  <Button key={p} size="sm" variant="outline" className="h-8" onClick={() => applyPreset(p)}>
                    {p === "ALL" ? "All" : p}
                  </Button>
                ))}
              </div>
              <div className="flex gap-2">
              <Button
                className="h-9"
                onClick={() => {
                  setApplied({ projectId: projectId.trim(), staffId: staffId.trim(), startDate, endDate });
                }}
              >
                Apply
              </Button>
              <Button
                variant="outline"
                className="h-9"
                onClick={() => {
                  setProjectId("");
                  setStaffId("");
                  setStartDate("");
                  setEndDate("");
                  setApplied({ projectId: "", staffId: "", startDate: "", endDate: "" });
                  setAiHtml("");
                  setInstruction("");
                }}
              >
                Reset
              </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {reportQuery.isError ? (
        <QueryFallback title="Report unavailable" error={reportQuery.error} onRetry={() => reportQuery.refetch()} isRetrying={reportQuery.isFetching} />
      ) : reportQuery.isLoading ? (
        <div className="text-slate-500 py-12 text-center">Loading report...</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "Total Cases", value: String(kpi.totalCases), color: "bg-slate-100 text-slate-700" },
              { label: "Total Invoiced (RM)", value: fmtAmt(kpi.totalInvoiced), color: "bg-blue-50 text-blue-700" },
              { label: "Total Collected (RM)", value: fmtAmt(kpi.totalCollected), color: "bg-green-50 text-green-700" },
              { label: "Outstanding Balance (RM)", value: fmtAmt(kpi.outstandingBalance), color: "bg-red-50 text-red-700" },
            ].map((x) => (
              <Card key={x.label} className="border-slate-200">
                <CardContent className="pt-6">
                  <div className="text-xs text-slate-500">{x.label}</div>
                  <div className={`text-lg font-bold mt-1 inline-block px-2 py-1 rounded ${x.color}`}>{x.value}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="border-slate-200">
            <CardHeader className="py-3 px-4 border-b">
              <CardTitle className="text-sm font-medium text-slate-700">Milestone Stages</CardTitle>
            </CardHeader>
            <CardContent className="py-4 px-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {stages.map((s) => (
                  <div key={s.label} className="border border-slate-200 rounded-md px-3 py-2">
                    <div className="text-xs text-slate-500">{s.label}</div>
                    <div className="text-lg font-bold text-slate-900">{s.count}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="py-3 px-4 border-b">
              <CardTitle className="text-sm font-medium text-slate-700">Case Rows</CardTitle>
            </CardHeader>
            <CardContent className="py-4 px-4">
              {rows.length === 0 ? (
                <div className="text-sm text-slate-400 text-center py-10">No data for the selected filters</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        {["File Ref", "Project Name", "Unit No.", "Purchaser Name", "Assigned Staff", "Current Status", "Total Fees (RM)", "Collected (RM)", "Amount Paid (RM)", "Balance Due (RM)"].map((h) => (
                          <th key={h} className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wide">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.map((r) => (
                        <tr key={r.fileRef} className="hover:bg-slate-50/50">
                          <td className="px-4 py-2.5 text-center font-mono font-medium text-slate-800">{r.fileRef}</td>
                          <td className="px-4 py-2.5 text-slate-700">{r.projectName}</td>
                          <td className="px-4 py-2.5 text-center text-slate-600">{r.unitNo || "—"}</td>
                          <td className="px-4 py-2.5 text-slate-700">{r.purchaserName || "—"}</td>
                          <td className="px-4 py-2.5 text-center text-slate-600">{r.assignedStaff || "—"}</td>
                          <td className="px-4 py-2.5 text-slate-600">{r.currentStatus}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtAmt(r.totalFeesRm)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-green-700">{fmtAmt(r.collectedRm)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-green-700">{fmtAmt(r.amountPaidRm)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-red-600">{fmtAmt(r.balanceDueRm)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="py-3 px-4 border-b">
              <CardTitle className="text-sm font-medium text-slate-700 flex items-center gap-2">
                <Sparkles className="h-4 w-4" /> AI Smart Report Maker (Professional Legal English)
              </CardTitle>
            </CardHeader>
            <CardContent className="py-4 px-4 space-y-3">
              <Textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="e.g. Please summarise this report as an executive briefing for a developer's board meeting."
              />
              <div className="flex gap-2">
                <Button onClick={() => runAi()} disabled={!instruction.trim() || aiLoading}>
                  {aiLoading ? "Generating..." : "Generate"}
                </Button>
                <Button variant="outline" onClick={() => setAiHtml("")} disabled={!aiHtml}>
                  Clear Output
                </Button>
              </div>
              {aiHtml ? (
                <div className="border border-slate-200 rounded-md overflow-hidden">
                  <iframe title="AI report output" className="w-full h-[520px]" sandbox="" srcDoc={aiHtml} />
                </div>
              ) : (
                <div className="text-xs text-slate-500">The output will be rendered as an isolated HTML preview.</div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
