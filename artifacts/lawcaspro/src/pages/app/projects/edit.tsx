import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useGetProject, getGetProjectQueryKey, useListDevelopers } from "@workspace/api-client-react";
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

  const { data: devsResponse } = useListDevelopers({ limit: 100 });
  const developers = devsResponse?.data || [];

  const [name, setName] = useState("");
  const [phase, setPhase] = useState("");
  const [selectedDevId, setSelectedDevId] = useState("");
  const [developerName, setDeveloperName] = useState("");
  const [titleType, setTitleType] = useState("");
  const [titleSubtype, setTitleSubtype] = useState("");
  const [masterTitleNumber, setMasterTitleNumber] = useState("");
  const [masterTitleLandSize, setMasterTitleLandSize] = useState("");
  const [mukim, setMukim] = useState("");
  const [daerah, setDaerah] = useState("");
  const [negeri, setNegeri] = useState("");
  const [propertyTypes, setPropertyTypes] = useState<PropertyType[]>([
    { id: crypto.randomUUID(), buildingType: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (project && !initialized) {
      setName(project.name || "");
      setPhase(project.phase || "");
      setSelectedDevId(project.developerId?.toString() || "");
      setDeveloperName(project.developerName || "");
      setTitleType(project.titleType || "");
      setTitleSubtype(project.titleSubtype || "");
      setMasterTitleNumber(project.masterTitleNumber || "");
      setMasterTitleLandSize(project.masterTitleLandSize || "");
      setMukim(project.mukim || "");
      setDaerah(project.daerah || "");
      setNegeri(project.negeri || "");

      const extra = project.extraFields as Record<string, unknown> | undefined;
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
          titleType: titleType || "master",
          phase,
          developerName,
          titleSubtype,
          masterTitleNumber,
          masterTitleLandSize,
          mukim,
          daerah,
          negeri,
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
              <Label className="text-sm font-semibold text-slate-700">Title Type</Label>
              <select
                value={titleType}
                onChange={e => setTitleType(e.target.value)}
                className="w-full h-10 mt-1.5 border border-slate-200 rounded-md px-3 text-sm bg-white"
              >
                <option value="">Select Title Type</option>
                <option value="master">Master Title</option>
                <option value="strata">Strata Title</option>
                <option value="individual">Individual Title</option>
              </select>
            </div>
            <div>
              <Label className="text-sm font-semibold text-slate-700">Title Subtype</Label>
              <select
                value={titleSubtype}
                onChange={e => setTitleSubtype(e.target.value)}
                className="w-full h-10 mt-1.5 border border-slate-200 rounded-md px-3 text-sm bg-white"
              >
                <option value="">Select Subtype</option>
                <option value="freehold">Freehold</option>
                <option value="leasehold">Leasehold</option>
                <option value="malay_reserve">Malay Reserve</option>
              </select>
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
