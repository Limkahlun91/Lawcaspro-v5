import { useParams, useLocation } from "wouter";
import { useGetDeveloper, getGetDeveloperQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Building2, Phone, Mail, User } from "lucide-react";

export default function DeveloperDetail() {
  const { id } = useParams<{ id: string }>();
  const developerId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();

  const { data: developer, isLoading } = useGetDeveloper(developerId, {
    query: {
      enabled: !!developerId,
      queryKey: getGetDeveloperQueryKey(developerId),
    }
  });

  if (isLoading) return <div>Loading developer details...</div>;
  if (!developer) return <div>Developer not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => setLocation("/app/developers")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">{developer.name}</h1>
          <p className="text-slate-500 mt-1">Reg No: {developer.companyRegNo || "N/A"}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Contact Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <User className="w-5 h-5 text-slate-400 mt-0.5" />
              <div>
                <div className="font-medium">Contact Person</div>
                <div className="text-slate-600">{developer.contactPerson || "Not specified"}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Phone className="w-5 h-5 text-slate-400 mt-0.5" />
              <div>
                <div className="font-medium">Phone</div>
                <div className="text-slate-600">{developer.phone || "Not specified"}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Mail className="w-5 h-5 text-slate-400 mt-0.5" />
              <div>
                <div className="font-medium">Email</div>
                <div className="text-slate-600">{developer.email || "Not specified"}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Building2 className="w-5 h-5 text-slate-400 mt-0.5" />
              <div>
                <div className="font-medium">Address</div>
                <div className="text-slate-600">{developer.address || "Not specified"}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
