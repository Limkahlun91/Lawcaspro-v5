import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Calendar as CalendarIcon, X } from "lucide-react";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isValidYmd(ymd: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return false;
  const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
  return dt.getUTCFullYear() === yyyy && dt.getUTCMonth() + 1 === mm && dt.getUTCDate() === dd;
}

export function formatYmdToDmy(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return "";
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return "";
  return `${pad2(dd)}/${pad2(mm)}/${m[1]}`;
}

function ymdToLocalDate(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
  const dt = new Date(yyyy, mm - 1, dd);
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getFullYear() !== yyyy || dt.getMonth() + 1 !== mm || dt.getDate() !== dd) return null;
  return dt;
}

function localDateToYmd(dt: Date): string {
  const yyyy = dt.getFullYear();
  const mm = dt.getMonth() + 1;
  const dd = dt.getDate();
  return `${yyyy}-${pad2(mm)}-${pad2(dd)}`;
}

export function normalizeDateOnlyFromApi(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isValidYmd(s) ? s : "";
    if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) {
      const ymd = s.slice(0, 10);
      return isValidYmd(ymd) ? ymd : "";
    }
    return "";
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    return v.toISOString().slice(0, 10);
  }
  return "";
}

export function parseDateInputToYmd(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (ymd) {
    const yyyy = Number(ymd[1]);
    const mm = Number(ymd[2]);
    const dd = Number(ymd[3]);
    if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
    const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (dt.getUTCFullYear() !== yyyy || dt.getUTCMonth() + 1 !== mm || dt.getUTCDate() !== dd) return null;
    return `${yyyy}-${pad2(mm)}-${pad2(dd)}`;
  }
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (dmy) {
    const dd = Number(dmy[1]);
    const mm = Number(dmy[2]);
    const yyyy = Number(dmy[3]);
    if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
    const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (dt.getUTCFullYear() !== yyyy || dt.getUTCMonth() + 1 !== mm || dt.getUTCDate() !== dd) return null;
    return `${yyyy}-${pad2(mm)}-${pad2(dd)}`;
  }
  return null;
}

export function DateOnlyInput(props: {
  valueYmd: string;
  onChangeYmd: (ymd: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { valueYmd, onChangeYmd, disabled, className } = props;
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => (valueYmd ? ymdToLocalDate(valueYmd) : null), [valueYmd]);
  const label = useMemo(() => (valueYmd ? formatYmdToDmy(valueYmd) : ""), [valueYmd]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn("h-9 justify-between px-3 font-normal", !label && "text-slate-500", className)}
        >
          <span className="truncate">{label || "Select date"}</span>
          <CalendarIcon className="h-4 w-4 text-slate-500" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        <Calendar
          mode="single"
          selected={selected ?? undefined}
          onSelect={(d) => {
            if (!d) return;
            onChangeYmd(localDateToYmd(d));
            setOpen(false);
          }}
          initialFocus
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || !valueYmd}
            onClick={() => {
              onChangeYmd("");
              setOpen(false);
            }}
          >
            <X className="h-4 w-4" />
            Clear
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
