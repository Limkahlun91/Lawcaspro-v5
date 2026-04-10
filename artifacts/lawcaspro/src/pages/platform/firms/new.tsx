import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useCreateFirm } from "@workspace/api-client-react";
import { useLocation, Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListFirmsQueryKey } from "@workspace/api-client-react";

const createFirmSchema = z.object({
  name: z.string().min(1, "Firm name is required"),
  slug: z.string().min(1, "Slug is required").regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric and hyphens"),
  subscriptionPlan: z.string().min(1, "Plan is required"),
  partnerName: z.string().min(1, "Partner name is required"),
  partnerEmail: z.string().email("Valid email is required"),
  partnerPassword: z.string().min(8, "Password must be at least 8 characters"),
});

type FormValues = z.infer<typeof createFirmSchema>;

export default function NewFirm() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const form = useForm<FormValues>({
    resolver: zodResolver(createFirmSchema),
    defaultValues: {
      name: "",
      slug: "",
      subscriptionPlan: "professional",
      partnerName: "",
      partnerEmail: "",
      partnerPassword: "",
    },
  });

  const createFirmMutation = useCreateFirm();

  const onSubmit = (data: FormValues) => {
    createFirmMutation.mutate(
      { data },
      {
        onSuccess: (firm) => {
          queryClient.invalidateQueries({ queryKey: getListFirmsQueryKey() });
          toast({
            title: "Firm created",
            description: `${firm.name} has been successfully created.`,
          });
          setLocation("/platform/firms");
        },
        onError: (error) => {
          const data = (error as { data?: unknown } | null | undefined)?.data;
          const apiError =
            data && typeof data === "object" && "error" in data && typeof (data as { error?: unknown }).error === "string"
              ? (data as { error: string }).error
              : null;
          const message =
            apiError ??
            (error instanceof Error ? error.message : null) ??
            "Please try again.";
          toast({
            title: "Error creating firm",
            description: message,
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => setLocation("/platform/firms")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Create Firm</h1>
          <p className="text-slate-500 mt-1">Onboard a new law firm to the platform</p>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Firm Details</CardTitle>
              <CardDescription>Basic information about the law firm.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Firm Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Lee & Partners" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="slug"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Workspace Slug</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. lee-partners" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="subscriptionPlan"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Subscription Plan</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a plan" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="starter">Starter</SelectItem>
                        <SelectItem value="professional">Professional</SelectItem>
                        <SelectItem value="enterprise">Enterprise</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Partner Account</CardTitle>
              <CardDescription>Create the initial founder/partner account for this firm.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="partnerName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Partner Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. John Lee" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="partnerEmail"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email Address</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. john@leepartners.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="partnerPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="••••••••" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4">
            <Button type="button" variant="outline" onClick={() => setLocation("/platform/firms")}>
              Cancel
            </Button>
            <Button type="submit" disabled={createFirmMutation.isPending} className="bg-amber-500 hover:bg-amber-600">
              {createFirmMutation.isPending ? "Creating..." : "Create Firm"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
