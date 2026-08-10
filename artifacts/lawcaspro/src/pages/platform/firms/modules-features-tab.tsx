import { useMemo, useState, type ReactElement } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, ChevronDown, ChevronRight, AlertTriangle, RotateCcw, AlertOctagon, Filter, CheckCircle2, XCircle, Layers, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { unwrapApiData } from "@/lib/api-contract";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type OverrideMode = "plan" | "enabled" | "disabled";
type SourceKind = "plan" | "founder_override" | "temporary_override" | "emergency_disable";

type FeatureDefLike = {
  key: string;
  name: string;
  module: string;
  parent: string | null;
  level: "module" | "submodule" | "feature" | "action";
  dependencies?: string[];
  routeHint?: string;
  valueType?: string;
  defaultValue?: string;
  status?: string;
  description?: string;
  planControlled?: boolean;
  firmControlled?: boolean;
};

type EntitlementLike = {
  enabled: boolean;
  source: SourceKind;
  reason?: string;
  limit?: number | null;
  usage?: number | null;
  trialExpiry?: string | null;
  planDefault?: boolean;
  overrideMode?: OverrideMode | null;
  expiryAt?: string | null;
  parentDenied?: boolean;
  dependencyDenied?: boolean;
  emergency?: boolean;
};

type RegistryResp = {
  features: FeatureDefLike[];
  modules: Array<{ key: string; name: string }>;
  jobGuardMap?: Record<string, string[]>;
  counts: { modules: number; features: number };
};

function useFeatureRegistry() {
  return useQuery<RegistryResp>({
    queryKey: ["platform-feature-registry"],
    queryFn: async () => {
      return unwrapApiData<RegistryResp>(await apiFetchJson("/platform/feature-registry"));
    },
    staleTime: 1000 * 60 * 5,
    retry: false,
  });
}

function useFirmEntitlements(firmId: number, enabled = true) {
  return useQuery<{ items: Record<string, EntitlementLike> }>({
    queryKey: ["founder-firm-entitlements", firmId],
    queryFn: async () => {
      return unwrapApiData<{ items: Record<string, EntitlementLike> }>(
        await apiFetchJson(`/founder/firms/${firmId}/entitlements/effective?includeAllKeys=true`)
      );
    },
    staleTime: 1000 * 30,
    enabled: !!firmId && enabled,
    retry: false,
  });
}

function sourceBadge(source: SourceKind, emergency?: boolean) {
  if (emergency || source === "emergency_disable") {
    return <Badge variant="destructive" className="gap-1 text-xs"><AlertOctagon className="w-3 h-3" />Emergency</Badge>;
  }
  switch (source) {
    case "plan":
      return <Badge variant="secondary" className="text-xs">Plan</Badge>;
    case "founder_override":
      return <Badge variant="outline" className="text-xs border-sky-500 text-sky-700 bg-sky-50">Founder Override</Badge>;
    case "temporary_override":
      return <Badge variant="outline" className="text-xs border-amber-500 text-amber-700 bg-amber-50">Temporary</Badge>;
    default:
      return <Badge variant="outline" className="text-xs">{source}</Badge>;
  }
}

function EffectiveBadge({ v }: { v: boolean }) {
  return v ? (
    <Badge variant="outline" className="gap-1 text-xs border-emerald-500 text-emerald-700 bg-emerald-50">
      <CheckCircle2 className="w-3 h-3" /> Enabled
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1 text-xs border-slate-400 text-slate-600 bg-slate-50">
      <XCircle className="w-3 h-3" /> Disabled
    </Badge>
  );
}

function OverrideModeSelect({ value, onChange, disabled }: { value: OverrideMode; onChange: (v: OverrideMode) => void; disabled?: boolean }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as OverrideMode)} disabled={disabled}>
      <SelectTrigger className="w-[150px] h-8 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="plan">Use Plan Default</SelectItem>
        <SelectItem value="enabled">Enabled</SelectItem>
        <SelectItem value="disabled">Disabled</SelectItem>
      </SelectContent>
    </Select>
  );
}

function ExpiryBadge({ expiryAt }: { expiryAt?: string | null }) {
  if (!expiryAt) return <span className="text-xs text-slate-400">—</span>;
  const t = new Date(expiryAt).getTime();
  if (t < Date.now()) return <Badge variant="outline" className="text-xs border-slate-400 text-slate-500">Expired</Badge>;
  return (
    <Badge variant="outline" className="text-xs border-amber-400 text-amber-700 bg-amber-50">
      Expires {new Date(expiryAt).toLocaleDateString()}
    </Badge>
  );
}

