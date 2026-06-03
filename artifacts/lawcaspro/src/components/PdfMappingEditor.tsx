import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Save,
  X,
  Type,
  BookOpen,
  Minus,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Copy,
  Star,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { apiFetchJson } from "@/lib/api-client";
import { toastError } from "@/lib/toast-error";

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type TextAlignment = "left" | "center" | "right";
type PdfFontFamily = "Helvetica" | "Times-Roman" | "Courier";

interface TextBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  lineHeight?: number;
  alignment: TextAlignment;
  fontFamily: PdfFontFamily;
  content: string;
}

interface PageMapping {
  pageIndex: number;
  textBoxes: TextBox[];
}

interface PdfMappings {
  pages: PageMapping[];
}

type LegacyPdfMappingEntry = {
  key: string;
  page: number;
  x: number;
  y: number;
  size: number;
  value?: string;
  maxWidth?: number;
  lineHeight?: number;
  alignment?: TextAlignment;
  fontFamily?: PdfFontFamily;
};

type LegacyVarGroup = {
  group: string;
  vars: { key: string; label: string; type?: string; fields?: string }[];
};

type VariableDefinition = {
  id: number;
  key: string;
  label: string;
  description: string | null;
  category: string;
  valueType: string;
  sourcePath: string | null;
  formatter: string | null;
  exampleValue: string | null;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
};

type VarGroup = {
  group: string;
  vars: {
    key: string;
    label: string;
    type?: string;
    category?: string;
    exampleValue?: string | null;
  }[];
};

interface Props {
  docId: number;
  docName: string;
  pdfUrl: string;
  onClose: () => void;
  mappingsGetUrl?: string;
  mappingsPutUrl?: string;
  variablesUrlPrimary?: string;
  variablesUrlFallback?: string;
}

