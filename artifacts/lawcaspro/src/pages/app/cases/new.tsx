import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useCreateCase, useListProjects, useListClients, useListUsers } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListCasesQueryKey } from "@workspace/api-client-react";
import { useEffect } from "react";

const createCaseSchema = z.object({
  projectId: z.coerce.number().min(1, "Project is required"),
  developerId: z.coerce.number().min(1, "Developer is required"),
  purchaseMode: z.enum(["cash", "loan"]),
  titleType: z.enum(["master", "individual", "strata"]),
  spaPrice: z.coerce.number().optional(),
  assignedLawyerId: z.coerce.number().min(1, "Lawyer is required"),
  purchaserIds: z.array(z.coerce.number()).min(1, "At least one purchaser is required"),
});

type FormValues = z.infer<typeof createCaseSchema>;

export default function NewCase() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: projectsRes } = useListProjects({ limit: 100 });
  const projects = projectsRes?.data || [];

  const { data: clientsRes } = useListClients({ limit: 100 });
  const clients = clientsRes?.data || [];

  const { data: usersRes } = useListUsers({ limit: 100 });
  const users = usersRes?.data || [];
  const lawyers = users.filter(u => u.roleName?.toLowerCase().includes("lawyer") || u.roleName?.toLowerCase().includes("partner"));

  const form = useForm<FormValues>({
    resolver: zodResolver(createCaseSchema),
    defaultValues: {
      projectId: 0,
      developerId: 0,
      purchaseMode: "loan",
      titleType: "master",
      spaPrice: undefined,
      assignedLawyerId: 0,
      purchaserIds: [0],
    },
  });

  const projectId = form.watch("projectId");
  const purchasers = form.watch("purchaserIds");

  // Auto-fill developer ID when project changes
  useEffect(() => {
    if (projectId) {
      const project = projects.find(p => p.id === Number(projectId));
      if (project) {
        form.setValue("developerId", project.developerId);
        form.setValue("titleType", project.titleType as any);
      }
    }
  }, [projectId, projects, form]);

  const addPurchaser = () => {
    form.setValue("purchaserIds", [...purchasers, 0]);
  };

  const removePurchaser = (index: number) => {
    if (purchasers.length > 1) {
      const newPurchasers = [...purchasers];
      newPurchasers.splice(index, 1);
      form.setValue("purchaserIds", newPurchasers);
    }
  };

  const createCaseMutation = useCreateCase();

  const onSubmit = (data: FormValues) => {
    createCaseMutation.mutate(
      { data },
      {
        onSuccess: (newCase) => {
          queryClient.invalidateQueries({ queryKey: getListCasesQueryKey() });
          toast({ title: "Case created successfully" });
          setLocation(`/app/cases/${newCase.id}`);
        },
        onError: (error) => {
          toast({
            title: "Error",
            description: error.error || "Failed to create case",
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <div className="space-y-6 max-w-4xl pb-12">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => setLocation("/app/cases")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Open New Case</h1>
          <p className="text-slate-500 mt-1">Initiate a conveyancing file</p>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="h-full">
              <CardHeader>
                <CardTitle>Property Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="projectId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Project</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ? field.value.toString() : ""}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a project" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {projects.map(p => (
                            <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="titleType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Title Type</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value} disabled>
                          <FormControl>
                            <SelectTrigger className="bg-slate-50">
                              <SelectValue placeholder="Auto-filled from project" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="master">Master Title</SelectItem>
                            <SelectItem value="individual">Individual Title</SelectItem>
                            <SelectItem value="strata">Strata Title</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="spaPrice"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>SPA Price (RM)</FormLabel>
                        <FormControl>
                          <Input type="number" placeholder="0.00" {...field} value={field.value || ""} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="h-full">
              <CardHeader>
                <CardTitle>Case Options</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="purchaseMode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Purchase Mode</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="cash">Cash</SelectItem>
                          <SelectItem value="loan">Loan</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-slate-500">Choosing "Cash" will disable loan workflow paths.</p>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="assignedLawyerId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Assigned Lawyer</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ? field.value.toString() : ""}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select lawyer" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {lawyers.map(l => (
                            <SelectItem key={l.id} value={l.id.toString()}>{l.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Purchasers</CardTitle>
              <Button type="button" variant="outline" size="sm" onClick={addPurchaser}>
                <Plus className="w-4 h-4 mr-2" /> Add Purchaser
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {purchasers.map((purchaserId, index) => (
                <div key={index} className="flex items-end gap-4 p-4 border border-slate-100 rounded-lg bg-slate-50">
                  <div className="flex-1">
                    <FormLabel className="text-xs font-semibold mb-2 block text-slate-500 uppercase tracking-wider">
                      Purchaser {index + 1} {index === 0 ? "(Main)" : "(Joint)"}
                    </FormLabel>
                    <Select 
                      value={purchaserId ? purchaserId.toString() : ""} 
                      onValueChange={(val) => {
                        const newPurchasers = [...purchasers];
                        newPurchasers[index] = Number(val);
                        form.setValue("purchaserIds", newPurchasers);
                      }}
                    >
                      <SelectTrigger className="bg-white">
                        <SelectValue placeholder="Select a client" />
                      </SelectTrigger>
                      <SelectContent>
                        {clients.map(c => (
                          <SelectItem key={c.id} value={c.id.toString()}>{c.name} ({c.icNo || 'No IC'})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {purchasers.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" className="text-red-500 hover:text-red-600 hover:bg-red-50" onClick={() => removePurchaser(index)}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4 sticky bottom-6 p-4 bg-white/80 backdrop-blur border border-slate-200 rounded-xl shadow-lg">
            <Button type="button" variant="outline" onClick={() => setLocation("/app/cases")}>
              Cancel
            </Button>
            <Button type="submit" disabled={createCaseMutation.isPending} className="bg-amber-500 hover:bg-amber-600">
              {createCaseMutation.isPending ? "Creating..." : "Create Case File"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
