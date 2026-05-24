import { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";
import { useToast } from "@/hooks/use-toast";
import { ensureArray } from "@/lib/list-items";
import { Trash2, Save, ChevronLeft, ChevronRight, AlignLeft, AlignCenter, AlignRight } from "lucide-react";

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type LegacyVarGroup = {
  group: string;
  vars: { key: string; label: string; type?: string; fields?: string }[];
};

type VariableDefinition = {
  key: string;
  label: string;
  category?: string;
  valueType?: string;
};

type VarGroup = {
  group: string;
  vars: { key: string; label: string }[];
};

type PdfFontFamily = "Helvetica" | "Times-Roman" | "Courier";
type TextAlignment = "left" | "center" | "right";

export type PdfMappingConfig = Record<
  string,
  {
    page: number;
    x: number;
    y: number;
    size: number;
    value?: string;
    maxWidth?: number;
    lineHeight?: number;
    fontFamily?: PdfFontFamily;
    alignment?: TextAlignment;
  }
>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function isLegacyGroups(v: unknown): v is LegacyVarGroup[] {
  if (!Array.isArray(v)) return false;
  const first = v[0];
  return isRecord(first) && typeof first.group === "string" && Array.isArray(first.vars);
}

function isVariableDefs(v: unknown): v is VariableDefinition[] {
  if (!Array.isArray(v)) return false;
  const first = v[0];
  return isRecord(first) && typeof first.key === "string" && typeof first.label === "string";
}

function groupLabelForCategory(cat: string): string {
  const c = (cat || "").toLowerCase();
  if (c === "case") return "Case";
  if (c === "purchaser") return "Purchaser";
  if (c === "property") return "Property";
  if (c === "loan") return "Loan";
  if (c === "developer") return "Developer";
  if (c === "project") return "Project";
  if (c === "workflow") return "Workflow";
  if (c === "custom") return "Custom";
  return "Other";
}

function normalizeMappingConfig(raw: unknown): PdfMappingConfig {
  if (!raw || typeof raw !== "object") return {};
  if (Array.isArray(raw)) {
    const out: PdfMappingConfig = {};
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const key =
        typeof item.key === "string"
          ? item.key
          : typeof item.variableKey === "string"
            ? item.variableKey
            : typeof item.variable === "string"
              ? item.variable
              : "";
      if (!key) continue;
      const page = typeof item.page === "number" ? item.page : 1;
      const x = typeof item.x === "number" ? item.x : NaN;
      const y = typeof item.y === "number" ? item.y : NaN;
      const size = typeof item.size === "number" ? item.size : 12;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const maxWidth = typeof item.maxWidth === "number" && Number.isFinite(item.maxWidth) ? item.maxWidth : undefined;
      const lineHeight = typeof item.lineHeight === "number" && Number.isFinite(item.lineHeight) ? item.lineHeight : undefined;
      const value =
        typeof item.value === "string"
          ? item.value
          : typeof item.content === "string"
            ? item.content
            : typeof item.expression === "string"
              ? item.expression
              : undefined;
      const fontFamily =
        item.fontFamily === "Helvetica" || item.fontFamily === "Times-Roman" || item.fontFamily === "Courier"
          ? item.fontFamily
          : undefined;
      const alignment =
        item.alignment === "left" || item.alignment === "center" || item.alignment === "right"
          ? item.alignment
          : undefined;
      out[key] = {
        page,
        x,
        y,
        size,
        ...(value !== undefined ? { value } : {}),
        ...(maxWidth ? { maxWidth } : {}),
        ...(lineHeight ? { lineHeight } : {}),
        ...(fontFamily ? { fontFamily } : {}),
        ...(alignment ? { alignment } : {}),
      };
    }
    return out;
  }
  const out: PdfMappingConfig = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRecord(v)) continue;
    const page = typeof v.page === "number" ? v.page : 1;
    const x = typeof v.x === "number" ? v.x : NaN;
    const y = typeof v.y === "number" ? v.y : NaN;
    const size = typeof v.size === "number" ? v.size : 12;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const maxWidth = typeof v.maxWidth === "number" && Number.isFinite(v.maxWidth) ? v.maxWidth : undefined;
    const lineHeight = typeof v.lineHeight === "number" && Number.isFinite(v.lineHeight) ? v.lineHeight : undefined;
    const value =
      typeof v.value === "string"
        ? v.value
        : typeof v.content === "string"
          ? v.content
          : typeof v.expression === "string"
            ? v.expression
            : undefined;
    const fontFamily =
      v.fontFamily === "Helvetica" || v.fontFamily === "Times-Roman" || v.fontFamily === "Courier"
        ? v.fontFamily
        : undefined;
    const alignment =
      v.alignment === "left" || v.alignment === "center" || v.alignment === "right"
        ? v.alignment
        : undefined;
    out[k] = {
      page,
      x,
      y,
      size,
      ...(value !== undefined ? { value } : {}),
      ...(maxWidth ? { maxWidth } : {}),
      ...(lineHeight ? { lineHeight } : {}),
      ...(fontFamily ? { fontFamily } : {}),
      ...(alignment ? { alignment } : {}),
    };
  }
  return out;
}

