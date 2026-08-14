import { useEffect, useMemo, useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileText, User, UserCheck, BadgeCheck, ExternalLink, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatRMAmount } from "@/lib/money";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";

type PVItem = {
  id: number;
  description: string;
  amount: number | string;
  sortOrder?: number;
};

type PVDetail = {
  id: number;
  firmId: number;
  caseId?: number | null;
  targetCaseId?: number | null;
  voucherType?: string;
  voucherNo: string;
  status?: string;
  approvalStatus?: string;
  fundStatus?: string;
  isAdvance?: boolean;
  payeeName: string;
  payeeBank?: string | null;
  payeeAccountNo?: string | null;
  paymentMethod?: string | null;
  bankChequeRefNo?: string | null;
  amount: number | string;
  purpose: string;
  responsibleLawyerId?: number | null;
  approvingPartnerId?: number | null;
  quotationId?: number | null;
  quotationClaimWarning?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  paidAt?: string | null;
  items: PVItem[];
  caseReferenceNo?: string | null;
  clientNames?: string | null;
  targetCaseReferenceNo?: string | null;
  targetClientNames?: string | null;
  createdByName?: string | null;
  preparedByName?: string | null;
  lawyerApprovedByName?: string | null;
  partnerApprovedByName?: string | null;
  paidByName?: string | null;
};

type CaseSummary = {
  id: number;
  referenceNo?: string | null;
  projectName?: string | null;
  developerName?: string | null;
};

type LedgerEntry = {
  id: string;
  transactionDate: string;
  entryCategory: "office" | "client";
  entryType: string;
  description: string;
  amount: number;
  sourceType?: string | null;
  sourceId?: number | null;
};

type CaseLedgerResponse = {
  summary: {
    total_billed: number;
    total_received: number;
    outstanding_balance: number;
    trust_balance: number;
  };
  data: LedgerEntry[];
};

function fmt(val: unknown) {
  return formatRMAmount(val);
}

const PV_STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  pending_lawyer: "bg-amber-100 text-amber-700",
  pending_partner: "bg-indigo-100 text-indigo-700",
  approved: "bg-green-100 text-green-700",
  pending_accounts: "bg-sky-100 text-sky-700",
  paid: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-600",
  void: "bg-slate-200 text-slate-600",
};

const FUND_STATUS_LABELS: Record<string, string> = {
  request_advance: "Request Advance",
  client_paid: "Client Paid",
};

const VOUCHER_TYPE_LABELS: Record<string, string> = {
  external_payment: "External Payment",
  internal_transfer: "Internal Transfer (Client → Office)",
  file_to_file_transfer: "File-to-File Transfer",
};

