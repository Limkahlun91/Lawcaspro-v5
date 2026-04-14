import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
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
  const [text, setText] = useState<string>("");
  const [invalid, setInvalid] = useState(false);
  const focusedRef = useRef(false);

  const formatted = useMemo(() => (valueYmd ? formatYmdToDmy(valueYmd) : ""), [valueYmd]);

  useEffect(() => {
    if (focusedRef.current) return;
    setText(formatted);
    setInvalid(false);
  }, [formatted]);

  return (
    <Input
      className={cn(className, invalid && "border-red-300 focus-visible:ring-red-200")}
      value={text}
      disabled={disabled}
      placeholder="dd/mm/yyyy"
      inputMode="numeric"
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        const next = parseDateInputToYmd(text);
        if (next === null) {
          if (!text.trim()) {
            setInvalid(false);
            onChangeYmd("");
            return;
          }
          setInvalid(true);
          return;
        }
        setInvalid(false);
        onChangeYmd(next);
        setText(formatYmdToDmy(next));
      }}
      onChange={(e) => {
        setText(e.target.value);
        if (invalid) setInvalid(false);
      }}
    />
  );
}

