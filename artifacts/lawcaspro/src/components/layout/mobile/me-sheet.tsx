import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { Link } from "wouter";
import {
  Home,
  ListTodo,
  Briefcase,
  Calculator,
  BarChart,
  FileText,
  Settings,
  ScrollText,
  LogOut,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MobileDockViewId } from "./mobile-dock";

export function MeSheet({
  open,
  onOpenChange,
  onChangeView,
  user,
  logout,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onChangeView: (v: MobileDockViewId) => void;
  user: { id?: string | number; name?: string; email?: string; roleName?: string; firmName?: string; userType?: string } | null | undefined;
  logout: () => void;
}) {
  const [meExpand, setMeExpand] = useState<"nav" | "profile" | "settings">("nav");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg !max-h-[82vh] overflow-hidden flex flex-col p-0 gap-0 !rounded-t-3xl md:!rounded-2xl focus:outline-none"
        aria-describedby="me-sheet-desc"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="px-4 pt-4 pb-3 border-b border-slate-200">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-full bg-slate-100 flex items-center justify-center font-bold text-lg text-slate-700 shrink-0" aria-hidden>
              {(user?.name ?? "U").charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base truncate">{user?.name}</DialogTitle>
              <DialogDescription id="me-sheet-desc" className="text-xs mt-0.5 truncate">{user?.email}</DialogDescription>
            </div>
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} aria-label="Close profile sheet"><X className="w-4 h-4" /></Button>
          </div>
          <div className="mt-2.5 grid grid-cols-3 gap-2 text-[11px]">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2"><div className="text-[10px] uppercase text-slate-500">Role</div><div className="font-semibold text-slate-800 mt-0.5">{user?.roleName ?? "—"}</div></div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2"><div className="text-[10px] uppercase text-slate-500">Firm</div><div className="font-semibold text-slate-800 mt-0.5 truncate">{user?.firmName ?? "—"}</div></div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2"><div className="text-[10px] uppercase text-slate-500">Type</div><div className="font-semibold text-slate-800 mt-0.5">{user?.userType ?? "—"}</div></div>
          </div>
        </DialogHeader>
        <div role="tablist" aria-label="Profile sections" className="flex items-center gap-2 px-4 pt-3 border-b border-slate-200">
          {(["nav","profile","settings"] as const).map((k) => {
            const active = meExpand === k;
            return (
              <button key={k} type="button" onClick={() => setMeExpand(k)}
                      role="tab"
                      aria-selected={active}
                      id={`me-tab-${k}`}
                      aria-controls={`me-panel-${k}`}
                      className={`text-xs font-semibold px-2.5 py-1.5 rounded-t-md -mb-px border-b-2 transition ${active ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
                {k === "nav" ? "Quick links" : k === "profile" ? "Profile" : "Settings"}
              </button>
            );
          })}
        </div>
        <div role="tabpanel" id={`me-panel-${meExpand}`} aria-labelledby={`me-tab-${meExpand}`} className="flex-1 overflow-y-auto px-4 py-3 space-y-1 text-sm">
          {meExpand === "nav" ? (
            <>
              <Link className="block" href="/app/dashboard" onClick={() => { onOpenChange(false); onChangeView("home"); }}><div className="rounded-md px-3 py-2 hover:bg-slate-100 flex items-center gap-2"><Home className="w-4 h-4 text-slate-600" /> Dashboard</div></Link>
              <Link className="block" href="/app/my-work" onClick={() => { onOpenChange(false); onChangeView("work"); }}><div className="rounded-md px-3 py-2 hover:bg-slate-100 flex items-center gap-2"><ListTodo className="w-4 h-4 text-slate-600" /> My Work</div></Link>
              <Link className="block" href="/app/cases" onClick={() => { onOpenChange(false); onChangeView("work"); }}><div className="rounded-md px-3 py-2 hover:bg-slate-100 flex items-center gap-2"><Briefcase className="w-4 h-4 text-slate-600" /> Cases</div></Link>
              <Link className="block" href="/app/accounting?tab=file-custody" onClick={() => { onOpenChange(false); onChangeView("monitor"); }}><div className="rounded-md px-3 py-2 hover:bg-slate-100 flex items-center gap-2"><Calculator className="w-4 h-4 text-slate-600" /> Accounting &amp; Custody</div></Link>
              <Link className="block" href="/app/reports" onClick={() => { onOpenChange(false); onChangeView("monitor"); }}><div className="rounded-md px-3 py-2 hover:bg-slate-100 flex items-center gap-2"><BarChart className="w-4 h-4 text-slate-600" /> Reports</div></Link>
              <Link className="block" href="/app/documents" onClick={() => { onOpenChange(false); }}><div className="rounded-md px-3 py-2 hover:bg-slate-100 flex items-center gap-2"><FileText className="w-4 h-4 text-slate-600" /> Documents</div></Link>
            </>
          ) : meExpand === "profile" ? (
            <div className="space-y-2">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
                <div className="text-[10px] uppercase text-slate-500">Legal name</div>
                <div className="font-semibold text-slate-800 mt-0.5">{user?.name}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
                <div className="text-[10px] uppercase text-slate-500">Email</div>
                <div className="font-semibold text-slate-800 mt-0.5 break-all">{user?.email}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
                <div className="text-[10px] uppercase text-slate-500">Role</div>
                <div className="font-semibold text-slate-800 mt-0.5">{user?.roleName}</div>
              </div>
              <p className="text-[11px] text-slate-500 px-1">Profile edits are controlled in <button className="underline cursor-pointer text-slate-700" type="button" onClick={() => setMeExpand("settings")}>System settings</button> by an Admin or Partner role.</p>
            </div>
          ) : (
            <>
              <Link className="block" href="/app/settings" onClick={() => onOpenChange(false)}><div className="rounded-md px-3 py-2 hover:bg-slate-100 flex items-center gap-2"><Settings className="w-4 h-4 text-slate-600" /> Firm settings</div></Link>
              <Link className="block" href="/app/audit" onClick={() => onOpenChange(false)}><div className="rounded-md px-3 py-2 hover:bg-slate-100 flex items-center gap-2"><ScrollText className="w-4 h-4 text-slate-600" /> Audit logs</div></Link>
              <Button variant="outline" className="w-full mt-2 justify-start text-rose-700 border-rose-200 bg-rose-50 hover:bg-rose-100" onClick={() => { onOpenChange(false); logout(); }}>
                <LogOut className="w-4 h-4 mr-2" /> Sign out
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
