import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";

type HistoryInputProps = Omit<React.ComponentProps<typeof Input>, "value" | "onChange"> & {
  storageKey: string;
  value: string;
  onChange: (next: string) => void;
  maxItems?: number;
};

function readHistory(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((x) => String(x ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function writeHistory(storageKey: string, values: string[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(values));
  } catch {
    return;
  }
}

export function HistoryInput(props: HistoryInputProps) {
  const { storageKey, value, onChange, maxItems, onBlur, ...rest } = props;
  const key = `lawcaspro:create-case:history:${storageKey}`;
  const [items, setItems] = useState<string[]>([]);
  const datalistId = useMemo(() => {
    const rand = Math.random().toString(36).slice(2);
    return `hist-${storageKey.replace(/[^a-zA-Z0-9_-]/g, "-")}-${rand}`;
  }, [storageKey]);

  useEffect(() => {
    setItems(readHistory(key));
  }, [key]);

  const saveCurrent = () => {
    const v = String(value ?? "").trim();
    if (!v) return;
    const deduped = [v, ...items.filter((x) => x !== v)];
    const limited = deduped.slice(0, maxItems ?? 15);
    setItems(limited);
    writeHistory(key, limited);
  };

  return (
    <>
      <Input
        {...rest}
        list={datalistId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          saveCurrent();
          onBlur?.(e);
        }}
      />
      <datalist id={datalistId}>
        {items.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
    </>
  );
}
