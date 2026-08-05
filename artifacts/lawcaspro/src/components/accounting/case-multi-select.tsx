import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetchJson } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { X } from "lucide-react";

type CaseSearchItem = {
  id: number;
  referenceNo: string;
  shortLabel: string;
  purchaserNames: string[];
  purchaserLabel: string | null;
  projectName: string | null;
  status: string | null;
};

export type SelectedCase = {
  case_id: number;
  title: string;
  referenceNo?: string;
  purchaserLabel?: string | null;
  projectName?: string | null;
  status?: string | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function normalizeQuery(v: string): string {
  return v.trim().replace(/\s+/g, " ").toLowerCase();
}

function isAbortLikeError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const rec = e as Record<string, unknown>;
  if (rec.name === "AbortError") return true;
  const msg = typeof rec.message === "string" ? rec.message.toLowerCase() : "";
  if (msg.includes("signal is aborted")) return true;
  return false;
}

function coerceCaseSearchItem(v: unknown): CaseSearchItem | null {
  if (!isRecord(v)) return null;
  const idRaw = typeof v.id === "number" ? v.id : typeof v.case_id === "number" ? v.case_id : NaN;
  const id = Number.isFinite(idRaw) && idRaw > 0 ? idRaw : NaN;
  if (!Number.isFinite(id)) return null;
  const referenceNo = typeof v.referenceNo === "string" ? v.referenceNo : typeof v.reference_no === "string" ? v.reference_no : "";
  const shortLabel = typeof v.shortLabel === "string" ? v.shortLabel : typeof v.title === "string" ? v.title : "";
  const purchaserNamesRaw = Array.isArray((v as any).purchaserNames) ? ((v as any).purchaserNames as unknown[]) : [];
  const purchaserNames = purchaserNamesRaw.map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => Boolean(x));
  const purchaserLabel = typeof (v as any).purchaserLabel === "string" ? String((v as any).purchaserLabel).trim() : null;
  return {
    id,
    referenceNo: String(referenceNo ?? "").trim(),
    shortLabel: String(shortLabel ?? "").trim() || String(referenceNo ?? "").trim(),
    purchaserNames,
    purchaserLabel: purchaserLabel || null,
    projectName: typeof v.projectName === "string" ? v.projectName : null,
    status: typeof v.status === "string" ? v.status : null,
  };
}

