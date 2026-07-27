import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import { apiFetchJson } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { QueryFallback } from "@/components/query-fallback";

type RoleSummary = {
  id: number;
  name: string;
  suggestedAccountingRole?: boolean;
  mappedKind?: "account_manager" | "account_admin" | null;
};

type AccountingSettingsForm = {
  accountManagerRoleIds: number[];
  accountAdminRoleIds: number[];
  timezone: string;
  workingHoursStart: string;
  workingHoursEnd: string;
  excludeSaturday: boolean;
  excludeSunday: boolean;
  firmHolidays: Array<{ date: string; label?: string }>;
  approvalRules: {
    requirePartnerApprovalByDefault: boolean;
    managerCanFinalApprove: boolean;
    adminCanFinalApprove: boolean;
    requireDoubleApproval: boolean;
    managerSoloVoucherTypes: string[];
    thresholds: Array<{
      minAmount?: number;
      maxAmount?: number;
      requiresPartnerApproval?: boolean;
    }>;
  };
  paymentVoucherSla: {
    defaultHours: number;
    urgentHours: number;
    dueSoonMinutes: number;
    voucherTypeHours: Record<string, number>;
    thresholds: Array<{ minAmount?: number; maxAmount?: number; hours: number }>;
    notifyAssignedAccountUser: boolean;
    notifyAccountManager: boolean;
    notifyPartnerOnOverdue: boolean;
  };
  clerkActionSla: {
    acknowledgeHours: number;
    completionHours: number;
    dueSoonMinutes: number;
    notifyCaseOwner: boolean;
    notifyPartnerOnOverdue: boolean;
  };
  paymentProofRequired: boolean;
};

type PreviewResponse = {
  settings: AccountingSettingsForm;
  roleChanges: Array<{
    roleId: number;
    additions: Array<{ module: string; action: string }>;
    removals: Array<{ module: string; action: string }>;
  }>;
};

type SettingsResponse = {
  settings: AccountingSettingsForm;
  defaults: AccountingSettingsForm;
  roles: RoleSummary[];
  suggestedRoleIds: number[];
};

const VOUCHER_TYPES = [
  { key: "external_payment", label: "External Payment" },
  { key: "file_transfer", label: "File Transfer" },
  { key: "file_to_file_transfer", label: "File-to-File Transfer" },
  { key: "internal_transfer", label: "Internal Transfer" },
  { key: "account_transfer", label: "Account Transfer" },
] as const;

function cloneSettings(settings: AccountingSettingsForm): AccountingSettingsForm {
  return JSON.parse(JSON.stringify(settings)) as AccountingSettingsForm;
}

