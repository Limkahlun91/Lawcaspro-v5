import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { CheckCircle2, Circle, Clock, AlertTriangle, Plus, Trash2, CheckSquare } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { QueryFallback } from "@/components/query-fallback";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { DateOnlyInput, formatYmdToDmy } from "@/components/date-only-input";

const PRIORITY_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  low:    { label: "Low",    color: "bg-slate-100 text-slate-600", icon: Circle },
  normal: { label: "Normal", color: "bg-blue-100 text-blue-700",  icon: Clock },
  high:   { label: "High",   color: "bg-amber-100 text-amber-700", icon: AlertTriangle },
  urgent: { label: "Urgent", color: "bg-red-100 text-red-700",    icon: AlertTriangle },
};

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  open:        { label: "Open",        color: "bg-blue-100 text-blue-700" },
  in_progress: { label: "In Progress", color: "bg-amber-100 text-amber-700" },
  done:        { label: "Done",        color: "bg-green-100 text-green-700" },
};

function isOverdue(dueDate: string | null, status: string) {
  if (!dueDate || status === "done") return false;
  return new Date(dueDate) < new Date(new Date().toDateString());
}

export default function CaseTasksTab({ caseId }: { caseId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", dueDate: "", priority: "normal" });
  const [filterStatus, setFilterStatus] = useState("all");

  const tasksQuery = useQuery({
    queryKey: ["case-tasks", caseId],
    queryFn: () => apiFetchJson(`/case-tasks?caseId=${caseId}`),
    retry: false,
  });
  const tasks = (tasksQuery.data ?? []) as any[];

  const createTask = useMutation({
    mutationFn: async (body: any) =>
      apiFetchJson(`/case-tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, caseId }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["case-tasks", caseId] }); setShowAdd(false); setForm({ title: "", description: "", dueDate: "", priority: "normal" }); toast({ title: "Task added" }); },
    onError: (e) => toastError(toast, e, "Create failed"),
  });

  const updateTask = useMutation({
    mutationFn: async ({ id, ...body }: any) =>
      apiFetchJson(`/case-tasks/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["case-tasks", caseId] }),
    onError: (e) => toastError(toast, e, "Update failed"),
  });

  const deleteTask = useMutation({
    mutationFn: async (id: number) => apiFetchJson(`/case-tasks/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["case-tasks", caseId] }); toast({ title: "Task deleted" }); },
    onError: (e) => toastError(toast, e, "Delete failed"),
  });

  const filtered = tasks.filter((t: any) => filterStatus === "all" || t.status === filterStatus);
  const openCount = tasks.filter((t: any) => t.status !== "done").length;
  const overdueCount = tasks.filter((t: any) => isOverdue(t.dueDate, t.status)).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-3">
          <span className="text-sm text-slate-500">{openCount} open</span>
          {overdueCount > 0 && <span className="text-sm text-red-600 font-medium">{overdueCount} overdue</span>}
        </div>
        <div className="flex items-center gap-2">
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-36 h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tasks</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="done">Done</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" className="bg-[#f5a623] hover:bg-amber-500 text-white h-8" onClick={() => setShowAdd(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Task
          </Button>
        </div>
      </div>

      {tasksQuery.isError ? (
        <QueryFallback title="Tasks unavailable" error={tasksQuery.error} onRetry={() => tasksQuery.refetch()} isRetrying={tasksQuery.isFetching} />
      ) : tasksQuery.isLoading ? (
        <div className="text-sm text-slate-400 py-8 text-center">Loading tasks...</div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-slate-400 text-sm">
          <CheckSquare className="h-8 w-8 mx-auto mb-2 text-slate-300" />
          No tasks yet. Add a task to track deadlines and actions.
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((task: any) => {
            const overdue = isOverdue(task.dueDate, task.status);
            const priorityCfg = PRIORITY_CONFIG[task.priority] ?? PRIORITY_CONFIG.normal;
            return (
              <Card key={task.id} className={`border ${overdue ? "border-red-200 bg-red-50/30" : "border-slate-200"}`}>
                <CardContent className="py-3 px-4 flex items-start gap-3">
                  <button
                    className="mt-0.5 flex-shrink-0"
                    onClick={() => updateTask.mutate({ id: task.id, status: task.status === "done" ? "open" : "done" })}
                    disabled={updateTask.isPending || deleteTask.isPending}
                  >
                    {task.status === "done"
                      ? <CheckCircle2 className="h-5 w-5 text-green-500" />
                      : <Circle className="h-5 w-5 text-slate-300 hover:text-green-400 transition-colors" />
                    }
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${task.status === "done" ? "line-through text-slate-400" : "text-slate-800"}`}>{task.title}</p>
                    {task.description && <p className="text-xs text-slate-500 mt-0.5">{task.description}</p>}
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      <Badge variant="outline" className={`text-xs ${priorityCfg.color} border-0`}>{priorityCfg.label}</Badge>
                      {task.status !== "open" && (
                        <Badge variant="outline" className={`text-xs ${STATUS_CONFIG[task.status]?.color ?? ""} border-0`}>{STATUS_CONFIG[task.status]?.label}</Badge>
                      )}
                      {task.dueDate && (
                        <span className={`text-xs flex items-center gap-0.5 ${overdue ? "text-red-600 font-medium" : "text-slate-500"}`}>
                          <Clock className="h-3 w-3" />{formatYmdToDmy(String(task.dueDate ?? "")) || String(task.dueDate ?? "")}{overdue ? " — Overdue" : ""}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {task.status === "open" && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => updateTask.mutate({ id: task.id, status: "in_progress" })} disabled={updateTask.isPending || deleteTask.isPending}>Start</Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-slate-400 hover:text-red-500"
                      onClick={() => { if (!confirm("Delete this task?")) return; deleteTask.mutate(task.id); }}
                      disabled={deleteTask.isPending || updateTask.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Add Task</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Title *</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Chase stamp duty payment" className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Description</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} className="mt-1 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Due Date</Label>
                <DateOnlyInput valueYmd={form.dueDate} onChangeYmd={(v) => setForm((f) => ({ ...f, dueDate: v }))} className="mt-1 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Priority</Label>
                <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v }))}>
                  <SelectTrigger className="mt-1 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(PRIORITY_CONFIG).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button className="bg-[#f5a623] hover:bg-amber-500 text-white" onClick={() => createTask.mutate(form)} disabled={!form.title || createTask.isPending}>
              {createTask.isPending ? "Adding..." : "Add Task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
