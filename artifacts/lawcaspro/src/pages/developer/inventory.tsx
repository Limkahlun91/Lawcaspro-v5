import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { downloadFromApi } from "@/lib/download";

type InventoryItem = {
  id: number;
  referenceNo: string;
  unitNo: string | null;
  purchaserName: string | null;
  projectName: string;
  spaStatus: string;
  loanStatus: string | null;
  updatedAt: string;
};

type InventoryResponse = { data: InventoryItem[]; total: number; page: number; limit: number };

type DevMessage = {
  id: string;
  senderType: "developer" | "staff";
  senderName: string;
  messageText: string;
  attachments: unknown;
  createdAt: string;
};

export default function DeveloperInventoryPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const limit = 50;

  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null);
  const [messageDraft, setMessageDraft] = useState("");

  const qs = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("page", String(page));
    sp.set("limit", String(limit));
    if (search.trim()) sp.set("search", search.trim());
    return sp.toString();
  }, [page, limit, search]);

  const invQuery = useQuery<InventoryResponse>({
    queryKey: ["developer-inventory", qs],
    queryFn: ({ signal }) => apiFetchJson(`/developer/inventory?${qs}`, { signal }),
    retry: false,
  });

  const messagesQuery = useQuery<{ data: DevMessage[] }>({
    queryKey: ["developer-case-messages", selectedCaseId],
    queryFn: ({ signal }) => apiFetchJson(`/developer/cases/${selectedCaseId}/messages`, { signal }),
    enabled: typeof selectedCaseId === "number" && selectedCaseId > 0,
    retry: false,
  });

  const sendMutation = useMutation({
    mutationFn: async ({ caseId, messageText }: { caseId: number; messageText: string }) => {
      return await apiFetchJson(`/developer/cases/${caseId}/messages`, {
        method: "POST",
        body: JSON.stringify({ messageText }),
      });
    },
    onSuccess: async () => {
      setMessageDraft("");
      await queryClient.invalidateQueries({ queryKey: ["developer-case-messages", selectedCaseId] });
    },
  });

  const items = Array.isArray(invQuery.data?.data) ? invQuery.data!.data : [];
  const total = Number(invQuery.data?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));

  if (invQuery.isLoading) {
    return <div className="text-slate-500 py-12 text-center text-sm">Loading inventory...</div>;
  }

  if (invQuery.isError) {
    return (
      <div className="py-12 flex justify-center">
        <div className="max-w-lg w-full px-4">
          <QueryFallback title="Inventory unavailable" error={invQuery.error} onRetry={() => invQuery.refetch()} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Project Inventory</h1>
          <p className="text-slate-500 mt-1">Units, purchasers, and status overview</p>
        </div>
        <Button
          onClick={async () => {
            const fileName = `developer_inventory_${new Date().toISOString().slice(0, 10)}.xlsx`;
            await downloadFromApi(`/developer/inventory/export.xlsx?${qs}`, fileName);
          }}
        >
          Export Excel
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Units</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search unit no / purchaser / reference..."
              className="w-full sm:w-96"
            />
            <div className="text-sm text-slate-500">Total: {total}</div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b">
                  <th className="py-2 pr-3">Unit No</th>
                  <th className="py-2 pr-3">Purchaser</th>
                  <th className="py-2 pr-3">SPA Status</th>
                  <th className="py-2 pr-3">Loan Status</th>
                  <th className="py-2 pr-3">Project</th>
                  <th className="py-2 pr-3">Last Updated</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-3 text-slate-900">{c.unitNo ?? "—"}</td>
                    <td className="py-2 pr-3 text-slate-900">{c.purchaserName ?? "—"}</td>
                    <td className="py-2 pr-3 text-slate-700">{c.spaStatus}</td>
                    <td className="py-2 pr-3 text-slate-700">{c.loanStatus ?? "—"}</td>
                    <td className="py-2 pr-3 text-slate-700">{c.projectName}</td>
                    <td className="py-2 pr-3 text-slate-600">{c.updatedAt ? new Date(c.updatedAt).toLocaleDateString() : "—"}</td>
                    <td className="py-2 pr-3 text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setSelectedCaseId(c.id);
                          setMessageDraft("");
                        }}
                      >
                        Message
                      </Button>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-slate-500">No cases found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="text-sm text-slate-500">
              Page {page} / {totalPages}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Prev
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={selectedCaseId != null} onOpenChange={(open) => { if (!open) setSelectedCaseId(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Case Messaging</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {messagesQuery.isLoading && <div className="text-sm text-slate-500">Loading messages...</div>}
            {messagesQuery.isError && <div className="text-sm text-red-600">Failed to load messages.</div>}
            {!messagesQuery.isLoading && !messagesQuery.isError && (
              <div className="space-y-2 max-h-[45vh] overflow-auto pr-1">
                {(Array.isArray(messagesQuery.data?.data) ? messagesQuery.data!.data : []).map((m) => {
                  const isMine = m.senderType === "developer";
                  return (
                    <div key={m.id} className={`flex ${isMine ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[85%] rounded-2xl px-3 py-2 ${isMine ? "bg-slate-900 text-white" : "bg-white text-slate-900 border border-slate-200"}`}>
                        <div className={`text-[11px] ${isMine ? "text-slate-200" : "text-slate-500"}`}>
                          {isMine ? "You" : (m.senderName || "Staff")}
                        </div>
                        <div className="text-sm whitespace-pre-wrap break-words">{m.messageText}</div>
                        <div className={`mt-1 text-[10px] ${isMine ? "text-slate-300" : "text-slate-400"}`}>
                          {m.createdAt ? new Date(m.createdAt).toLocaleString() : ""}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {(Array.isArray(messagesQuery.data?.data) ? messagesQuery.data!.data : []).length === 0 && (
                  <div className="text-sm text-slate-600">No messages yet.</div>
                )}
              </div>
            )}

            <div className="pt-2 border-t border-slate-200 space-y-2">
              <Textarea
                value={messageDraft}
                onChange={(e) => setMessageDraft(e.target.value)}
                placeholder="Write a message to the law firm..."
                className="min-h-[90px]"
              />
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-slate-500">{Math.min(2000, messageDraft.length)}/2000</div>
                <Button
                  onClick={() => {
                    const t = messageDraft.trim();
                    if (!t || !selectedCaseId) return;
                    if (t.length > 2000) return;
                    sendMutation.mutate({ caseId: selectedCaseId, messageText: t });
                  }}
                  disabled={sendMutation.isPending || !messageDraft.trim()}
                >
                  Send
                </Button>
              </div>
              {sendMutation.isError && <div className="text-xs text-red-600">Failed to send. Please try again.</div>}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedCaseId(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