function buildTree(features: FeatureDefLike[]) {
  const byKey = new Map<string, { def: FeatureDefLike; children: string[] }>();
  const roots: string[] = [];
  for (const f of features) {
    byKey.set(f.key, { def: f, children: [] });
  }
  for (const f of features) {
    if (f.parent && byKey.has(f.parent)) {
      byKey.get(f.parent)!.children.push(f.key);
    } else {
      roots.push(f.key);
    }
  }
  // sort children by module, then by name
  const sortFn = (a: string, b: string) => {
    const da = byKey.get(a)!.def;
    const db = byKey.get(b)!.def;
    if (da.module !== db.module) return da.module.localeCompare(db.module);
    return (da.name || da.key).localeCompare(db.name || db.key);
  };
  roots.sort(sortFn);
  for (const node of byKey.values()) node.children.sort(sortFn);
  return { byKey, roots };
}

export function FirmModulesFeaturesTab({ firmId, firmName }: { firmId: number; firmName: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("__all__");
  const [showOverridesOnly, setShowOverridesOnly] = useState(false);
  const [onlyDisabled, setOnlyDisabled] = useState(false);
  const [expandAll, setExpandAll] = useState<null | boolean>(null);
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({});

  const registry = useFeatureRegistry();
  const entitlements = useFirmEntitlements(firmId);

  const tree = useMemo(() => {
    if (!registry.data) return { byKey: new Map(), roots: [] as string[] };
    return buildTree(registry.data.features);
  }, [registry.data]);

  const modules = registry.data?.modules ?? [];

  const filtersMatch = (key: string): boolean => {
    const def = tree.byKey.get(key)?.def;
    if (!def) return false;
    if (category !== "__all__" && def.module !== category) return false;
    const sr = search.trim().toLowerCase();
    if (sr) {
      const hay = `${def.key} ${def.name ?? ""} ${def.description ?? ""} ${def.module}`.toLowerCase();
      if (!hay.includes(sr)) return false;
    }
    const ent = entitlements.data?.items[key];
    if (showOverridesOnly) {
      if (!ent || (ent.source !== "founder_override" && ent.source !== "temporary_override" && ent.source !== "emergency_disable")) return false;
    }
    if (onlyDisabled) {
      if (!ent || ent.enabled) return false;
    }
    return true;
  };

  const anyDescendantMatches = (key: string): boolean => {
    if (filtersMatch(key)) return true;
    const node = tree.byKey.get(key);
    if (!node) return false;
    for (const c of node.children) if (anyDescendantMatches(c)) return true;
    return false;
  };

  const invalidateEntitlements = async () => {
    await qc.invalidateQueries({ queryKey: ["founder-firm-entitlements", firmId] });
    await qc.invalidateQueries({ queryKey: ["firm", "entitlements"] });
  };

  const setOverride = async (featureKey: string, mode: OverrideMode, reason = "Founder override (Modules & Features)") => {
    try {
      if (mode === "plan") {
        await apiFetchJson(`/founder/firms/${firmId}/entitlements/${featureKey}`, { method: "DELETE" });
      } else {
        await apiFetchJson(`/founder/firms/${firmId}/entitlements`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            featureKey,
            enabled: mode === "enabled",
            overrideType: "founder_override",
            reason,
          }),
        });
      }
      toast({ title: "Entitlement updated", description: featureKey });
      await invalidateEntitlements();
    } catch (e) {
      toastError(toast, e, "Update failed");
    }
  };

  const bulkAction = async (action: "enable" | "disable" | "reset") => {
    try {
      await apiFetchJson(`/founder/firms/${firmId}/entitlements/bulk-override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          scope: search || category !== "__all__" || showOverridesOnly || onlyDisabled ? "filtered" : "all",
          filters: {
            module: category !== "__all__" ? category : undefined,
            search: search || undefined,
            overridesOnly: showOverridesOnly,
            disabledOnly: onlyDisabled,
          },
        }),
      });
      toast({ title: `Bulk ${action} applied` });
      await invalidateEntitlements();
    } catch (e) {
      toastError(toast, e, "Bulk action failed");
    }
  };

  const resetAllToPlan = async () => {
    if (!window.confirm("Reset ALL overrides for this firm to Plan defaults?")) return;
    try {
      await apiFetchJson(`/founder/firms/${firmId}/entitlements/reset`, { method: "POST" });
      toast({ title: "All entitlements reset to plan defaults" });
      await invalidateEntitlements();
    } catch (e) {
      toastError(toast, e, "Reset failed");
    }
  };

  const emergencyFirmDisable = async (featureKey: string) => {
    const reason = window.prompt("Emergency disable reason (required):");
    if (!reason) return;
    try {
      await apiFetchJson(`/founder/firms/${firmId}/entitlements/emergency`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureKey, enabled: false, reason }),
      });
      toast({ title: "Emergency disabled", description: featureKey });
      await invalidateEntitlements();
    } catch (e) {
      toastError(toast, e, "Emergency disable failed");
    }
  };

  const toggleExpand = (k: string) => {
    setExpandOverrides((prev) => ({ ...prev, [k]: !prev[k] }));
  };

  function getExpandState(k: string): boolean {
    if (expandAll !== null) return expandAll;
    if (k in expandOverrides) return expandOverrides[k];
    // expand modules by default
    const def = tree.byKey.get(k)?.def;
    return !!def && def.level === "module";
  }

  const renderRow = (key: string, depth: number): ReactElement | null => {
    if (!anyDescendantMatches(key)) return null;
    const def = tree.byKey.get(key)!.def;
    const children = tree.byKey.get(key)!.children;
    const ent = entitlements.data?.items[key];
    const expanded = getExpandState(key);
    const hasChildren = children.length > 0;
    const overrideMode: OverrideMode =
      ent?.source === "founder_override"
        ? ent.enabled ? "enabled" : "disabled"
        : ent?.source === "temporary_override"
          ? ent.enabled ? "enabled" : "disabled"
          : "plan";

    return (
      <div key={key}>
        <div
          className={`grid gap-2 items-center py-2 px-2 border-b border-slate-100 hover:bg-slate-50/80`}
          style={{ gridTemplateColumns: "minmax(280px, 2fr) 110px 150px 110px 100px 130px 110px auto" }}
        >
          <div className="flex items-center gap-1 min-w-0" style={{ paddingLeft: 4 + depth * 16 }}>
            {hasChildren ? (
              <button className="p-1 hover:bg-slate-100 rounded" onClick={() => toggleExpand(key)} aria-label="toggle">
                {expanded ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
              </button>
            ) : (
              <span className="w-6 inline-block" />
            )}
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm text-slate-900 truncate">{def.name ?? def.key}</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="font-mono text-[11px] text-slate-500 truncate max-w-[280px]">{def.key}</span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[420px] text-xs">
                      <div><span className="font-semibold">Key:</span> {def.key}</div>
                      <div><span className="font-semibold">Module:</span> {def.module}</div>
                      <div><span className="font-semibold">Level:</span> {def.level}</div>
                      {def.parent ? <div><span className="font-semibold">Parent:</span> {def.parent}</div> : null}
                      {def.dependencies?.length ? <div><span className="font-semibold">Dependencies:</span> {def.dependencies.join(", ")}</div> : null}
                      {def.description ? <div><span className="font-semibold">Description:</span> {def.description}</div> : null}
                      {def.routeHint ? <div><span className="font-semibold">Route hint:</span> {def.routeHint}</div> : null}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                {ent?.parentDenied ? <Badge variant="outline" className="text-[10px] border-slate-300 text-slate-500 bg-slate-50">Parent OFF</Badge> : null}
                {ent?.dependencyDenied ? <Badge variant="outline" className="text-[10px] border-rose-300 text-rose-600 bg-rose-50">Dep Missing</Badge> : null}
              </div>
              <div className="text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-[10px]">{def.module}</Badge>
                <Badge variant="secondary" className="text-[10px]">{def.level}</Badge>
                {def.valueType && def.valueType !== "boolean" ? (
                  <Badge variant="outline" className="text-[10px]">{def.valueType}</Badge>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 text-xs text-slate-600">
            <EffectiveBadge v={ent?.planDefault ?? true} />
          </div>

          <div className="flex items-center">
            <OverrideModeSelect
              value={overrideMode}
              onChange={(m) => setOverride(key, m)}
              disabled={ent?.source === "emergency_disable"}
            />
          </div>

          <div className="flex items-center gap-1 text-xs text-slate-600">
            <EffectiveBadge v={!!ent?.enabled} />
          </div>

          <div className="text-xs text-slate-600 truncate">
            {ent?.limit != null ? (
              <span>
                {ent?.usage != null ? `${ent.usage} / ` : ""}
                {typeof ent.limit === "number" && ent.limit < 0 ? "∞" : String(ent.limit)}
              </span>
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </div>

          <div className="flex items-center gap-1 flex-wrap">
            {sourceBadge((ent?.source ?? "plan") as SourceKind, ent?.emergency)}
          </div>

          <div className="text-xs">
            <ExpiryBadge expiryAt={ent?.trialExpiry ?? ent?.expiryAt} />
          </div>

          <div className="flex items-center gap-1 justify-end pr-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => emergencyFirmDisable(key)}
                    className="h-7 px-2 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                    disabled={ent?.source === "emergency_disable"}
                  >
                    <AlertTriangle className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left" className="text-xs">Emergency disable for this firm (audit logged)</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
        {expanded && hasChildren ? (
          <div>{children.map((c: string) => renderRow(c, depth + 1))}</div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-slate-500" />
            Modules &amp; Features
          </CardTitle>
          <CardDescription>
            Founder controls for <span className="font-medium">{firmName}</span>. Parent OFF disables all children; stored child overrides are preserved when parent toggles.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2 flex-wrap items-center">
            <div className="flex-1 min-w-[220px] relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search by key / name / description..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__"><span className="flex items-center gap-2"><Layers className="w-3.5 h-3.5" />All modules</span></SelectItem>
                {modules.map((m) => (
                  <SelectItem key={m.key} value={m.key}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={() => setExpandAll(expandAll === false ? true : expandAll === true ? null : true)} className="gap-1">
              <ChevronDown className="w-4 h-4" />
              {expandAll === true ? "Collapse All" : "Expand All"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setExpandAll(false)} className="gap-1">
              <ChevronRight className="w-4 h-4" />
              Collapse
            </Button>
            <Button size="sm" variant="outline" onClick={() => entitlements.refetch()} className="gap-1">
              <RefreshCw className={`w-4 h-4 ${entitlements.isRefetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>

          <div className="flex gap-4 items-center flex-wrap text-sm">
            <Label className="flex items-center gap-2 cursor-pointer">
              <Checkbox checked={showOverridesOnly} onCheckedChange={(v) => setShowOverridesOnly(!!v)} />
              Show overrides only
            </Label>
            <Label className="flex items-center gap-2 cursor-pointer">
              <Checkbox checked={onlyDisabled} onCheckedChange={(v) => setOnlyDisabled(!!v)} />
              Disabled only
            </Label>
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              <Filter className="w-4 h-4 text-slate-400" />
              <Button size="sm" variant="outline" onClick={() => bulkAction("enable")} disabled={!firmId}>Enable All (filtered)</Button>
              <Button size="sm" variant="outline" onClick={() => bulkAction("disable")} disabled={!firmId}>Disable All (filtered)</Button>
              <Button size="sm" variant="outline" onClick={() => bulkAction("reset")} disabled={!firmId} className="gap-1">
                <RotateCcw className="w-3.5 h-3.5" /> Reset (filtered)
              </Button>
              <Button size="sm" variant="destructive" onClick={resetAllToPlan} disabled={!firmId} className="gap-1">
                <RotateCcw className="w-3.5 h-3.5" /> Reset All to Plan
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Tabs defaultValue="tree" className="w-full">
            <div className="px-3 pt-3">
              <TabsList>
                <TabsTrigger value="tree">Feature Tree</TabsTrigger>
                <TabsTrigger value="flat">Flat List</TabsTrigger>
                <TabsTrigger value="summary">Summary</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="tree" className="pt-0">
              <div>
                <div
                  className="grid gap-2 items-center px-2 py-2 text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200 bg-slate-50 sticky top-0"
                  style={{ gridTemplateColumns: "minmax(280px, 2fr) 110px 150px 110px 100px 130px 110px auto" }}
                >
                  <div className="pl-2">Feature</div>
                  <div>Plan Default</div>
                  <div>Override</div>
                  <div>Effective</div>
                  <div>Limit/Usage</div>
                  <div>Source</div>
                  <div>Expiry</div>
                  <div className="pr-2"></div>
                </div>
                <div>
                  {!registry.data || !entitlements.data ? (
                    <div className="text-sm text-slate-500 py-10 text-center">Loading entitlements…</div>
                  ) : tree.roots.length === 0 ? (
                    <div className="text-sm text-slate-500 py-10 text-center">No features in registry.</div>
                  ) : (
                    tree.roots.map((k) => renderRow(k, 0))
                  )}
                </div>
              </div>
            </TabsContent>
            <TabsContent value="flat" className="pt-0">
              <div className="text-sm text-slate-500 p-3">Flat list mode shows all features that match filters without hierarchy.</div>
              <div>
                <div
                  className="grid gap-2 items-center px-2 py-2 text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200 bg-slate-50"
                  style={{ gridTemplateColumns: "minmax(280px, 2fr) 110px 150px 110px 100px 130px 110px auto" }}
                >
                  <div className="pl-2">Feature</div>
                  <div>Plan Default</div>
                  <div>Override</div>
                  <div>Effective</div>
                  <div>Limit/Usage</div>
                  <div>Source</div>
                  <div>Expiry</div>
                  <div className="pr-2"></div>
                </div>
                <div>
                  {registry.data?.features
                    .sort((a, b) => a.module.localeCompare(b.module) || a.key.localeCompare(b.key))
                    .filter((f) => anyDescendantMatches(f.key))
                    .map((f) => (
                      <div
                        key={f.key}
                        className={`grid gap-2 items-center py-2 px-2 border-b border-slate-100 hover:bg-slate-50/80`}
                        style={{ gridTemplateColumns: "minmax(280px, 2fr) 110px 150px 110px 100px 130px 110px auto" }}
                      >
                        <div className="flex flex-col min-w-0">
                          <span className="font-medium text-sm">{f.name ?? f.key}</span>
                          <span className="font-mono text-[11px] text-slate-500 truncate">{f.key}</span>
                          <div className="flex gap-1 mt-0.5">
                            <Badge variant="outline" className="text-[10px]">{f.module}</Badge>
                            <Badge variant="secondary" className="text-[10px]">{f.level}</Badge>
                          </div>
                        </div>
                        <EffectiveBadge v={entitlements.data?.items[f.key]?.planDefault ?? true} />
                        <OverrideModeSelect
                          value={
                            (entitlements.data?.items[f.key]?.source === "founder_override" ||
                              entitlements.data?.items[f.key]?.source === "temporary_override")
                              ? (entitlements.data?.items[f.key]?.enabled ? "enabled" : "disabled")
                              : "plan"
                          }
                          onChange={(m) => setOverride(f.key, m)}
                          disabled={entitlements.data?.items[f.key]?.source === "emergency_disable"}
                        />
                        <EffectiveBadge v={!!entitlements.data?.items[f.key]?.enabled} />
                        <div className="text-xs text-slate-600 truncate">
                          {entitlements.data?.items[f.key]?.limit != null
                            ? `${entitlements.data.items[f.key]?.usage ?? 0} / ${
                                typeof entitlements.data.items[f.key]?.limit === "number" &&
                                (entitlements.data.items[f.key]?.limit as number) < 0
                                  ? "∞"
                                  : String(entitlements.data.items[f.key]?.limit)
                              }`
                            : "—"}
                        </div>
                        <div className="flex items-center gap-1 flex-wrap">
                          {sourceBadge((entitlements.data?.items[f.key]?.source ?? "plan") as SourceKind, entitlements.data?.items[f.key]?.emergency)}
                        </div>
                        <ExpiryBadge expiryAt={entitlements.data?.items[f.key]?.trialExpiry ?? entitlements.data?.items[f.key]?.expiryAt} />
                        <div className="flex items-center gap-1 justify-end pr-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => emergencyFirmDisable(f.key)}
                            className="h-7 px-2 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                            disabled={entitlements.data?.items[f.key]?.source === "emergency_disable"}
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </TabsContent>
            <TabsContent value="summary" className="pt-0">
              <div className="p-4 space-y-3 text-sm text-slate-700">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Card><CardContent className="p-4"><div className="text-xs text-slate-500">Modules</div><div className="text-xl font-semibold">{registry.data?.counts.modules ?? 0}</div></CardContent></Card>
                  <Card><CardContent className="p-4"><div className="text-xs text-slate-500">Features</div><div className="text-xl font-semibold">{registry.data?.counts.features ?? 0}</div></CardContent></Card>
                  <Card><CardContent className="p-4"><div className="text-xs text-slate-500">Enabled (effective)</div><div className="text-xl font-semibold text-emerald-700">{Object.values(entitlements.data?.items ?? {}).filter((x) => x.enabled).length}</div></CardContent></Card>
                  <Card><CardContent className="p-4"><div className="text-xs text-slate-500">Overrides</div><div className="text-xl font-semibold text-sky-700">{Object.values(entitlements.data?.items ?? {}).filter((x) => x.source === "founder_override" || x.source === "temporary_override").length}</div></CardContent></Card>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