function mappingFingerprint(v: PdfMappingConfig): string {
  const keys = Object.keys(v).sort((a, b) => a.localeCompare(b));
  return keys.map((k) => {
    const x = v[k];
    const value = typeof x.value === "string" ? x.value : "";
    const maxWidth = typeof x.maxWidth === "number" ? String(x.maxWidth) : "";
    const lineHeight = typeof x.lineHeight === "number" ? String(x.lineHeight) : "";
    const fontFamily = typeof x.fontFamily === "string" ? x.fontFamily : "";
    const alignment = typeof x.alignment === "string" ? x.alignment : "";
    return `${k}:${x.page},${x.x},${x.y},${x.size},${value},${maxWidth},${lineHeight},${fontFamily},${alignment}`;
  }).join("|");
}

function viewDimsFromPdfPage(page: unknown): { w: number; h: number } | null {
  if (!isRecord(page)) return null;
  const view = page.view;
  if (!Array.isArray(view) || view.length < 4) return null;
  const w = typeof view[2] === "number" ? view[2] : NaN;
  const h = typeof view[3] === "number" ? view[3] : NaN;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { w, h };
}

type Props = {
  open: boolean;
  templateId: number;
  templateName: string;
  pdfUrl: string;
  initialMappingConfig: unknown;
  savePath?: string;
  saveBodyKey?: string;
  responseMappingKey?: string;
  onClose: () => void;
  onSaved?: (next: PdfMappingConfig) => void;
};

