import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";
import { PlatformPage, PlatformPageHeader } from "@/components/platform/page";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";

type Plan = {
  id: number;
  name: string;
  priceMonthly: string;
  maxUsers: number | null;
  maxCasesPerMonth: number | null;
  features: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

const FEATURE_CATALOG = [
  { key: "allow_doc_automation", label: "Document Automation" },
  { key: "allow_client_portal", label: "Client Portal" },
  { key: "allow_accounting", label: "Accounting Module" },
  { key: "custom_branding", label: "Custom Branding" },
] as const;

type FeatureKey = (typeof FEATURE_CATALOG)[number]["key"];

const FEATURE_KEYS = new Set<string>(FEATURE_CATALOG.map((f) => f.key));

const createFeatureState = (source?: Record<string, unknown> | null): Record<FeatureKey, boolean> => {
  const s: Record<FeatureKey, boolean> = {} as Record<FeatureKey, boolean>;
  for (const f of FEATURE_CATALOG) {
    const v = source?.[f.key];
    s[f.key] = v === true || v === "true" || v === 1 || v === "1";
  }
  return s;
};

export default function PlatformSubscriptionPlansPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);

  const [name, setName] = useState("");
  const [priceMonthly, setPriceMonthly] = useState("");
  const [maxUsers, setMaxUsers] = useState<string>("");
  const [maxCasesPerMonth, setMaxCasesPerMonth] = useState<string>("");
  const [isActive, setIsActive] = useState(true);
  const [features, setFeatures] = useState<Record<FeatureKey, boolean>>(() => createFeatureState({}));
  const [extraFeatures, setExtraFeatures] = useState<Record<string, unknown>>({});

  const plansQuery = useQuery({
    queryKey: ["subscription-plans-admin"],
    queryFn: async () => unwrapApiData<{ items: Plan[] }>(await apiFetchJson("/subscription-plans")),
    retry: false,
  });

  const items = useMemo(() => {
    const rows = plansQuery.data?.items ?? [];
    return Array.isArray(rows) ? rows : [];
  }, [plansQuery.data]);

  const resetForm = () => {
    setEditing(null);
    setName("");
    setPriceMonthly("");
    setMaxUsers("");
    setMaxCasesPerMonth("");
    setIsActive(true);
    setFeatures(createFeatureState({}));
    setExtraFeatures({});
  };

  const openCreate = () => {
    resetForm();
    setOpen(true);
  };

  const openEdit = (p: Plan) => {
    const rawFeatures =
      p.features && typeof p.features === "object" && !Array.isArray(p.features)
        ? (p.features as Record<string, unknown>)
        : {};
    setEditing(p);
    setName(p.name ?? "");
    setPriceMonthly(String(p.priceMonthly ?? ""));
    setMaxUsers(p.maxUsers == null ? "" : String(p.maxUsers));
    setMaxCasesPerMonth(p.maxCasesPerMonth == null ? "" : String(p.maxCasesPerMonth));
    setIsActive(!!p.isActive);
    setFeatures(createFeatureState(rawFeatures));
    setExtraFeatures(Object.fromEntries(Object.entries(rawFeatures).filter(([k]) => !FEATURE_KEYS.has(k))));
    setOpen(true);
  };

  const setAllFeatures = (checked: boolean) => {
    setFeatures(() => {
      const next: Record<FeatureKey, boolean> = {} as Record<FeatureKey, boolean>;
      for (const f of FEATURE_CATALOG) next[f.key] = checked;
      return next;
    });
  };

  const upsertMutation = useMutation({
    mutationFn: async () => {
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error("Name is required");
      const trimmedPrice = priceMonthly.trim();
      if (!trimmedPrice) throw new Error("Price is required");
      const featuresPayload: Record<string, unknown> = {
        ...extraFeatures,
        ...Object.fromEntries(FEATURE_CATALOG.map((f) => [f.key, !!features[f.key]])),
      };

      const body = {
        name: trimmedName,
        priceMonthly: trimmedPrice,
        maxUsers: maxUsers.trim() ? Number(maxUsers) : null,
        maxCasesPerMonth: maxCasesPerMonth.trim() ? Number(maxCasesPerMonth) : null,
        features: featuresPayload,
        isActive,
      };

      if (editing) {
        const res = await apiFetchJson(`/subscription-plans/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
        return unwrapApiData(res);
      }

      const res = await apiFetchJson("/subscription-plans", { method: "POST", body: JSON.stringify(body) });
      return unwrapApiData(res);
    },
    onSuccess: async () => {
      toast({ title: editing ? "Plan updated" : "Plan created" });
      setOpen(false);
      resetForm();
      await qc.invalidateQueries({ queryKey: ["subscription-plans-admin"] });
      await qc.invalidateQueries({ queryKey: ["subscription-plans"] });
    },
    onError: (e) => toastError(toast, e, "Save failed"),
  });

  return (
    <PlatformPage>
      <PlatformPageHeader
        title="Subscription Plans"
        description="Database-driven plans (pricing, limits, and feature flags)."
        actions={<Button onClick={openCreate}>New Plan</Button>}
      />

      <Card>
        <CardContent className="p-0">
          {plansQuery.isLoading ? (
            <div className="p-8 text-center text-slate-500">Loading...</div>
          ) : plansQuery.isError ? (
            <div className="p-8 text-center text-slate-500">Failed to load plans</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3 font-semibold">Name</th>
                    <th className="px-6 py-3 font-semibold text-right">Price (RM)</th>
                    <th className="px-6 py-3 font-semibold text-right">Max Users</th>
                    <th className="px-6 py-3 font-semibold text-right">Max Cases / Month</th>
                    <th className="px-6 py-3 font-semibold">Status</th>
                    <th className="px-6 py-3 font-semibold">Features</th>
                    <th className="px-6 py-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((p) => {
                    const featuresCount = p.features && typeof p.features === "object" ? Object.keys(p.features).length : 0;
                    return (
                      <tr key={p.id} className="hover:bg-slate-50/50">
                        <td className="px-6 py-4 font-medium text-slate-900">{p.name}</td>
                        <td className="px-6 py-4 text-right text-slate-900">RM {Number(p.priceMonthly ?? 0).toFixed(2)}</td>
                        <td className="px-6 py-4 text-right text-slate-700">{p.maxUsers == null ? "—" : p.maxUsers}</td>
                        <td className="px-6 py-4 text-right text-slate-700">{p.maxCasesPerMonth == null ? "—" : p.maxCasesPerMonth}</td>
                        <td className="px-6 py-4">
                          {p.isActive ? (
                            <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white">Active</Badge>
                          ) : (
                            <Badge variant="outline">Inactive</Badge>
                          )}
                        </td>
                        <td className="px-6 py-4 text-slate-700">{featuresCount} keys</td>
                        <td className="px-6 py-4 text-right">
                          <Button variant="outline" size="sm" onClick={() => openEdit(p)}>Edit</Button>
                        </td>
                      </tr>
                    );
                  })}
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-10 text-center text-slate-500">No plans.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={(v) => { if (!v) { setOpen(false); resetForm(); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Plan" : "New Plan"}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Professional Plan" />
            </div>
            <div className="space-y-2">
              <Label>Price Monthly (RM)</Label>
              <Input value={priceMonthly} onChange={(e) => setPriceMonthly(e.target.value)} placeholder="e.g. 199.00" />
            </div>
            <div className="space-y-2">
              <Label>Max Users (optional)</Label>
              <Input value={maxUsers} onChange={(e) => setMaxUsers(e.target.value)} placeholder="e.g. 20" />
            </div>
            <div className="space-y-2">
              <Label>Max Cases Per Month (optional)</Label>
              <Input value={maxCasesPerMonth} onChange={(e) => setMaxCasesPerMonth(e.target.value)} placeholder="e.g. 200" />
            </div>
            <div className="flex items-center justify-between rounded border border-slate-200 px-3 py-2 md:col-span-2">
              <div className="text-sm text-slate-700">Active</div>
              <Switch checked={isActive} onCheckedChange={setIsActive} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <div className="flex items-center justify-between">
                <Label>Features</Label>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setAllFeatures(true)} disabled={upsertMutation.isPending}>
                    Select All
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setAllFeatures(false)} disabled={upsertMutation.isPending}>
                    Deselect All
                  </Button>
                </div>
              </div>

              <div className="rounded border border-slate-200 p-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {FEATURE_CATALOG.map((f) => (
                    <label key={f.key} htmlFor={`feature-${f.key}`} className="flex items-center gap-2 text-sm text-slate-800">
                      <Checkbox
                        id={`feature-${f.key}`}
                        checked={!!features[f.key]}
                        onCheckedChange={(v) => setFeatures((prev) => ({ ...prev, [f.key]: v === true }))}
                        disabled={upsertMutation.isPending}
                      />
                      <span>{f.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setOpen(false); resetForm(); }} disabled={upsertMutation.isPending}>Cancel</Button>
            <Button onClick={() => upsertMutation.mutate()} disabled={upsertMutation.isPending}>
              {upsertMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PlatformPage>
  );
}
