import { useState, useEffect } from "react";
import { useListUsers, useListRoles } from "@workspace/api-client-react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Search, Save, Trash2, Building2 } from "lucide-react";
import { Link, useSearch } from "wouter";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include", ...opts });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const TABS = ["Firm Info", "Users", "Roles & Permissions"] as const;
type Tab = typeof TABS[number];

const TAB_KEYS: Record<string, Tab> = {
  firm: "Firm Info",
  users: "Users",
  roles: "Roles & Permissions",
};

function FirmInfoTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ["firm-settings"],
    queryFn: () => apiFetch("/firm-settings"),
  });

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [stNumber, setStNumber] = useState("");
  const [tinNumber, setTinNumber] = useState("");
  const [newBankName, setNewBankName] = useState("");
  const [newAccountNo, setNewAccountNo] = useState("");
  const [newAccountType, setNewAccountType] = useState("office");

  useEffect(() => {
    if (settings) {
      setName(settings.name || "");
      setAddress(settings.address || "");
      setStNumber(settings.stNumber || "");
      setTinNumber(settings.tinNumber || "");
    }
  }, [settings]);

  const updateMutation = useMutation({
    mutationFn: (data: any) => apiFetch("/firm-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["firm-settings"] });
      toast({ title: "Firm information updated" });
    },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });

  const addBankMutation = useMutation({
    mutationFn: (data: any) => apiFetch("/firm-settings/bank-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["firm-settings"] });
      setNewBankName("");
      setNewAccountNo("");
      setNewAccountType("office");
      toast({ title: "Bank account added" });
    },
    onError: () => toast({ title: "Failed to add bank account", variant: "destructive" }),
  });

  const deleteBankMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/firm-settings/bank-accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["firm-settings"] });
      toast({ title: "Bank account removed" });
    },
    onError: () => toast({ title: "Failed to remove bank account", variant: "destructive" }),
  });

  const handleSaveInfo = () => {
    updateMutation.mutate({ name, address, stNumber, tinNumber });
  };

  const handleAddBank = () => {
    if (!newBankName.trim() || !newAccountNo.trim()) {
      toast({ title: "Bank name and account number are required", variant: "destructive" });
      return;
    }
    addBankMutation.mutate({ bankName: newBankName, accountNo: newAccountNo, accountType: newAccountType });
  };

  if (isLoading) return <div className="py-12 text-center text-slate-500">Loading...</div>;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="w-4 h-4" />
            General Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-slate-500">Firm Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs text-slate-500">ST Number (Service Tax)</Label>
              <Input value={stNumber} onChange={e => setStNumber(e.target.value)} placeholder="e.g. W10-1234-56789012" />
            </div>
            <div>
              <Label className="text-xs text-slate-500">TIN Number (Tax Identification)</Label>
              <Input value={tinNumber} onChange={e => setTinNumber(e.target.value)} placeholder="e.g. C1234567890" />
            </div>
            <div className="md:col-span-2">
              <Label className="text-xs text-slate-500">Address</Label>
              <textarea
                value={address}
                onChange={e => setAddress(e.target.value)}
                className="w-full h-20 border rounded-md px-3 py-2 text-sm resize-none"
                placeholder="Firm address"
              />
            </div>
          </div>
          <div className="flex justify-end mt-4">
            <Button onClick={handleSaveInfo} disabled={updateMutation.isPending} className="bg-amber-500 hover:bg-amber-600 text-white">
              <Save className="w-4 h-4 mr-2" />
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bank Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {settings?.bankAccounts?.length > 0 && (
            <table className="w-full text-sm mb-4">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left px-4 py-2 font-medium text-slate-600">Bank Name</th>
                  <th className="text-left px-4 py-2 font-medium text-slate-600">Account No.</th>
                  <th className="text-left px-4 py-2 font-medium text-slate-600">Type</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {settings.bankAccounts.map((acc: any) => (
                  <tr key={acc.id} className="border-b border-slate-100">
                    <td className="px-4 py-3 font-medium">{acc.bankName}</td>
                    <td className="px-4 py-3 text-slate-600">{acc.accountNo}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium capitalize ${
                        acc.accountType === "client" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"
                      }`}>
                        {acc.accountType}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Button variant="ghost" size="sm" onClick={() => deleteBankMutation.mutate(acc.id)} className="text-red-500 h-7 w-7 p-0">
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <Label className="text-xs text-slate-500">Bank Name</Label>
              <Input value={newBankName} onChange={e => setNewBankName(e.target.value)} placeholder="e.g. Maybank" />
            </div>
            <div className="flex-1">
              <Label className="text-xs text-slate-500">Account No.</Label>
              <Input value={newAccountNo} onChange={e => setNewAccountNo(e.target.value)} placeholder="e.g. 1234567890" />
            </div>
            <div className="w-32">
              <Label className="text-xs text-slate-500">Type</Label>
              <select
                value={newAccountType}
                onChange={e => setNewAccountType(e.target.value)}
                className="w-full h-9 border rounded-md px-3 text-sm bg-white"
              >
                <option value="office">Office</option>
                <option value="client">Client</option>
              </select>
            </div>
            <Button onClick={handleAddBank} disabled={addBankMutation.isPending} variant="outline" className="shrink-0">
              <Plus className="w-4 h-4 mr-1" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function Settings() {
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const tabFromUrl = params.get("tab");
  const initialTab = (tabFromUrl && TAB_KEYS[tabFromUrl]) ? TAB_KEYS[tabFromUrl] : "Firm Info";
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

      {activeTab === "Firm Info" && <FirmInfoTab />}

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
