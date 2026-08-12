import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { wrapRouteWithFeature } from "@/lib/feature-guards";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function HrSettingsInner() {
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader><CardTitle>HR Settings</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Working Days Per Week</Label>
              <Input defaultValue="5" />
            </div>
            <div className="space-y-2">
              <Label>Default Leave Policy</Label>
              <Select defaultValue="annual-18"><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="annual-18">Standard (18 days)</SelectItem>
                <SelectItem value="annual-20">Senior (20 days)</SelectItem>
                <SelectItem value="annual-25">Partner (25 days)</SelectItem>
              </SelectContent></Select>
            </div>
            <div className="space-y-2">
              <Label>Claim Approval Threshold (MYR)</Label>
              <Input defaultValue="1000" />
            </div>
            <div className="space-y-2">
              <Label>Payroll Cut-off Day</Label>
              <Input defaultValue="25" />
            </div>
          </div>
          <div><Button size="sm">Save Settings</Button></div>
        </CardContent>
      </Card>
    </div>
  );
}
export default wrapRouteWithFeature("module.hr", HrSettingsInner);