export default function PaymentVoucherDetail() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const pvId = Number(id);

  const pvQuery = useQuery<PVDetail>({
    queryKey: ["payment-voucher", pvId],
    queryFn: ({ signal }) => apiFetchJson(`/payment-vouchers/${pvId}`, { signal }),
    enabled: Number.isFinite(pvId) && pvId > 0,
    retry: false,
  });

  const { data: pv, isLoading: pvLoading, isError: pvError, error: pvErrObj } = pvQuery;
  const caseId = pv?.caseId ? Number(pv.caseId) : NaN;

  const caseQuery = useQuery<CaseSummary>({
    queryKey: ["case-summary-for-pv", caseId],
    queryFn: async ({ signal }) => {
      const raw = await apiFetchJson(`/cases/${caseId}`, { signal });
      const d = (raw as any)?.data ?? raw;
      return {
        id: Number(d?.id ?? caseId),
        referenceNo: d?.referenceNo ?? null,
        projectName: d?.projectName ?? null,
        developerName: d?.developerName ?? null,
      };
    },
    enabled: Number.isFinite(caseId) && caseId > 0,
    retry: false,
    staleTime: 60_000,
  });

  const ledgerQuery = useQuery<CaseLedgerResponse>({
    queryKey: ["case-ledger-for-pv", caseId],
    queryFn: ({ signal }) => apiFetchJson(`/cases/${caseId}/ledger`, { signal }),
    enabled: Number.isFinite(caseId) && caseId > 0,
    retry: false,
  });

  const ledgerEntries = Array.isArray(ledgerQuery.data?.data) ? ledgerQuery.data!.data : [];
  const ledgerSummary = ledgerQuery.data?.summary ?? null;

  if (pvLoading) {
    return <div className="py-16 text-center text-slate-400">Loading payment voucher…</div>;
  }
  if (pvError) {
    return (
      <div className="py-10">
        <QueryFallback
          title="Payment Voucher unavailable"
          error={pvErrObj}
          onRetry={() => void pvQuery.refetch()}
          isRetrying={pvQuery.isFetching}
        />
      </div>
    );
  }
  if (!pv) {
    return <div className="py-16 text-center text-slate-400">Payment Voucher not found</div>;
  }

  const items = Array.isArray(pv.items) ? pv.items : [];
  const statusLabel = String(pv.status ?? "draft").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
  const fundLabel = pv.fundStatus ? FUND_STATUS_LABELS[String(pv.fundStatus)] ?? String(pv.fundStatus) : "—";
  const voucherTypeLabel = pv.voucherType ? VOUCHER_TYPE_LABELS[String(pv.voucherType)] ?? String(pv.voucherType) : "External Payment";

  const responsibleLawyerName = pv.lawyerApprovedByName ?? pv.preparedByName ?? null;
  const approvingPartnerName = pv.partnerApprovedByName ?? null;

  return (
    <div className="space-y-6 min-w-0">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between print:hidden">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/app/accounting?tab=payment-vouchers")} className="gap-1.5">
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-slate-900">Payment Voucher</h1>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <span className="font-mono text-slate-700 font-semibold">{pv.voucherNo}</span>
            <Badge className={cn("text-xs font-medium", PV_STATUS_COLORS[String(pv.status ?? "draft")] ?? "bg-slate-100 text-slate-600")}>
              {statusLabel}
            </Badge>
            <Badge variant="outline" className="text-xs">{voucherTypeLabel}</Badge>
            {pv.createdAt && <span className="text-sm text-slate-400">Created: {String(pv.createdAt).slice(0, 10)}</span>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="md:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="w-4 h-4 text-slate-500" /> Case Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!Number.isFinite(caseId) || caseId <= 0 ? (
              <div className="text-sm text-slate-500">No case linked to this payment voucher.</div>
            ) : caseQuery.isLoading ? (
              <div className="text-sm text-slate-400">Loading case…</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">Case Reference</div>
                  <Link href={`/app/cases/${caseId}`} className="text-sky-700 hover:underline font-medium font-mono">
                    {pv.caseReferenceNo ?? caseQuery.data?.referenceNo ?? `Case #${caseId}`}
                  </Link>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">Client</div>
                  <div className="font-medium text-slate-800">{pv.clientNames ?? "—"}</div>
                </div>
                <div className="sm:col-span-2">
                  <div className="text-xs text-slate-500 mb-0.5">Project / Developer</div>
                  <div className="text-slate-800">
                    {caseQuery.data?.projectName ? (
                      <>
                        <span className="font-medium">{String(caseQuery.data.projectName)}</span>
                        {caseQuery.data.developerName ? <span className="text-slate-500"> · {String(caseQuery.data.developerName)}</span> : null}
                      </>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </div>
                </div>
                {pv.voucherType === "file_to_file_transfer" && pv.targetCaseId ? (
                  <>
                    <div className="sm:col-span-2 pt-3 mt-1 border-t border-slate-100">
                      <div className="text-xs text-slate-500 mb-0.5">Transfer To (Target File)</div>
                      <div className="font-medium text-slate-800">
                        <Link href={`/app/cases/${Number(pv.targetCaseId)}`} className="text-sky-700 hover:underline font-mono">
                          {pv.targetCaseReferenceNo ?? `Case #${Number(pv.targetCaseId)}`}
                        </Link>
                        {pv.targetClientNames ? <span className="text-slate-500 ml-2">{String(pv.targetClientNames)}</span> : null}
                      </div>
                    </div>
                  </>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4 text-slate-500" /> PV Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between items-start gap-2">
              <span className="text-slate-500">Payee</span>
              <span className="font-medium text-slate-800 text-right">{pv.payeeName}</span>
            </div>
            <div className="flex justify-between items-start gap-2">
              <span className="text-slate-500">Fund Status</span>
              <span className="text-slate-800">{fundLabel}</span>
            </div>
            <div className="flex justify-between items-start gap-2">
              <span className="text-slate-500">Payment Method</span>
              <span className="text-slate-800 capitalize text-right">
                {String(pv.paymentMethod ?? "—").replace(/_/g, " ")}
              </span>
            </div>
            {pv.bankChequeRefNo ? (
              <div className="flex justify-between items-start gap-2">
                <span className="text-slate-500">Bank / Cheque Ref</span>
                <span className="text-slate-800 font-mono text-xs text-right">{String(pv.bankChequeRefNo)}</span>
              </div>
            ) : null}
            <div className="pt-3 mt-1 border-t border-slate-100">
              <div className="text-xs text-slate-500 mb-1">Voucher Total</div>
              <div className="text-xl font-bold text-slate-900 text-right">{fmt(pv.amount)}</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Purpose</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-700 whitespace-pre-wrap break-words">{pv.purpose}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Line Items</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr className="text-left text-slate-600">
                  <th className="py-3 px-4 font-medium w-16 text-center">#</th>
                  <th className="py-3 px-4 font-medium">Description</th>
                  <th className="py-3 px-4 font-medium text-right">Amount (RM)</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-8 text-center text-slate-500 text-sm">
                      No line items.
                    </td>
                  </tr>
                ) : (
                  items.map((it, idx) => (
                    <tr key={it.id ?? idx} className="border-t border-slate-100">
                      <td className="py-2.5 px-4 text-center text-slate-400 text-xs">{idx + 1}</td>
                      <td className="py-2.5 px-4 text-slate-800">{it.description}</td>
                      <td className="py-2.5 px-4 text-right font-mono text-xs font-medium text-slate-800">
                        {fmt(it.amount)}
                      </td>
                    </tr>
                  ))
                )}
                <tr className="border-t-2 border-slate-200 bg-slate-50">
                  <td colSpan={2} className="py-3 px-4 text-right font-semibold text-slate-800">Total</td>
                  <td className="py-3 px-4 text-right font-bold text-slate-900 font-mono">{fmt(pv.amount)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <User className="w-4 h-4 text-slate-500" /> Responsible Lawyer
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-slate-800 font-medium">
              {responsibleLawyerName ? String(responsibleLawyerName) : <span className="text-slate-400">—</span>}
            </div>
            {pv.lawyerApprovedByName ? (
              <div className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
                <UserCheck className="w-3.5 h-3.5" /> Verified / Approved
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BadgeCheck className="w-4 h-4 text-slate-500" /> Approving Partner
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-slate-800 font-medium">
              {approvingPartnerName ? String(approvingPartnerName) : <span className="text-slate-400">—</span>}
            </div>
            {pv.partnerApprovedByName ? (
              <div className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
                <UserCheck className="w-3.5 h-3.5" /> Partner Approved
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ExternalLink className="w-4 h-4 text-slate-500" /> Quotation
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pv.quotationId && Number(pv.quotationId) > 0 ? (
              <Link
                href={`/app/quotations/${Number(pv.quotationId)}`}
                className="text-sm text-sky-700 hover:underline font-medium inline-flex items-center gap-1.5"
              >
                View Quotation #{Number(pv.quotationId)}
                <ExternalLink className="w-3.5 h-3.5" />
              </Link>
            ) : (
              <div className="text-sm text-slate-500">No quotation linked.</div>
            )}
            {pv.quotationClaimWarning ? (
              <div className="mt-3 p-3 rounded-md border border-amber-200 bg-amber-50 text-xs text-amber-800 whitespace-pre-wrap">
                {String(pv.quotationClaimWarning)}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Case Ledger</h3>
          <p className="text-sm text-slate-500 mt-1">
            Ledger entries for this case. The matching Payment Voucher entry is highlighted.
          </p>
        </div>

        {!Number.isFinite(caseId) || caseId <= 0 ? (
          <Card>
            <CardContent className="pt-6 pb-6 text-sm text-slate-500 text-center">
              No case linked — ledger unavailable.
            </CardContent>
          </Card>
        ) : (
          <>
            {ledgerSummary ? (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-xs text-slate-500">Total Billed</div>
                    <div className="text-lg font-bold text-slate-900">{fmt(ledgerSummary.total_billed)}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-xs text-slate-500">Amount Paid</div>
                    <div className="text-lg font-bold text-slate-900">{fmt(ledgerSummary.total_received)}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-xs text-slate-500">Outstanding</div>
                    <div className={cn("text-lg font-bold", ledgerSummary.outstanding_balance > 0 ? "text-red-600" : "text-slate-900")}>
                      {fmt(ledgerSummary.outstanding_balance)}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-xs text-slate-500">Client Trust Balance</div>
                    <div className="text-lg font-bold text-slate-900">{fmt(ledgerSummary.trust_balance)}</div>
                  </CardContent>
                </Card>
              </div>
            ) : null}

            <Card>
              <CardContent className="p-0">
                {ledgerQuery.isLoading ? (
                  <div className="py-10 text-sm text-slate-500 text-center">Loading ledger…</div>
                ) : ledgerQuery.isError ? (
                  <div className="py-10 text-sm text-red-600 text-center">Failed to load case ledger.</div>
                ) : ledgerEntries.length === 0 ? (
                  <div className="py-10 text-sm text-slate-500 text-center">No ledger entries yet.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 border-b border-slate-200">
                        <tr className="text-left text-slate-600">
                          <th className="py-3 px-3 font-medium">Date</th>
                          <th className="py-3 px-3 font-medium">Type</th>
                          <th className="py-3 px-3 font-medium">Description</th>
                          <th className="py-3 px-3 font-medium text-right">Debit</th>
                          <th className="py-3 px-3 font-medium text-right">Credit</th>
                          <th className="py-3 px-3 font-medium">Source Reference</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ledgerEntries.map((e) => {
                          const isDebitSide =
                            e.entryType === "invoice_billed" ||
                            e.entryType === "disbursement_paid" ||
                            e.entryType === "trust_paid";
                          const amountVal = Number(e.amount ?? 0);
                          const absVal = Math.abs(amountVal);
                          const debit = isDebitSide ? absVal : 0;
                          const credit = isDebitSide ? 0 : absVal;
                          const isMatch =
                            String(e.sourceType ?? "") === "payment_voucher" &&
                            Number(e.sourceId) === pvId;
                          const kindLabel = (e.sourceType ?? e.entryType) as string;
                          let sourceRef = <span className="text-slate-400 text-xs">—</span>;
                          if (typeof e.sourceId === "number" && e.sourceId > 0) {
                            if (e.sourceType === "payment_voucher") {
                              sourceRef = (
                                <Link href={`/app/accounting/payment-vouchers/${e.sourceId}`} className="text-sky-700 hover:underline font-mono text-xs">
                                  PV #{e.sourceId}
                                </Link>
                              );
                            } else if (e.sourceType === "invoice") {
                              sourceRef = (
                                <Link href={`/app/accounting/invoices/${e.sourceId}`} className="text-sky-700 hover:underline font-mono text-xs">
                                  INV #{e.sourceId}
                                </Link>
                              );
                            } else if (e.sourceType === "receipt") {
                              sourceRef = (
                                <Link href={`/app/accounting/receipts/${e.sourceId}`} className="text-sky-700 hover:underline font-mono text-xs">
                                  RCP #{e.sourceId}
                                </Link>
                              );
                            } else if (e.sourceType === "quotation") {
                              sourceRef = (
                                <Link href={`/app/quotations/${e.sourceId}`} className="text-sky-700 hover:underline font-mono text-xs">
                                  QTN #{e.sourceId}
                                </Link>
                              );
                            } else {
                              sourceRef = <span className="font-mono text-xs text-slate-500">{kindLabel}#{e.sourceId}</span>;
                            }
                          }
                          return (
                            <tr
                              key={e.id}
                              className={cn(
                                "border-b border-slate-100",
                                isMatch ? "bg-amber-50 hover:bg-amber-100/50" : "hover:bg-slate-50",
                              )}
                            >
                              <td className={cn("py-2 px-3 whitespace-nowrap", isMatch && "font-medium text-slate-900")}>
                                {e.transactionDate}
                                {isMatch ? (
                                  <Badge className="ml-2 text-[10px] bg-amber-200 text-amber-900 border border-amber-300">This PV</Badge>
                                ) : null}
                              </td>
                              <td className="py-2 px-3 font-mono text-xs capitalize text-slate-700">
                                {String(e.entryType).replace(/_/g, " ")}
                              </td>
                              <td className={cn("py-2 px-3", isMatch && "font-medium text-slate-900")}>
                                {e.description}
                              </td>
                              <td className="py-2 px-3 text-right font-mono text-xs">
                                {debit > 0 ? fmt(debit) : <span className="text-slate-300">—</span>}
                              </td>
                              <td className="py-2 px-3 text-right font-mono text-xs">
                                {credit > 0 ? fmt(credit) : <span className="text-slate-300">—</span>}
                              </td>
                              <td className="py-2 px-3">{sourceRef}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
