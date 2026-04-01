import { useListProjects, useListDevelopers } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "lucide-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";

export default function ProjectsList() {
  const [search, setSearch] = useState("");
  const [developerId, setDeveloperId] = useState<string>("all");
  const [projectType, setProjectType] = useState<string>("all");
  const [titleType, setTitleType] = useState<string>("all");
  
  const { data: response, isLoading } = useListProjects({ 
    page: 1, 
    limit: 50,
    search: search || undefined,
    developerId: developerId !== "all" ? parseInt(developerId) : undefined,
    projectType: projectType !== "all" ? projectType : undefined,
    titleType: titleType !== "all" ? titleType : undefined,
  });

  const { data: devsRes } = useListDevelopers({ limit: 100 });
  const developers = devsRes?.data || [];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Projects</h1>
          <p className="text-slate-500 mt-1">Manage development projects</p>
        </div>
        <Link href="/app/projects/new">
          <Button className="bg-amber-500 hover:bg-amber-600 text-white">
            <Plus className="w-4 h-4 mr-2" />
            New Project
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input 
            placeholder="Search projects..." 
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <Select value={developerId} onValueChange={setDeveloperId}>
          <SelectTrigger>
            <SelectValue placeholder="Developer" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Developers</SelectItem>
            {developers.map(d => <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={projectType} onValueChange={setProjectType}>
          <SelectTrigger>
            <SelectValue placeholder="Project Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="landed">Landed</SelectItem>
            <SelectItem value="highrise">Highrise</SelectItem>
          </SelectContent>
        </Select>

        <Select value={titleType} onValueChange={setTitleType}>
          <SelectTrigger>
            <SelectValue placeholder="Title Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Titles</SelectItem>
            <SelectItem value="master">Master</SelectItem>
            <SelectItem value="individual">Individual</SelectItem>
            <SelectItem value="strata">Strata</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-slate-500">Loading projects...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3 font-semibold">Name</th>
                    <th className="px-6 py-3 font-semibold">Developer</th>
                    <th className="px-6 py-3 font-semibold">Type</th>
                    <th className="px-6 py-3 font-semibold">Title Type</th>
                    <th className="px-6 py-3 font-semibold text-right">Cases</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {response?.data.map((proj) => (
                    <tr key={proj.id} className="hover:bg-slate-50/50">
                      <td className="px-6 py-4">
                        <Link href={`/app/projects/${proj.id}`}>
                          <span className="font-medium text-slate-900 hover:text-amber-600 cursor-pointer transition-colors">
                            {proj.name}
                          </span>
                        </Link>
                      </td>
                      <td className="px-6 py-4 text-slate-600">
                        {proj.developerName}
                      </td>
                      <td className="px-6 py-4 text-slate-600 capitalize">
                        {proj.projectType}
                      </td>
                      <td className="px-6 py-4 text-slate-600 capitalize">
                        {proj.titleType}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className="inline-flex items-center justify-center px-2 py-1 text-xs font-bold leading-none text-slate-600 bg-slate-100 rounded">
                          {proj.caseCount}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {response?.data.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                        No projects found.
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
