import { useParams, useLocation } from "wouter";
import { useGetClient, getGetClientQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, User, Phone, Mail, MapPin, Briefcase } from "lucide-react";

export default function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const clientId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();

  const { data: client, isLoading } = useGetClient(clientId, {
    query: {
      enabled: !!clientId,
      queryKey: getGetClientQueryKey(clientId),
    }
  });

  if (isLoading) return <div>Loading client details...</div>;
  if (!client) return <div>Client not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => setLocation("/app/clients")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">{client.name}</h1>
          <p className="text-slate-500 mt-1">IC/Reg No: {client.icNo || "N/A"}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Client Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <User className="w-5 h-5 text-slate-400 mt-0.5" />
              <div>
                <div className="font-medium">Nationality</div>
                <div className="text-slate-600">{client.nationality || "Not specified"}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Phone className="w-5 h-5 text-slate-400 mt-0.5" />
              <div>
                <div className="font-medium">Phone</div>
                <div className="text-slate-600">{client.phone || "Not specified"}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Mail className="w-5 h-5 text-slate-400 mt-0.5" />
              <div>
                <div className="font-medium">Email</div>
                <div className="text-slate-600">{client.email || "Not specified"}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <MapPin className="w-5 h-5 text-slate-400 mt-0.5" />
              <div>
                <div className="font-medium">Address</div>
                <div className="text-slate-600">{client.address || "Not specified"}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle>Case History</CardTitle>
            <Briefcase className="w-4 h-4 text-slate-400" />
          </CardHeader>
          <CardContent>
            <div className="mt-4">
              <div className="text-3xl font-bold text-slate-900">{client.caseCount}</div>
              <p className="text-slate-500 text-sm mt-1">Total cases associated with this client.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
