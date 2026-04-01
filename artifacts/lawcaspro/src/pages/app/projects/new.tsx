import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useCreateProject, useListDevelopers } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListProjectsQueryKey } from "@workspace/api-client-react";

const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required"),
  developerId: z.coerce.number().min(1, "Developer is required"),
  projectType: z.enum(["landed", "highrise"]),
  titleType: z.enum(["master", "individual", "strata"]),
  landUse: z.string().optional(),
  developmentCondition: z.string().optional(),
  unitCategory: z.string().optional(),
  
  // Highrise specific
  storeyNo: z.string().optional(),
  buildingNo: z.string().optional(),
  carParkNo: z.string().optional(),
  carParkLevel: z.string().optional(),
  accessoryParcelNo: z.string().optional(),
  shareUnits: z.string().optional(),
  
  // Landed specific
  developerParcelNo: z.string().optional(),
  buildingType: z.string().optional(),
  unitType: z.string().optional(),
  landArea: z.string().optional(),
  buildUpArea: z.string().optional(),
});

type FormValues = z.infer<typeof createProjectSchema>;

export default function NewProject() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: devsResponse } = useListDevelopers({ limit: 100 });
  const developers = devsResponse?.data || [];

  const form = useForm<FormValues>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: {
      name: "",
      developerId: 0,
      projectType: "landed",
      titleType: "master",
      landUse: "",
      developmentCondition: "",
      unitCategory: "",
    },
  });

  const projectType = form.watch("projectType");
  const createProjectMutation = useCreateProject();

  const onSubmit = (data: FormValues) => {
    // Pack extra fields
    const extraFields: Record<string, unknown> = {};
    if (data.projectType === "highrise") {
      if (data.storeyNo) extraFields.storeyNo = data.storeyNo;
      if (data.buildingNo) extraFields.buildingNo = data.buildingNo;
      if (data.carParkNo) extraFields.carParkNo = data.carParkNo;
      if (data.carParkLevel) extraFields.carParkLevel = data.carParkLevel;
      if (data.accessoryParcelNo) extraFields.accessoryParcelNo = data.accessoryParcelNo;
      if (data.shareUnits) extraFields.shareUnits = data.shareUnits;
    } else {
      if (data.developerParcelNo) extraFields.developerParcelNo = data.developerParcelNo;
      if (data.buildingType) extraFields.buildingType = data.buildingType;
      if (data.unitType) extraFields.unitType = data.unitType;
      if (data.landArea) extraFields.landArea = data.landArea;
      if (data.buildUpArea) extraFields.buildUpArea = data.buildUpArea;
    }

    const payload = {
      name: data.name,
      developerId: data.developerId,
      projectType: data.projectType,
      titleType: data.titleType,
      landUse: data.landUse,
      developmentCondition: data.developmentCondition,
      unitCategory: data.unitCategory,
      extraFields
    };

    createProjectMutation.mutate(
      { data: payload },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          toast({ title: "Project created successfully" });
          setLocation("/app/projects");
        },
        onError: (error) => {
          toast({
            title: "Error",
            description: error.error || "Please try again.",
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => setLocation("/app/projects")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">New Project</h1>
          <p className="text-slate-500 mt-1">Register a new development project</p>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Core Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Project Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Phase 1 - Botanica" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="developerId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Developer</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value ? field.value.toString() : ""}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a developer" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {developers.map(dev => (
                          <SelectItem key={dev.id} value={dev.id.toString()}>{dev.name}</SelectItem>
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
                  name="projectType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Project Type</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="landed">Landed</SelectItem>
                          <SelectItem value="highrise">Highrise / Strata</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="titleType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Title Type</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
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
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Technical Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="landUse"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Land Use</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Building / Agriculture" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="developmentCondition"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Development Condition</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Freehold / Leasehold" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {projectType === "landed" && (
                <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-100">
                  <FormField control={form.control} name="developerParcelNo" render={({ field }) => (
                    <FormItem><FormLabel>Developer Parcel No</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="buildingType" render={({ field }) => (
                    <FormItem><FormLabel>Building Type</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="unitType" render={({ field }) => (
                    <FormItem><FormLabel>Unit Type</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="landArea" render={({ field }) => (
                    <FormItem><FormLabel>Land Area</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="buildUpArea" render={({ field }) => (
                    <FormItem><FormLabel>Build Up Area</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                </div>
              )}

              {projectType === "highrise" && (
                <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-100">
                  <FormField control={form.control} name="storeyNo" render={({ field }) => (
                    <FormItem><FormLabel>Storey No</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="buildingNo" render={({ field }) => (
                    <FormItem><FormLabel>Building No</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="carParkNo" render={({ field }) => (
                    <FormItem><FormLabel>Car Park No</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="carParkLevel" render={({ field }) => (
                    <FormItem><FormLabel>Car Park Level</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="accessoryParcelNo" render={({ field }) => (
                    <FormItem><FormLabel>Accessory Parcel No</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="shareUnits" render={({ field }) => (
                    <FormItem><FormLabel>Share Units</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex justify-end gap-4">
            <Button type="button" variant="outline" onClick={() => setLocation("/app/projects")}>
              Cancel
            </Button>
            <Button type="submit" disabled={createProjectMutation.isPending} className="bg-amber-500 hover:bg-amber-600">
              {createProjectMutation.isPending ? "Saving..." : "Create Project"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
