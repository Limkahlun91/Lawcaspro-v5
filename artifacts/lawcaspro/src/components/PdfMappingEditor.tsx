import { useState, useRef, useEffect, useCallback } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  ChevronLeft, ChevronRight, Plus, Trash2, Save, X, GripVertical,
  Type, BookOpen, Copy, Check, Minus,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const API_BASE = import.meta.env.BASE_URL + "api";

interface TextBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  content: string;
}

interface PageMapping {
  pageIndex: number;
  textBoxes: TextBox[];
}

interface PdfMappings {
  pages: PageMapping[];
}

interface VarGroup {
  group: string;
  vars: { key: string; label: string; type?: string; fields?: string }[];
}

interface Props {
  docId: number;
  docName: string;
  pdfUrl: string;
  onClose: () => void;
}

export default function PdfMappingEditor({ docId, docName, pdfUrl, onClose }: Props) {
  const { toast } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);

  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [mappings, setMappings] = useState<PdfMappings>({ pages: [] });
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showVarPanel, setShowVarPanel] = useState(false);
  const [varGroups, setVarGroups] = useState<VarGroup[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [pdfScale, setPdfScale] = useState(1);
  const [pdfDimensions, setPdfDimensions] = useState({ width: 0, height: 0 });

  const [dragging, setDragging] = useState<{ boxId: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [resizing, setResizing] = useState<{ boxId: string; startX: number; startY: number; origW: number; origH: number } | null>(null);

  useEffect(() => {
    loadMappings();
    loadVarGroups();
  }, [docId]);

  const loadMappings = async () => {
    try {
      const res = await fetch(`${API_BASE}/platform/documents/${docId}/pdf-mappings`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setMappings(data.mappings || { pages: [] });
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  const loadVarGroups = async () => {
    try {
      const res = await fetch(`${API_BASE}/document-variables`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setVarGroups(data);
      }
    } catch { /* ignore */ }
  };

  const saveMappings = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/platform/documents/${docId}/pdf-mappings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings }),
        credentials: "include",
      });
      if (res.ok) {
        toast({ title: "Mappings saved" });
      } else {
        toast({ title: "Failed to save", variant: "destructive" });
      }
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    }
    setSaving(false);
  };

  const getCurrentPageBoxes = (): TextBox[] => {
    const pm = mappings.pages.find(p => p.pageIndex === currentPage);
    return pm?.textBoxes ?? [];
  };

  const updateCurrentPageBoxes = (textBoxes: TextBox[]) => {
    setMappings(prev => {
      const newPages = [...prev.pages];
      const idx = newPages.findIndex(p => p.pageIndex === currentPage);
      if (idx >= 0) {
        newPages[idx] = { ...newPages[idx], textBoxes };
      } else {
        newPages.push({ pageIndex: currentPage, textBoxes });
      }
      return { pages: newPages };
    });
  };

  const addTextBox = () => {
    const newBox: TextBox = {
      id: `tb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      x: 50,
      y: 50,
      width: 200,
      height: 30,
      fontSize: 10,
      content: "",
    };
    updateCurrentPageBoxes([...getCurrentPageBoxes(), newBox]);
    setSelectedBoxId(newBox.id);
  };

  const deleteTextBox = (boxId: string) => {
    updateCurrentPageBoxes(getCurrentPageBoxes().filter(b => b.id !== boxId));
    if (selectedBoxId === boxId) setSelectedBoxId(null);
  };

  const updateTextBox = (boxId: string, updates: Partial<TextBox>) => {
    updateCurrentPageBoxes(
      getCurrentPageBoxes().map(b => b.id === boxId ? { ...b, ...updates } : b)
    );
  };

  const selectedBox = getCurrentPageBoxes().find(b => b.id === selectedBoxId);

  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-textbox]")) return;
    setSelectedBoxId(null);
  };

  const handleMouseDown = (e: React.MouseEvent, boxId: string, mode: "drag" | "resize") => {
    e.preventDefault();
    e.stopPropagation();
    const box = getCurrentPageBoxes().find(b => b.id === boxId);
    if (!box) return;
    setSelectedBoxId(boxId);
    if (mode === "drag") {
      setDragging({ boxId, startX: e.clientX, startY: e.clientY, origX: box.x, origY: box.y });
    } else {
      setResizing({ boxId, startX: e.clientX, startY: e.clientY, origW: box.width, origH: box.height });
    }
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (dragging) {
      const dx = (e.clientX - dragging.startX) / pdfScale;
      const dy = (e.clientY - dragging.startY) / pdfScale;
      updateTextBox(dragging.boxId, {
        x: Math.max(0, dragging.origX + dx),
        y: Math.max(0, dragging.origY + dy),
      });
    }
    if (resizing) {
      const dx = (e.clientX - resizing.startX) / pdfScale;
      const dy = (e.clientY - resizing.startY) / pdfScale;
      updateTextBox(resizing.boxId, {
        width: Math.max(40, resizing.origW + dx),
        height: Math.max(16, resizing.origH + dy),
      });
    }
  }, [dragging, resizing, pdfScale]);

  const handleMouseUp = useCallback(() => {
    setDragging(null);
    setResizing(null);
  }, []);

  useEffect(() => {
    if (!dragging && !resizing) return;
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, resizing, handleMouseMove, handleMouseUp]);

  const insertVariable = (key: string, type?: string) => {
    if (!selectedBoxId) return;
    const box = getCurrentPageBoxes().find(b => b.id === selectedBoxId);
    if (!box) return;
    let varText: string;
    if (type === "loop") {
      varText = `{#${key}}...{/${key}}`;
    } else if (type === "loopField") {
      varText = `{${key}}`;
    } else {
      varText = `{{${key}}}`;
    }
    updateTextBox(selectedBoxId, { content: box.content + varText });
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1000);
  };

  const onDocLoad = ({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setCurrentPage(0);
  };

  const onPageLoad = (page: any) => {
    const vp = page.getViewport({ scale: 1 });
    setPdfDimensions({ width: vp.width, height: vp.height });
    const container = containerRef.current;
    if (container) {
      const availW = container.clientWidth - 24;
      const scale = Math.min(availW / vp.width, 1.5);
      setPdfScale(scale);
    }
  };

  const boxes = getCurrentPageBoxes();

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
        <div className="bg-white rounded-lg p-8 text-center">
          <p className="text-slate-500">Loading PDF editor...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex">
      <div className="flex flex-1 m-4 bg-white rounded-xl overflow-hidden shadow-2xl">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-4 py-3 border-b bg-slate-50">
            <div className="flex items-center gap-3">
              <h2 className="font-semibold text-slate-800 text-sm truncate max-w-[200px]">{docName}</h2>
              <Badge variant="outline" className="text-xs">PDF Mapping</Badge>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 border rounded-md px-2 py-1">
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={currentPage === 0} onClick={() => setCurrentPage(p => p - 1)}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-xs text-slate-600 min-w-[60px] text-center">
                  Page {currentPage + 1} / {numPages}
                </span>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={currentPage >= numPages - 1} onClick={() => setCurrentPage(p => p + 1)}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
              <Button variant="outline" size="sm" className="h-7 gap-1" onClick={addTextBox}>
                <Plus className="w-3.5 h-3.5" />
                Add Text Box
              </Button>
              <Button variant="outline" size="sm" className="h-7 gap-1" onClick={() => setShowVarPanel(!showVarPanel)}>
                <BookOpen className="w-3.5 h-3.5" />
                Variables
              </Button>
              <Button size="sm" className="h-7 gap-1" onClick={saveMappings} disabled={saving}>
                <Save className="w-3.5 h-3.5" />
                {saving ? "Saving..." : "Save"}
              </Button>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div ref={containerRef} className="flex-1 overflow-auto bg-slate-200 p-3 flex justify-center" onClick={handleCanvasClick}>
            <div className="relative inline-block" style={{ width: pdfDimensions.width * pdfScale, height: pdfDimensions.height * pdfScale }}>
              <Document file={pdfUrl} onLoadSuccess={onDocLoad}>
                <Page
                  pageIndex={currentPage}
                  onLoadSuccess={onPageLoad}
                  scale={pdfScale}
                  renderAnnotationLayer={false}
                  renderTextLayer={false}
                />
              </Document>

              {boxes.map(box => (
                <div
                  key={box.id}
                  data-textbox
                  className={cn(
                    "absolute border-2 cursor-move group",
                    selectedBoxId === box.id
                      ? "border-blue-500 bg-blue-50/30"
                      : "border-amber-400/60 bg-amber-50/20 hover:border-amber-500"
                  )}
                  style={{
                    left: box.x * pdfScale,
                    top: box.y * pdfScale,
                    width: box.width * pdfScale,
                    height: box.height * pdfScale,
                  }}
                  onMouseDown={e => handleMouseDown(e, box.id, "drag")}
                  onClick={e => { e.stopPropagation(); setSelectedBoxId(box.id); }}
                >
                  <div className="absolute inset-0 overflow-hidden px-1 flex items-start">
                    <span
                      className="text-slate-700 leading-tight break-words whitespace-pre-wrap"
                      style={{ fontSize: box.fontSize * pdfScale }}
                    >
                      {box.content || "..."}
                    </span>
                  </div>
                  {selectedBoxId === box.id && (
                    <>
                      <button
                        className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center text-xs hover:bg-red-600 z-10"
                        onClick={e => { e.stopPropagation(); deleteTextBox(box.id); }}
                      >
                        <X className="w-3 h-3" />
                      </button>
                      <div
                        className="absolute bottom-0 right-0 w-4 h-4 bg-blue-500 cursor-se-resize rounded-tl-sm"
                        onMouseDown={e => handleMouseDown(e, box.id, "resize")}
                      />
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="w-72 border-l flex flex-col bg-white shrink-0">
          {selectedBox ? (
            <div className="flex-1 overflow-y-auto">
              <div className="p-3 border-b bg-slate-50">
                <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">Text Box Properties</h3>
              </div>
              <div className="p-3 space-y-3">
                <div>
                  <label className="text-xs font-medium text-slate-600 mb-1 block">Content</label>
                  <textarea
                    className="w-full border rounded-md px-2 py-1.5 text-sm resize-none focus:ring-1 focus:ring-blue-300 focus:border-blue-300"
                    rows={4}
                    value={selectedBox.content}
                    onChange={e => updateTextBox(selectedBox.id, { content: e.target.value })}
                    placeholder="Type text and/or {{variables}} here..."
                  />
                  <p className="text-xs text-slate-400 mt-1">Use {"{{variable_name}}"} for variables</p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">X</label>
                    <Input
                      type="number"
                      className="h-7 text-xs"
                      value={Math.round(selectedBox.x)}
                      onChange={e => updateTextBox(selectedBox.id, { x: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">Y</label>
                    <Input
                      type="number"
                      className="h-7 text-xs"
                      value={Math.round(selectedBox.y)}
                      onChange={e => updateTextBox(selectedBox.id, { y: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">Width</label>
                    <Input
                      type="number"
                      className="h-7 text-xs"
                      value={Math.round(selectedBox.width)}
                      onChange={e => updateTextBox(selectedBox.id, { width: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">Height</label>
                    <Input
                      type="number"
                      className="h-7 text-xs"
                      value={Math.round(selectedBox.height)}
                      onChange={e => updateTextBox(selectedBox.id, { height: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600 mb-1 block">Font Size</label>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => updateTextBox(selectedBox.id, { fontSize: Math.max(6, selectedBox.fontSize - 1) })}>
                      <Minus className="w-3 h-3" />
                    </Button>
                    <Input
                      type="number"
                      className="h-7 text-xs text-center w-16"
                      value={selectedBox.fontSize}
                      onChange={e => updateTextBox(selectedBox.id, { fontSize: Number(e.target.value) || 10 })}
                    />
                    <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => updateTextBox(selectedBox.id, { fontSize: selectedBox.fontSize + 1 })}>
                      <Plus className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
                <Button variant="destructive" size="sm" className="w-full gap-1 mt-2" onClick={() => deleteTextBox(selectedBox.id)}>
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete Text Box
                </Button>
              </div>

              {showVarPanel && (
                <div className="border-t">
                  <div className="p-3 bg-blue-50 border-b">
                    <h3 className="text-xs font-semibold text-blue-800 uppercase tracking-wider">Insert Variable</h3>
                    <p className="text-xs text-blue-600 mt-0.5">Click to insert into content</p>
                  </div>
                  <div className="max-h-[300px] overflow-y-auto">
                    {varGroups.map(group => (
                      <div key={group.group}>
                        <div className="px-3 py-1.5 bg-slate-50 text-xs font-medium text-slate-500 uppercase tracking-wider">
                          {group.group}
                        </div>
                        {group.vars.map((v: any) => (
                          <button
                            key={v.key}
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 flex items-center justify-between group border-b border-slate-50"
                            onClick={() => insertVariable(v.key, v.type)}
                          >
                            <div className="min-w-0 flex-1">
                              <span className="text-slate-600">{v.label}</span>
                              <div className="mt-0.5">
                                <code className={cn(
                                  "text-xs px-1 py-0.5 rounded font-mono",
                                  v.type === "loop" ? "bg-blue-100 text-blue-700" : v.type === "loopField" ? "bg-blue-50 text-blue-600" : "bg-amber-50 text-amber-700"
                                )}>
                                  {v.type === "loop" ? `{#${v.key}}...{/${v.key}}` : v.type === "loopField" ? `{${v.key}}` : `{{${v.key}}}`}
                                </code>
                              </div>
                            </div>
                            {copiedKey === v.key ? (
                              <Check className="w-3 h-3 text-green-500 shrink-0" />
                            ) : (
                              <Plus className="w-3 h-3 text-slate-300 group-hover:text-blue-500 shrink-0" />
                            )}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
              <Type className="w-10 h-10 text-slate-300 mb-3" />
              <p className="text-sm font-medium text-slate-500">No text box selected</p>
              <p className="text-xs text-slate-400 mt-1">Click a text box on the PDF to edit its properties, or click "Add Text Box" to create one.</p>
              <Button variant="outline" size="sm" className="mt-4 gap-1" onClick={addTextBox}>
                <Plus className="w-3.5 h-3.5" />
                Add Text Box
              </Button>
            </div>
          )}

          <div className="border-t p-3 bg-slate-50">
            <p className="text-xs text-slate-400">
              {boxes.length} text box{boxes.length !== 1 ? "es" : ""} on this page
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
