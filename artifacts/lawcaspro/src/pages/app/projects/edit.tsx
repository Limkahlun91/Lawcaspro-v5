import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useGetProject, getGetProjectQueryKey, useListDevelopers, getListDevelopersQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X, Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListProjectsQueryKey } from "@workspace/api-client-react";
import { QueryFallback } from "@/components/query-fallback";
import { toastError } from "@/lib/toast-error";
import { apiRequest } from "@/lib/api-client";
import { DateOnlyInput, normalizeDateOnlyFromApi } from "@/components/date-only-input";

interface PropertyType {
  id: string;
  buildingType: string;
}

export default function EditProject() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: project, isLoading: projectLoading, isError: projectError, error, refetch, isFetching } = useGetProject(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectQueryKey(projectId) },
  });

  const listDevelopersParams1 = { limit: 100 };
  const { data: devsResponse } = useListDevelopers(listDevelopersParams1, {
    query: { staleTime: 5 * 60 * 1000, queryKey: getListDevelopersQueryKey(listDevelopersParams1) },
  });
  const developers = devsResponse?.data || [];

  const [name, setName] = useState("");
  const [phase, setPhase] = useState("");
  const [selectedDevId, setSelectedDevId] = useState("");
  const [developerName, setDeveloperName] = useState("");
  const [titleType, setTitleType] = useState<"master" | "individual" | "strata" | "">("");
  const [isEncumbered, setIsEncumbered] = useState<"yes" | "no">("no");
  const [tenure, setTenure] = useState<"freehold" | "leasehold" | "">("");
  const [masterChargeeBank, setMasterChargeeBank] = useState("");
  const [masterChargeeAccount, setMasterChargeeAccount] = useState("");
  const [titleSubtype, setTitleSubtype] = useState("");
  const [masterTitleNumber, setMasterTitleNumber] = useState("");
  const [masterTitleLandSize, setMasterTitleLandSize] = useState("");
  const [mukim, setMukim] = useState("");
  const [daerah, setDaerah] = useState("");
  const [negeri, setNegeri] = useState("");
  const [constructionPeriodMonths, setConstructionPeriodMonths] = useState("");
  const [actualVpDate, setActualVpDate] = useState("");
  const [cccDate, setCccDate] = useState("");
  const [hdaAccount, setHdaAccount] = useState("");
  const [hdaBank, setHdaBank] = useState("");
  const [propertyTypes, setPropertyTypes] = useState<PropertyType[]>([
    { id: crypto.randomUUID(), buildingType: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (project && !initialized) {
      const proj = project as unknown as Record<string, unknown>;
      setName(project.name || "");
      setSelectedDevId(project.developerId?.toString() || "");
      const tt = typeof proj.titleType === "string" ? proj.titleType : "";
      setTitleType(tt === "master" || tt === "strata" || tt === "individual" ? tt : "");
      setIsEncumbered(proj.isEncumbered === true ? "yes" : "no");
      const ten = typeof proj.tenure === "string" ? proj.tenure : "";
      setTenure(ten === "freehold" || ten === "leasehold" ? ten : "");
      setMasterChargeeBank(typeof proj.masterChargeeBank === "string" ? proj.masterChargeeBank : "");
      setMasterChargeeAccount(typeof proj.masterChargeeAccount === "string" ? proj.masterChargeeAccount : "");
      setConstructionPeriodMonths(
        typeof proj.constructionPeriodMonths === "number" ? String(proj.constructionPeriodMonths)
        : typeof (proj as Record<string, unknown>).constructionPeriodMonths === "string" ? String((proj as Record<string, unknown>).constructionPeriodMonths)
        : ""
      );
      setActualVpDate(normalizeDateOnlyFromApi((proj as Record<string, unknown>).actualVpDate));
      setCccDate(normalizeDateOnlyFromApi((proj as Record<string, unknown>).cccDate));
      setHdaAccount(typeof proj.hdaAccount === "string" ? proj.hdaAccount : "");
      setHdaBank(typeof proj.hdaBank === "string" ? proj.hdaBank : "");

      const extra = project.extraFields as Record<string, unknown> | undefined;
      setPhase(typeof proj.phase === "string" ? proj.phase : "");
      setDeveloperName(typeof proj.developerName === "string" ? proj.developerName : "");
      setTitleSubtype(typeof proj.titleSubtype === "string" ? proj.titleSubtype : "");
      setMasterTitleNumber(typeof proj.masterTitleNumber === "string" ? proj.masterTitleNumber : "");
      setMasterTitleLandSize(typeof proj.masterTitleLandSize === "string" ? proj.masterTitleLandSize : "");
      setMukim(typeof proj.mukim === "string" ? proj.mukim : "");
      setDaerah(typeof proj.daerah === "string" ? proj.daerah : "");
      setNegeri(typeof proj.negeri === "string" ? proj.negeri : "");
      const pts = (extra?.propertyTypes as PropertyType[]) || [];
      if (pts.length > 0) {
        setPropertyTypes(pts.map(p => ({ id: p.id || crypto.randomUUID(), buildingType: p.buildingType || "" })));
      }
      setInitialized(true);
    }
  }, [project, initialized]);

  useEffect(() => {
    if (selectedDevId && developers.length > 0) {
      const dev = developers.find((d: any) => d.id === parseInt(selectedDevId));
      if (dev) setDeveloperName(dev.name);
    }
  }, [selectedDevId, developers]);

  const addPropertyType = () => {
    setPropertyTypes(prev => [...prev, { id: crypto.randomUUID(), buildingType: "" }]);
  };

  const removePropertyType = (ptId: string) => {
    setPropertyTypes(prev => prev.filter(p => p.id !== ptId));
  };

  const updatePropertyType = (ptId: string, value: string) => {
    setPropertyTypes(prev => prev.map(p => p.id === ptId ? { ...p, buildingType: value } : p));
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast({ title: "Project name is required", variant: "destructive" });
      return;
    }
    if (!titleType) {
      toast({ title: "Please select a title type", variant: "destructive" });
      return;
    }
    if (!tenure) {
      toast({ title: "Please select tenure", variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      const projectTypeValue = titleType === "strata" ? "highrise" : "landed";
      await apiRequest(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          developerId: selectedDevId ? parseInt(selectedDevId) : undefined,
          projectType: projectTypeValue,
          titleType,
          isEncumbered: isEncumbered === "yes",
          tenure,
          masterChargeeBank: isEncumbered === "yes" ? (masterChargeeBank.trim() || null) : null,
          masterChargeeAccount: masterChargeeAccount.trim() || null,
          constructionPeriodMonths: constructionPeriodMonths.trim() ? Number(constructionPeriodMonths) : null,
          actualVpDate: actualVpDate || null,
          cccDate: cccDate || null,
          hdaAccount: hdaAccount.trim() || null,
          hdaBank: hdaBank.trim() || null,
          phase: phase || null,
          developerName: developerName || null,
          titleSubtype: titleSubtype || null,
          masterTitleNumber: masterTitleNumber || null,
          masterTitleLandSize: masterTitleLandSize || null,
          mukim: mukim || null,
          daerah: daerah || null,
          negeri: negeri || null,
          extraFields: {
            propertyTypes: propertyTypes.filter(p => p.buildingType.trim()),
          },
        }),
      });

      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      toast({ title: "Project updated successfully" });
      setLocation(`/app/projects/${projectId}`);
    } catch (err) {
      toastError(toast, err, "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (projectLoading) {
    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
        <div className="bg-white rounded-lg p-8 text-slate-500">Loading project...</div>
      </div>
    );
  }

  if (projectError) {
    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-lg p-6 w-full max-w-lg">
          <QueryFallback title="Project unavailable" error={error} onRetry={() => refetch()} isRetrying={isFetching} />
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
        <div className="bg-white rounded-lg p-8 text-slate-500">Project not found</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-10 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-[960px] my-8 relative">
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-200">
          <h2 className="text-xl font-bold text-slate-900">Edit Project</h2>
          <button
            onClick={() => setLocation(`/app/projects/${projectId}`)}
            className="text-slate-400 hover:text-slate-600 p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-8 py-6 space-y-6">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <Label className="text-sm font-semibold text-slate-700">Project Name *</Label>
              <Input value={name} onChange={e => setName(e.target.value)} className="mt-1.5" />
            </div>
            <div>
              <Label className="text-sm font-semibold text-slate-700">Phase</Label>
              <Input value={phase} onChange={e => setPhase(e.target.value)} placeholder="e.g., Phase 1" className="mt-1.5" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div>
              <Label className="text-sm font-semibold text-slate-700">Developer (from list)</Label>
              <select
                value={selectedDevId}
                onChange={e => setSelectedDevId(e.target.value)}
                className="w-full h-10 mt-1.5 border border-slate-200 rounded-md px-3 text-sm bg-white"
              >
                <option value="">Select Developer</option>
                {developers.map((dev: any) => (
                  <option key={dev.id} value={dev.id}>{dev.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-sm font-semibold text-slate-700">Developer Name *</Label>
              <Input value={developerName} onChange={e => setDeveloperName(e.target.value)} placeholder="Enter developer name" className="mt-1.5" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div>
              <Label className="text-sm font-semibold text-slate-700">Title Type *</Label>
              <select
                value={titleType}
                onChange={e => {
                  const v = e.target.value;
                  setTitleType(v === "master" || v === "strata" || v === "individual" ? v : "");
                }}
                className="w-full h-10 mt-1.5 border border-slate-200 rounded-md px-3 text-sm bg-white"
              >
                <option value="">Select Title Type</option>
                <option value="master">Master Title</option>
                <option value="strata">Strata Title</option>
                <option value="individual">Individual Title</option>
              </select>
            </div>
            <div>
              <Label className="text-sm font-semibold text-slate-700">Tenure *</Label>
              <select
                value={tenure}
                onChange={e => {
                  const v = e.target.value;
                  setTenure(v === "freehold" || v === "leasehold" ? v : "");
                }}
                className="w-full h-10 mt-1.5 border border-slate-200 rounded-md px-3 text-sm bg-white"
              >
                <option value="freehold">Freehold</option>
                <option value="leasehold">Leasehold</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div>
              <Label className="text-sm font-semibold text-slate-700">Encumbered *</Label>
              <select
                value={isEncumbered}
                onChange={e => setIsEncumbered(e.target.value === "yes" ? "yes" : "no")}
                className="w-full h-10 mt-1.5 border border-slate-200 rounded-md px-3 text-sm bg-white"
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </div>
            <div>
              <Label className="text-sm font-semibold text-slate-700">Master Chargee Bank</Label>
              <Input
                value={masterChargeeBank}
                onChange={e => setMasterChargeeBank(e.target.value)}
                disabled={isEncumbered !== "yes"}
                placeholder={isEncumbered === "yes" ? "e.g., Maybank" : "Enable Encumbered = Yes"}
                className="mt-1.5"
              />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-6">
            <h3 className="text-base font-bold text-slate-900 mb-4">Vacant Possession (VP) & Completion</h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div>
                <Label className="text-sm font-semibold text-slate-700">Construction Period (Months)</Label>
                <Input value={constructionPeriodMonths} onChange={(e) => setConstructionPeriodMonths(e.target.value)} inputMode="numeric" className="mt-1.5" />
                <div className="text-xs text-slate-500 mt-1">Contractual VP Date: Auto-calculated in Case</div>
              </div>
              <div>
                <Label className="text-sm font-semibold text-slate-700">Actual VP Date</Label>
                <div className="mt-1.5">
                  <DateOnlyInput valueYmd={actualVpDate} onChangeYmd={setActualVpDate} />
                </div>
              </div>
              <div>
                <Label className="text-sm font-semibold text-slate-700">CCC Date</Label>
                <div className="mt-1.5">
                  <DateOnlyInput valueYmd={cccDate} onChangeYmd={setCccDate} />
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-slate-200 pt-6">
            <h3 className="text-base font-bold text-slate-900 mb-4">Additional Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <Label className="text-sm font-semibold text-slate-700">HDA Account</Label>
                <Input value={hdaAccount} onChange={(e) => setHdaAccount(e.target.value)} className="mt-1.5" />
              </div>
              <div>
                <Label className="text-sm font-semibold text-slate-700">HDA Bank</Label>
                <Input value={hdaBank} onChange={(e) => setHdaBank(e.target.value)} className="mt-1.5" />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-5">
              <div>
                <Label className="text-sm font-semibold text-slate-700">Master Chargee Account Number</Label>
                <Input value={masterChargeeAccount} onChange={(e) => setMasterChargeeAccount(e.target.value)} className="mt-1.5" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div>
              <Label className="text-sm font-semibold text-slate-700">Master Title Number</Label>
              <Input value={masterTitleNumber} onChange={e => setMasterTitleNumber(e.target.value)} className="mt-1.5" />
            </div>
            <div>
              <Label className="text-sm font-semibold text-slate-700">Master Title Land Size</Label>
              <Input value={masterTitleLandSize} onChange={e => setMasterTitleLandSize(e.target.value)} placeholder="e.g., 10 acres" className="mt-1.5" />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-6">
            <div>
              <Label className="text-sm font-semibold text-slate-700">Mukim</Label>
              <Input value={mukim} onChange={e => setMukim(e.target.value)} className="mt-1.5" />
            </div>
            <div>
              <Label className="text-sm font-semibold text-slate-700">Daerah</Label>
              <Input value={daerah} onChange={e => setDaerah(e.target.value)} className="mt-1.5" />
            </div>
            <div>
              <Label className="text-sm font-semibold text-slate-700">Negeri</Label>
              <Input value={negeri} onChange={e => setNegeri(e.target.value)} className="mt-1.5" />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">Property Types</h3>
              <Button variant="outline" size="sm" onClick={addPropertyType}>
                <Plus className="w-4 h-4 mr-1" /> Add Type
              </Button>
            </div>
            <div className="space-y-3">
              {propertyTypes.map((pt) => (
                <div key={pt.id} className="bg-slate-50 rounded-lg p-4 relative">
                  <div className="flex items-end gap-3">
                    <div className="flex-1">
                      <Label className="text-xs font-medium text-slate-500">Building Type</Label>
                      <Input
                        value={pt.buildingType}
                        onChange={e => updatePropertyType(pt.id, e.target.value)}
                        placeholder="e.g., TWO STOREY TERRACE HOUSE"
                        className="mt-1"
                      />
                    </div>
                    {propertyTypes.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removePropertyType(pt.id)}
                        className="text-red-400 hover:text-red-600 h-9 w-9 p-0 shrink-0"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="px-8 py-4 border-t border-slate-200 flex justify-end gap-3">
          <Button variant="outline" onClick={() => setLocation(`/app/projects/${projectId}`)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={saving}
            className="bg-amber-500 hover:bg-amber-600 text-white"
          >
            {saving ? "Saving..." : "Update Project"}
          </Button>
        </div>
      </div>
    </div>
  );
}
