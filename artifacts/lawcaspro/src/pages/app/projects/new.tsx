import { useState } from "react";
import { useCreateProject, useListDevelopers, getListDevelopersQueryKey } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X, Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListProjectsQueryKey } from "@workspace/api-client-react";
import { toastError } from "@/lib/toast-error";
import { DateOnlyInput } from "@/components/date-only-input";

interface PropertyType {
  id: string;
  buildingType: string;
}

export default function NewProject() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const listDevelopersParams2 = { limit: 100 };
  const { data: devsResponse } = useListDevelopers(listDevelopersParams2, {
    query: { staleTime: 5 * 60 * 1000, queryKey: getListDevelopersQueryKey(listDevelopersParams2) },
  });
  const developers = devsResponse?.data || [];
  const createProjectMutation = useCreateProject();

  const [name, setName] = useState("");
  const [phase, setPhase] = useState("");
  const [selectedDevId, setSelectedDevId] = useState("");
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

  const selectedDeveloper = selectedDevId
    ? developers.find((d: any) => d.id === parseInt(selectedDevId, 10))
    : null;
  const developerName = selectedDeveloper?.name ?? "";

  const addPropertyType = () => {
    setPropertyTypes(prev => [...prev, { id: crypto.randomUUID(), buildingType: "" }]);
  };

  const removePropertyType = (id: string) => {
    setPropertyTypes(prev => prev.filter(p => p.id !== id));
  };

  const updatePropertyType = (id: string, value: string) => {
    setPropertyTypes(prev => prev.map(p => p.id === id ? { ...p, buildingType: value } : p));
  };

  const handleSubmit = () => {
    if (!name.trim()) {
      toast({ title: "Project name is required", variant: "destructive" });
      return;
    }
    if (!selectedDevId) {
      toast({ title: "Please select a developer from the list", variant: "destructive" });
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

    const projectTypeValue = titleType === "strata" ? "highrise" : "landed";

    const payload = {
      name,
      developerId: parseInt(selectedDevId),
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
      phase,
      developerName: developerName || undefined,
      titleSubtype,
      masterTitleNumber,
      masterTitleLandSize,
      mukim,
      daerah,
      negeri,
      extraFields: {
        propertyTypes: propertyTypes.filter(p => p.buildingType.trim()),
      },
    };

    createProjectMutation.mutate(
      { data: payload },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          toast({ title: "Project created successfully" });
          setLocation("/app/projects");
        },
        onError: (error: any) => {
          toastError(toast, error, "Create failed");
        },
      }
    );
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-10 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-[960px] my-8 relative">
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-200">
          <h2 className="text-xl font-bold text-slate-900">New Project</h2>
          <button
            onClick={() => setLocation("/app/projects")}
            className="text-slate-400 hover:text-slate-600 p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-8 py-6 space-y-6">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <Label className="text-sm font-semibold text-slate-700">Project Name *</Label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label className="text-sm font-semibold text-slate-700">Phase</Label>
              <Input
                value={phase}
                onChange={e => setPhase(e.target.value)}
                placeholder="e.g., Phase 1"
                className="mt-1.5"
              />
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
              <Label className="text-sm font-semibold text-slate-700">Developer Name</Label>
              <Input
                value={developerName}
                disabled
                placeholder="Select a developer to auto-fill"
                className="mt-1.5"
              />
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
              <Input
                value={masterTitleNumber}
                onChange={e => setMasterTitleNumber(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label className="text-sm font-semibold text-slate-700">Master Title Land Size</Label>
              <Input
                value={masterTitleLandSize}
                onChange={e => setMasterTitleLandSize(e.target.value)}
                placeholder="e.g., 10 acres"
                className="mt-1.5"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-6">
            <div>
              <Label className="text-sm font-semibold text-slate-700">Mukim</Label>
              <Input
                value={mukim}
                onChange={e => setMukim(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label className="text-sm font-semibold text-slate-700">Daerah</Label>
              <Input
                value={daerah}
                onChange={e => setDaerah(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label className="text-sm font-semibold text-slate-700">Negeri</Label>
              <Input
                value={negeri}
                onChange={e => setNegeri(e.target.value)}
                className="mt-1.5"
              />
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
          <Button variant="outline" onClick={() => setLocation("/app/projects")}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={createProjectMutation.isPending}
            className="bg-amber-500 hover:bg-amber-600 text-white"
          >
            {createProjectMutation.isPending ? "Saving..." : "Create Project"}
          </Button>
        </div>
      </div>
    </div>
  );
}
