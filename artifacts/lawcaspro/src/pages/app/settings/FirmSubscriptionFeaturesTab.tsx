import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CreditCard, CheckCircle2, XCircle, Clock, Layers, Package, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { useState } from "react";
import { apiFetchJson } from "@/lib/api-client";
import { unwrapApiData } from "@/lib/api-contract";
import { useAuth } from "@/lib/auth-context";

type FeatureDefLike = {
  key: string;
  name: string;
  module: string;
  level: "module" | "submodule" | "feature" | "action";
  parent: string | null;
  planControlled?: boolean;
  firmControlled?: boolean;
};

type EntitlementLike = {
  enabled: boolean;
  source: "plan" | "founder_override" | "temporary_override" | "emergency_disable";
  planDefault?: boolean;
  limit?: number | null;
  usage?: number | null;
  trialExpiry?: string | null;
  expiryAt?: string | null;
  reason?: string;
};

export function FirmSubscriptionFeaturesTab({ firmId }: { firmId: number }) {
  const [search, setSearch] = useState("");
  const { user } = useAuth();
  const userId = (user as any)?.id ?? null;
  const registry = useQuery({
    queryKey: ["platform-feature-registry"],
    queryFn: async () =>
      unwrapApiData<{ features: FeatureDefLike[]; modules: Array<{ key: string; name: string }> }>(
        await apiFetchJson("/platform/feature-registry")
      ),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const entitlements = useQuery({
    queryKey: ["firm", String(firmId), "user", String(userId), "firm-subscription-features"],
    queryFn: async () => {
      const raw = unwrapApiData<any>(
        await apiFetchJson(`/users/_self/effective-features`)
      );
      const effective: Record<string, any> = raw?.effective ?? {};
      const items: Record<string, EntitlementLike> = {};
      for (const k of Object.keys(effective)) {
        const v = effective[k] as any;
        items[k] = {
          enabled: Boolean(v?.enabled),
          source: (v?.source as any) ?? "plan",
          planDefault: Boolean(v?.enabled),
        };
      }
      return { items } as { items: Record<string, EntitlementLike> };
    },
    staleTime: 60 * 1000,
    enabled: !!firmId,
    retry: 1,
  });

  const rows = useMemo(() => {
    const features = registry.data?.features ?? [];
    const items = entitlements.data?.items ?? {};
    const sr = search.trim().toLowerCase();
    return features
      .map((f) => ({ def: f, ent: items[f.key] }))
      .filter(({ def, ent }) => {
        if (!def.planControlled && !ent) return false;
        if (sr) {
          const hay = `${def.key} ${def.name} ${def.module}`.toLowerCase();
          if (!hay.includes(sr)) return false;
        }
        return true;
      })
      .sort((a, b) => a.def.module.localeCompare(b.def.module) || a.def.key.localeCompare(b.def.key));
  }, [registry.data, entitlements.data, search]);

  const modules = registry.data?.modules ?? [];

  const stats = useMemo(() => {
    const enabled = rows.filter((r) => r.ent?.enabled).length;
    const disabled = rows.length - enabled;
    const trial = rows.filter((r) => r.ent?.trialExpiry).length;
    const limited = rows.filter((r) => (r.ent?.limit ?? 0) >= 0).length;
    return { enabled, disabled, trial, limited, total: rows.length };
  }, [rows]);

  return (
    <Tabs defaultValue="overview" className="w-full">
      <div className="mb-2">
        <TabsList>
          <TabsTrigger value="overview">Plan</TabsTrigger>
          <TabsTrigger value="features">Features</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="overview">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Card>
            <CardContent className="p-4 space-y-1">
              <div className="text-xs text-slate-500 flex items-center gap-1"><Package className="w-3.5 h-3.5" />Total Features</div>
              <div className="text-2xl font-semibold">{stats.total}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 space-y-1">
              <div className="text-xs text-slate-500 flex items-center gap-1 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" />Included</div>
              <div className="text-2xl font-semibold text-emerald-700">{stats.enabled}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 space-y-1">
              <div className="text-xs text-slate-500 flex items-center gap-1 text-slate-600"><XCircle className="w-3.5 h-3.5" />Not Included</div>
              <div className="text-2xl font-semibold text-slate-600">{stats.disabled}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 space-y-1">
              <div className="text-xs text-slate-500 flex items-center gap-1 text-amber-700"><Clock className="w-3.5 h-3.5" />Trial / Limited</div>
              <div className="text-2xl font-semibold text-amber-700">{stats.trial + stats.limited}</div>
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><CreditCard className="w-4 h-4" />Subscription Summary</CardTitle>
            <CardDescription>Review your current plan entitlements. Contact Lawcaspro sales to upgrade or enable trials.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-slate-700 space-y-1">
            <div>Module count: <span className="font-medium">{modules.length}</span></div>
            <div>Total features: <span className="font-medium">{stats.total}</span></div>
            <div>Available now: <span className="font-medium text-emerald-700">{stats.enabled}</span></div>
            <div>Not included in plan: <span className="font-medium text-slate-600">{stats.disabled}</span></div>
            <div className="pt-3 text-xs text-slate-500 flex items-start gap-1">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              Entitlements are managed by your plan and Lawcaspro Founder. Firm users cannot modify entitlements directly.
            </div>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="features">
        <Card>
          <CardContent className="p-0">
            <div className="p-3 border-b border-slate-200 bg-slate-50/70 flex gap-2 items-center">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input placeholder="Search features..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
              </div>
              <Button variant="outline" size="sm" onClick={() => entitlements.refetch()}>Refresh</Button>
            </div>
            <div
              className="grid gap-2 items-center px-3 py-2 text-[11px] uppercase tracking-wider text-slate-500 bg-white/60 border-b border-slate-200"
              style={{ gridTemplateColumns: "minmax(220px, 2fr) 120px 140px 200px 180px" }}
            >
              <div>Feature</div>
              <div>Status</div>
              <div>Limit</div>
              <div>Usage</div>
              <div>Trial Expiry</div>
            </div>
            <div className="divide-y divide-slate-100 max-h-[560px] overflow-y-auto">
              {rows.length === 0 ? (
                <div className="py-10 text-center text-sm text-slate-500">No features match your filters.</div>
              ) : (
                rows.map(({ def, ent }) => {
                  const enabled = ent?.enabled ?? false;
                  return (
                    <div
                      key={def.key}
                      className="grid gap-2 items-center px-3 py-2 hover:bg-slate-50/60"
                      style={{ gridTemplateColumns: "minmax(220px, 2fr) 120px 140px 200px 180px" }}
                    >
                      <div className="flex flex-col min-w-0">
                        <span className="font-medium text-sm text-slate-900 truncate">{def.name ?? def.key}</span>
                        <span className="font-mono text-[11px] text-slate-500 truncate">{def.key}</span>
                        <div className="flex gap-1 mt-0.5 flex-wrap">
                          <Badge variant="outline" className="text-[10px]">{def.module}</Badge>
                          <Badge variant="secondary" className="text-[10px]">{def.level}</Badge>
                          {ent?.source && ent.source !== "plan" ? (
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${
                                ent.source === "emergency_disable"
                                  ? "border-rose-400 text-rose-700 bg-rose-50"
                                  : ent.source === "founder_override"
                                    ? "border-sky-400 text-sky-700 bg-sky-50"
                                    : "border-amber-400 text-amber-700 bg-amber-50"
                              }`}
                            >
                              {ent.source.replace("_", " ")}
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                      <div>
                        {enabled ? (
                          <Badge variant="outline" className="gap-1 text-xs border-emerald-400 text-emerald-700 bg-emerald-50">
                            <CheckCircle2 className="w-3 h-3" /> Included
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="gap-1 text-xs border-slate-300 text-slate-500 bg-slate-50">
                            <XCircle className="w-3 h-3" /> Not Included
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-slate-600 truncate">
                        {ent?.limit != null
                          ? typeof ent.limit === "number" && ent.limit < 0
                            ? "Unlimited"
                            : String(ent.limit)
                          : enabled
                            ? "Included"
                            : "—"}
                      </div>
                      <div className="text-xs text-slate-600 truncate">
                        {ent?.usage != null && ent?.limit != null && ent.limit >= 0
                          ? `${String(ent.usage)} / ${String(ent.limit)}`
                          : ent?.usage != null
                            ? String(ent.usage)
                            : "—"}
                      </div>
                      <div className="text-xs text-slate-600 truncate">
                        {ent?.trialExpiry
                          ? new Date(ent.trialExpiry).toLocaleString()
                          : ent?.expiryAt
                            ? new Date(ent.expiryAt).toLocaleString()
                            : "—"}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="billing">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><CreditCard className="w-4 h-4" />Billing</CardTitle>
            <CardDescription>View invoices, update payment method, or manage plan.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-slate-600 space-y-2">
            <div>Billing portal is being prepared. Contact support or your plan administrator for statements and invoices.</div>
            <div className="flex gap-2 pt-2 flex-wrap">
              <Button variant="outline" size="sm" disabled>View Invoices</Button>
              <Button variant="outline" size="sm" disabled>Manage Payment Method</Button>
              <Button variant="outline" size="sm" disabled>Upgrade Plan</Button>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

export default FirmSubscriptionFeaturesTab;
