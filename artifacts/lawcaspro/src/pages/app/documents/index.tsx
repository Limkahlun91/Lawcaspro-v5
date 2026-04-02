import { useState, useEffect } from "react";
import { useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileText, Download, Search, FolderOpen, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import DocumentTemplates from "@/pages/app/settings/DocumentTemplates";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

interface SystemDoc {
  id: number;
  name: string;
  description: string | null;
  category: string;
  fileName: string;
  fileType: string;
  fileSize: number | null;
  objectPath: string;
  createdAt: string;
}

const TABS = ["Master Documents", "Firm Documents"] as const;
type Tab = typeof TABS[number];

const TAB_KEYS: Record<string, Tab> = {
  master: "Master Documents",
  firm: "Firm Documents",
};

function formatFileSize(bytes: number | null): string {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

function getFileExtension(fileName: string): string {
  const ext = fileName.split(".").pop()?.toUpperCase() || "";
  return ext;
}

function MasterDocumentsTab() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");

  const { data: docs, isLoading } = useQuery<SystemDoc[]>({
    queryKey: ["hub-documents"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/hub/documents`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  const filteredDocs = (docs || []).filter(d =>
    !search || d.name.toLowerCase().includes(search.toLowerCase()) || d.fileName.toLowerCase().includes(search.toLowerCase())
  );

  const categories = Array.from(new Set(filteredDocs.map(d => d.category)));

  const handleDownload = async (doc: SystemDoc) => {
    try {
      const pathPart = doc.objectPath.replace(/^\/objects\//, "");
      const res = await fetch(`${API_BASE}/storage/objects/${pathPart}`, { credentials: "include" });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const el = document.createElement("a");
      el.href = url;
      el.download = doc.fileName;
      el.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Failed to download document", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-500">Documents shared by Lawcaspro platform. These are read-only and cannot be modified.</p>
        </div>
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search documents..."
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-slate-500">Loading master documents...</div>
      ) : filteredDocs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FolderOpen className="w-12 h-12 mx-auto text-slate-300 mb-4" />
            <p className="text-slate-500">No master documents available</p>
            <p className="text-slate-400 text-xs mt-1">System documents will appear here when uploaded by Lawcaspro</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {categories.map(cat => {
            const catDocs = filteredDocs.filter(d => d.category === cat);
            if (catDocs.length === 0) return null;
            return (
              <div key={cat}>
                <div className="flex items-center gap-2 mb-3">
                  <FolderOpen className="w-4 h-4 text-amber-500" />
                  <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">{cat}</h3>
                  <span className="text-xs text-slate-400">({catDocs.length})</span>
                  <Lock className="w-3 h-3 text-slate-400 ml-1" />
                </div>
                <Card>
                  <CardContent className="p-0">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50">
                          <th className="text-left px-4 py-2.5 font-medium text-slate-600">Name</th>
                          <th className="text-left px-4 py-2.5 font-medium text-slate-600 w-24">Type</th>
                          <th className="text-left px-4 py-2.5 font-medium text-slate-600 w-24">Size</th>
                          <th className="text-left px-4 py-2.5 font-medium text-slate-600 w-28">Date</th>
                          <th className="text-right px-4 py-2.5 font-medium text-slate-600 w-20">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {catDocs.map(doc => (
                          <tr key={doc.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-3">
                                <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                                <div>
                                  <div className="font-medium text-slate-900">{doc.name}</div>
                                  {doc.description && (
                                    <div className="text-xs text-slate-500 mt-0.5">{doc.description}</div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
                                {getFileExtension(doc.fileName)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-slate-500">{formatFileSize(doc.fileSize)}</td>
                            <td className="px-4 py-3 text-slate-500">{formatDate(doc.createdAt)}</td>
                            <td className="px-4 py-3 text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDownload(doc)}
                                title="Download"
                                className="h-8 w-8 p-0"
                              >
                                <Download className="w-4 h-4" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function DocumentsPage() {
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const tabFromUrl = params.get("tab");
  const initialTab = (tabFromUrl && TAB_KEYS[tabFromUrl]) ? TAB_KEYS[tabFromUrl] : "Master Documents";
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  useEffect(() => {
    if (tabFromUrl && TAB_KEYS[tabFromUrl]) {
      setActiveTab(TAB_KEYS[tabFromUrl]);
    }
  }, [tabFromUrl]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Documents</h1>
        <p className="text-slate-500 mt-1">Master documents and firm document templates</p>
      </div>

      <div className="flex border-b border-gray-200">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
              activeTab === tab
                ? "border-amber-500 text-amber-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Master Documents" && <MasterDocumentsTab />}
      {activeTab === "Firm Documents" && <DocumentTemplates />}
    </div>
  );
}
