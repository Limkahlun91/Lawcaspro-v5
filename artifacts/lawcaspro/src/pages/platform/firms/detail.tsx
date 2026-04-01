import { useParams, useLocation } from "wouter";
import { useGetFirm, useUpdateFirm, getGetFirmQueryKey, getListFirmsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Building2, Users, Briefcase } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

export default function FirmDetail() {
  const { id } = useParams<{ id: string }>();
  const firmId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: firm, isLoading } = useGetFirm(firmId, {
    query: {
      enabled: !!firmId,
      queryKey: getGetFirmQueryKey(firmId),
    }
  });

  const updateFirmMutation = useUpdateFirm();

  const [status, setStatus] = useState<string>("");
  const [plan, setPlan] = useState<string>("");

  useEffect(() => {
    if (firm) {
      setStatus(firm.status);
      setPlan(firm.subscriptionPlan);
    }
  }, [firm]);

  const handleUpdate = () => {
    updateFirmMutation.mutate(
      { firmId, data: { status, subscriptionPlan: plan } },
      {
        onSuccess: () => {
          toast({ title: "Firm updated successfully" });
          queryClient.invalidateQueries({ queryKey: getGetFirmQueryKey(firmId) });
          queryClient.invalidateQueries({ queryKey: getListFirmsQueryKey() });
        },
        onError: (error) => {
          toast({
            title: "Update failed",
            description: error.error || "An error occurred",
            variant: "destructive"
          });
        }
      }
    );
  };

  if (isLoading) return <div>Loading firm details...</div>;
  if (!firm) return <div>Firm not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => setLocation("/platform/firms")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">{firm.name}</h1>
          <p className="text-slate-500 mt-1">Workspace: {firm.slug}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">Total Users</CardTitle>
            <Users className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{firm.userCount}</div>
            <p className="text-xs text-slate-500 mt-1">{firm.partnerCount} partners</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">Total Cases</CardTitle>
            <Briefcase className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{firm.caseCount}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-500">Created At</CardTitle>
            <Building2 className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold">{new Date(firm.createdAt).toLocaleDateString()}</div>
          </CardContent>
        </Card>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Firm Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <div className="space-y-2">
            <Label>Subscription Plan</Label>
            <Select value={plan} onValueChange={setPlan}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="starter">Starter</SelectItem>
                <SelectItem value="professional">Professional</SelectItem>
                <SelectItem value="enterprise">Enterprise</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <Button 
            onClick={handleUpdate} 
            disabled={updateFirmMutation.isPending || (status === firm.status && plan === firm.subscriptionPlan)}
          >
            {updateFirmMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