export default function PdfMappingEditor({
  docId,
  docName,
  pdfUrl,
  onClose,
  mappingsGetUrl,
  mappingsPutUrl,
  variablesUrlPrimary,
  variablesUrlFallback,
}: Props) {
  const { toast } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  const contentTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [mappings, setMappings] = useState<PdfMappings>({ pages: [] });
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showVarPanel, setShowVarPanel] = useState(false);
  const [varGroups, setVarGroups] = useState<VarGroup[]>([]);
  const [varSearch, setVarSearch] = useState("");
  const recentVarsStorageKey = useMemo(
    () => `lawcaspro:pdf_mapping_recent_vars:${docId}`,
    [docId],
  );
  const favoriteVarsStorageKey = useMemo(
    () => `lawcaspro:pdf_mapping_favorite_vars:${docId}`,
    [docId],
  );
  const [recentVarKeys, setRecentVarKeys] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(recentVarsStorageKey);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return Array.isArray(parsed)
        ? parsed.map((x) => String(x)).filter(Boolean).slice(0, 12)
        : [];
    } catch {
      return [];
    }
  });
  const [favoriteVarKeys, setFavoriteVarKeys] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(favoriteVarsStorageKey);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return Array.isArray(parsed)
        ? parsed.map((x) => String(x)).filter(Boolean).slice(0, 50)
        : [];
    } catch {
      return [];
    }
  });
  const favoriteVarKeySet = useMemo(
    () => new Set(favoriteVarKeys),
    [favoriteVarKeys],
  );
  const [pdfScale, setPdfScale] = useState(1);
  const [pdfDimensions, setPdfDimensions] = useState({ width: 0, height: 0 });
  const [pageView, setPageView] = useState<
    Record<number, { width: number; height: number }>
  >({});
  const [legacyEntries, setLegacyEntries] = useState<
    LegacyPdfMappingEntry[] | null
  >(null);

  const [dragging, setDragging] = useState<{
    boxId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const [resizing, setResizing] = useState<{
    boxId: string;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const isRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        recentVarsStorageKey,
        JSON.stringify(recentVarKeys),
      );
    } catch {
    }
  }, [recentVarKeys, recentVarsStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        favoriteVarsStorageKey,
        JSON.stringify(favoriteVarKeys),
      );
    } catch {
    }
  }, [favoriteVarKeys, favoriteVarsStorageKey]);

  const isPdfMappings = (v: unknown): v is PdfMappings => {
    if (!isRecord(v)) return false;
    const pages = (v as any).pages;
    if (!Array.isArray(pages)) return false;
    const first = pages[0] as any;
    if (!first) return true;
    if (!first || typeof first !== "object" || Array.isArray(first))
      return false;
    if (typeof first.pageIndex !== "number") return false;
    if (!Array.isArray(first.textBoxes)) return false;
    return true;
  };

  const normalizeLegacyPdfMapping = (raw: unknown): LegacyPdfMappingEntry[] => {
    const out: LegacyPdfMappingEntry[] = [];
    const pushOne = (key: unknown, coord: any) => {
      if (typeof key !== "string" || !key.trim()) return;
      const page =
        typeof coord?.page === "number" && Number.isFinite(coord.page)
          ? Math.max(1, Math.floor(coord.page))
          : 1;
      const x =
        typeof coord?.x === "number" && Number.isFinite(coord.x)
          ? coord.x
          : NaN;
      const y =
        typeof coord?.y === "number" && Number.isFinite(coord.y)
          ? coord.y
          : NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const size =
        typeof coord?.size === "number" && Number.isFinite(coord.size)
          ? Math.max(1, coord.size)
          : 12;
      const value =
        typeof coord?.value === "string"
          ? coord.value
          : typeof coord?.content === "string"
            ? coord.content
            : typeof coord?.expression === "string"
              ? coord.expression
              : undefined;
      const maxWidth =
        typeof coord?.maxWidth === "number" && Number.isFinite(coord.maxWidth)
          ? Math.max(1, coord.maxWidth)
          : undefined;
      const lineHeight =
        typeof coord?.lineHeight === "number" &&
        Number.isFinite(coord.lineHeight)
          ? Math.max(1, coord.lineHeight)
          : undefined;
      const alignment =
        coord?.alignment === "left" ||
        coord?.alignment === "center" ||
        coord?.alignment === "right"
          ? (coord.alignment as TextAlignment)
          : undefined;
      const fontFamily =
        coord?.fontFamily === "Helvetica" ||
        coord?.fontFamily === "Times-Roman" ||
        coord?.fontFamily === "Courier"
          ? (coord.fontFamily as PdfFontFamily)
          : undefined;
      out.push({
        key: key.trim(),
        page,
        x,
        y,
        size,
        ...(value ? { value } : {}),
        ...(maxWidth ? { maxWidth } : {}),
        ...(lineHeight ? { lineHeight } : {}),
        ...(alignment ? { alignment } : {}),
        ...(fontFamily ? { fontFamily } : {}),
      });
    };
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const rec = item as any;
        const key =
          typeof rec.key === "string"
            ? rec.key
            : typeof rec.variableKey === "string"
              ? rec.variableKey
              : typeof rec.variable === "string"
                ? rec.variable
                : undefined;
        pushOne(key, rec);
      }
      return out;
    }
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>))
        pushOne(k, v as any);
    }
    return out;
  };

  const legacyToCanvasMappings = (
    entries: LegacyPdfMappingEntry[],
    views: Record<number, { width: number; height: number }>,
    fallbackHeight: number,
  ): PdfMappings => {
    const byPage = new Map<number, TextBox[]>();
    for (const e of entries) {
      const pageIndex = Math.max(0, (e.page || 1) - 1);
      const pageHeight = views[pageIndex]?.height ?? fallbackHeight;
      const fontSize = e.size || 10;
      const yTop = Math.max(0, pageHeight - e.y - fontSize);
      const tb: TextBox = {
        id: `legacy_${pageIndex}_${e.key}_${Math.random().toString(36).slice(2, 8)}`,
        x: Math.max(0, e.x),
        y: yTop,
        width: e.maxWidth ?? 200,
        height: e.lineHeight ?? Math.ceil(fontSize * 1.3),
        fontSize,
        alignment: e.alignment ?? "left",
        fontFamily: e.fontFamily ?? "Helvetica",
        content:
          typeof e.value === "string" && e.value.trim()
            ? e.value
            : `{{${e.key}}}`,
      };
      const list = byPage.get(pageIndex) ?? [];
      list.push(tb);
      byPage.set(pageIndex, list);
    }
    const pages: PageMapping[] = Array.from(byPage.entries())
      .map(([pageIndex, textBoxes]) => ({ pageIndex, textBoxes }))
      .sort((a, b) => a.pageIndex - b.pageIndex);
    return { pages };
  };

  useEffect(() => {
    loadMappings();
    loadVarGroups();
  }, [docId]);

  const loadMappings = async () => {
    try {
      const data = await apiFetchJson<unknown>(
        mappingsGetUrl ?? `/platform/documents/${docId}/pdf-mappings`,
        { allowStatuses: [404] },
      );
      const raw =
        isRecord(data) && "mappings" in data ? (data as any).mappings : null;
      if (!raw) {
        setMappings({ pages: [] });
        setLegacyEntries(null);
      } else if (isPdfMappings(raw)) {
        setMappings(raw);
        setLegacyEntries(null);
      } else {
        setMappings({ pages: [] });
        setLegacyEntries(normalizeLegacyPdfMapping(raw));
      }
    } catch {
      /* ignore */
    }
    setLoading(false);
  };

  const loadVarGroups = async () => {
    try {
      const data = await (async () => {
        try {
          return await apiFetchJson<unknown>(
            variablesUrlPrimary ?? "/platform/document-variables?active=1",
          );
        } catch {
          return await apiFetchJson<unknown>(
            variablesUrlFallback ?? "/document-variables?active=1",
          );
        }
      })();
      const isLegacyGroups = (v: unknown): v is LegacyVarGroup[] => {
        if (!Array.isArray(v)) return false;
        const first = v[0] as any;
        return (
          !!first &&
          typeof first === "object" &&
          typeof first.group === "string" &&
          Array.isArray(first.vars)
        );
      };
      if (isLegacyGroups(data)) {
        setVarGroups(data);
        return;
      }

      const isVariableDefs = (v: unknown): v is VariableDefinition[] => {
        if (!Array.isArray(v)) return false;
        const first = v[0] as any;
        return (
          !!first &&
          typeof first === "object" &&
          typeof first.key === "string" &&
          typeof first.label === "string"
        );
      };
      if (!isVariableDefs(data)) return;

      const groupLabelForCategory = (cat: string): string => {
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
      };

      const groupsMap = new Map<string, VarGroup>();
      for (const v of data) {
        const group = groupLabelForCategory(v.category);
        const item = {
          key: v.key,
          label: v.label,
          type: v.valueType === "array" ? "loop" : undefined,
          category: v.category,
          exampleValue: v.exampleValue ?? null,
        };
        const existing = groupsMap.get(group);
        if (existing) existing.vars.push(item);
        else groupsMap.set(group, { group, vars: [item] });
      }

      const groups = Array.from(groupsMap.values()).map((g) => ({
        group: g.group,
        vars: [...g.vars].sort((a, b) => a.label.localeCompare(b.label)),
      }));
      setVarGroups(groups.sort((a, b) => a.group.localeCompare(b.group)));
    } catch {
      /* ignore */
    }
  };

  const saveMappings = async () => {
    setSaving(true);
    try {
      await apiFetchJson(
        mappingsPutUrl ?? `/platform/documents/${docId}/pdf-mappings`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mappings }),
        },
      );
      toast({ title: "Mappings saved" });
    } catch (e) {
      toastError(toast, e, "Failed to save");
    }
    setSaving(false);
  };

  useEffect(() => {
    if (!legacyEntries || legacyEntries.length === 0) return;
    const values = Object.values(pageView);
    const fallbackHeight = values[0]?.height ?? pdfDimensions.height;
    if (!fallbackHeight || !Number.isFinite(fallbackHeight)) return;
    setMappings(
      legacyToCanvasMappings(legacyEntries, pageView, fallbackHeight),
    );
    setLegacyEntries(null);
  }, [legacyEntries, pageView, pdfDimensions.height]);

  const getCurrentPageBoxes = (): TextBox[] => {
    const pm = mappings.pages.find((p) => p.pageIndex === currentPage);
    return pm?.textBoxes ?? [];
  };

  const updateCurrentPageBoxes = (textBoxes: TextBox[]) => {
    setMappings((prev) => {
      const newPages = [...prev.pages];
      const idx = newPages.findIndex((p) => p.pageIndex === currentPage);
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
      lineHeight: 1.2,
      alignment: "left",
      fontFamily: "Helvetica",
      content: "",
    };
    updateCurrentPageBoxes([...getCurrentPageBoxes(), newBox]);
    setSelectedBoxId(newBox.id);
  };

  const duplicateSelectedTextBox = () => {
    if (!selectedBox) return;
    const copy: TextBox = {
      ...selectedBox,
      id: `tb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      x: selectedBox.x + 10,
      y: selectedBox.y + 10,
      lineHeight:
        typeof selectedBox.lineHeight === "number"
          ? selectedBox.lineHeight
          : 1.2,
    };
    updateCurrentPageBoxes([...getCurrentPageBoxes(), copy]);
    setSelectedBoxId(copy.id);
  };

  const deleteTextBox = (boxId: string) => {
    updateCurrentPageBoxes(getCurrentPageBoxes().filter((b) => b.id !== boxId));
    if (selectedBoxId === boxId) setSelectedBoxId(null);
  };

  const updateTextBox = (boxId: string, updates: Partial<TextBox>) => {
    updateCurrentPageBoxes(
      getCurrentPageBoxes().map((b) =>
        b.id === boxId ? { ...b, ...updates } : b,
      ),
    );
  };

  const selectedBox = getCurrentPageBoxes().find((b) => b.id === selectedBoxId);

  const clamp = (n: number, min: number, max: number) =>
    Math.min(max, Math.max(min, n));
  const roundTo1dp = (n: number) => Math.round(n * 10) / 10;

  const cssFontFamily = (font: PdfFontFamily): string => {
    if (font === "Times-Roman") return "Times New Roman, Times, serif";
    if (font === "Courier") return "Courier New, Courier, monospace";
    return "Helvetica, Arial, sans-serif";
  };

  const insertIntoSelectedContentAtCursor = (insertText: string) => {
    if (!selectedBoxId) {
      toast({
        title: "Please select a text box first, or create a new text box.",
      });
      return;
    }
    const box = getCurrentPageBoxes().find((b) => b.id === selectedBoxId);
    if (!box) return;
    const el = contentTextareaRef.current;
    const start =
      el && typeof el.selectionStart === "number"
        ? el.selectionStart
        : box.content.length;
    const end =
      el && typeof el.selectionEnd === "number" ? el.selectionEnd : start;
    const next =
      box.content.slice(0, start) + insertText + box.content.slice(end);
    const nextCursor = start + insertText.length;
    updateTextBox(selectedBoxId, { content: next });
    setTimeout(() => {
      const target = contentTextareaRef.current;
      if (!target) return;
      try {
        target.focus();
        target.setSelectionRange(nextCursor, nextCursor);
      } catch {}
    }, 0);
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-textbox]")) return;
    setSelectedBoxId(null);
  };

  const handleMouseDown = (
    e: React.MouseEvent,
    boxId: string,
    mode: "drag" | "resize",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const box = getCurrentPageBoxes().find((b) => b.id === boxId);
    if (!box) return;
    setSelectedBoxId(boxId);
    if (mode === "drag") {
      setDragging({
        boxId,
        startX: e.clientX,
        startY: e.clientY,
        origX: box.x,
        origY: box.y,
      });
    } else {
      setResizing({
        boxId,
        startX: e.clientX,
        startY: e.clientY,
        origW: box.width,
        origH: box.height,
      });
    }
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
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
    },
    [dragging, resizing, pdfScale],
  );

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
    const normalizedKey = String(key ?? "")
      .trim()
      .replace(/^\{\{\s*/, "")
      .replace(/\s*\}\}$/, "")
      .replace(/^\{\s*/, "")
      .replace(/\s*\}$/, "");
    setRecentVarKeys((prev) =>
      [normalizedKey, ...prev.filter((x) => x !== normalizedKey)].slice(0, 12),
    );
    let varText: string;
    if (type === "loop") {
      varText = `{#${normalizedKey}}...{/${normalizedKey}}`;
    } else if (type === "loopField") {
      varText = `{${normalizedKey}}`;
    } else {
      varText = `{{${normalizedKey}}}`;
    }
    insertIntoSelectedContentAtCursor(varText);
  };

  const toggleFavoriteVarKey = (key: string) => {
    const k = String(key || "").trim();
    if (!k) return;
    setFavoriteVarKeys((prev) => {
      const has = prev.includes(k);
      const next = has ? prev.filter((x) => x !== k) : [k, ...prev];
      return next.slice(0, 50);
    });
  };

  const copyVarToken = async (key: string) => {
    const k = String(key || "").trim();
    if (!k) return;
    try {
      await navigator.clipboard.writeText(`{{${k}}}`);
      toast({ title: "Copied", description: `{{${k}}}` });
    } catch {
      toast({ title: "Copy failed" });
    }
  };

  const availableVarKeySet = useMemo(() => {
    const s = new Set<string>();
    for (const g of varGroups) for (const v of g.vars) if (v.key) s.add(v.key);
    return s;
  }, [varGroups]);

  const quickInsertKeys = useMemo(() => {
    const base = [
      "reference_no",
      "parcel_no",
      "developer_name",
      "purchasers_inline",
      "purchaser_name",
      "purchaser_ic",
    ];
    if (availableVarKeySet.has("loan_bank_name")) base.push("loan_bank_name");
    else if (availableVarKeySet.has("bank_name")) base.push("bank_name");
    return base;
  }, [availableVarKeySet]);

  const filteredVarGroups = useMemo(() => {
    const q = varSearch.trim().toLowerCase();
    if (!q) return varGroups;
    const matches = (
      v: { key: string; label: string; category?: string },
      group: string,
    ) => {
      const hay =
        `${v.key} ${v.label} ${v.category ?? ""} ${group}`.toLowerCase();
      return hay.includes(q);
    };
    return varGroups
      .map((g) => ({ ...g, vars: g.vars.filter((v) => matches(v, g.group)) }))
      .filter((g) => g.vars.length > 0);
  }, [varGroups, varSearch]);

  const insertVariablePanel = (
    <div className="border-t">
      <div className="p-4 bg-blue-50 border-b">
        <h3 className="text-xs font-semibold text-blue-800 uppercase tracking-wider">
          Insert Variable
        </h3>
        <p className="text-xs text-blue-600 mt-0.5">
          Insert into content at cursor
        </p>
      </div>
      <div className="p-4 space-y-3">
        {favoriteVarKeys.length > 0 ? (
          <div>
            <div className="text-xs font-medium text-slate-600 mb-1">
              Favorites
            </div>
            <div className="flex flex-wrap gap-1.5">
              {favoriteVarKeys.slice(0, 12).map((k) => (
                <Button
                  key={k}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => insertVariable(k)}
                >
                  {k}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {recentVarKeys.length > 0 ? (
          <div>
            <div className="text-xs font-medium text-slate-600 mb-1">
              Recent
            </div>
            <div className="flex flex-wrap gap-1.5">
              {recentVarKeys.slice(0, 12).map((k) => (
                <Button
                  key={k}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => insertVariable(k)}
                >
                  {k}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <div className="text-xs font-medium text-slate-600 mb-1">
            Quick Insert
          </div>
          <div className="flex flex-wrap gap-1.5">
            {quickInsertKeys.map((k) => (
              <Button
                key={k}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => insertVariable(k)}
              >
                {k}
              </Button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-slate-600 mb-1 block">
            Search
          </label>
          <Input
            value={varSearch}
            onChange={(e) => setVarSearch(e.target.value)}
            placeholder="Search by key, label, category..."
            className="h-8 text-xs"
          />
        </div>

        <div className="border rounded-md overflow-hidden">
          <div className="max-h-[260px] overflow-auto">
            {filteredVarGroups.length === 0 ? (
              <div className="p-3 text-xs text-slate-500">No results.</div>
            ) : (
              <div className="divide-y">
                {filteredVarGroups.map((g) => (
                  <div key={g.group}>
                    <div className="px-3 py-2 text-[11px] font-semibold text-slate-600 bg-slate-50 border-b">
                      {g.group}
                    </div>
                    <div className="divide-y">
                      {g.vars.map((v) => (
                        <div
                          key={`${g.group}:${v.key}`}
                          className="w-full text-left px-3 py-2 hover:bg-slate-50"
                          role="button"
                          tabIndex={0}
                          onClick={() => insertVariable(v.key, (v as any).type)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              insertVariable(v.key, (v as any).type);
                            }
                          }}
                        >
                          <div className="flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-medium text-slate-800 truncate">
                                {v.label}
                              </div>
                              <div className="text-[11px] text-slate-500 truncate">
                                {v.key}
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                className={cn(
                                  "p-1 rounded hover:bg-slate-100",
                                  favoriteVarKeySet.has(v.key) &&
                                    "text-amber-500",
                                )}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  toggleFavoriteVarKey(v.key);
                                }}
                                aria-label="Favorite"
                              >
                                <Star className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                className="p-1 rounded hover:bg-slate-100"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void copyVarToken(v.key);
                                }}
                                aria-label="Copy token"
                              >
                                <Copy className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            <div className="text-[11px] text-slate-400 shrink-0">
                              {v.category ?? g.group}
                            </div>
                          </div>
                          {v.exampleValue ? (
                            <div className="text-[11px] text-slate-500 mt-1 line-clamp-2">
                              Example: {v.exampleValue}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  const onDocLoad = ({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setCurrentPage(0);
  };

  const onPageLoad = (page: any) => {
    const vp = page.getViewport({ scale: 1 });
    setPdfDimensions({ width: vp.width, height: vp.height });
    setPageView((prev) => ({
      ...prev,
      [currentPage]: { width: vp.width, height: vp.height },
    }));
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
              <h2 className="font-semibold text-slate-800 text-sm truncate max-w-[200px]">
                {docName}
              </h2>
              <Badge variant="outline" className="text-xs">
                PDF Mapping
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 border rounded-md px-2 py-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  disabled={currentPage === 0}
                  onClick={() => setCurrentPage((p) => p - 1)}
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-xs text-slate-600 min-w-[60px] text-center">
                  Page {currentPage + 1} / {numPages}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  disabled={currentPage >= numPages - 1}
                  onClick={() => setCurrentPage((p) => p + 1)}
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1"
                onClick={addTextBox}
              >
                <Plus className="w-3.5 h-3.5" />
                Add Text Box
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1"
                onClick={() => setShowVarPanel(!showVarPanel)}
              >
                <BookOpen className="w-3.5 h-3.5" />
                Variables
              </Button>
              <Button
                size="sm"
                className="h-7 gap-1"
                onClick={saveMappings}
                disabled={saving}
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? "Saving..." : "Save"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={onClose}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div
            ref={containerRef}
            className="flex-1 overflow-auto bg-slate-200 p-3 flex justify-center"
            onClick={handleCanvasClick}
          >
            <div
              className="relative inline-block"
              style={{
                width: pdfDimensions.width * pdfScale,
                height: pdfDimensions.height * pdfScale,
              }}
            >
              <Document
                file={pdfUrl}
                onLoadSuccess={onDocLoad}
                onLoadError={(err) => toastError(toast, err, "PDF load error")}
              >
                <Page
                  pageIndex={currentPage}
                  onLoadSuccess={onPageLoad}
                  scale={pdfScale}
                  renderAnnotationLayer={false}
                  renderTextLayer={false}
                />
              </Document>

              {boxes.map((box) => (
                <div
                  key={box.id}
                  data-textbox
                  className={cn(
                    "absolute border-2 cursor-move group",
                    selectedBoxId === box.id
                      ? "border-blue-500 bg-blue-50/30"
                      : "border-amber-400/60 bg-amber-50/20 hover:border-amber-500",
                  )}
                  style={{
                    left: box.x * pdfScale,
                    top: box.y * pdfScale,
                    width: box.width * pdfScale,
                    height: box.height * pdfScale,
                  }}
                  onMouseDown={(e) => handleMouseDown(e, box.id, "drag")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedBoxId(box.id);
                  }}
                >
                  <div className="absolute inset-0 overflow-hidden px-1 flex items-start">
                    <span
                      className="text-slate-700 leading-tight break-words whitespace-pre-wrap block"
                      style={{
                        fontSize: box.fontSize * pdfScale,
                        textAlign: box.alignment,
                        width: "100%",
                        fontFamily: cssFontFamily(box.fontFamily),
                      }}
                    >
                      {box.content || "..."}
                    </span>
                  </div>
                  {selectedBoxId === box.id && (
                    <>
                      <button
                        className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center text-xs hover:bg-red-600 z-10"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteTextBox(box.id);
                        }}
                      >
                        <X className="w-3 h-3" />
                      </button>
                      <div
                        className="absolute bottom-0 right-0 w-4 h-4 bg-blue-500 cursor-se-resize rounded-tl-sm"
                        onMouseDown={(e) =>
                          handleMouseDown(e, box.id, "resize")
                        }
                      />
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="w-72 border-l flex flex-col bg-white shrink-0">
          <div className="flex-1 overflow-y-auto">
            {selectedBox ? (
              <>
                <div className="p-4 border-b bg-slate-50">
                  <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                    Text Box Properties
                  </h3>
                </div>
                <div className="p-4 space-y-4">
                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">
                      Content
                    </label>
                    <textarea
                      className="w-full border rounded-md px-2 py-1.5 text-sm resize-none focus:ring-1 focus:ring-blue-300 focus:border-blue-300"
                      rows={4}
                      value={selectedBox.content}
                      onChange={(e) =>
                        updateTextBox(selectedBox.id, {
                          content: e.target.value,
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key !== "Tab") return;
                        e.preventDefault();
                        insertIntoSelectedContentAtCursor("\t");
                      }}
                      placeholder="Type text and/or {{variables}} here..."
                      ref={contentTextareaRef}
                    />
                    <p className="text-xs text-slate-400 mt-1">
                      Use {"{{variable_name}}"} for variables
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-slate-600 mb-1 block">
                        Font
                      </label>
                      <Select
                        value={selectedBox.fontFamily}
                        onValueChange={(v) =>
                          updateTextBox(selectedBox.id, {
                            fontFamily: v as PdfFontFamily,
                          })
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Font" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Helvetica">Helvetica</SelectItem>
                          <SelectItem value="Times-Roman">
                            Times-Roman
                          </SelectItem>
                          <SelectItem value="Courier">Courier</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-slate-600 mb-1 block">
                        Alignment
                      </label>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant={
                            selectedBox.alignment === "left"
                              ? "default"
                              : "outline"
                          }
                          size="sm"
                          className="h-8 w-10 p-0"
                          onClick={() =>
                            updateTextBox(selectedBox.id, { alignment: "left" })
                          }
                          title="Left"
                        >
                          <AlignLeft className="w-4 h-4" />
                        </Button>
                        <Button
                          type="button"
                          variant={
                            selectedBox.alignment === "center"
                              ? "default"
                              : "outline"
                          }
                          size="sm"
                          className="h-8 w-10 p-0"
                          onClick={() =>
                            updateTextBox(selectedBox.id, {
                              alignment: "center",
                            })
                          }
                          title="Center"
                        >
                          <AlignCenter className="w-4 h-4" />
                        </Button>
                        <Button
                          type="button"
                          variant={
                            selectedBox.alignment === "right"
                              ? "default"
                              : "outline"
                          }
                          size="sm"
                          className="h-8 w-10 p-0"
                          onClick={() =>
                            updateTextBox(selectedBox.id, {
                              alignment: "right",
                            })
                          }
                          title="Right"
                        >
                          <AlignRight className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs font-medium text-slate-600 mb-1 block">
                        X
                      </label>
                      <Input
                        type="number"
                        className="h-7 text-xs"
                        value={Math.round(selectedBox.x)}
                        onChange={(e) =>
                          updateTextBox(selectedBox.id, {
                            x: Number(e.target.value),
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-slate-600 mb-1 block">
                        Y
                      </label>
                      <Input
                        type="number"
                        className="h-7 text-xs"
                        value={Math.round(selectedBox.y)}
                        onChange={(e) =>
                          updateTextBox(selectedBox.id, {
                            y: Number(e.target.value),
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-slate-600 mb-1 block">
                        Width
                      </label>
                      <Input
                        type="number"
                        className="h-7 text-xs"
                        value={Math.round(selectedBox.width)}
                        onChange={(e) =>
                          updateTextBox(selectedBox.id, {
                            width: Number(e.target.value),
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-slate-600 mb-1 block">
                        Height
                      </label>
                      <Input
                        type="number"
                        className="h-7 text-xs"
                        value={Math.round(selectedBox.height)}
                        onChange={(e) =>
                          updateTextBox(selectedBox.id, {
                            height: Number(e.target.value),
                          })
                        }
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">
                      Font Size
                    </label>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() =>
                          updateTextBox(selectedBox.id, {
                            fontSize: Math.max(6, selectedBox.fontSize - 1),
                          })
                        }
                      >
                        <Minus className="w-3 h-3" />
                      </Button>
                      <Input
                        type="number"
                        className="h-7 text-xs text-center w-16"
                        value={selectedBox.fontSize}
                        onChange={(e) =>
                          updateTextBox(selectedBox.id, {
                            fontSize: Number(e.target.value) || 10,
                          })
                        }
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() =>
                          updateTextBox(selectedBox.id, {
                            fontSize: selectedBox.fontSize + 1,
                          })
                        }
                      >
                        <Plus className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-600 mb-1 block">
                      Line Height
                    </label>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => {
                          const cur =
                            typeof selectedBox.lineHeight === "number" &&
                            Number.isFinite(selectedBox.lineHeight)
                              ? selectedBox.lineHeight
                              : 1.2;
                          const next = roundTo1dp(clamp(cur - 0.1, 0.8, 3.0));
                          updateTextBox(selectedBox.id, { lineHeight: next });
                        }}
                      >
                        <Minus className="w-3 h-3" />
                      </Button>
                      <Input
                        type="number"
                        step={0.1}
                        min={0.8}
                        max={3.0}
                        className="h-7 text-xs text-center w-16"
                        value={roundTo1dp(
                          typeof selectedBox.lineHeight === "number" &&
                            Number.isFinite(selectedBox.lineHeight)
                            ? selectedBox.lineHeight
                            : 1.2,
                        )}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (!Number.isFinite(n)) return;
                          updateTextBox(selectedBox.id, {
                            lineHeight: roundTo1dp(clamp(n, 0.8, 3.0)),
                          });
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => {
                          const cur =
                            typeof selectedBox.lineHeight === "number" &&
                            Number.isFinite(selectedBox.lineHeight)
                              ? selectedBox.lineHeight
                              : 1.2;
                          const next = roundTo1dp(clamp(cur + 0.1, 0.8, 3.0));
                          updateTextBox(selectedBox.id, { lineHeight: next });
                        }}
                      >
                        <Plus className="w-3 h-3" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs ml-auto"
                        onClick={() => {
                          const text = String(selectedBox.content ?? "");
                          const lineCount = Math.max(
                            1,
                            text.split(/\r?\n/).length,
                          );
                          const lh =
                            typeof selectedBox.lineHeight === "number" &&
                            Number.isFinite(selectedBox.lineHeight)
                              ? selectedBox.lineHeight
                              : 1.2;
                          const padding = 8;
                          const height = Math.ceil(
                            lineCount * selectedBox.fontSize * lh + padding,
                          );
                          updateTextBox(selectedBox.id, {
                            height: Math.max(16, height),
                            lineHeight: roundTo1dp(clamp(lh, 0.8, 3.0)),
                          });
                        }}
                      >
                        Auto Height
                      </Button>
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full gap-1"
                    onClick={duplicateSelectedTextBox}
                  >
                    <Copy className="w-3.5 h-3.5" />
                    Duplicate Text Box
                  </Button>

                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full gap-1 mt-2"
                    onClick={() => deleteTextBox(selectedBox.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Text Box
                  </Button>
                </div>
              </>
            ) : (
              <div className="p-6 text-center">
                <Type className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                <p className="text-sm font-medium text-slate-500">
                  No text box selected
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  Click a text box on the PDF to edit its properties, or click
                  "Add Text Box" to create one.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 gap-1"
                  onClick={addTextBox}
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Text Box
                </Button>
              </div>
            )}

            {showVarPanel ? insertVariablePanel : null}
          </div>

          <div className="border-t p-3 bg-slate-50">
            <p className="text-xs text-slate-400">
              {boxes.length} text box{boxes.length !== 1 ? "es" : ""} on this
              page
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
