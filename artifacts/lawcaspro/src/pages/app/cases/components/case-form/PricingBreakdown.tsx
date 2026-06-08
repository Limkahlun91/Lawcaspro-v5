import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatRMAmount, toMoneyNumber } from "@/lib/money";

export function PricingBreakdown(props: {
  purchasePrice: string;
}) {
  const base = toMoneyNumber(props.purchasePrice);
  const rates = [0.025, 0.05, 0.075, 0.1, 0.15, 0.175];
  return (
    <div className="space-y-2">
      <Label>Pricing Reference (Purchase Price)</Label>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {rates.map((r) => (
          <div key={r} className="space-y-1">
            <Label className="text-xs text-slate-500">{(r * 100).toFixed(1).replace(/\.0$/, "")}%</Label>
            <Input value={formatRMAmount(base * r)} readOnly />
          </div>
        ))}
      </div>
    </div>
  );
}