export function TemplatePdfMappingEditor(props: Props) {
  const { toast } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const lastInitFingerprintRef = useRef<string>("");
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [saving, setSaving] = useState(false);
  const [varGroups, setVarGroups] = useState<VarGroup[]>([]);
  const [selectedVarKey, setSelectedVarKey] = useState<string>("");
  const [mapping, setMapping] = useState<PdfMappingConfig>(() => normalizeMappingConfig(props.initialMappingConfig));
  const [pageView, setPageView] = useState<Record<number, { w: number; h: number }>>({});

  const normalizedInitialMapping = useMemo(() => normalizeMappingConfig(props.initialMappingConfig), [props.initialMappingConfig]);

  useEffect(() => {
    if (!props.open) return;
    const fp = mappingFingerprint(normalizedInitialMapping);
    if (fp === lastInitFingerprintRef.current) return;
    lastInitFingerprintRef.current = fp;
    setMapping(normalizedInitialMapping);
    setPage(1);
    loadVarGroups();
  }, [props.open, normalizedInitialMapping]);

  const loadVarGroups = async () => {
    try {
      const data = await (async () => {
        try {
          return await apiFetchJson<unknown>("/document-variables?active=1");
        } catch {
          return await apiFetchJson<unknown>("/platform/document-variables?active=1");
        }
      })();
      if (isLegacyGroups(data)) {
        setVarGroups(data.map((g) => ({ group: g.group, vars: ensureArray(g.vars).map((v) => ({ key: v.key, label: v.label })) })));
        return;
      }
      if (!isVariableDefs(data)) return;
      const map = new Map<string, VarGroup>();
      for (const v of data) {
        const grp = groupLabelForCategory(String(v.category ?? ""));
        const entry = map.get(grp) ?? { group: grp, vars: [] };
        entry.vars.push({ key: v.key, label: v.label });
        map.set(grp, entry);
      }
      const groups = Array.from(map.values()).map((g) => ({ group: g.group, vars: g.vars.sort((a, b) => a.label.localeCompare(b.label)) }));
      setVarGroups(groups.sort((a, b) => a.group.localeCompare(b.group)));
    } catch (e) {
      toastError(toast, e, "Failed to load variables");
    }
  };

  const allVars = useMemo(() => {
    return varGroups.flatMap((g) => g.vars.map((v) => ({ ...v, group: g.group })));
  }, [varGroups]);

  const varLabelByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of allVars) m.set(v.key, v.label);
    return m;
  }, [allVars]);

  const entries = useMemo(() => {
    return Object.entries(mapping).sort((a, b) => a[0].localeCompare(b[0]));
  }, [mapping]);

  const handlePdfClick = (e: React.MouseEvent) => {
    if (!selectedVarKey) return;
    const pageRect = pageContainerRef.current?.getBoundingClientRect();
    if (!pageRect) return;
    const native = e.nativeEvent as unknown as { offsetX?: number; offsetY?: number };
    const xPx = typeof native.offsetX === "number" ? native.offsetX : (e.clientX - pageRect.left);
    const yPx = typeof native.offsetY === "number" ? native.offsetY : (e.clientY - pageRect.top);
    const dims = pageView[page];
    if (!dims) return;
    const x = (xPx / pageRect.width) * dims.w;
    const y = ((pageRect.height - yPx) / pageRect.height) * dims.h;
    setMapping((prev) => ({
      ...prev,
      [selectedVarKey]: {
        page,
        x: Math.max(0, Math.round(x * 100) / 100),
        y: Math.max(0, Math.round(y * 100) / 100),
        size: prev[selectedVarKey]?.size ?? 12,
        ...(prev[selectedVarKey]
          ? {}
          : {
              value: `{{${selectedVarKey}}}`,
            }),
        ...(prev[selectedVarKey]?.maxWidth ? { maxWidth: prev[selectedVarKey]?.maxWidth } : {}),
        ...(prev[selectedVarKey]?.lineHeight ? { lineHeight: prev[selectedVarKey]?.lineHeight } : {}),
        ...(prev[selectedVarKey]?.fontFamily ? { fontFamily: prev[selectedVarKey]?.fontFamily } : {}),
        ...(prev[selectedVarKey]?.alignment ? { alignment: prev[selectedVarKey]?.alignment } : {}),
      },
    }));
  };

  const updateEntry = (key: string, patch: Partial<PdfMappingConfig[string]>) => {
    setMapping((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const deleteEntry = (key: string) => {
    setMapping((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const savePath = props.savePath ?? `/templates/${props.templateId}`;
      const saveBodyKey = props.saveBodyKey ?? "mappingConfig";
      const responseMappingKey = props.responseMappingKey ?? "mapping_config";
      const updated = await apiFetchJson(savePath, {
        method: "PATCH",
        body: JSON.stringify({ [saveBodyKey]: mapping }),
      });
      const next = (() => {
        if (!isRecord(updated)) return mapping;
        return normalizeMappingConfig((updated as any)[responseMappingKey] ?? mapping);
      })();
      props.onSaved?.(next);
      toast({ title: "PDF mapping saved" });
    } catch (e) {
      toastError(toast, e, "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(v) => { if (!v) props.onClose(); }}>
      <DialogContent className="max-w-[1200px] w-[95vw] max-h-[100dvh] h-[100dvh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle className="flex items-center gap-2">
            PDF Mapping · {props.templateName}
            <Badge variant="secondary">template #{props.templateId}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 grid grid-cols-1 md:grid-cols-[1fr_360px] gap-0 overflow-hidden">
          <div className="flex flex-col overflow-hidden">
            <div className="px-6 py-3 border-b flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <div className="text-sm text-slate-600">
                Page {page} / {numPages || "—"}
              </div>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(numPages || p, p + 1))} disabled={!numPages || page >= numPages}>
                <ChevronRight className="w-4 h-4" />
              </Button>
              <div className="flex-1" />
              <Select value={selectedVarKey} onValueChange={setSelectedVarKey}>
                <SelectTrigger className="w-[360px]"><SelectValue placeholder="Select a variable then click on PDF" /></SelectTrigger>
                <SelectContent>
                  {allVars.map((v) => (
                    <SelectItem key={v.key} value={v.key}>{v.group} · {v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex-1 overflow-auto bg-slate-50" ref={containerRef}>
              <div className="p-6 flex justify-center">
                <div ref={pageContainerRef} onClick={handlePdfClick} className="shadow bg-white relative">
                  <Document file={props.pdfUrl} onLoadSuccess={(d) => setNumPages(d.numPages)} loading={<div className="p-6 text-sm text-slate-500">Loading PDF…</div>}>
                    <Page
                      pageNumber={page}
                      renderAnnotationLayer={false}
                      renderTextLayer={false}
                      onLoadSuccess={(p) => {
                        const dims = viewDimsFromPdfPage(p);
                        if (!dims) return;
                        setPageView((prev) => ({ ...prev, [page]: dims }));
                      }}
                    />
                  </Document>
                  {(() => {
                    const dims = pageView[page];
                    if (!dims) return null;
                    const markers = entries.filter(([, v]) => v.page === page);
                    if (markers.length === 0) return null;
                    return (
                      <div className="absolute inset-0">
                        {markers.map(([key, v]) => {
                          const left = Math.max(0, Math.min(100, (v.x / dims.w) * 100));
                          const top = Math.max(0, Math.min(100, 100 - (v.y / dims.h) * 100));
                          const label = varLabelByKey.get(key) ?? key;
                          const selected = selectedVarKey === key;
                          return (
                            <button
                              key={key}
                              type="button"
                              className={cn(
                                "absolute -translate-x-1/2 -translate-y-1/2 rounded border px-1.5 py-0.5 text-[10px] font-semibold shadow-sm",
                                selected ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-800 border-slate-300"
                              )}
                              style={{ left: `${left}%`, top: `${top}%` }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedVarKey(key);
                              }}
                              title={label}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          </div>

          <div className="border-l bg-white h-full max-h-full overflow-y-auto">
            <div className="p-4 border-b">
              <div className="text-sm font-medium">Mappings</div>
              <div className="text-xs text-slate-500 mt-1">
                Select a variable, then click on the PDF to set x/y for that variable.
              </div>
            </div>

            <div className="p-4 space-y-4">
              {entries.length === 0 ? (
                <div className="text-sm text-slate-500">No mappings yet.</div>
              ) : (
                entries.map(([key, v]) => (
                  <div key={key} className="rounded border border-slate-200 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium truncate">{key}</div>
                      <Button variant="ghost" size="sm" onClick={() => deleteEntry(key)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500 mb-1">Content / Value</div>
                      <Textarea
                        value={v.value ?? ""}
                        placeholder={`{{${key}}}`}
                        className="min-h-[72px]"
                        onChange={(e) => {
                          const next = e.target.value;
                          updateEntry(key, { value: next.trim() ? next : undefined });
                        }}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-xs text-slate-500 mb-1">Page</div>
                        <Input value={String(v.page)} onChange={(e) => updateEntry(key, { page: Math.max(1, Number(e.target.value) || 1) })} />
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 mb-1">Font size</div>
                        <Input value={String(v.size)} onChange={(e) => updateEntry(key, { size: Math.max(1, Number(e.target.value) || 12) })} />
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 mb-1">Font</div>
                        <Select
                          value={v.fontFamily ?? "Helvetica"}
                          onValueChange={(val) => updateEntry(key, { fontFamily: val as PdfFontFamily })}
                        >
                          <SelectTrigger className="h-9"><SelectValue placeholder="Font" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Helvetica">Helvetica</SelectItem>
                            <SelectItem value="Times-Roman">Times-Roman</SelectItem>
                            <SelectItem value="Courier">Courier</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 mb-1">Alignment</div>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant={(v.alignment ?? "left") === "left" ? "default" : "outline"}
                            size="sm"
                            className="h-9 w-10 p-0"
                            onClick={() => updateEntry(key, { alignment: "left" })}
                            title="Left"
                          >
                            <AlignLeft className="w-4 h-4" />
                          </Button>
                          <Button
                            type="button"
                            variant={(v.alignment ?? "left") === "center" ? "default" : "outline"}
                            size="sm"
                            className="h-9 w-10 p-0"
                            onClick={() => updateEntry(key, { alignment: "center" })}
                            title="Center"
                          >
                            <AlignCenter className="w-4 h-4" />
                          </Button>
                          <Button
                            type="button"
                            variant={(v.alignment ?? "left") === "right" ? "default" : "outline"}
                            size="sm"
                            className="h-9 w-10 p-0"
                            onClick={() => updateEntry(key, { alignment: "right" })}
                            title="Right"
                          >
                            <AlignRight className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 mb-1">X</div>
                        <Input value={String(v.x)} onChange={(e) => updateEntry(key, { x: Number(e.target.value) || 0 })} />
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 mb-1">Y</div>
                        <Input value={String(v.y)} onChange={(e) => updateEntry(key, { y: Number(e.target.value) || 0 })} />
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 mb-1">Max width</div>
                        <Input value={v.maxWidth ?? ""} onChange={(e) => updateEntry(key, { maxWidth: e.target.value ? Math.max(1, Number(e.target.value) || 1) : undefined })} />
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 mb-1">Line height</div>
                        <Input value={v.lineHeight ?? ""} onChange={(e) => updateEntry(key, { lineHeight: e.target.value ? Math.max(1, Number(e.target.value) || 1) : undefined })} />
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t flex items-center justify-between sticky bottom-0 bg-white">
          <div className="text-xs text-slate-500">
            Click mapping uses PDF points (origin bottom-left).
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={props.onClose}>Close</Button>
            <Button onClick={save} disabled={saving}>
              <Save className="w-4 h-4 mr-2" />
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
