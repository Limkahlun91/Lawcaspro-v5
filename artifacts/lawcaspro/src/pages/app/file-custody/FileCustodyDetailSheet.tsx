import { useState, useEffect, useMemo, useCallback, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw,
  Send,
  CheckCircle2,
  ArrowLeftRight,
  Undo2,
  Inbox,
  AlertTriangle,
  History,
  User,
  FileText,
  Clock,
  FolderGit,
  Info,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { QueryFallback } from "@/components/query-fallback";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { useAuth } from "@/lib/auth-context";
import {
  FILE_CUSTODY_QUERY_KEYS,
  type FileCustodyItem,
  type FileCustodyMovement,
  type FileCustodyStatus,
  type MovementKind,
  type PartnerUser,
  type FirmUser,
  getFileCustodyItem,
  releaseCustody,
  acknowledgeCustody,
  requestReturnCustody,
  returnCustody,
  receiveReturnCustody,
  escalateCustody,
  isVersionConflict,
} from "@/lib/file-custody-api";

const OUT_STATUSES: readonly FileCustodyStatus[] = [
  "out_on_loan",
  "out_with_counsel",
  "out_with_client",
  "out_external",
] as const;

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
    default:
      return "outline";
  }
}

function formatMovementKind(kind: MovementKind): string {
  const map: Record<MovementKind, string> = {
    release: "Released",
    acknowledge: "Acknowledged",
    return_request: "Return Requested",
    return: "Returned",
    receive_return: "Return Received",
    overdue_auto_flag: "Escalated",
    archived: "Archived",
    reinstated: "Reinstated",
  };
  return (map as Record<string, string>)[kind] ?? kind;
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

function kindIcon(kind: MovementKind) {
  switch (kind) {
    case "release":
      return <Send className="w-4 h-4 text-blue-600" />;
    case "acknowledge":
      return <CheckCircle2 className="w-4 h-4 text-emerald-600" />;
    case "return_request":
      return <ArrowLeftRight className="w-4 h-4 text-amber-600" />;
    case "return":
      return <Undo2 className="w-4 h-4 text-amber-600" />;
    case "receive_return":
      return <Inbox className="w-4 h-4 text-emerald-600" />;
    case "overdue_auto_flag":
      return <AlertTriangle className="w-4 h-4 text-rose-600" />;
    case "archived":
      return <FileText className="w-4 h-4 text-slate-500" />;
    case "reinstated":
      return <FolderGit className="w-4 h-4 text-blue-500" />;
    default:
      return <Info className="w-4 h-4 text-slate-400" />;
  }
}

type ActiveDialog =
  | { kind: "release" }
  | { kind: "acknowledge"; movementId: number }
  | { kind: "return_request" }
  | { kind: "return"; movementId: number }
  | { kind: "receive_return"; movementId: number }
  | { kind: "escalate"; movementId: number }
  | null;

export function FileCustodyDetailSheet(props: {
  itemId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canRelease: boolean;
  canReceive: boolean;
  canReturn: boolean;
  canManage: boolean;
  partners: PartnerUser[];
  firmUsers: FirmUser[];
  onVersionConflict: () => Promise<void> | void;
  onActionSuccess: () => void;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const myUserId = typeof (user as any)?.id === "number"
    ? (user as any).id
    : Number((user as any)?.id ?? 0);
  const roleName = String((user as any)?.roleName ?? "");
  const isPartnerOrManager =
    roleName.toLowerCase().includes("partner") ||
    roleName.toLowerCase().includes("manager");

  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null);
  const [staleAlertVisible, setStaleAlertVisible] = useState(false);
  const [staleRefetching, setStaleRefetching] = useState(false);
  const [retryAfterConflict, setRetryAfterConflict] = useState<ActiveDialog>(null);

  const detailQuery = useQuery({
    queryKey: FILE_CUSTODY_QUERY_KEYS.detail(props.itemId),
    queryFn: () => getFileCustodyItem(props.itemId),
    enabled: props.open && Number.isFinite(props.itemId) && props.itemId > 0,
    staleTime: 5_000,
    retry: false,
  });

  useEffect(() => {
    if (!props.open) {
      setActiveDialog(null);
      setStaleAlertVisible(false);
      setRetryAfterConflict(null);
    }
  }, [props.open, props.itemId]);

  const item = detailQuery.data?.item;
  const movements = detailQuery.data?.movements ?? [];

  const latestReleaseMovement = useMemo(() => {
    return movements.find((m: FileCustodyMovement) => m.movementKind === "release");
  }, [movements]);

  const latestReturnRequestMovement = useMemo(() => {
    return movements.find((m: FileCustodyMovement) => m.movementKind === "return_request");
  }, [movements]);

  const refreshDetail = useCallback(async () => {
    setStaleRefetching(true);
    try {
      await queryClient.invalidateQueries({
        queryKey: FILE_CUSTODY_QUERY_KEYS.detail(props.itemId),
      });
      await detailQuery.refetch();
    } finally {
      setStaleRefetching(false);
    }
  }, [queryClient, detailQuery, props.itemId]);

  const handleConflictThenRefresh = useCallback(
    async (nextDialog: ActiveDialog) => {
      setStaleAlertVisible(true);
      try {
        await props.onVersionConflict();
        await refreshDetail();
      } catch {
        // ignore
      }
      setRetryAfterConflict(nextDialog);
    },
    [props, refreshDetail],
  );

  const closeDialog = useCallback(() => {
    setActiveDialog(null);
  }, []);

  const onMutationError = useCallback(
    (err: unknown, fallbackDialog: ActiveDialog) => {
      if (isVersionConflict(err)) {
        closeDialog();
        void handleConflictThenRefresh(fallbackDialog);
        toast({
          title: "Item modified",
          description: "This file was updated by another user. Refreshing…",
          variant: "default",
        });
      } else {
        toastError(toast, err);
      }
    },
    [toast, handleConflictThenRefresh, closeDialog],
  );

  const releaseMutation = useMutation({
    mutationFn: releaseCustody,
    onSuccess: () => {
      toast({ title: "File released", variant: "default" });
      closeDialog();
      props.onActionSuccess();
      void refreshDetail();
    },
    onError: (err) => onMutationError(err, { kind: "release" }),
  });

  const acknowledgeMutation = useMutation({
    mutationFn: acknowledgeCustody,
    onSuccess: () => {
      toast({ title: "Receipt acknowledged", variant: "default" });
      closeDialog();
      props.onActionSuccess();
      void refreshDetail();
    },
    onError: (err) => {
      const mvId = activeDialog?.kind === "acknowledge" ? activeDialog.movementId : 0;
      onMutationError(err, mvId ? { kind: "acknowledge", movementId: mvId } : null);
    },
  });

  const returnRequestMutation = useMutation({
    mutationFn: requestReturnCustody,
    onSuccess: () => {
      toast({ title: "Return requested", variant: "default" });
      closeDialog();
      props.onActionSuccess();
      void refreshDetail();
    },
    onError: (err) => onMutationError(err, { kind: "return_request" }),
  });

  const returnMutation = useMutation({
    mutationFn: returnCustody,
    onSuccess: () => {
      toast({ title: "File returned", variant: "default" });
      closeDialog();
      props.onActionSuccess();
      void refreshDetail();
    },
    onError: (err) => {
      const mvId = activeDialog?.kind === "return" ? activeDialog.movementId : 0;
      onMutationError(err, mvId ? { kind: "return", movementId: mvId } : null);
    },
  });

  const receiveReturnMutation = useMutation({
    mutationFn: receiveReturnCustody,
    onSuccess: () => {
      toast({ title: "Return received", variant: "default" });
      closeDialog();
      props.onActionSuccess();
      void refreshDetail();
    },
    onError: (err) => {
      const mvId = activeDialog?.kind === "receive_return" ? activeDialog.movementId : 0;
      onMutationError(err, mvId ? { kind: "receive_return", movementId: mvId } : null);
    },
  });

  const escalateMutation = useMutation({
    mutationFn: escalateCustody,
    onSuccess: () => {
      toast({ title: "Escalated to partner(s)", variant: "default" });
      closeDialog();
      props.onActionSuccess();
      void refreshDetail();
    },
    onError: (err) => {
      const mvId = activeDialog?.kind === "escalate" ? activeDialog.movementId : 0;
      onMutationError(err, mvId ? { kind: "escalate", movementId: mvId } : null);
    },
  });

  const statusIsOut = item ? OUT_STATUSES.includes(item.lifecycleStatus) : false;
  const canDoAcknowledge =
    props.canReceive &&
    statusIsOut &&
    !!latestReleaseMovement &&
    !movements.some(
      (m: FileCustodyMovement) =>
        m.movementKind === "acknowledge" &&
        Number((m.meta as any)?.relatedReleaseMovementId) === latestReleaseMovement.id,
    );
  const canDoReturnRequest =
    props.canReturn &&
    (item?.lifecycleStatus === "out_with_counsel" ||
      item?.lifecycleStatus === "out_with_client" ||
      item?.lifecycleStatus === "out_on_loan" ||
      item?.lifecycleStatus === "out_external");
  const currentUserIsHolder =
    !!item && item.currentHolderUserId != null && Number(item.currentHolderUserId) === Number(myUserId);
  const canDoReturn =
    props.canReturn &&
    item?.lifecycleStatus === "return_pending" &&
    (currentUserIsHolder || isPartnerOrManager);
  const canDoReceiveReturn =
    props.canReceive &&
    (item?.lifecycleStatus === "return_pending" ||
      item?.lifecycleStatus === "out_external" ||
      statusIsOut);
  const canDoEscalate = props.canManage;

  useEffect(() => {
    if (retryAfterConflict && staleAlertVisible) {
      // automatically reopen dialog after refresh completes (query resolved)
      if (!detailQuery.isFetching && !staleRefetching) {
        setActiveDialog(retryAfterConflict);
        setRetryAfterConflict(null);
        setStaleAlertVisible(false);
      }
    }
  }, [retryAfterConflict, staleAlertVisible, detailQuery.isFetching, staleRefetching]);

  return (
    <>
      <Sheet open={props.open} onOpenChange={props.onOpenChange}>
        <SheetContent className="w-full sm:max-w-2xl md:max-w-3xl p-0">
          <div className="flex flex-col h-full">
            <SheetHeader className="px-6 py-4 border-b border-slate-200">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <SheetTitle className="flex items-center gap-2 text-xl">
                    <FileText className="w-5 h-5 text-blue-600" />
                    {detailQuery.isLoading && !item ? (
                      <Skeleton className="h-6 w-48" />
                    ) : (
                      <span className="truncate">{item?.fileReferenceNo ?? "File"}</span>
                    )}
                    {item && (
                      <Badge variant={statusBadgeVariant(item.lifecycleStatus)} className="ml-2">
                        {formatStatus(item.lifecycleStatus)}
                      </Badge>
                    )}
                  </SheetTitle>
                  <SheetDescription className="mt-1 text-sm text-slate-500">
                    {detailQuery.isLoading && !item
                      ? "Loading file details…"
                      : item
                        ? item.fileTitle
                        : "—"}
                  </SheetDescription>
                </div>
                <Button variant="ghost" size="sm" onClick={refreshDetail} disabled={detailQuery.isFetching || staleRefetching}>
                  <RefreshCw className={`w-4 h-4 ${detailQuery.isFetching || staleRefetching ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </SheetHeader>

            {staleAlertVisible && (
              <div className="px-6 pt-4">
                <Alert variant="destructive">
                  <AlertTriangle className="w-4 h-4 mr-2" />
                  <AlertTitle>Stale data</AlertTitle>
                  <AlertDescription className="flex items-center gap-2 flex-wrap">
                    <span>
                      This item was modified by another user.
                      {staleRefetching || detailQuery.isFetching ? " Refreshing…" : " Refreshed."}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setStaleAlertVisible(false);
                        setRetryAfterConflict(null);
                      }}
                    >
                      Dismiss
                    </Button>
                    {retryAfterConflict && !detailQuery.isFetching && !staleRefetching && (
                      <Button
                        size="sm"
                        onClick={() => {
                          setActiveDialog(retryAfterConflict);
                          setRetryAfterConflict(null);
                          setStaleAlertVisible(false);
                        }}
                      >
                        Re-open dialog
                      </Button>
                    )}
                  </AlertDescription>
                </Alert>
              </div>
            )}

            <ScrollArea className="flex-1">
              <div className="px-6 py-4 space-y-6">
                {detailQuery.isError && !item ? (
                  <div className="py-8">
                    <QueryFallback
                      title="Failed to load detail"
                      error={detailQuery.error}
                      onRetry={() => detailQuery.refetch()}
                      isRetrying={detailQuery.isFetching}
                    />
                  </div>
                ) : detailQuery.isLoading && !item ? (
                  <div className="space-y-6">
                    <div className="grid grid-cols-2 gap-3">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="space-y-1">
                          <Skeleton className="h-3 w-24" />
                          <Skeleton className="h-5 w-full" />
                        </div>
                      ))}
                    </div>
                    <div className="space-y-2">
                      <Skeleton className="h-5 w-32" />
                      {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-16 w-full" />
                      ))}
                    </div>
                  </div>
                ) : item ? (
                  <>
                    <Tabs defaultValue="summary" className="w-full">
                      <TabsList className="grid w-full grid-cols-2">
                        <TabsTrigger value="summary">
                          <Info className="w-4 h-4 mr-2" />
                          Summary
                        </TabsTrigger>
                        <TabsTrigger value="timeline">
                          <History className="w-4 h-4 mr-2" />
                          Movements ({movements.length})
                        </TabsTrigger>
                      </TabsList>

                      <TabsContent value="summary" className="mt-4 space-y-4">
                        <div className="flex flex-wrap gap-2">
                          {props.canRelease && !item.isArchived && (
                            <Button
                              onClick={() => setActiveDialog({ kind: "release" })}
                              disabled={item.isArchived}
                            >
                              <Send className="w-4 h-4 mr-2" />
                              Release
                            </Button>
                          )}
                          {canDoAcknowledge && (
                            <Button
                              variant="secondary"
                              onClick={() =>
                                setActiveDialog({
                                  kind: "acknowledge",
                                  movementId: latestReleaseMovement!.id,
                                })
                              }
                            >
                              <CheckCircle2 className="w-4 h-4 mr-2" />
                              Acknowledge
                            </Button>
                          )}
                          {canDoReturnRequest && (
                            <Button
                              variant="secondary"
                              onClick={() => setActiveDialog({ kind: "return_request" })}
                            >
                              <ArrowLeftRight className="w-4 h-4 mr-2" />
                              Return Request
                            </Button>
                          )}
                          {canDoReturn && latestReturnRequestMovement && (
                            <Button
                              variant="secondary"
                              onClick={() =>
                                setActiveDialog({
                                  kind: "return",
                                  movementId: latestReturnRequestMovement.id,
                                })
                              }
                            >
                              <Undo2 className="w-4 h-4 mr-2" />
                              Return
                            </Button>
                          )}
                          {canDoReceiveReturn && latestReleaseMovement && (
                            <Button
                              variant="outline"
                              onClick={() =>
                                setActiveDialog({
                                  kind: "receive_return",
                                  movementId: (latestReturnRequestMovement ?? latestReleaseMovement).id,
                                })
                              }
                            >
                              <Inbox className="w-4 h-4 mr-2" />
                              Receive Return
                            </Button>
                          )}
                          {canDoEscalate && movements.length > 0 && (
                            <Button
                              variant="destructive"
                              onClick={() =>
                                setActiveDialog({
                                  kind: "escalate",
                                  movementId: movements[0].id,
                                })
                              }
                            >
                              <AlertTriangle className="w-4 h-4 mr-2" />
                              Escalate
                            </Button>
                          )}
                        </div>

                        <Card>
                          <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                            <SummaryField label="File Reference" value={item.fileReferenceNo} mono />
                            <SummaryField
                              label="Status"
                              value={
                                <Badge variant={statusBadgeVariant(item.lifecycleStatus)}>
                                  {formatStatus(item.lifecycleStatus)}
                                </Badge>
                              }
                            />
                            <SummaryField
                              label="Case"
                              value={
                                item.caseId ? (
                                  <a
                                    className="text-blue-700 hover:underline"
                                    href={`/app/cases/${item.caseId}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Case #{item.caseId}
                                  </a>
                                ) : (
                                  "—"
                                )
                              }
                            />
                            <SummaryField
                              label="Matter / Project"
                              value={item.matterLabel || "—"}
                            />
                            <SummaryField
                              label="Title"
                              value={item.fileTitle || "—"}
                              className="md:col-span-2"
                            />
                            <SummaryField
                              label="Description"
                              value={item.fileDescription || "—"}
                              className="md:col-span-2"
                              multiline
                            />
                            <SummaryField
                              label="Category"
                              value={String(item.category ?? "—")}
                            />
                            <SummaryField
                              label="Format"
                              value={String(item.physicalOrDigital ?? "—")}
                            />
                            <SummaryField
                              label="Storage Location"
                              value={item.storageLocation || "—"}
                            />
                            <SummaryField
                              label="Tags"
                              value={item.tags || "—"}
                              className="md:col-span-2"
                              multiline
                            />
                            <Separator className="md:col-span-2" />
                            <SummaryField
                              label="Current Holder"
                              value={
                                <div>
                                  <div className="font-medium text-slate-800 flex items-center gap-1.5">
                                    <User className="w-3.5 h-3.5 text-slate-400" />
                                    {item.holderName ?? item.currentHolderName ?? "—"}
                                  </div>
                                  {(item.currentHolderContact || item.currentHolderFirmExternal) && (
                                    <div className="text-xs text-slate-500 mt-0.5">
                                      {item.currentHolderFirmExternal
                                        ? `${item.currentHolderFirmExternal} · `
                                        : ""}
                                      {item.currentHolderContact || ""}
                                    </div>
                                  )}
                                </div>
                              }
                            />
                            <SummaryField
                              label="Remarks"
                              value={
                                movements[0]?.movementNote ||
                                movements[0]?.acknowledgedNote ||
                                movements[0]?.returnedNote ||
                                "—"
                              }
                              multiline
                            />
                            <SummaryField
                              label="Expected Return"
                              value={
                                item.expectedReturnAt ? (
                                  <span className={item.isReturnOverdue ? "text-rose-700 font-medium" : ""}>
                                    {formatDateTime(item.expectedReturnAt)}
                                    {item.isReturnOverdue && " (Overdue)"}
                                  </span>
                                ) : (
                                  "—"
                                )
                              }
                            />
                            <SummaryField
                              label="Ack Due"
                              value={
                                item.acknowledgeDueAt ? (
                                  <span className={item.isAcknowledgementOverdue ? "text-orange-700 font-medium" : ""}>
                                    {formatDateTime(item.acknowledgeDueAt)}
                                    {item.acknowledgedAt && (
                                      <span className="text-emerald-700 ml-2">
                                        · ack at {formatDateTime(item.acknowledgedAt)}
                                      </span>
                                    )}
                                  </span>
                                ) : (
                                  "—"
                                )
                              }
                            />
                            <SummaryField
                              label="Version"
                              value={String(item.version ?? 0)}
                              mono
                            />
                            <SummaryField label="Created" value={formatDateTime(item.createdAt)} />
                            <SummaryField label="Last Updated" value={formatDateTime(item.updatedAt)} />
                          </CardContent>
                        </Card>
                      </TabsContent>

                      <TabsContent value="timeline" className="mt-4">
                        <MovementTimeline movements={movements} />
                      </TabsContent>
                    </Tabs>
                  </>
                ) : null}
              </div>
            </ScrollArea>
          </div>
        </SheetContent>
      </Sheet>

      <ReleaseDialog
        open={activeDialog?.kind === "release"}
        onClose={closeDialog}
        onSubmit={(payload) => releaseMutation.mutate(payload)}
        submitting={releaseMutation.isPending}
        item={item}
        firmUsers={props.firmUsers}
      />

      <AcknowledgeDialog
        open={activeDialog?.kind === "acknowledge"}
        onClose={closeDialog}
        onSubmit={(payload) => acknowledgeMutation.mutate(payload)}
        submitting={acknowledgeMutation.isPending}
        movementId={activeDialog?.kind === "acknowledge" ? activeDialog.movementId : 0}
      />

      <ReturnRequestDialog
        open={activeDialog?.kind === "return_request"}
        onClose={closeDialog}
        onSubmit={(payload) => returnRequestMutation.mutate(payload)}
        submitting={returnRequestMutation.isPending}
        item={item}
      />

      <ReturnDialog
        open={activeDialog?.kind === "return"}
        onClose={closeDialog}
        onSubmit={(payload) => returnMutation.mutate(payload)}
        submitting={returnMutation.isPending}
        title="Return File"
        description="Mark file as returned by current holder."
        movementId={activeDialog?.kind === "return" ? activeDialog.movementId : 0}
      />

      <ReturnDialog
        open={activeDialog?.kind === "receive_return"}
        onClose={closeDialog}
        onSubmit={(payload) => receiveReturnMutation.mutate(payload)}
        submitting={receiveReturnMutation.isPending}
        title="Receive Return"
        description="Confirm return has been received in office."
        movementId={activeDialog?.kind === "receive_return" ? activeDialog.movementId : 0}
      />

      <EscalateDialog
        open={activeDialog?.kind === "escalate"}
        onClose={closeDialog}
        onSubmit={(payload) => escalateMutation.mutate(payload)}
        submitting={escalateMutation.isPending}
        partners={props.partners}
        movementId={activeDialog?.kind === "escalate" ? activeDialog.movementId : 0}
      />
    </>
  );
}

