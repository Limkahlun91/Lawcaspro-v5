import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
  projectName: string | null;
  status: string | null;
};

export type SelectedCase = {
  case_id: number;
  title: string;
  referenceNo?: string;
  projectName?: string | null;
  status?: string | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function coerceCaseSearchItem(v: unknown): CaseSearchItem | null {
  if (!isRecord(v)) return null;
  const idRaw = typeof v.id === "number" ? v.id : typeof v.case_id === "number" ? v.case_id : NaN;
  const id = Number.isFinite(idRaw) && idRaw > 0 ? idRaw : NaN;
  if (!Number.isFinite(id)) return null;
  const referenceNo = typeof v.referenceNo === "string" ? v.referenceNo : typeof v.reference_no === "string" ? v.reference_no : "";
  const shortLabel = typeof v.shortLabel === "string" ? v.shortLabel : typeof v.title === "string" ? v.title : "";
  return {
    id,
    referenceNo: String(referenceNo ?? "").trim(),
    shortLabel: String(shortLabel ?? "").trim() || String(referenceNo ?? "").trim(),
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
    const t = setTimeout(() => setDebounced(raw.trim()), debounceMs);
    return () => clearTimeout(t);
  }, [raw, debounceMs]);

  const query = useQuery({
    queryKey: ["accounting", "cases", "search", debounced, limit],
    queryFn: async ({ signal }) => {
      const qs = new URLSearchParams();
      qs.set("query", debounced);
      qs.set("limit", String(limit));
      const res = await apiFetchJson(`${endpoint}?${qs.toString()}`, { signal, timeoutMs: 15000 }) as unknown;
      const itemsRaw = isRecord(res) && Array.isArray((res as any).items)
        ? (res as any).items
        : isRecord(res) && isRecord((res as any).data) && Array.isArray((res as any).data.items)
          ? (res as any).data.items
          : isRecord(res) && Array.isArray((res as any).data)
            ? (res as any).data
            : [];
      return (itemsRaw as unknown[]).map(coerceCaseSearchItem).filter(Boolean) as CaseSearchItem[];
    },
    enabled: open && debounced.length >= minSearchLength,
    retry: false,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const selectedIds = useMemo(() => new Set(props.value.map((x) => x.case_id)), [props.value]);

  const add = (item: CaseSearchItem) => {
    const next: SelectedCase = {
      case_id: item.id,
      title: item.shortLabel || item.referenceNo,
      referenceNo: item.referenceNo,
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
              ) : query.isFetching ? (
                <CommandEmpty>Searching…</CommandEmpty>
              ) : query.isError ? (
                <CommandEmpty>Search failed. Please retry.</CommandEmpty>
              ) : (query.data?.length ?? 0) === 0 ? (
                <CommandEmpty>No cases found.</CommandEmpty>
              ) : (
                <CommandGroup>
                  {(query.data ?? []).map((c) => {
                    const already = selectedIds.has(c.id);
                    const rowLabel = c.shortLabel || c.referenceNo;
                    return (
                      <CommandItem
                        key={String(c.id)}
                        value={String(c.id)}
                        onSelect={() => add(c)}
                        disabled={mode === "multi" ? already : false}
                      >
                        <span className="truncate">{rowLabel}</span>
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
