import { useMemo, useState, useEffect, useCallback, type ChangeEvent } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  Search,
  RefreshCw,
  Plus,
  ChevronLeft,
  ChevronRight,
  Filter,
  AlertTriangle,
  Clock,
  Folder,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { QueryFallback } from "@/components/query-fallback";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import {
  FILE_CUSTODY_QUERY_KEYS,
  type FileCustodyItem,
  type FileCustodyStatus,
  listFileCustodyItems,
  getFileCustodyItem,
  listFileCustodyPartners,
  listFirmUsers,
  type FirmUser,
  type PartnerUser,
  isVersionConflict,
} from "@/lib/file-custody-api";
import { FileCustodyDetailSheet } from "./FileCustodyDetailSheet";

const STATUS_OPTIONS: Array<{ value: FileCustodyStatus | "all"; label: string }> = [
  { value: "all", label: "All Statuses" },
  { value: "in_office", label: "In Office" },
  { value: "out_on_loan", label: "Out On Loan" },
  { value: "out_with_counsel", label: "Out With Counsel" },
  { value: "out_with_client", label: "Out With Client" },
  { value: "out_external", label: "Out External" },
  { value: "return_pending", label: "Return Pending" },
  { value: "returned", label: "Returned" },
  { value: "archived", label: "Archived" },
  { value: "lost", label: "Lost" },
];

function statusBadgeVariant(status: FileCustodyStatus): "default" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "in_office":
      return "default";
    case "returned":
      return "secondary";
    case "archived":
      return "outline";
    case "lost":
      return "destructive";
    case "return_pending":
      return "secondary";
    case "out_on_loan":
    case "out_with_counsel":
    case "out_with_client":
    case "out_external":
      return "outline";
    default:
      return "outline";
  }
}

