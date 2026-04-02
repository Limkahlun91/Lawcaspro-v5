import { useState, useEffect } from "react";
import { useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FileText, Download, Search, FolderOpen, Folder, Lock, ChevronRight,
} from "lucide-react";
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
  folderId: number | null;
  createdAt: string;
}

interface SystemFolder {
  id: number;
  name: string;
  parentId: number | null;
  sortOrder: number;
  isDisabled: boolean;
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
  return fileName.split(".").pop()?.toUpperCase() || "";
}

function FolderTreeItem({
  folder,
  folders,
  selectedId,
  onSelect,
  depth = 0,
}: {
  folder: SystemFolder;
  folders: SystemFolder[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  depth?: number;
}) {
  const children = folders
    .filter(f => f.parentId === folder.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const isSelected = selectedId === folder.id;
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 py-2 px-2 rounded-md cursor-pointer text-sm transition-colors",
          isSelected ? "bg-amber-50 border border-amber-200" : "hover:bg-slate-50 border border-transparent"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(folder.id)}
      >
        {children.length > 0 ? (
          <button
            onClick={e => { e.stopPropagation(); setExpanded(!expanded); }}
            className="p-0.5 hover:bg-slate-200 rounded shrink-0"
          >
            <ChevronRight className={cn("w-3.5 h-3.5 transition-transform", expanded && "rotate-90")} />
          </button>
        ) : (
          <span className="w-[18px]" />
        )}
        {isSelected ? (
          <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
        ) : (
          <Folder className="w-4 h-4 text-slate-400 shrink-0" />
        )}
        <span className={cn("font-medium flex-1 break-words leading-snug", isSelected ? "text-amber-700" : "text-slate-700")}>
          {folder.name}
        </span>
        <Lock className="w-2.5 h-2.5 text-slate-300 shrink-0" />
      </div>
      {expanded && children.map(child => (
        <FolderTreeItem
          key={child.id}
          folder={child}
          folders={folders}
          selectedId={selectedId}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

function MasterDocumentsTab() {
  const { toast } = useToast();
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);

  const { data: folders = [] } = useQuery<SystemFolder[]>({
    queryKey: ["hub-folders"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/hub/folders`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  const { data: docs = [], isLoading } = useQuery<SystemDoc[]>({
    queryKey: ["hub-documents", selectedFolderId],
    queryFn: async () => {
      const url = selectedFolderId !== null
        ? `${API_BASE}/hub/documents?folderId=${selectedFolderId}`
        : `${API_BASE}/hub/documents`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
  });

  const rootFolders = folders.filter(f => f.parentId === null).sort((a, b) => a.sortOrder - b.sortOrder);
  const selectedFolder = folders.find(f => f.id === selectedFolderId);

  const folderPath = (): string => {
    if (!selectedFolder) return "All Documents";
    const parts: string[] = [];
    let current: SystemFolder | undefined = selectedFolder;
    while (current) {
      parts.unshift(current.name);
      current = folders.find(f => f.id === current!.parentId);
    }
    return parts.join(" / ");
  };

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
      <p className="text-sm text-slate-500">Documents shared by Lawcaspro platform. These are read-only and cannot be modified.</p>

      <div className="flex gap-6 min-h-[400px]">
        <div className="w-80 shrink-0">
          <Card>
            <CardContent className="p-3">
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Folders</h3>
                <Lock className="w-3 h-3 text-slate-300" />
              </div>

              <div
                className={cn(
                  "py-2 px-2 rounded-md cursor-pointer text-sm flex items-center gap-2 transition-colors mb-1",
                  selectedFolderId === null
                    ? "bg-amber-50 border border-amber-200 text-amber-700 font-medium"
                    : "hover:bg-slate-50 text-slate-600 border border-transparent"
                )}
                onClick={() => setSelectedFolderId(null)}
              >
                <FolderOpen className="w-4 h-4" />
                All Documents
              </div>

              <div className="space-y-0.5">
                {rootFolders.map(folder => (
                  <FolderTreeItem
                    key={folder.id}
                    folder={folder}
                    folders={folders}
                    selectedId={selectedFolderId}
                    onSelect={setSelectedFolderId}
                  />
                ))}
              </div>

              {rootFolders.length === 0 && (
                <p className="text-xs text-slate-400 text-center py-4">No folders available</p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex-1 min-w-0">
          <Card>
            <CardContent className="p-4">
              <div className="mb-4">
                <h3 className="text-sm font-semibold text-slate-700">Documents</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {selectedFolder ? `Folder: ${folderPath()}` : "Showing all documents"}
                </p>
              </div>

              {isLoading ? (
                <div className="py-12 text-center text-slate-500">Loading...</div>
              ) : docs.length === 0 ? (
                <div className="text-center py-12">
                  <FileText className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                  <p className="text-slate-500">No documents in this folder</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50">
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600">Name</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600 w-20">Type</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600 w-20">Size</th>
                      <th className="text-left px-4 py-2.5 font-medium text-slate-600 w-28">Date</th>
                      <th className="text-right px-4 py-2.5 font-medium text-slate-600 w-20">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docs.map(doc => (
                      <tr key={doc.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                            <div>
                              <div className="font-medium text-slate-900">{doc.name}</div>
                              {doc.description && <div className="text-xs text-slate-500 mt-0.5">{doc.description}</div>}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
                            {getFileExtension(doc.fileName)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-500 text-xs">{formatFileSize(doc.fileSize)}</td>
                        <td className="px-4 py-3 text-slate-500 text-xs">{formatDate(doc.createdAt)}</td>
                        <td className="px-4 py-3 text-right">
                          <Button variant="ghost" size="sm" onClick={() => handleDownload(doc)} title="Download" className="h-8 w-8 p-0">
                            <Download className="w-4 h-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
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
