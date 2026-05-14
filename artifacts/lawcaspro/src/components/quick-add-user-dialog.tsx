import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCreateUser, useListRoles, getListUsersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/toast-error";
import { Copy } from "lucide-react";
import { cn } from "@/lib/utils";

const schema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().email("Valid email is required"),
});

type Values = z.infer<typeof schema>;

function generateTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const len = 14;
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)] ?? "A";
  }
  return out;
}

export function QuickAddUserDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roleKind: "lawyer" | "clerk";
  onCreated: (user: { id: number; name?: string | null; email?: string | null }) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const rolesQuery = useListRoles();
  const roles = rolesQuery.data ?? [];

  const roleId = useMemo(() => {
    const desired = props.roleKind === "lawyer" ? "Lawyer" : "Clerk";
    const exact = roles.find((r: any) => String(r?.name ?? "").toLowerCase() === desired.toLowerCase());
    if (exact?.id) return Number(exact.id);
    const loose = roles.find((r: any) => String(r?.name ?? "").toLowerCase().includes(desired.toLowerCase()));
    return loose?.id ? Number(loose.id) : 0;
  }, [roles, props.roleKind]);

  const [tempPassword, setTempPassword] = useState<string>(() => generateTempPassword());

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "" },
  });

  useEffect(() => {
    if (!props.open) return;
    form.reset({ name: "", email: "" });
    setTempPassword(generateTempPassword());
  }, [props.open, form]);

  const createUserMutation = useCreateUser();

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(tempPassword);
      toast({ title: "Temporary password copied" });
    } catch (e) {
      toastError(toast, e, "Copy failed");
    }
  };

  const onSubmit = (data: Values) => {
    if (!roleId) {
      toast({ title: "Role not available", description: "Please configure roles first.", variant: "destructive" as any });
      return;
    }
    createUserMutation.mutate(
      {
        data: {
          name: data.name,
          email: data.email,
          password: tempPassword,
          roleId,
        } as any,
      },
      {
        onSuccess: async (created: any) => {
          await qc.invalidateQueries({ queryKey: getListUsersQueryKey() });
          try {
            await navigator.clipboard.writeText(tempPassword);
          } catch {}
          const id = typeof created?.id === "number" ? Number(created.id) : NaN;
          if (Number.isFinite(id)) {
            props.onCreated({ id, name: created?.name ?? null, email: created?.email ?? null });
          }
          toast({ title: props.roleKind === "lawyer" ? "Lawyer added" : "Clerk added", description: "Temporary password copied to clipboard." });
          props.onOpenChange(false);
        },
        onError: (e) => {
          toastError(toast, e, "Create user failed");
        },
      }
    );
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Quick Add {props.roleKind === "lawyer" ? "Lawyer" : "Clerk"}
          </DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Full name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input placeholder="user@firm.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-500">Temporary password</div>
              <div className="mt-1 flex items-center gap-2">
                <div className={cn("text-xs font-mono text-slate-900 truncate", createUserMutation.isPending && "opacity-70")}>{tempPassword}</div>
                <Button type="button" variant="outline" size="sm" className="h-7" onClick={copyPassword} disabled={!tempPassword}>
                  <Copy className="w-3.5 h-3.5 mr-1" />
                  Copy
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)} disabled={createUserMutation.isPending}>
                Cancel
              </Button>
              <Button type="submit" className="bg-amber-500 hover:bg-amber-600" disabled={createUserMutation.isPending || rolesQuery.isLoading}>
                {createUserMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

