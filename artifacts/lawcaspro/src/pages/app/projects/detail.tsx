import { useParams, useLocation } from "wouter";
import { useGetProject, getGetProjectQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Building2, MapPin, Tag } from "lucide-react";

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();

  const { data: project, isLoading } = useGetProject(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getGetProjectQueryKey(projectId),
    }
  });

  if (isLoading) return <div>Loading project details...</div>;
  if (!project) return <div>Project not found</div>;

  const renderExtraFields = () => {
    if (!project.extraFields) return null;
    
    return (
      <div className="grid grid-cols-2 gap-y-4 gap-x-8 mt-4 pt-4 border-t border-slate-100">
        {Object.entries(project.extraFields).map(([key, value]) => {
          if (!value) return null;
          // convert camelCase to Title Case
          const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
          return (
            <div key={key}>
              <div className="text-sm font-medium text-slate-500">{label}</div>
              <div className="text-slate-900 mt-0.5">{String(value)}</div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => setLocation("/app/projects")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">{project.name}</h1>
          <p className="text-slate-500 mt-1">Developer: {project.developerName}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Project Information</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-6">
              <div className="flex items-start gap-3">
                <Building2 className="w-5 h-5 text-amber-500 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-slate-500">Project Type</div>
                  <div className="text-slate-900 capitalize font-medium">{project.projectType}</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Tag className="w-5 h-5 text-amber-500 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-slate-500">Title Type</div>
                  <div className="text-slate-900 capitalize font-medium">{project.titleType}</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <MapPin className="w-5 h-5 text-amber-500 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-slate-500">Land Use</div>
                  <div className="text-slate-900 font-medium">{project.landUse || "-"}</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Building2 className="w-5 h-5 text-amber-500 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-slate-500">Condition</div>
                  <div className="text-slate-900 font-medium">{project.developmentCondition || "-"}</div>
                </div>
              </div>
            </div>

            {renderExtraFields()}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
