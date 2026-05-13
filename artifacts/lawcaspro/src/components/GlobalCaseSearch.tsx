import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { apiFetchJson } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type CaseSearchItem = {
  id: number;
  referenceNo: string;
  status: string;
  assignedLawyerName?: string | null;
  assignedClerkName?: string | null;
};

type CaseListResponse = {
  data: CaseSearchItem[];
  total: number;
  page: number;
  limit: number;
};

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return Boolean(el.isContentEditable);
}

export function GlobalCaseSearch(): JSX.Element {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<CaseSearchItem[]>([]);
  const lastAbortRef = useRef<AbortController | null>(null);

  const normalizedQuery = useMemo(() => query.trim(), [query]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== "k") return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setItems([]);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = normalizedQuery;
    if (!q) {
      setItems([]);
      setLoading(false);
      return;
    }

    const t = setTimeout(async () => {
      lastAbortRef.current?.abort();
      const controller = new AbortController();
      lastAbortRef.current = controller;
      setLoading(true);
      try {
        const res = await apiFetchJson<CaseListResponse>(`/cases?search=${encodeURIComponent(q)}&page=1&limit=10`, { signal: controller.signal });
        setItems(Array.isArray(res.data) ? res.data : []);
      } catch {
        setItems([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 150);

    return () => clearTimeout(t);
  }, [open, normalizedQuery]);

  const onSelectCase = (id: number) => {
    setOpen(false);
    navigate(`/app/cases/${id}`);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search cases (Ref No, Purchaser, Plot/Parcel)…"
      />
      <CommandList>
        <CommandEmpty>
          <div className={cn("text-sm", loading ? "text-slate-500" : "")}>
            {loading ? "Searching…" : (normalizedQuery ? "No results." : "Type to search.")}
          </div>
        </CommandEmpty>
        <CommandGroup heading="Cases">
          {items.map((c) => (
            <CommandItem key={c.id} value={`${c.referenceNo} ${c.status}`} onSelect={() => onSelectCase(c.id)}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="font-semibold truncate">{c.referenceNo}</div>
                  <div className="text-xs text-slate-500 truncate">{c.status}</div>
                </div>
                <div className="text-xs text-slate-500 truncate">
                  {c.assignedLawyerName ? `Lawyer: ${c.assignedLawyerName}` : "Lawyer: —"}
                  <span className="text-slate-300"> · </span>
                  {c.assignedClerkName ? `Clerk: ${c.assignedClerkName}` : "Clerk: —"}
                </div>
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

