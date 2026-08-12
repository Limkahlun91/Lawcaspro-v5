import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";

function MyProfile() {
  const { user } = useAuth();
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader><CardTitle>My Profile</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2"><Label>Display Name</Label><Input defaultValue={user?.name ?? ""} /></div>
          <div className="space-y-2"><Label>Email</Label><Input defaultValue={user?.email ?? ""} disabled /></div>
          <div className="space-y-2"><Label>Phone</Label><Input placeholder="+60" /></div>
          <div className="space-y-2"><Label>Employee No</Label><Input defaultValue={(user as any)?.employeeNumber ?? ""} disabled /></div>
          <div className="space-y-2"><Label>Job Title</Label><Input defaultValue={(user as any)?.jobTitle ?? ""} disabled /></div>
          <div className="space-y-2"><Label>Department</Label><Input defaultValue={user?.department ?? ""} disabled /></div>
          <div className="md:col-span-2"><Button size="sm">Save Changes</Button></div>
        </CardContent>
      </Card>
    </div>
  );
}
export default MyProfile;
