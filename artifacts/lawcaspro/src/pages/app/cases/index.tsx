import { useListCases, useListProjects, useListDevelopers, useListUsers } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "lucide-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";

export default function CasesList() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [purchaseMode, setPurchaseMode] = useState<string>("all");
  const [titleType, setTitleType] = useState<string>("all");
  const [projectId, setProjectId] = useState<string>("all");
  const [developerId, setDeveloperId] = useState<string>("all");
  const [lawyerId, setLawyerId] = useState<string>("all");

  const { data: response, isLoading } = useListCases({ 
    page: 1, 
    limit: 50,
    search: search || undefined,
    status: status !== "all" ? status : undefined,
    purchaseMode: purchaseMode !== "all" ? purchaseMode : undefined,
    titleType: titleType !== "all" ? titleType : undefined,
    projectId: projectId !== "all" ? parseInt(projectId) : undefined,
    developerId: developerId !== "all" ? parseInt(developerId) : undefined,
    assignedLawyerId: lawyerId !== "all" ? parseInt(lawyerId) : undefined,
  });

  const { data: projectsRes } = useListProjects({ limit: 100 });
  const { data: devsRes } = useListDevelopers({ limit: 100 });
  const { data: usersRes } = useListUsers({ limit: 100 });
  
  const projects = projectsRes?.data || [];
  const developers = devsRes?.data || [];
  const lawyers = usersRes?.data?.filter(u => u.roleName?.toLowerCase().includes("lawyer") || u.roleName?.toLowerCase().includes("partner")) || [];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Cases</h1>
          <p className="text-slate-500 mt-1">Manage conveyancing cases</p>
          <p className="text-xs text-slate-400 mt-1">Total: {response?.total ?? 0}</p>
        </div>
        <Link href="/app/cases/new">
          <Button className="bg-amber-500 hover:bg-amber-600 text-white">
            <Plus className="w-4 h-4 mr-2" />
            New Case
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input 
            placeholder="Search reference no..." 
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger>
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>

        <Select value={purchaseMode} onValueChange={setPurchaseMode}>
          <SelectTrigger>
            <SelectValue placeholder="Purchase Mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Modes</SelectItem>
            <SelectItem value="cash">Cash</SelectItem>
            <SelectItem value="loan">Loan</SelectItem>
          </SelectContent>
        </Select>

        <Select value={titleType} onValueChange={setTitleType}>
          <SelectTrigger>
            <SelectValue placeholder="Title Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Title Types</SelectItem>
            <SelectItem value="master">Master</SelectItem>
            <SelectItem value="individual">Individual</SelectItem>
            <SelectItem value="strata">Strata</SelectItem>
          </SelectContent>
        </Select>

        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger>
            <SelectValue placeholder="Project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Projects</SelectItem>
            {projects.map(p => <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={developerId} onValueChange={setDeveloperId}>
          <SelectTrigger>
            <SelectValue placeholder="Developer" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Developers</SelectItem>
            {developers.map(d => <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={lawyerId} onValueChange={setLawyerId}>
          <SelectTrigger>
            <SelectValue placeholder="Assigned Lawyer" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Lawyers</SelectItem>
            {lawyers.map(l => <SelectItem key={l.id} value={l.id.toString()}>{l.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-slate-500">Loading cases...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3 font-semibold">Ref No</th>
                    <th className="px-6 py-3 font-semibold">Project</th>
                    <th className="px-6 py-3 font-semibold">Mode / Title</th>
                    <th className="px-6 py-3 font-semibold">Status</th>
                    <th className="px-6 py-3 font-semibold">Lawyer</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {response?.data.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50/50">
                      <td className="px-6 py-4">
                        <Link href={`/app/cases/${c.id}`}>
                          <span className="font-medium text-slate-900 hover:text-amber-600 cursor-pointer transition-colors">
                            {c.referenceNo}
                          </span>
                        </Link>
                      </td>
                      <td className="px-6 py-4">
                        <div className="font-medium text-slate-800">{c.projectName}</div>
                        <div className="text-slate-500 text-xs mt-0.5">{c.developerName}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="capitalize text-slate-800">{c.purchaseMode}</div>
                        <div className="text-slate-500 text-xs mt-0.5 capitalize">{c.titleType}</div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-700">
                          {c.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-slate-600">
                        {c.assignedLawyerName || "Unassigned"}
                      </td>
                    </tr>
                  ))}
                  {response?.data.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                        No cases found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
