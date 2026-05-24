import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AddressLines } from "./types";

export function AddressLinesFields(props: {
  label: string;
  value: AddressLines;
  onChange: (next: AddressLines) => void;
  onBlurCompose?: () => void;
  disabled?: boolean;
}) {
  const disabled = Boolean(props.disabled);
  const v = props.value;
  const set = (k: keyof AddressLines, next: string) => props.onChange({ ...v, [k]: next });

  return (
    <div className="space-y-2">
      <Label>{props.label}</Label>
      <div className="grid grid-cols-1 gap-2">
        <Input value={v.line1} onChange={(e) => set("line1", e.target.value)} onBlur={props.onBlurCompose} disabled={disabled} placeholder="Line 1" />
        <Input value={v.line2} onChange={(e) => set("line2", e.target.value)} onBlur={props.onBlurCompose} disabled={disabled} placeholder="Line 2" />
        <Input value={v.line3} onChange={(e) => set("line3", e.target.value)} onBlur={props.onBlurCompose} disabled={disabled} placeholder="Line 3" />
        <Input value={v.line4} onChange={(e) => set("line4", e.target.value)} onBlur={props.onBlurCompose} disabled={disabled} placeholder="Line 4" />
        <Input value={v.line5} onChange={(e) => set("line5", e.target.value)} onBlur={props.onBlurCompose} disabled={disabled} placeholder="Line 5" />
      </div>
    </div>
  );
}