export function CaseMultiSelect(props: {
  value: SelectedCase[];
  onChange: (next: SelectedCase[]) => void;
  placeholder?: string;
  disabled?: boolean;
  mode?: "multi" | "single";
  error?: string | null;
  endpoint?: string;
  minSearchLength?: number;
  debounceMs?: number;
  limit?: number;
}) {
  const mode = props.mode ?? "multi";
  const endpoint = props.endpoint ?? "/accounting/cases/search";
  const minSearchLength = props.minSearchLength ?? 2;
  const debounceMs = props.debounceMs ?? 300;
  const limit = props.limit ?? 20;

  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(normalizeQuery(raw)), debounceMs);
    return () => clearTimeout(t);
  }, [raw, debounceMs]);

  const [items, setItems] = useState<CaseSearchItem[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const activeSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const lastQueryRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      setIsFetching(false);
      setError(null);
      return;
    }

    const q = normalizeQuery(debounced);
    if (q.length < minSearchLength) {
      abortRef.current?.abort();
      abortRef.current = null;
      setIsFetching(false);
      setError(null);
      return;
    }

    if (lastQueryRef.current === q) return;
    lastQueryRef.current = q;

    requestSeqRef.current += 1;
    const seq = requestSeqRef.current;
    activeSeqRef.current = seq;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setIsFetching(true);

    const qs = new URLSearchParams();
    qs.set("query", q);
    qs.set("limit", String(limit));
    const url = `${endpoint}?${qs.toString()}`;

    void (async () => {
      try {
        const data = await apiFetchJson<{ items?: unknown[] | null }>(url, { signal: ac.signal, timeoutMs: 15000 });
        if (activeSeqRef.current !== seq) return;
        const rawItems = Array.isArray(data?.items) ? data.items : null;
        if (!rawItems) throw new Error("Unexpected response from server");
        const next = rawItems.map(coerceCaseSearchItem).filter(Boolean) as CaseSearchItem[];
        setItems(next);
        setError(null);
        setIsFetching(false);
      } catch (e: any) {
        if (activeSeqRef.current !== seq) return;
        if (isAbortLikeError(e)) {
          setIsFetching(false);
          return;
        }
        setError("Search failed. Please retry.");
        setIsFetching(false);
      }
    })();

    return () => {
      if (abortRef.current === ac) ac.abort();
    };
  }, [debounced, endpoint, limit, minSearchLength, open]);

  const selectedIds = useMemo(() => new Set(props.value.map((x) => x.case_id)), [props.value]);

  const add = (item: CaseSearchItem) => {
    const chipTitle = (() => {
      const firstName = item.purchaserNames[0] ? String(item.purchaserNames[0]).trim() : "";
      const proj = item.projectName ? String(item.projectName).trim() : "";
      const mid = firstName ? `${item.referenceNo} • ${firstName}` : item.referenceNo;
      return proj ? `${mid} • ${proj}` : mid;
    })();
    const next: SelectedCase = {
      case_id: item.id,
      title: chipTitle,
      referenceNo: item.referenceNo,
      purchaserLabel: item.purchaserLabel,
      projectName: item.projectName,
      status: item.status,
    };
    if (mode === "single") {
      props.onChange([next]);
      setOpen(false);
      setRaw("");
      return;
    }
    if (selectedIds.has(item.id)) return;
    props.onChange([...props.value, next]);
  };

  const remove = (id: number) => {
    props.onChange(props.value.filter((x) => x.case_id !== id));
  };

  const triggerLabel = props.value.length > 0
    ? props.value.length === 1
      ? props.value[0]?.title ?? "Selected 1 case"
      : `Selected ${props.value.length} cases`
    : "";

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
            disabled={props.disabled}
          >
            <span className="truncate text-left">
              {triggerLabel || props.placeholder || "Search cases..."}
            </span>
            <span className="text-xs text-slate-400">{open ? "Esc" : "⌄"}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={props.placeholder || "Search case ref / client / project..."}
              value={raw}
              onValueChange={setRaw}
            />
            <CommandList>
              {raw.trim().length < minSearchLength ? (
                <CommandEmpty>Type at least {minSearchLength} characters.</CommandEmpty>
            ) : isFetching && items.length === 0 ? (
                <CommandEmpty>Searching…</CommandEmpty>
            ) : error && items.length === 0 ? (
              <CommandEmpty>{error}</CommandEmpty>
            ) : items.length === 0 ? (
                <CommandEmpty>No cases found.</CommandEmpty>
              ) : (
                <CommandGroup>
                  {items.map((c) => {
                    const already = selectedIds.has(c.id);
                    const lower = c.purchaserLabel ? `${c.purchaserLabel} • ` : "";
                    const rowSecondary = `${lower}${c.projectName ?? ""}`.trim().replace(/\s+•\s*$/, "");
                    return (
                      <CommandItem
                        key={String(c.id)}
                        value={String(c.id)}
                        onSelect={() => add(c)}
                        disabled={mode === "multi" ? already : false}
                      >
                        <div className="flex flex-col min-w-0">
                          <span className="truncate">{c.referenceNo}</span>
                          {rowSecondary ? <span className="truncate text-xs text-slate-500">{rowSecondary}</span> : null}
                        </div>
                        {already ? <span className="ml-auto text-xs text-slate-400">Selected</span> : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {props.value.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {props.value.map((c) => (
            <Badge key={c.case_id} variant="outline" className="gap-1 pr-1">
              <span className="truncate max-w-[240px]">{c.title}</span>
              <button
                type="button"
                className="ml-1 inline-flex items-center justify-center rounded-sm hover:bg-slate-100"
                onClick={() => remove(c.case_id)}
                aria-label="Remove"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}

      {props.error ? <div className="text-xs text-red-600">{props.error}</div> : null}
    </div>
  );
}
