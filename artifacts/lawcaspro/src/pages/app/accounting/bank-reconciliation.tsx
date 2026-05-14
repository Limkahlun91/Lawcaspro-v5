import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetchBlob, apiFetchJson } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { downloadBlob } from "@/lib/download";
import { cn } from "@/lib/utils";

type BankTransactionRow = {
  id: string;
  bank_account_id?: number | null;
  case_id?: number | null;
  transaction_date: string;
  description: string;
  reference_no: string | null;
  withdrawal: string | number | null;
  deposit: string | number | null;
  balance: string | number | null;
  is_exported: boolean;
  exported_at?: string | null;
  case?: { case_id: number; title: string } | null;
  recommended_case?: { case_id: number; title: string; match_reason: string } | null;
};

type ListBankTransactionsResponse = { data: BankTransactionRow[] };

type BankAccountRow = {
  id: number;
  bank_name: string;
  account_name: string | null;
  account_no: string;
  gl_code: string | null;
  opening_balance: string | number | null;
  opening_balance_date: string | null;
  is_default: boolean;
};

type ListBankAccountsResponse = { data: BankAccountRow[] };

function toNumberOrNull(v: string): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export default function BankReconciliationPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [bankAccountId, setBankAccountId] = useState<number | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignTx, setAssignTx] = useState<BankTransactionRow | null>(null);
  const [caseQuery, setCaseQuery] = useState("");
  const [caseResults, setCaseResults] = useState<Array<{ case_id: number; title: string }>>([]);

  const accountsQuery = useQuery<ListBankAccountsResponse>({
    queryKey: ["bank-accounts"],
    queryFn: ({ signal }) => apiFetchJson("/accounting/bank-accounts", { signal }),
    retry: false,
  });

  const accounts = Array.isArray(accountsQuery.data?.data) ? accountsQuery.data!.data : [];
  const selectedAccount = accounts.find((a) => a.id === bankAccountId) ?? null;

  useEffect(() => {
    if (bankAccountId != null) return;
    if (accounts.length === 0) return;
    const def = accounts.find((a) => a.is_default) ?? accounts[0];
    setBankAccountId(def.id);
  }, [accounts, bankAccountId]);

  const txQuery = useQuery<ListBankTransactionsResponse>({
    queryKey: ["bank-transactions", bankAccountId],
    queryFn: ({ signal }) => apiFetchJson(`/accounting/bank-transactions?bankAccountId=${bankAccountId}`, { signal }),
    enabled: bankAccountId != null,
    retry: false,
  });

  const rows = Array.isArray(txQuery.data?.data) ? txQuery.data!.data : [];

  const parseMutation = useMutation({
    mutationFn: async (f: File) => {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("bankAccountId", String(bankAccountId ?? ""));
      return await apiFetchJson("/accounting/bank-statements/parse", { method: "POST", body: fd });
    },
    onSuccess: async (data: any) => {
      toast({ title: "Statement parsed", description: `Inserted ${Number(data?.inserted ?? 0)} transactions.` });
      setFile(null);
      await qc.invalidateQueries({ queryKey: ["bank-transactions", bankAccountId] });
    },
    onError: (e) => toastError(toast, e, "Parse failed"),
  });

  const updateMutation = useMutation({
    mutationFn: async (payload: { id: string; patch: Record<string, unknown> }) => {
      return await apiFetchJson(`/accounting/bank-transactions/${payload.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload.patch),
      });
    },
    onSuccess: async () => {
      toast({ title: "Saved" });
      setEditingId(null);
      setDraft({});
      await qc.invalidateQueries({ queryKey: ["bank-transactions", bankAccountId] });
    },
    onError: (e) => toastError(toast, e, "Save failed"),
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const blob = await apiFetchBlob(`/accounting/bank-transactions/export?bankAccountId=${bankAccountId}`);
      const fileName = `bank_transactions_export_${new Date().toISOString().slice(0, 10)}.xlsx`;
      downloadBlob(blob, fileName);
    },
    onSuccess: async () => {
      toast({ title: "Exported to Excel" });
      await qc.invalidateQueries({ queryKey: ["bank-transactions", bankAccountId] });
    },
    onError: (e) => toastError(toast, e, "Export failed"),
  });

  const isBusy = parseMutation.isPending || updateMutation.isPending || exportMutation.isPending;

  const caseSearchMutation = useMutation({
    mutationFn: async () => {
      const q = caseQuery.trim();
      return await apiFetchJson(`/accounting/cases/search?query=${encodeURIComponent(q)}`);
    },
    onSuccess: (data: any) => {
      const rows = Array.isArray(data?.data) ? data.data : [];
      setCaseResults(rows);
    },
    onError: (e) => toastError(toast, e, "Search failed"),
  });

  const bindMutation = useMutation({
    mutationFn: async (payload: { txId: string; caseId: number }) => {
      return await apiFetchJson(`/accounting/bank-transactions/${payload.txId}/bind-case`, {
        method: "POST",
        body: JSON.stringify({ caseId: payload.caseId }),
      });
    },
    onSuccess: async () => {
      toast({ title: "Successfully bound to Case & Ledger updated" });
      setAssignOpen(false);
      setAssignTx(null);
      setCaseQuery("");
      setCaseResults([]);
      await qc.invalidateQueries({ queryKey: ["bank-transactions", bankAccountId] });
    },
    onError: (e) => toastError(toast, e, "Bind failed"),
  });

  const editingRow = useMemo(() => rows.find((r) => r.id === editingId) ?? null, [rows, editingId]);
  const currentBalance = useMemo(() => {
    const opening = selectedAccount?.opening_balance == null ? 0 : Number(selectedAccount.opening_balance);
    const net = rows.reduce((acc, r) => acc + Number(r.deposit ?? 0) - Number(r.withdrawal ?? 0), 0);
    return opening + net;
  }, [rows, selectedAccount]);

  function beginEdit(r: BankTransactionRow) {
    setEditingId(r.id);
    setDraft({
      transactionDate: r.transaction_date ?? "",
      description: r.description ?? "",
      referenceNo: r.reference_no ?? "",
      withdrawal: r.withdrawal == null ? "" : String(r.withdrawal),
      deposit: r.deposit == null ? "" : String(r.deposit),
      balance: r.balance == null ? "" : String(r.balance),
    });
  }

  function dropHandlers() {
    return {
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(true);
      },
      onDragLeave: () => setDragOver(false),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0] ?? null;
        if (!f) return;
        if (f.type !== "application/pdf") {
          toast({ title: "Only PDF is supported", variant: "destructive" as any });
          return;
        }
        setFile(f);
      },
    };
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">Bank Reconciliation</h1>
          <p className="text-slate-500 mt-1 text-sm">Upload statements, correct OCR results, and export to Excel.</p>
        </div>
        <Button onClick={() => exportMutation.mutate()} disabled={isBusy || bankAccountId == null} className="bg-emerald-600 hover:bg-emerald-700">
          Export to Excel (XLSX)
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Bank Account</CardTitle>
        </CardHeader>
        <CardContent className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-[280px]">
            <Select value={bankAccountId != null ? String(bankAccountId) : ""} onValueChange={(v) => setBankAccountId(Number(v))}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder={accountsQuery.isLoading ? "Loading..." : "Select bank account"} />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {(a.account_name || a.bank_name) + " • " + a.account_no}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedAccount?.opening_balance_date ? (
              <div className="text-xs text-slate-500 mt-2">
                Opening Balance: RM {Number(selectedAccount.opening_balance ?? 0).toFixed(2)} on {selectedAccount.opening_balance_date}
              </div>
            ) : null}
          </div>

          <div className="text-right">
            <div className="text-xs text-slate-500">Computed Balance</div>
            <div className="text-xl font-bold text-slate-900">RM {Number(currentBalance ?? 0).toFixed(2)}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Upload Statement (PDF)</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            {...dropHandlers()}
            className={cn(
              "border-2 border-dashed rounded-lg p-6 text-center transition-colors",
              dragOver ? "border-emerald-400 bg-emerald-50" : "border-slate-200 bg-white"
            )}
          >
            <div className="text-sm text-slate-700 font-medium">Drag & drop your PDF here</div>
            <div className="text-xs text-slate-500 mt-1">or choose a file</div>

            <div className="mt-4 flex items-center justify-center gap-3 flex-wrap">
              <Input
                type="file"
                accept="application/pdf"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (f && f.type !== "application/pdf") {
                    toast({ title: "Only PDF is supported", variant: "destructive" as any });
                    setFile(null);
                    return;
                  }
                  setFile(f);
                }}
                className="max-w-[360px]"
                disabled={isBusy}
              />
              <Button
                onClick={() => file && parseMutation.mutate(file)}
                disabled={!file || isBusy || bankAccountId == null}
              >
                {parseMutation.isPending ? "AI Parsing..." : "Upload & Parse (AI)"}
              </Button>
            </div>
            {file ? (
              <div className="text-xs text-slate-500 mt-3">Selected: {file.name}</div>
            ) : null}
            {parseMutation.isPending ? (
              <div className="mt-3 text-sm text-slate-700 font-medium">
                Analyzing Bank Statement via AI...
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={assignOpen}
        onOpenChange={(v) => {
          setAssignOpen(v);
          if (!v) {
            setAssignTx(null);
            setCaseQuery("");
            setCaseResults([]);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Search & Assign Case</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="text-xs text-slate-500">
              Transaction: {assignTx?.description ?? ""}
            </div>
            <div className="flex items-center gap-2">
              <Input value={caseQuery} onChange={(e) => setCaseQuery(e.target.value)} placeholder="Search by reference no / client name" />
              <Button onClick={() => caseSearchMutation.mutate()} disabled={!caseQuery.trim() || caseSearchMutation.isPending}>
                {caseSearchMutation.isPending ? "Searching..." : "Search"}
              </Button>
            </div>

            <div className="border rounded-md overflow-hidden">
              {caseResults.length === 0 ? (
                <div className="text-sm text-slate-500 py-4 text-center">No results.</div>
              ) : (
                <div className="max-h-[320px] overflow-auto">
                  {caseResults.map((c) => (
                    <button
                      key={c.case_id}
                      type="button"
                      className="w-full text-left px-3 py-2 border-b last:border-b-0 hover:bg-slate-50 disabled:opacity-60"
                      disabled={!assignTx || bindMutation.isPending}
                      onClick={() => assignTx && bindMutation.mutate({ txId: assignTx.id, caseId: c.case_id })}
                    >
                      <div className="text-sm font-medium text-slate-900">{c.title}</div>
                      <div className="text-xs text-slate-500">Case #{c.case_id}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)} disabled={bindMutation.isPending}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Bank Transactions</CardTitle>
        </CardHeader>
        <CardContent>
          {txQuery.isError ? (
            <div className="text-sm text-red-600">Failed to load transactions.</div>
          ) : null}
          {txQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-6 text-center">Loading...</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-slate-500 py-6 text-center">No transactions yet.</div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr className="text-left text-slate-600">
                    <th className="py-3 px-3 font-medium">Date</th>
                    <th className="py-3 px-3 font-medium">Description</th>
                    <th className="py-3 px-3 font-medium">Ref No</th>
                    <th className="py-3 px-3 font-medium text-right">Withdrawal</th>
                    <th className="py-3 px-3 font-medium text-right">Deposit</th>
                    <th className="py-3 px-3 font-medium text-right">Balance</th>
                    <th className="py-3 px-3 font-medium">Case Assignment</th>
                    <th className="py-3 px-3 font-medium">Exported</th>
                    <th className="py-3 px-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const isEditing = editingId === r.id;
                    return (
                      <tr key={r.id} className="border-b border-slate-100 align-top">
                        <td className="py-2 px-3 whitespace-nowrap">
                          {isEditing ? (
                            <Input value={draft.transactionDate ?? ""} onChange={(e) => setDraft((p) => ({ ...p, transactionDate: e.target.value }))} className="h-8 w-[140px]" />
                          ) : (
                            r.transaction_date
                          )}
                        </td>
                        <td className="py-2 px-3 min-w-[280px]">
                          {isEditing ? (
                            <Input value={draft.description ?? ""} onChange={(e) => setDraft((p) => ({ ...p, description: e.target.value }))} className="h-8" />
                          ) : (
                            r.description
                          )}
                        </td>
                        <td className="py-2 px-3">
                          {isEditing ? (
                            <Input value={draft.referenceNo ?? ""} onChange={(e) => setDraft((p) => ({ ...p, referenceNo: e.target.value }))} className="h-8 w-[160px]" />
                          ) : (
                            r.reference_no ?? ""
                          )}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {isEditing ? (
                            <Input value={draft.withdrawal ?? ""} onChange={(e) => setDraft((p) => ({ ...p, withdrawal: e.target.value }))} className="h-8 w-[120px] text-right" />
                          ) : (
                            r.withdrawal == null ? "" : Number(r.withdrawal).toFixed(2)
                          )}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {isEditing ? (
                            <Input value={draft.deposit ?? ""} onChange={(e) => setDraft((p) => ({ ...p, deposit: e.target.value }))} className="h-8 w-[120px] text-right" />
                          ) : (
                            r.deposit == null ? "" : Number(r.deposit).toFixed(2)
                          )}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {isEditing ? (
                            <Input value={draft.balance ?? ""} onChange={(e) => setDraft((p) => ({ ...p, balance: e.target.value }))} className="h-8 w-[120px] text-right" />
                          ) : (
                            r.balance == null ? "" : Number(r.balance).toFixed(2)
                          )}
                        </td>
                        <td className="py-2 px-3 min-w-[260px]">
                          {r.case ? (
                            <div>
                              <div className="text-sm font-medium text-emerald-700">✓ {r.case.title}</div>
                              <div className="text-xs text-slate-500">Case #{r.case.case_id}</div>
                            </div>
                          ) : r.recommended_case ? (
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <div className="text-sm font-medium text-slate-900">{r.recommended_case.title}</div>
                                <div className="text-xs text-amber-700 mt-0.5 inline-flex items-center gap-1">
                                  <span className="px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200">Auto-Match</span>
                                </div>
                                <div className="text-[11px] text-slate-500 mt-1">{r.recommended_case.match_reason}</div>
                              </div>
                              <Button
                                size="sm"
                                className="bg-emerald-600 hover:bg-emerald-700"
                                disabled={isBusy || bindMutation.isPending}
                                onClick={() => bindMutation.mutate({ txId: r.id, caseId: r.recommended_case!.case_id })}
                              >
                                Approve ✓
                              </Button>
                            </div>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isBusy || bindMutation.isPending}
                              onClick={() => {
                                setAssignTx(r);
                                setAssignOpen(true);
                                setCaseQuery("");
                                setCaseResults([]);
                              }}
                            >
                              Search & Assign
                            </Button>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          <span className={cn("text-xs px-2 py-0.5 rounded-full", r.is_exported ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600")}>
                            {r.is_exported ? "Yes" : "No"}
                          </span>
                        </td>
                        <td className="py-2 px-3">
                          {isEditing ? (
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                disabled={isBusy}
                                onClick={() => updateMutation.mutate({
                                  id: r.id,
                                  patch: {
                                    transactionDate: draft.transactionDate,
                                    description: draft.description,
                                    referenceNo: draft.referenceNo.trim() ? draft.referenceNo : null,
                                    withdrawal: toNumberOrNull(draft.withdrawal),
                                    deposit: toNumberOrNull(draft.deposit),
                                    balance: toNumberOrNull(draft.balance),
                                  },
                                })}
                              >
                                Save
                              </Button>
                              <Button variant="outline" size="sm" disabled={isBusy} onClick={() => { setEditingId(null); setDraft({}); }}>
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <Button variant="outline" size="sm" onClick={() => beginEdit(r)} disabled={isBusy}>
                              Edit
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {editingRow ? (
            <div className="text-xs text-slate-500 mt-3">
              Editing: {editingRow.description}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
