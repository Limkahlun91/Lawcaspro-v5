import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HistoryInput } from "./HistoryInput";
import type { AddressLines } from "./types";

export function AddressLinesFields(props: {
  label: string;
  value: AddressLines;
  onChange: (next: AddressLines) => void;
  onBlurCompose?: () => void;
  normalize?: (value: string) => string;
  historyKeyPrefix?: string;
  disabled?: boolean;
  maxLines?: 1 | 2 | 3 | 4 | 5;
}) {
  const disabled = Boolean(props.disabled);
  const v = props.value;
  const set = (k: keyof AddressLines, next: string) => props.onChange({ ...v, [k]: next });
  const maxLines = props.maxLines ?? 5;
  const onBlur = (k: keyof AddressLines) => () => {
    if (props.normalize) {
      const normalized = props.normalize(v[k]);
      if (normalized !== v[k]) set(k, normalized);
    }
    props.onBlurCompose?.();
  };

  return (
    <div className="space-y-2">
      <Label>{props.label}</Label>
      <div className="grid grid-cols-1 gap-2">
        {props.historyKeyPrefix ? (
          <HistoryInput storageKey={`${props.historyKeyPrefix}.line1`} value={v.line1} onChange={(next) => set("line1", next)} onBlur={onBlur("line1")} disabled={disabled} placeholder="Line 1" />
        ) : (
          <Input value={v.line1} onChange={(e) => set("line1", e.target.value)} onBlur={onBlur("line1")} disabled={disabled} placeholder="Line 1" />
        )}
        {props.historyKeyPrefix ? (
          <HistoryInput storageKey={`${props.historyKeyPrefix}.line2`} value={v.line2} onChange={(next) => set("line2", next)} onBlur={onBlur("line2")} disabled={disabled} placeholder="Line 2" />
        ) : (
          <Input value={v.line2} onChange={(e) => set("line2", e.target.value)} onBlur={onBlur("line2")} disabled={disabled} placeholder="Line 2" />
        )}
        {maxLines >= 3 ? (
          props.historyKeyPrefix ? (
            <HistoryInput storageKey={`${props.historyKeyPrefix}.line3`} value={v.line3} onChange={(next) => set("line3", next)} onBlur={onBlur("line3")} disabled={disabled} placeholder="Line 3" />
          ) : (
            <Input value={v.line3} onChange={(e) => set("line3", e.target.value)} onBlur={onBlur("line3")} disabled={disabled} placeholder="Line 3" />
          )
        ) : null}
        {maxLines >= 4 ? (
          props.historyKeyPrefix ? (
            <HistoryInput storageKey={`${props.historyKeyPrefix}.line4`} value={v.line4} onChange={(next) => set("line4", next)} onBlur={onBlur("line4")} disabled={disabled} placeholder="Line 4" />
          ) : (
            <Input value={v.line4} onChange={(e) => set("line4", e.target.value)} onBlur={onBlur("line4")} disabled={disabled} placeholder="Line 4" />
          )
        ) : null}
        {maxLines >= 5 ? (
          props.historyKeyPrefix ? (
            <HistoryInput storageKey={`${props.historyKeyPrefix}.line5`} value={v.line5} onChange={(next) => set("line5", next)} onBlur={onBlur("line5")} disabled={disabled} placeholder="Line 5" />
          ) : (
            <Input value={v.line5} onChange={(e) => set("line5", e.target.value)} onBlur={onBlur("line5")} disabled={disabled} placeholder="Line 5" />
          )
        ) : null}
      </div>
    </div>
  );
}

