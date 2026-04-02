import { useState, useEffect } from "react";
import { useListUsers, useListRoles } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search } from "lucide-react";
import { Link, useSearch } from "wouter";
import { cn } from "@/lib/utils";

const TABS = ["Users", "Roles & Permissions"] as const;
type Tab = typeof TABS[number];

const TAB_KEYS: Record<string, Tab> = {
  users: "Users",
  roles: "Roles & Permissions",
};

export default function Settings() {
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const tabFromUrl = params.get("tab");
  const initialTab = (tabFromUrl && TAB_KEYS[tabFromUrl]) ? TAB_KEYS[tabFromUrl] : "Users";
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  useEffect(() => {
    if (tabFromUrl && TAB_KEYS[tabFromUrl]) {
      setActiveTab(TAB_KEYS[tabFromUrl]);
    }
  }, [tabFromUrl]);
  const [userSearch, setUserSearch] = useState("");

  const { data: usersRes, isLoading: loadingUsers } = useListUsers({
    page: 1,
    limit: 50,
    search: userSearch || undefined,
  });

  const { data: rolesRes, isLoading: loadingRoles } = useListRoles();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Settings</h1>
        <p className="text-slate-500 mt-1">Firm preferences and configuration</p>
      </div>

      <div className="flex border-b border-gray-200">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
              activeTab === tab
                ? "border-amber-500 text-amber-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Users Tab */}
      {activeTab === "Users" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search users..."
                className="pl-9"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
              />
            </div>
            <Link href="/app/users/new">
              <Button className="bg-amber-500 hover:bg-amber-600 text-white">
                <Plus className="w-4 h-4 mr-2" />
                New User
              </Button>
            </Link>
          </div>

          <Card>
            <CardContent className="p-0">
              {loadingUsers ? (
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
                      {usersRes?.data?.map((user: any) => (
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
                              user.status === "active"
                                ? "bg-green-100 text-green-800"
                                : "bg-slate-100 text-slate-800"
                            }`}>
                              {user.status}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right text-slate-600">
                            {user.lastLoginAt
                              ? new Date(user.lastLoginAt).toLocaleDateString()
                              : "Never"}
                          </td>
                        </tr>
                      ))}
                      {usersRes?.data?.length === 0 && (
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
      )}

      {/* Roles & Permissions Tab */}
      {activeTab === "Roles & Permissions" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {loadingRoles ? (
              <div className="col-span-2 p-8 text-center text-slate-500">Loading roles...</div>
            ) : (
              rolesRes?.data?.map((role: any) => (
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
                      <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                        Permissions
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {role.permissions?.slice(0, 8).map((p: any) => (
                          <span
                            key={p.id}
                            className={`px-2 py-1 rounded text-[10px] font-medium border ${
                              p.allowed
                                ? "bg-green-50 text-green-700 border-green-200"
                                : "bg-red-50 text-red-700 border-red-200"
                            }`}
                          >
                            {p.module}:{p.action}
                          </span>
                        ))}
                        {role.permissions?.length > 8 && (
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
      )}

    </div>
  );
}
