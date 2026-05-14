import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DateOnlyInput, normalizeDateOnlyFromApi } from "@/components/date-only-input";
import { apiFetchJson } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { cn } from "@/lib/utils";

type BankAccountRow = {
  id: number;
  bank_name: string;
  account_name: string | null;
  account_no: string;
  account_type: string;
  autocount_gl_code: string | null;
  opening_balance: string | number | null;
  opening_balance_date: string | null;
  is_default: boolean;
};

type ListBankAccountsResponse = { data: BankAccountRow[] };

function fmtMoney(v: unknown) {
  return `RM ${Number(v ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parseMoney(v: string): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export default function BankAccountsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<BankAccountRow | null>(null);

  const [accountName, setAccountName] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNo, setAccountNo] = useState("");
  const [accountType, setAccountType] = useState("office");
  const [autocountGlCode, setAutocountGlCode] = useState("");
  const [openingBalance, setOpeningBalance] = useState("0");
  const [openingBalanceDate, setOpeningBalanceDate] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(false);

  const listQuery = useQuery<ListBankAccountsResponse>({
    queryKey: ["bank-accounts"],
    queryFn: ({ signal }) => apiFetchJson("/accounting/bank-accounts", { signal }),
    retry: false,
  });

  const rows = Array.isArray(listQuery.data?.data) ? listQuery.data!.data : [];

  const upsertMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        accountName: accountName.trim() || null,
        bankName: bankName.trim(),
        accountNo: accountNo.trim(),
        accountType,
        autocountGlCode: autocountGlCode.trim() || null,
        openingBalance: parseMoney(openingBalance) ?? 0,
        openingBalanceDate,
        isDefault,
      };
      if (editing) {
        return await apiFetchJson(`/accounting/bank-accounts/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      }
      return await apiFetchJson("/accounting/bank-accounts", { method: "POST", body: JSON.stringify(payload) });
    },
    onSuccess: async () => {
      toast({ title: "Saved" });
      setOpen(false);
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ["bank-accounts"] });
    },
    onError: (e) => toastError(toast, e, "Save failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiFetchJson(`/accounting/bank-accounts/${id}`, { method: "DELETE" });
    },
    onSuccess: async () => {
      toast({ title: "Deleted" });
      await qc.invalidateQueries({ queryKey: ["bank-accounts"] });
    },
    onError: (e) => toastError(toast, e, "Delete failed"),
  });

  const isBusy = upsertMutation.isPending || deleteMutation.isPending;

  function resetForm(next?: BankAccountRow | null) {
    const r = next ?? null;
    setEditing(r);
    setAccountName(r?.account_name ?? "");
    setBankName(r?.bank_name ?? "");
    setAccountNo(r?.account_no ?? "");
    setAccountType(r?.account_type ?? "office");
    setAutocountGlCode(r?.autocount_gl_code ?? "");
    setOpeningBalance(String(r?.opening_balance ?? 0));
    setOpeningBalanceDate(r?.opening_balance_date ? normalizeDateOnlyFromApi(r.opening_balance_date) : null);
    setIsDefault(Boolean(r?.is_default ?? false));
  }

  const balanceHint = useMemo(() => {
    const v = parseMoney(openingBalance);
    return v == null ? "" : fmtMoney(v);
  }, [openingBalance]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Bank Accounts</h2>
          <p className="text-sm text-slate-500 mt-1">Configure opening balance and AutoCount GL code per account.</p>
        </div>
        <Button onClick={() => { resetForm(null); setOpen(true); }} disabled={isBusy}>
          New Account
        </Button>
      </div>

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditing(null); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Bank Account" : "New Bank Account"}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Account Name</Label>
              <Input value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="Maybank Client Account" />
            </div>
            <div className="space-y-1.5">
              <Label>Bank Name</Label>
              <Input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Maybank" />
            </div>
            <div className="space-y-1.5">
              <Label>Account Number</Label>
              <Input value={accountNo} onChange={(e) => setAccountNo(e.target.value)} placeholder="1234567890" />
            </div>
            <div className="space-y-1.5">
              <Label>Account Type</Label>
              <Select value={accountType} onValueChange={setAccountType}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="office">office</SelectItem>
                  <SelectItem value="client">client</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>AutoCount GL Code</Label>
              <Input value={autocountGlCode} onChange={(e) => setAutocountGlCode(e.target.value)} placeholder="GL-1000" />
            </div>
            <div className="space-y-1.5">
              <Label>Opening Balance</Label>
              <Input value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} placeholder="0.00" />
              {balanceHint ? <div className="text-[11px] text-slate-500">{balanceHint}</div> : null}
            </div>
            <div className="space-y-1.5">
              <Label>Opening Balance Date</Label>
              <DateOnlyInput value={openingBalanceDate} onChange={setOpeningBalanceDate} />
            </div>
            <div className="space-y-1.5">
              <Label>Default</Label>
              <Select value={isDefault ? "yes" : "no"} onValueChange={(v) => setIsDefault(v === "yes")}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="no">No</SelectItem>
                  <SelectItem value="yes">Yes</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isBusy}>Cancel</Button>
            <Button onClick={() => upsertMutation.mutate()} disabled={isBusy || !bankName.trim() || !accountNo.trim() || !openingBalanceDate}>
              {upsertMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {listQuery.isError ? <div className="text-sm text-red-600">Failed to load bank accounts.</div> : null}
          {listQuery.isLoading ? (
            <div className="text-sm text-slate-500 py-6 text-center">Loading...</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-slate-500 py-6 text-center">No bank accounts yet.</div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr className="text-left text-slate-600">
                    <th className="py-3 px-3 font-medium">Name</th>
                    <th className="py-3 px-3 font-medium">Account No</th>
                    <th className="py-3 px-3 font-medium">Type</th>
                    <th className="py-3 px-3 font-medium">GL Code</th>
                    <th className="py-3 px-3 font-medium text-right">Opening Balance</th>
                    <th className="py-3 px-3 font-medium">Opening Date</th>
                    <th className="py-3 px-3 font-medium">Default</th>
                    <th className="py-3 px-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-slate-100">
                      <td className="py-2 px-3">
                        <div className="font-medium text-slate-900">{r.account_name || r.bank_name}</div>
                        <div className="text-xs text-slate-400">{r.bank_name}</div>
                      </td>
                      <td className="py-2 px-3 font-mono text-xs">{r.account_no}</td>
                      <td className="py-2 px-3">
                        <span className={cn("text-xs px-2 py-0.5 rounded-full", r.account_type === "client" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600")}>
                          {r.account_type}
                        </span>
                      </td>
                      <td className="py-2 px-3 font-mono text-xs">{r.autocount_gl_code ?? ""}</td>
                      <td className="py-2 px-3 text-right font-mono text-xs">{fmtMoney(r.opening_balance ?? 0)}</td>
                      <td className="py-2 px-3 text-xs">{r.opening_balance_date ?? ""}</td>
                      <td className="py-2 px-3 text-xs">{r.is_default ? "Yes" : "No"}</td>
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2">
                          <Button variant="outline" size="sm" disabled={isBusy} onClick={() => { resetForm(r); setOpen(true); }}>
                            Edit
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={isBusy}
                            onClick={() => deleteMutation.mutate(r.id)}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
