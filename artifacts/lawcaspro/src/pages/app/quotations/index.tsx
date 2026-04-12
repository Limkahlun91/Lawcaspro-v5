import { useListQuotations, getListQuotationsQueryKey, useDeleteQuotation, useDuplicateQuotation } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link, useLocation } from "wouter";
import { Plus, FileText, Copy, Trash2, Eye } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { QueryFallback } from "@/components/query-fallback";
import { formatCurrencyMYR, formatDateMY } from "@/lib/format";
import { toastError } from "@/lib/toast-error";

export default function QuotationsList() {
  const { data: quotations, isLoading, isError, error, refetch, isFetching } = useListQuotations();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const deleteMutation = useDeleteQuotation();
  const duplicateMutation = useDuplicateQuotation();

  const handleDelete = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this quotation?")) return;
    deleteMutation.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListQuotationsQueryKey() });
          toast({ title: "Quotation deleted" });
        },
        onError: (err) => toastError(toast, err, "Delete failed"),
      }
    );
  };

  const handleDuplicate = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    duplicateMutation.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListQuotationsQueryKey() });
          toast({ title: "Quotation duplicated" });
        },
        onError: (err) => toastError(toast, err, "Duplicate failed"),
      }
    );
  };

  const statusColors: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    sent: "bg-blue-100 text-blue-700",
    accepted: "bg-green-100 text-green-700",
    rejected: "bg-red-100 text-red-700",
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Quotations</h1>
          <p className="text-sm text-slate-500 mt-1">Manage fee quotations for legal services</p>
        </div>
        <Link href="/app/quotations/new">
          <Button className="bg-amber-500 hover:bg-amber-600 text-white">
            <Plus className="w-4 h-4 mr-2" />
            New Quotation
          </Button>
        </Link>
      </div>

      {isLoading ? (
        <div className="text-sm text-slate-500">Loading quotations...</div>
      ) : isError ? (
        <QueryFallback title="Quotations unavailable" error={error} onRetry={() => refetch()} isRetrying={isFetching} />
      ) : !quotations || quotations.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="w-12 h-12 mx-auto text-slate-300 mb-4" />
            <p className="text-slate-500 text-sm">No quotations yet</p>
            <p className="text-slate-400 text-xs mt-1">Create your first quotation to get started</p>
          </CardContent>
        </Card>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="text-left px-4 py-3 font-medium text-slate-600">Reference</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Client</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Property</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">Total (incl. ST)</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Date</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {quotations.map((q) => (
                <tr
                  key={q.id}
                  className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                  onClick={() => setLocation(`/app/quotations/${q.id}`)}
                >
                  <td className="px-4 py-3 font-medium text-slate-900">{q.referenceNo}</td>
                  <td className="px-4 py-3 text-slate-600">{q.clientName}</td>
                  <td className="px-4 py-3 text-slate-500 max-w-[200px] truncate">
                    {q.propertyDescription || "-"}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-900">
                    {formatCurrencyMYR(q.totalInclTax)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium capitalize ${statusColors[q.status] || statusColors.draft}`}>
                      {q.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {formatDateMY(q.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); setLocation(`/app/quotations/${q.id}`); }}
                        title="View"
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => handleDuplicate(q.id, e)}
                        title="Duplicate"
                        disabled={duplicateMutation.isPending || deleteMutation.isPending}
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => handleDelete(q.id, e)}
                        title="Delete"
                        className="text-red-500 hover:text-red-700"
                        disabled={deleteMutation.isPending || duplicateMutation.isPending}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