export default function AccountingSettingsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const canRead = hasPermission(user, "accounting", "read");
  const canManage = hasPermission(user, "accounting", "manage_settings");

  const settingsQuery = useQuery<SettingsResponse>({
    queryKey: ["accounting-settings"],
    queryFn: () => apiFetchJson("/accounting/settings"),
    enabled: canRead,
    retry: false,
  });

  const [form, setForm] = useState<AccountingSettingsForm | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);

  useEffect(() => {
    if (!settingsQuery.data?.settings) return;
    setForm(cloneSettings(settingsQuery.data.settings));
    setPreview(null);
  }, [settingsQuery.data]);

  const roleNameById = useMemo(
    () => new Map((settingsQuery.data?.roles ?? []).map((role) => [role.id, role.name])),
    [settingsQuery.data?.roles],
  );

  const previewMutation = useMutation({
    mutationFn: async (body: AccountingSettingsForm) => apiFetchJson("/accounting/settings/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    onSuccess: (data) => {
      setPreview(data as PreviewResponse);
      toast({ title: "Permission preview updated" });
    },
    onError: (error) => toastError(toast, error, "Preview failed"),
  });

  const saveMutation = useMutation({
    mutationFn: async (body: AccountingSettingsForm) => apiFetchJson("/accounting/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    onSuccess: (data) => {
      const next = data as PreviewResponse;
      setPreview(next);
      setForm((prev) => (prev ? cloneSettings(prev) : prev));
      settingsQuery.refetch();
      toast({ title: "Accounting settings saved" });
    },
    onError: (error) => toastError(toast, error, "Save failed"),
  });

  if (!canRead) {
    return <div className="p-6 text-slate-500">Accounting settings are not available for this role.</div>;
  }

  if (settingsQuery.isLoading || !form) {
    return <div className="p-6 text-slate-500">Loading accounting settings...</div>;
  }

  if (settingsQuery.isError) {
    return (
      <div className="p-6">
        <QueryFallback title="Accounting settings unavailable" error={settingsQuery.error} onRetry={() => settingsQuery.refetch()} isRetrying={settingsQuery.isFetching} />
      </div>
    );
  }

  const roles = settingsQuery.data?.roles ?? [];
  const previewChanges = preview?.roleChanges ?? [];
  const disabled = !canManage || saveMutation.isPending || previewMutation.isPending;

  const toggleRole = (kind: "manager" | "admin", roleId: number, checked: boolean) => {
    setForm((current) => {
      if (!current) return current;
      const next = cloneSettings(current);
      if (kind === "manager") {
        next.accountManagerRoleIds = checked
          ? Array.from(new Set([...next.accountManagerRoleIds, roleId]))
          : next.accountManagerRoleIds.filter((id) => id !== roleId);
        if (checked) next.accountAdminRoleIds = next.accountAdminRoleIds.filter((id) => id !== roleId);
      } else {
        next.accountAdminRoleIds = checked
          ? Array.from(new Set([...next.accountAdminRoleIds, roleId]))
          : next.accountAdminRoleIds.filter((id) => id !== roleId);
        if (checked) next.accountManagerRoleIds = next.accountManagerRoleIds.filter((id) => id !== roleId);
      }
      return next;
    });
    setPreview(null);
  };

  const updateHoliday = (index: number, patch: Partial<{ date: string; label?: string }>) => {
    setForm((current) => {
      if (!current) return current;
      const next = cloneSettings(current);
      next.firmHolidays[index] = { ...next.firmHolidays[index], ...patch };
      return next;
    });
    setPreview(null);
  };

  const updateApprovalThreshold = (index: number, patch: Partial<{ minAmount?: number; maxAmount?: number; requiresPartnerApproval?: boolean }>) => {
    setForm((current) => {
      if (!current) return current;
      const next = cloneSettings(current);
      next.approvalRules.thresholds[index] = { ...next.approvalRules.thresholds[index], ...patch };
      return next;
    });
    setPreview(null);
  };

  const updateSlaThreshold = (index: number, patch: Partial<{ minAmount?: number; maxAmount?: number; hours: number }>) => {
    setForm((current) => {
      if (!current) return current;
      const next = cloneSettings(current);
      next.paymentVoucherSla.thresholds[index] = { ...next.paymentVoucherSla.thresholds[index], ...patch };
      return next;
    });
    setPreview(null);
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Accounting Settings</h1>
          <p className="mt-1 text-slate-500">Map Accounting roles by role ID, preview permission template changes, and configure approval/SLA policies per firm.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => previewMutation.mutate(form)} disabled={!canManage || previewMutation.isPending}>
            {previewMutation.isPending ? "Previewing..." : "Preview Permission Changes"}
          </Button>
          <Button className="bg-amber-500 hover:bg-amber-600 text-white" onClick={() => saveMutation.mutate(form)} disabled={!canManage || saveMutation.isPending}>
            {saveMutation.isPending ? "Saving..." : "Save Accounting Settings"}
          </Button>
        </div>
      </div>

      {!canManage ? (
        <Card className="border-slate-200">
          <CardContent className="pt-6 text-sm text-slate-600">
            Read-only mode. This role can review accounting settings but cannot apply role mappings or permission templates.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Role Mapping</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="border-slate-200">
              <CardHeader><CardTitle className="text-base">Account Manager Roles</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {roles.map((role) => (
                  <label key={`manager-${role.id}`} className="flex items-start gap-3 rounded-md border border-slate-200 p-3">
                    <Checkbox
                      checked={form.accountManagerRoleIds.includes(role.id)}
                      disabled={disabled}
                      onCheckedChange={(checked) => toggleRole("manager", role.id, Boolean(checked))}
                    />
                    <div>
                      <div className="font-medium text-slate-900">{role.name}</div>
                      {role.suggestedAccountingRole ? <div className="text-xs text-amber-600">Suggested from existing accounting permissions</div> : null}
                    </div>
                  </label>
                ))}
              </CardContent>
            </Card>

            <Card className="border-slate-200">
              <CardHeader><CardTitle className="text-base">Account Admin Roles</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {roles.map((role) => (
                  <label key={`admin-${role.id}`} className="flex items-start gap-3 rounded-md border border-slate-200 p-3">
                    <Checkbox
                      checked={form.accountAdminRoleIds.includes(role.id)}
                      disabled={disabled}
                      onCheckedChange={(checked) => toggleRole("admin", role.id, Boolean(checked))}
                    />
                    <div>
                      <div className="font-medium text-slate-900">{role.name}</div>
                      {role.suggestedAccountingRole ? <div className="text-xs text-amber-600">Suggested from existing accounting permissions</div> : null}
                    </div>
                  </label>
                ))}
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Working Hours And Holidays</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Timezone</Label>
            <Input value={form.timezone} disabled={disabled} onChange={(e) => { setForm({ ...form, timezone: e.target.value }); setPreview(null); }} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Working Hours Start</Label>
              <Input value={form.workingHoursStart} disabled={disabled} onChange={(e) => { setForm({ ...form, workingHoursStart: e.target.value }); setPreview(null); }} />
            </div>
            <div className="space-y-2">
              <Label>Working Hours End</Label>
              <Input value={form.workingHoursEnd} disabled={disabled} onChange={(e) => { setForm({ ...form, workingHoursEnd: e.target.value }); setPreview(null); }} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
            <Label htmlFor="exclude-sat">Exclude Saturday</Label>
            <Switch id="exclude-sat" checked={form.excludeSaturday} disabled={disabled} onCheckedChange={(checked) => { setForm({ ...form, excludeSaturday: checked }); setPreview(null); }} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
            <Label htmlFor="exclude-sun">Exclude Sunday</Label>
            <Switch id="exclude-sun" checked={form.excludeSunday} disabled={disabled} onCheckedChange={(checked) => { setForm({ ...form, excludeSunday: checked }); setPreview(null); }} />
          </div>
          <div className="space-y-3 md:col-span-2">
            <div className="flex items-center justify-between">
              <Label>Firm Holidays</Label>
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  setForm((current) => current ? { ...current, firmHolidays: [...current.firmHolidays, { date: "", label: "" }] } : current);
                  setPreview(null);
                }}
              >
                Add Holiday
              </Button>
            </div>
            <div className="space-y-3">
              {form.firmHolidays.map((holiday, index) => (
                <div key={`holiday-${index}`} className="grid gap-3 rounded-md border border-slate-200 p-3 md:grid-cols-[180px_1fr_auto]">
                  <Input value={holiday.date} placeholder="YYYY-MM-DD" disabled={disabled} onChange={(e) => updateHoliday(index, { date: e.target.value })} />
                  <Input value={holiday.label ?? ""} placeholder="Holiday label" disabled={disabled} onChange={(e) => updateHoliday(index, { label: e.target.value })} />
                  <Button type="button" variant="outline" disabled={disabled} onClick={() => {
                    setForm((current) => current ? { ...current, firmHolidays: current.firmHolidays.filter((_, i) => i !== index) } : current);
                    setPreview(null);
                  }}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Approval Rules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
              <Label htmlFor="partner-default">Require Partner Approval By Default</Label>
              <Switch id="partner-default" checked={form.approvalRules.requirePartnerApprovalByDefault} disabled={disabled} onCheckedChange={(checked) => {
                setForm({ ...form, approvalRules: { ...form.approvalRules, requirePartnerApprovalByDefault: checked } });
                setPreview(null);
              }} />
            </div>
            <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
              <Label htmlFor="double-approval">Require Double Approval</Label>
              <Switch id="double-approval" checked={form.approvalRules.requireDoubleApproval} disabled={disabled} onCheckedChange={(checked) => {
                setForm({ ...form, approvalRules: { ...form.approvalRules, requireDoubleApproval: checked } });
                setPreview(null);
              }} />
            </div>
            <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
              <Label htmlFor="manager-final">Account Manager Can Final Approve</Label>
              <Switch id="manager-final" checked={form.approvalRules.managerCanFinalApprove} disabled={disabled} onCheckedChange={(checked) => {
                setForm({ ...form, approvalRules: { ...form.approvalRules, managerCanFinalApprove: checked } });
                setPreview(null);
              }} />
            </div>
            <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
              <Label htmlFor="admin-final">Account Admin Can Final Approve</Label>
              <Switch id="admin-final" checked={form.approvalRules.adminCanFinalApprove} disabled={disabled} onCheckedChange={(checked) => {
                setForm({ ...form, approvalRules: { ...form.approvalRules, adminCanFinalApprove: checked } });
                setPreview(null);
              }} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Manager Solo Voucher Types</Label>
            <Input
              value={form.approvalRules.managerSoloVoucherTypes.join(", ")}
              disabled={disabled}
              onChange={(e) => {
                setForm({
                  ...form,
                  approvalRules: {
                    ...form.approvalRules,
                    managerSoloVoucherTypes: e.target.value.split(",").map((value) => value.trim()).filter(Boolean),
                  },
                });
                setPreview(null);
              }}
              placeholder="external_payment, file_transfer"
            />
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Approval Thresholds</Label>
              <Button type="button" variant="outline" disabled={disabled} onClick={() => {
                setForm({
                  ...form,
                  approvalRules: {
                    ...form.approvalRules,
                    thresholds: [...form.approvalRules.thresholds, { minAmount: 0, maxAmount: undefined, requiresPartnerApproval: true }],
                  },
                });
                setPreview(null);
              }}>
                Add Threshold
              </Button>
            </div>
            {form.approvalRules.thresholds.map((rule, index) => (
              <div key={`approval-threshold-${index}`} className="grid gap-3 rounded-md border border-slate-200 p-3 md:grid-cols-4">
                <Input type="number" value={rule.minAmount ?? ""} disabled={disabled} placeholder="Min amount" onChange={(e) => updateApprovalThreshold(index, { minAmount: e.target.value ? Number(e.target.value) : undefined })} />
                <Input type="number" value={rule.maxAmount ?? ""} disabled={disabled} placeholder="Max amount" onChange={(e) => updateApprovalThreshold(index, { maxAmount: e.target.value ? Number(e.target.value) : undefined })} />
                <div className="flex items-center justify-between rounded-md border border-slate-200 px-3">
                  <Label>Partner Approval</Label>
                  <Switch checked={Boolean(rule.requiresPartnerApproval)} disabled={disabled} onCheckedChange={(checked) => updateApprovalThreshold(index, { requiresPartnerApproval: checked })} />
                </div>
                <Button type="button" variant="outline" disabled={disabled} onClick={() => {
                  setForm({
                    ...form,
                    approvalRules: { ...form.approvalRules, thresholds: form.approvalRules.thresholds.filter((_, i) => i !== index) },
                  });
                  setPreview(null);
                }}>
                  Remove
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment Voucher SLA</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Default Hours</Label>
              <Input type="number" value={form.paymentVoucherSla.defaultHours} disabled={disabled} onChange={(e) => {
                setForm({ ...form, paymentVoucherSla: { ...form.paymentVoucherSla, defaultHours: Number(e.target.value || 0) } });
                setPreview(null);
              }} />
            </div>
            <div className="space-y-2">
              <Label>Urgent Hours</Label>
              <Input type="number" value={form.paymentVoucherSla.urgentHours} disabled={disabled} onChange={(e) => {
                setForm({ ...form, paymentVoucherSla: { ...form.paymentVoucherSla, urgentHours: Number(e.target.value || 0) } });
                setPreview(null);
              }} />
            </div>
            <div className="space-y-2">
              <Label>Due Soon Minutes</Label>
              <Input type="number" value={form.paymentVoucherSla.dueSoonMinutes} disabled={disabled} onChange={(e) => {
                setForm({ ...form, paymentVoucherSla: { ...form.paymentVoucherSla, dueSoonMinutes: Number(e.target.value || 0) } });
                setPreview(null);
              }} />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {VOUCHER_TYPES.map((voucherType) => (
              <div key={voucherType.key} className="space-y-2">
                <Label>{voucherType.label} Hours</Label>
                <Input
                  type="number"
                  value={form.paymentVoucherSla.voucherTypeHours[voucherType.key] ?? 0}
                  disabled={disabled}
                  onChange={(e) => {
                    setForm({
                      ...form,
                      paymentVoucherSla: {
                        ...form.paymentVoucherSla,
                        voucherTypeHours: {
                          ...form.paymentVoucherSla.voucherTypeHours,
                          [voucherType.key]: Number(e.target.value || 0),
                        },
                      },
                    });
                    setPreview(null);
                  }}
                />
              </div>
            ))}
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>SLA Thresholds By Amount</Label>
              <Button type="button" variant="outline" disabled={disabled} onClick={() => {
                setForm({
                  ...form,
                  paymentVoucherSla: {
                    ...form.paymentVoucherSla,
                    thresholds: [...form.paymentVoucherSla.thresholds, { minAmount: 0, maxAmount: undefined, hours: form.paymentVoucherSla.defaultHours }],
                  },
                });
                setPreview(null);
              }}>
                Add SLA Threshold
              </Button>
            </div>
            {form.paymentVoucherSla.thresholds.map((rule, index) => (
              <div key={`sla-threshold-${index}`} className="grid gap-3 rounded-md border border-slate-200 p-3 md:grid-cols-4">
                <Input type="number" value={rule.minAmount ?? ""} disabled={disabled} placeholder="Min amount" onChange={(e) => updateSlaThreshold(index, { minAmount: e.target.value ? Number(e.target.value) : undefined })} />
                <Input type="number" value={rule.maxAmount ?? ""} disabled={disabled} placeholder="Max amount" onChange={(e) => updateSlaThreshold(index, { maxAmount: e.target.value ? Number(e.target.value) : undefined })} />
                <Input type="number" value={rule.hours} disabled={disabled} placeholder="Hours" onChange={(e) => updateSlaThreshold(index, { hours: Number(e.target.value || 0) })} />
                <Button type="button" variant="outline" disabled={disabled} onClick={() => {
                  setForm({
                    ...form,
                    paymentVoucherSla: { ...form.paymentVoucherSla, thresholds: form.paymentVoucherSla.thresholds.filter((_, i) => i !== index) },
                  });
                  setPreview(null);
                }}>
                  Remove
                </Button>
              </div>
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
              <Label>Notify Assigned Account User</Label>
              <Switch checked={form.paymentVoucherSla.notifyAssignedAccountUser} disabled={disabled} onCheckedChange={(checked) => {
                setForm({ ...form, paymentVoucherSla: { ...form.paymentVoucherSla, notifyAssignedAccountUser: checked } });
                setPreview(null);
              }} />
            </div>
            <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
              <Label>Notify Account Manager</Label>
              <Switch checked={form.paymentVoucherSla.notifyAccountManager} disabled={disabled} onCheckedChange={(checked) => {
                setForm({ ...form, paymentVoucherSla: { ...form.paymentVoucherSla, notifyAccountManager: checked } });
                setPreview(null);
              }} />
            </div>
            <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
              <Label>Notify Partner On Overdue</Label>
              <Switch checked={form.paymentVoucherSla.notifyPartnerOnOverdue} disabled={disabled} onCheckedChange={(checked) => {
                setForm({ ...form, paymentVoucherSla: { ...form.paymentVoucherSla, notifyPartnerOnOverdue: checked } });
                setPreview(null);
              }} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Clerk Action SLA</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Acknowledge Hours</Label>
              <Input type="number" value={form.clerkActionSla.acknowledgeHours} disabled={disabled} onChange={(e) => {
                setForm({ ...form, clerkActionSla: { ...form.clerkActionSla, acknowledgeHours: Number(e.target.value || 0) } });
                setPreview(null);
              }} />
            </div>
            <div className="space-y-2">
              <Label>Completion Hours</Label>
              <Input type="number" value={form.clerkActionSla.completionHours} disabled={disabled} onChange={(e) => {
                setForm({ ...form, clerkActionSla: { ...form.clerkActionSla, completionHours: Number(e.target.value || 0) } });
                setPreview(null);
              }} />
            </div>
            <div className="space-y-2">
              <Label>Due Soon Minutes</Label>
              <Input type="number" value={form.clerkActionSla.dueSoonMinutes} disabled={disabled} onChange={(e) => {
                setForm({ ...form, clerkActionSla: { ...form.clerkActionSla, dueSoonMinutes: Number(e.target.value || 0) } });
                setPreview(null);
              }} />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
              <Label>Notify Case Owner</Label>
              <Switch checked={form.clerkActionSla.notifyCaseOwner} disabled={disabled} onCheckedChange={(checked) => {
                setForm({ ...form, clerkActionSla: { ...form.clerkActionSla, notifyCaseOwner: checked } });
                setPreview(null);
              }} />
            </div>
            <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
              <Label>Notify Partner On Overdue</Label>
              <Switch checked={form.clerkActionSla.notifyPartnerOnOverdue} disabled={disabled} onCheckedChange={(checked) => {
                setForm({ ...form, clerkActionSla: { ...form.clerkActionSla, notifyPartnerOnOverdue: checked } });
                setPreview(null);
              }} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border border-slate-200 p-3">
            <Label htmlFor="proof-required">Proof Of Payment Required</Label>
            <Switch id="proof-required" checked={form.paymentProofRequired} disabled={disabled} onCheckedChange={(checked) => {
              setForm({ ...form, paymentProofRequired: checked });
              setPreview(null);
            }} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Permission Template Preview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {previewChanges.length === 0 ? (
            <div className="text-sm text-slate-500">Run preview to inspect additions and removals before applying the role template.</div>
          ) : (
            previewChanges.map((change) => (
              <div key={change.roleId} className="rounded-md border border-slate-200 p-4">
                <div className="font-medium text-slate-900">{roleNameById.get(change.roleId) ?? `Role #${change.roleId}`}</div>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <div>
                    <div className="mb-2 text-sm font-medium text-green-700">Will Add</div>
                    <div className="space-y-1 text-sm text-slate-700">
                      {change.additions.length === 0 ? <div className="text-slate-400">No additions</div> : change.additions.map((item, index) => (
                        <div key={`add-${change.roleId}-${index}`}>{item.module}:{item.action}</div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 text-sm font-medium text-red-700">Will Remove</div>
                    <div className="space-y-1 text-sm text-slate-700">
                      {change.removals.length === 0 ? <div className="text-slate-400">No removals</div> : change.removals.map((item, index) => (
                        <div key={`remove-${change.roleId}-${index}`}>{item.module}:{item.action}</div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
