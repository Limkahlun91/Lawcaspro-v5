import { useListRoles } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";

export default function RolesList() {
  const { data: response, isLoading } = useListRoles();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Roles & Permissions</h1>
        <p className="text-slate-500 mt-1">Manage access control for your firm</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {isLoading ? (
          <div>Loading roles...</div>
        ) : (
          response?.data.map(role => (
            <Card key={role.id}>
              <CardContent className="p-6">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="text-lg font-bold">{role.name}</h3>
                    <p className="text-sm text-slate-500">{role.userCount} users</p>
                  </div>
                  {role.isSystemRole && (
                    <span className="bg-slate-100 text-slate-600 px-2 py-1 rounded text-xs font-medium uppercase tracking-wider">
                      System
                    </span>
                  )}
                </div>
                
                <div className="space-y-2 mt-4">
                  <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Permissions</h4>
                  <div className="flex flex-wrap gap-2">
                    {role.permissions.slice(0, 8).map(p => (
                      <span key={p.id} className={`px-2 py-1 rounded text-[10px] font-medium border ${
                        p.allowed ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'
                      }`}>
                        {p.module}:{p.action}
                      </span>
                    ))}
                    {role.permissions.length > 8 && (
                      <span className="px-2 py-1 rounded text-[10px] font-medium border bg-slate-50 text-slate-600 border-slate-200">
                        +{role.permissions.length - 8} more
                      </span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
