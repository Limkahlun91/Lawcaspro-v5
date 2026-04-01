import { useListUsers } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "lucide-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { useState } from "react";

export default function UsersList() {
  const [search, setSearch] = useState("");
  
  const { data: response, isLoading } = useListUsers({ 
    page: 1, 
    limit: 50,
    search: search || undefined
  });

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Users</h1>
          <p className="text-slate-500 mt-1">Manage staff and permissions</p>
        </div>
        <Link href="/app/users/new">
          <Button className="bg-amber-500 hover:bg-amber-600 text-white">
            <Plus className="w-4 h-4 mr-2" />
            New User
          </Button>
        </Link>
      </div>

      <div className="flex gap-4 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input 
            placeholder="Search users..." 
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-slate-500">Loading users...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-3 font-semibold">Name</th>
                    <th className="px-6 py-3 font-semibold">Role</th>
                    <th className="px-6 py-3 font-semibold">Status</th>
                    <th className="px-6 py-3 font-semibold text-right">Last Login</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {response?.data.map((user) => (
                    <tr key={user.id} className="hover:bg-slate-50/50">
                      <td className="px-6 py-4">
                        <div className="font-medium text-slate-900">{user.name}</div>
                        <div className="text-slate-500 text-xs mt-0.5">{user.email}</div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-800">
                          {user.roleName || "No Role"}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          user.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-800'
                        }`}>
                          {user.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right text-slate-600">
                        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : 'Never'}
                      </td>
                    </tr>
                  ))}
                  {response?.data.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-6 py-8 text-center text-slate-500">
                        No users found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