function formatStatus(status: FileCustodyStatus): string {
  const map: Record<FileCustodyStatus, string> = {
    in_office: "In Office",
    out_on_loan: "Out On Loan",
    out_with_counsel: "Out With Counsel",
    out_with_client: "Out With Client",
    out_external: "Out External",
    return_pending: "Return Pending",
    returned: "Returned",
    archived: "Archived",
    lost: "Lost",
  };
  return map[status] ?? status;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-MY", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

export default function FileCustodyPage() {
  const [location, setLocation] = useLocation();
  const searchString = typeof window !== "undefined"
    ? window.location.search
    : location.includes("?")
      ? location.slice(location.indexOf("?"))
      : "";
  const sp = useMemo(() => new URLSearchParams(searchString.startsWith("?") ? searchString.slice(1) : searchString), [searchString]);
  const currentQs = sp.toString();

  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const canView = hasPermission(user, "file_custody", "view");
  const canRelease = hasPermission(user, "file_custody", "release");
  const canReceive = hasPermission(user, "file_custody", "receive");
  const canReturn = hasPermission(user, "file_custody", "return");
  const canManage = hasPermission(user, "file_custody", "manage");

  const initialPage = sp.get("offset") ? Math.floor(Number(sp.get("offset")) / Math.max(1, Number(sp.get("limit") ?? 50))) + 1 : 1;
  const initialLimit = sp.get("limit") ? Number(sp.get("limit")) : 50;
  const initialSearch = sp.get("q") ?? "";
  const initialStatus = (sp.get("lifecycle_status") as FileCustodyStatus | "all") ?? "all";
  const initialHolder = sp.get("current_holder_user_id") ?? "all";
  const initialCaseRef = sp.get("case_ref") ?? "";

  const [page, setPage] = useState<number>(() => Number.isInteger(initialPage) && initialPage > 0 ? initialPage : 1);
  const [limit, setLimit] = useState<number>(() => Number.isInteger(initialLimit) && initialLimit > 0 ? initialLimit : 50);
  const [search, setSearch] = useState<string>(initialSearch);
  const [status, setStatus] = useState<FileCustodyStatus | "all">(initialStatus);
  const [holderId, setHolderId] = useState<string>(initialHolder);
  const [caseRefSearch, setCaseRefSearch] = useState<string>(initialCaseRef);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState<boolean>(false);
  const [versionConflictAlert, setVersionConflictAlert] = useState<boolean>(false);

  useEffect(() => {
    const nextSp = new URLSearchParams();
    const offset = (page - 1) * limit;
    if (offset > 0) nextSp.set("offset", String(offset));
    if (limit !== 50) nextSp.set("limit", String(limit));
    if (search.trim()) nextSp.set("q", search.trim());
    if (status !== "all") nextSp.set("lifecycle_status", status);
    if (holderId !== "all") nextSp.set("current_holder_user_id", holderId);
    const nextQs = nextSp.toString();
    if (nextQs !== currentQs) {
      setLocation(`/app/file-custody${nextQs ? `?${nextQs}` : ""}`);
    }
  }, [page, limit, search, status, holderId, caseRefSearch, currentQs, setLocation]);

  const offset = (page - 1) * limit;

  const usersQuery = useQuery<{ users: FirmUser[] }>({
    queryKey: ["firm-users", "active"],
    queryFn: listFirmUsers,
    enabled: canView,
    staleTime: 60_000,
    retry: false,
  });

  const partnersQuery = useQuery<{ partners: PartnerUser[] }>({
    queryKey: FILE_CUSTODY_QUERY_KEYS.partners,
    queryFn: listFileCustodyPartners,
    enabled: canView && canManage,
    staleTime: 60_000,
    retry: false,
  });

  const listQueryParams = useMemo(() => {
    const params: Record<string, unknown> = { offset, limit };
    if (search.trim()) params.q = search.trim();
    if (status !== "all") params.lifecycle_status = status;
    if (holderId !== "all") params.current_holder_user_id = Number(holderId);
    return params;
  }, [offset, limit, search, status, holderId]);

  const listQuery = useQuery({
    queryKey: FILE_CUSTODY_QUERY_KEYS.list(listQueryParams),
    queryFn: () => listFileCustodyItems(listQueryParams as any),
    enabled: canView,
    staleTime: 15_000,
    retry: false,
    placeholderData: (prev) => prev,
  });

  const filteredItems = useMemo(() => {
    const items = listQuery.data?.items ?? [];
    if (!caseRefSearch.trim()) return items;
    const needle = caseRefSearch.trim().toLowerCase();
    return items.filter((it: FileCustodyItem) => {
      const caseId = it.caseId ? String(it.caseId) : "";
      return caseId.includes(needle) || String(it.matterLabel ?? "").toLowerCase().includes(needle);
    });
  }, [listQuery.data?.items, caseRefSearch]);

  const totalPages = Math.max(1, Math.ceil((listQuery.data?.total ?? 0) / limit));

  const refreshAll = useCallback(() => {
    setVersionConflictAlert(false);
    void queryClient.invalidateQueries({ queryKey: FILE_CUSTODY_QUERY_KEYS.all });
  }, [queryClient]);

  const handleSelectItem = useCallback((item: FileCustodyItem) => {
    setSelectedItemId(item.id);
    setDetailOpen(true);
    setVersionConflictAlert(false);
  }, []);

  if (!canView) {
    return (
      <div className="p-8">
        <QueryFallback
          title="Access denied"
          error={new Error("Missing permission: file_custody:view")}
        />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Folder className="w-6 h-6 text-blue-600" />
            File Custody
          </h1>
          <p className="text-slate-500 mt-1 text-sm">
            Track physical and digital file movements, acknowledgements, and returns.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={refreshAll} disabled={listQuery.isFetching}>
            <RefreshCw className={`w-4 h-4 mr-2 ${listQuery.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          {canManage && (
            <Button
              onClick={() => {
                toast({ title: "Tip", description: "Use the Register action in item detail for now." });
              }}
            >
              <Plus className="w-4 h-4 mr-2" />
              Register File
            </Button>
          )}
        </div>
      </div>

      {versionConflictAlert && (
        <Alert variant="destructive">
          <AlertTriangle className="w-4 h-4 mr-2" />
          <AlertTitle>Stale data detected</AlertTitle>
          <AlertDescription className="flex items-center gap-2">
            <span>One or more items were modified by another user. List has been refreshed.</span>
            <Button variant="outline" size="sm" onClick={() => setVersionConflictAlert(false)}>
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col lg:flex-row gap-3 lg:items-end">
            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-600">File Reference / Title</label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    className="pl-9"
                    placeholder="Search ref or title..."
                    value={search}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-600">Case / Matter</label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    className="pl-9"
                    placeholder="Case ID or label..."
                    value={caseRefSearch}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setCaseRefSearch(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-600">Status</label>
                <Select value={status} onValueChange={(v: string) => { setStatus(v as any); setPage(1); }}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-600">Current Holder</label>
                <Select value={holderId} onValueChange={(v: string) => { setHolderId(v); setPage(1); }}>
                  <SelectTrigger>
                    <SelectValue placeholder="All holders" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All holders</SelectItem>
                    {(usersQuery.data?.users ?? []).map((u) => (
                      <SelectItem key={u.id} value={String(u.id)}>
                        {u.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {listQuery.isError && !listQuery.data ? (
            <div className="py-10">
              <QueryFallback
                title="Failed to load file custody"
                error={listQuery.error}
                onRetry={() => listQuery.refetch()}
                isRetrying={listQuery.isFetching}
              />
            </div>
          ) : listQuery.isLoading && !listQuery.data ? (
            <div className="space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 py-3">
                  <Skeleton className="h-6 w-40" />
                  <Skeleton className="h-6 w-32" />
                  <Skeleton className="h-6 flex-1" />
                  <Skeleton className="h-6 w-32" />
                  <Skeleton className="h-6 w-28" />
                  <Skeleton className="h-6 w-40" />
                </div>
              ))}
            </div>
          ) : filteredItems.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileText />
                </EmptyMedia>
                <EmptyTitle>No file custody items</EmptyTitle>
                <EmptyDescription>
                  {listQuery.data?.total
                    ? "No items match the current filters. Try adjusting search or filters."
                    : "Register a file to get started tracking its movements."}
                </EmptyDescription>
              </EmptyHeader>
              {canManage && (
                <EmptyContent>
                  <Button
                    onClick={() => toast({ title: "Tip", description: "Use Register File from a case detail or settings." })}
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Register File
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          ) : (
            <>
              <div className="rounded-md border border-slate-200 overflow-hidden">
                <Table>
                  <TableHeader className="bg-slate-50">
                    <TableRow>
                      <TableHead className="w-[180px]">File Reference</TableHead>
                      <TableHead className="w-[140px]">Case</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="w-[160px]">Current Holder</TableHead>
                      <TableHead className="w-[130px]">Status</TableHead>
                      <TableHead className="w-[160px]">Released By</TableHead>
                      <TableHead className="w-[170px]">Released At</TableHead>
                      <TableHead className="w-[160px]">Released To</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredItems.map((item: FileCustodyItem) => (
                      <TableRow
                        key={item.id}
                        className="cursor-pointer hover:bg-blue-50/50"
                        onClick={() => handleSelectItem(item)}
                      >
                        <TableCell className="font-medium">
                          <div className="flex flex-col">
                            <span className="text-blue-700 hover:underline">
                              {item.fileReferenceNo}
                            </span>
                            {item.isReturnOverdue && (
                              <Badge variant="destructive" className="mt-1 w-fit text-[10px]">
                                <Clock className="w-3 h-3 mr-1" /> Overdue
                              </Badge>
                            )}
                            {!item.isReturnOverdue && item.isAcknowledgementOverdue && (
                              <Badge variant="outline" className="mt-1 w-fit text-[10px] border-orange-300 text-orange-700 bg-orange-50">
                                <AlertTriangle className="w-3 h-3 mr-1" /> Ack Overdue
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            {item.caseId ? (
                              <Link
                                href={`/app/cases/${item.caseId}`}
                                onClick={(e) => e.stopPropagation()}
                                className="text-blue-700 hover:underline"
                              >
                                Case #{item.caseId}
                              </Link>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                            {item.matterLabel && (
                              <div className="text-xs text-slate-500 mt-0.5 truncate max-w-[160px]">
                                {item.matterLabel}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm max-w-md">
                            <div className="font-medium text-slate-800 truncate">
                              {item.fileTitle}
                            </div>
                            {item.fileDescription && (
                              <div className="text-xs text-slate-500 mt-0.5 line-clamp-2">
                                {item.fileDescription}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            <div className="font-medium text-slate-800">
                              {item.holderName ?? item.currentHolderName ?? "—"}
                            </div>
                            {(item.currentHolderFirmExternal || item.currentHolderContact) && (
                              <div className="text-xs text-slate-500 truncate max-w-[180px]">
                                {item.currentHolderFirmExternal ?? item.currentHolderContact}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusBadgeVariant(item.lifecycleStatus)}>
                            {formatStatus(item.lifecycleStatus)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-slate-600">—</TableCell>
                        <TableCell className="text-sm text-slate-600">
                          {formatDateTime(item.updatedAt)}
                        </TableCell>
                        <TableCell className="text-sm text-slate-600">
                          {item.currentHolderName || item.holderName ? (
                            <span>{item.currentHolderName ?? item.holderName}</span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex items-center justify-between mt-4 flex-wrap gap-3">
                <div className="text-sm text-slate-500">
                  Showing{" "}
                  <span className="font-medium text-slate-700">
                    {filteredItems.length}
                  </span>{" "}
                  of{" "}
                  <span className="font-medium text-slate-700">
                    {listQuery.data?.total ?? 0}
                  </span>{" "}
                  items
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    value={String(limit)}
                    onValueChange={(v: string) => {
                      setLimit(Number(v));
                      setPage(1);
                    }}
                  >
                    <SelectTrigger className="w-[120px] h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="20">20 / page</SelectItem>
                      <SelectItem value="50">50 / page</SelectItem>
                      <SelectItem value="100">100 / page</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1 || listQuery.isFetching}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <div className="px-3 text-sm text-slate-600 min-w-[80px] text-center">
                      Page {page} / {totalPages}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages || listQuery.isFetching}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {selectedItemId != null && (
        <FileCustodyDetailSheet
          itemId={selectedItemId}
          open={detailOpen}
          onOpenChange={(open) => {
            setDetailOpen(open);
            if (!open) setSelectedItemId(null);
          }}
          canRelease={canRelease}
          canReceive={canReceive}
          canReturn={canReturn}
          canManage={canManage}
          partners={partnersQuery.data?.partners ?? []}
          firmUsers={usersQuery.data?.users ?? []}
          onVersionConflict={async () => {
            setVersionConflictAlert(true);
            await queryClient.invalidateQueries({ queryKey: FILE_CUSTODY_QUERY_KEYS.all });
          }}
          onActionSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: FILE_CUSTODY_QUERY_KEYS.all });
          }}
        />
      )}
    </div>
  );
}