function SummaryField(props: {
  label: string;
  value: React.ReactNode;
  className?: string;
  mono?: boolean;
  multiline?: boolean;
}) {
  return (
    <div className={props.className}>
      <div className="text-xs font-medium text-slate-500 mb-1">{props.label}</div>
      <div
        className={`text-sm text-slate-800 ${props.mono ? "font-mono" : ""} ${
          props.multiline ? "whitespace-pre-wrap break-words" : ""
        }`}
      >
        {props.value}
      </div>
    </div>
  );
}

function MovementTimeline({ movements }: { movements: FileCustodyMovement[] }) {
  if (movements.length === 0) {
    return (
      <div className="py-10 text-center text-slate-500 text-sm">
        No movements yet for this file.
      </div>
    );
  }
  return (
    <ol className="relative border-l border-slate-200 ml-2 space-y-5">
      {movements.map((mv) => (
        <li key={mv.id} className="ml-5">
          <span className="absolute -left-[9px] flex items-center justify-center w-5 h-5 rounded-full bg-white border border-slate-200 shadow-sm">
            {kindIcon(mv.movementKind)}
          </span>
          <div className="bg-slate-50 border border-slate-200 rounded-md p-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="font-medium">
                  {formatMovementKind(mv.movementKind)}
                </Badge>
                <span className="text-xs text-slate-500 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {formatDateTime(mv.createdAt)}
                </span>
              </div>
              <div className="text-xs text-slate-500">#{mv.id}</div>
            </div>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              {mv.fromHolderName || mv.fromHolderUserId ? (
                <div>
                  <div className="text-xs text-slate-500">From</div>
                  <div className="font-medium text-slate-800">
                    {mv.fromHolderName ?? `User #${mv.fromHolderUserId}`}
                  </div>
                </div>
              ) : null}
              {mv.toHolderName || mv.toHolderUserId || mv.toHolderFirmExternal ? (
                <div>
                  <div className="text-xs text-slate-500">To</div>
                  <div className="font-medium text-slate-800">
                    {mv.toHolderName ??
                      (mv.toHolderUserId ? `User #${mv.toHolderUserId}` : mv.toHolderFirmExternal ?? "—")}
                    {mv.toHolderFirmExternal && (
                      <span className="text-xs text-slate-500 block">
                        {mv.toHolderFirmExternal}
                      </span>
                    )}
                  </div>
                </div>
              ) : null}
              {mv.acknowledgedAt && (
                <div>
                  <div className="text-xs text-slate-500">Acknowledged</div>
                  <div className="text-slate-700">{formatDateTime(mv.acknowledgedAt)}</div>
                </div>
              )}
              {mv.returnedAt && (
                <div>
                  <div className="text-xs text-slate-500">Returned</div>
                  <div className="text-slate-700">{formatDateTime(mv.returnedAt)}</div>
                </div>
              )}
              {mv.expectedReturnAt && (
                <div>
                  <div className="text-xs text-slate-500">Expected Return</div>
                  <div className="text-slate-700">{formatDateTime(mv.expectedReturnAt)}</div>
                </div>
              )}
              {mv.returnedCondition && (
                <div>
                  <div className="text-xs text-slate-500">Condition</div>
                  <div className="capitalize text-slate-700">{mv.returnedCondition.replace("_", " ")}</div>
                </div>
              )}
            </div>
            {(mv.movementNote || mv.acknowledgedNote || mv.returnedNote) && (
              <div className="mt-3 p-2 bg-white rounded border border-slate-200 text-sm text-slate-700 whitespace-pre-wrap break-words">
                <div className="text-xs text-slate-500 mb-0.5">Notes</div>
                {mv.acknowledgedNote && <div>Ack: {mv.acknowledgedNote}</div>}
                {mv.returnedNote && <div>Return: {mv.returnedNote}</div>}
                {mv.movementNote &&
                  !(
                    (mv.acknowledgedNote && mv.movementNote === mv.acknowledgedNote) ||
                    (mv.returnedNote && mv.movementNote === mv.returnedNote)
                  ) && <div>Remarks: {mv.movementNote}</div>}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ReleaseDialog(props: {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: Parameters<typeof releaseCustody>[0]) => void;
  submitting: boolean;
  item?: FileCustodyItem;
  firmUsers: FirmUser[];
}) {
  const [toHolderUserId, setToHolderUserId] = useState<string>("");
  const [toHolderName, setToHolderName] = useState("");
  const [toHolderContact, setToHolderContact] = useState("");
  const [toHolderFirmExternal, setToHolderFirmExternal] = useState("");
  const [severity, setSeverity] = useState<"info" | "normal" | "high" | "urgent" | "critical">("normal");
  const [expectedReturnAt, setExpectedReturnAt] = useState("");
  const [acknowledgeDueAt, setAcknowledgeDueAt] = useState("");
  const [movementNote, setMovementNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (props.open) {
      setToHolderUserId("");
      setToHolderName("");
      setToHolderContact("");
      setToHolderFirmExternal("");
      setSeverity("normal");
      setExpectedReturnAt("");
      setAcknowledgeDueAt("");
      setMovementNote("");
      setErrors({});
    }
  }, [props.open]);

  const disabled = props.submitting;

  const submit = () => {
    const e: Record<string, string> = {};
    if (!toHolderUserId && !toHolderName.trim()) {
      e.target = "Select an internal user OR provide external holder name";
    }
    if (Object.keys(e).length) {
      setErrors(e);
      return;
    }
    props.onSubmit({
      custodyItemId: props.item!.id,
      toHolderUserId: toHolderUserId ? Number(toHolderUserId) : undefined,
      toHolderName: toHolderName.trim() || undefined,
      toHolderContact: toHolderContact.trim() || undefined,
      toHolderFirmExternal: toHolderFirmExternal.trim() || undefined,
      severity,
      expectedReturnAt: expectedReturnAt || undefined,
      acknowledgeDueAt: acknowledgeDueAt || undefined,
      movementNote: movementNote.trim() || undefined,
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={(o: boolean) => !o && !disabled && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Release File Custody</DialogTitle>
          <DialogDescription>
            Transfer custody of <span className="font-mono">{props.item?.fileReferenceNo}</span> to another holder.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[70vh] overflow-y-auto px-1">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Internal User (optional)</Label>
              <Select value={toHolderUserId} onValueChange={(v: string) => { setToHolderUserId(v); if (v) { setToHolderName(""); setToHolderContact(""); } }} disabled={disabled}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a user…" />
                </SelectTrigger>
                <SelectContent>
                  {props.firmUsers.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.name} <span className="text-slate-400 ml-1 text-xs">({u.email})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Severity</Label>
              <Select value={severity} onValueChange={(v: string) => setSeverity(v as any)} disabled={disabled}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="p-3 rounded-md border border-dashed border-slate-300 bg-slate-50/60 space-y-3">
            <div className="text-xs font-medium text-slate-600">External Holder (if not internal user)</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input
                  disabled={disabled || !!toHolderUserId}
                  value={toHolderName}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setToHolderName(e.target.value)}
                  placeholder="Counsel / client name"
                />
              </div>
              <div className="space-y-1">
                <Label>Contact</Label>
                <Input
                  disabled={disabled || !!toHolderUserId}
                  value={toHolderContact}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setToHolderContact(e.target.value)}
                  placeholder="Email or phone"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Firm / External Organisation</Label>
              <Input
                disabled={disabled}
                value={toHolderFirmExternal}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setToHolderFirmExternal(e.target.value)}
                placeholder="Firm name"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Acknowledge Due</Label>
              <Input
                type="datetime-local"
                disabled={disabled}
                value={acknowledgeDueAt}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setAcknowledgeDueAt(e.target.value ? new Date(e.target.value).toISOString() : "")}
              />
            </div>
            <div className="space-y-1">
              <Label>Expected Return</Label>
              <Input
                type="datetime-local"
                disabled={disabled}
                value={expectedReturnAt}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setExpectedReturnAt(e.target.value ? new Date(e.target.value).toISOString() : "")}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Remarks / Notes</Label>
            <Textarea
              rows={3}
              disabled={disabled}
              value={movementNote}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setMovementNote(e.target.value)}
              placeholder="Purpose of release, handling instructions…"
            />
          </div>
          {errors.target && (
            <Alert variant="destructive">
              <AlertTitle>Missing target</AlertTitle>
              <AlertDescription>{errors.target}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={disabled}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={disabled}>
            {props.submitting ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                Releasing…
              </>
            ) : (
              <>
                <Send className="w-4 h-4 mr-2" />
                Release
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AcknowledgeDialog(props: {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: Parameters<typeof acknowledgeCustody>[0]) => void;
  submitting: boolean;
  movementId: number;
}) {
  const [acknowledgedNote, setAcknowledgedNote] = useState("");
  const [condition, setCondition] = useState<"good" | "damaged" | "partial" | "missing_pages">("good");

  useEffect(() => {
    if (props.open) {
      setAcknowledgedNote("");
      setCondition("good");
    }
  }, [props.open]);

  const mid = props.movementId;
  return (
    <Dialog open={props.open} onOpenChange={(o: boolean) => !o && !props.submitting && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Acknowledge Receipt</DialogTitle>
          <DialogDescription>
            Confirm you have received the file.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[65vh] overflow-y-auto px-1">
          <div className="space-y-1">
            <Label>Condition</Label>
            <Select value={condition} onValueChange={(v: string) => setCondition(v as any)} disabled={props.submitting}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="good">Good</SelectItem>
                <SelectItem value="damaged">Damaged</SelectItem>
                <SelectItem value="partial">Partial</SelectItem>
                <SelectItem value="missing_pages">Missing pages</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Acknowledgement Notes</Label>
            <Textarea
              rows={3}
              disabled={props.submitting}
              value={acknowledgedNote}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setAcknowledgedNote(e.target.value)}
              placeholder="Condition notes, missing items…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={props.submitting}>Cancel</Button>
          <Button
            onClick={() =>
              props.onSubmit({
                movementId: mid,
                acknowledgedNote: acknowledgedNote.trim() || undefined,
                condition,
              })
            }
            disabled={props.submitting || !mid}
          >
            {props.submitting ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Submitting…
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4 mr-2" /> Acknowledge
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReturnRequestDialog(props: {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: Parameters<typeof requestReturnCustody>[0]) => void;
  submitting: boolean;
  item?: FileCustodyItem;
}) {
  const [note, setNote] = useState("");
  const [requestedReturnAt, setRequestedReturnAt] = useState("");
  useEffect(() => {
    if (props.open) {
      setNote("");
      setRequestedReturnAt("");
    }
  }, [props.open]);
  return (
    <Dialog open={props.open} onOpenChange={(o: boolean) => !o && !props.submitting && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request Return</DialogTitle>
          <DialogDescription>
            Ask the current holder to return this file.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[65vh] overflow-y-auto px-1">
          <div className="space-y-1">
            <Label>Requested Return By</Label>
            <Input
              type="datetime-local"
              value={requestedReturnAt}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setRequestedReturnAt(e.target.value ? new Date(e.target.value).toISOString() : "")
              }
              disabled={props.submitting}
            />
          </div>
          <div className="space-y-1">
            <Label>Request Notes</Label>
            <Textarea
              rows={3}
              value={note}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)}
              disabled={props.submitting}
              placeholder="Reason / urgency / handover location…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={props.submitting}>Cancel</Button>
          <Button
            onClick={() =>
              props.onSubmit({
                custodyItemId: props.item!.id,
                note: note.trim() || undefined,
                requestedReturnAt: requestedReturnAt || undefined,
              })
            }
            disabled={props.submitting || !props.item}
          >
            {props.submitting ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Submitting…
              </>
            ) : (
              <>
                <ArrowLeftRight className="w-4 h-4 mr-2" /> Request Return
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReturnDialog(props: {
  open: boolean;
  onClose: () => void;
  onSubmit:
    | ((payload: Parameters<typeof returnCustody>[0]) => void)
    | ((payload: Parameters<typeof receiveReturnCustody>[0]) => void);
  submitting: boolean;
  title: string;
  description: string;
  movementId: number;
}) {
  const [returnedNote, setReturnedNote] = useState("");
  const [returnedCondition, setReturnedCondition] = useState<
    "good" | "damaged" | "partial" | "missing_pages"
  >("good");
  useEffect(() => {
    if (props.open) {
      setReturnedNote("");
      setReturnedCondition("good");
    }
  }, [props.open]);
  const mid = props.movementId ?? 0;
  return (
    <Dialog open={props.open} onOpenChange={(o: boolean) => !o && !props.submitting && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[65vh] overflow-y-auto px-1">
          <div className="space-y-1">
            <Label>Condition</Label>
            <Select value={returnedCondition} onValueChange={(v: string) => setReturnedCondition(v as any)} disabled={props.submitting}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="good">Good</SelectItem>
                <SelectItem value="damaged">Damaged</SelectItem>
                <SelectItem value="partial">Partial</SelectItem>
                <SelectItem value="missing_pages">Missing pages</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Notes</Label>
            <Textarea
              rows={3}
              value={returnedNote}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setReturnedNote(e.target.value)}
              disabled={props.submitting}
              placeholder="Missing items, damages, handover details…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={props.submitting}>Cancel</Button>
          <Button
            onClick={() =>
              (props.onSubmit as (p: any) => void)({
                movementId: mid,
                returnedNote: returnedNote.trim() || undefined,
                returnedCondition,
              })
            }
            disabled={props.submitting || !mid}
          >
            {props.submitting ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Submitting…
              </>
            ) : (
              <>
                <Undo2 className="w-4 h-4 mr-2" /> Submit
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EscalateDialog(props: {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: Parameters<typeof escalateCustody>[0]) => void;
  submitting: boolean;
  partners: PartnerUser[];
  movementId: number;
}) {
  const [note, setNote] = useState("");
  const [targetPartnerUserId, setTargetPartnerUserId] = useState<string>("all");
  useEffect(() => {
    if (props.open) {
      setNote("");
      setTargetPartnerUserId("all");
    }
  }, [props.open]);
  const mid = props.movementId ?? 0;
  return (
    <Dialog open={props.open} onOpenChange={(o: boolean) => !o && !props.submitting && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Escalate to Partner</DialogTitle>
          <DialogDescription>
            Flag this movement for partner attention.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[65vh] overflow-y-auto px-1">
          <div className="space-y-1">
            <Label>Target Partner</Label>
            <Select value={targetPartnerUserId} onValueChange={(v: string) => setTargetPartnerUserId(v)} disabled={props.submitting}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Partners</SelectItem>
                {props.partners.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name} <span className="text-slate-400 ml-1 text-xs">({p.email})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Reason</Label>
            <Textarea
              rows={3}
              value={note}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)}
              disabled={props.submitting}
              placeholder="Why partner attention is required…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={props.submitting}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() =>
              props.onSubmit({
                movementId: mid,
                targetPartnerUserId: targetPartnerUserId === "all" ? undefined : targetPartnerUserId,
                note: note.trim() || undefined,
              })
            }
            disabled={props.submitting || !mid}
          >
            {props.submitting ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Escalating…
              </>
            ) : (
              <>
                <AlertTriangle className="w-4 h-4 mr-2" /> Escalate
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InternalDialogWrapper(props: {
  open: boolean;
  onMovementId: (id: number) => void;
  render: (ctx: { movementId: number }) => React.ReactNode;
}) {
  const movementId = (props as any).movementId as number | undefined;
  useEffect(() => {
    if (props.open && movementId) {
      props.onMovementId(movementId);
    }
  }, [props.open, movementId]);
  const effectiveId = movementId ?? 0;
  return <>{props.render({ movementId: effectiveId })}</>;
}
