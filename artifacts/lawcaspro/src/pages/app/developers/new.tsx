import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useCreateDeveloper } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListDevelopersQueryKey } from "@workspace/api-client-react";

const createDeveloperSchema = z.object({
  name: z.string().min(1, "Name is required"),
  companyRegNo: z.string().optional(),
  address: z.string().optional(),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email("Valid email required").optional().or(z.literal("")),
});

type FormValues = z.infer<typeof createDeveloperSchema>;

export default function NewDeveloper() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<FormValues>({
    resolver: zodResolver(createDeveloperSchema),
    defaultValues: {
      name: "",
      companyRegNo: "",
      address: "",
      contactPerson: "",
      phone: "",
      email: "",
    },
  });

  const createDeveloperMutation = useCreateDeveloper();

  const onSubmit = (data: FormValues) => {
    createDeveloperMutation.mutate(
      { data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListDevelopersQueryKey() });
          toast({ title: "Developer created successfully" });
          setLocation("/app/developers");
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
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon" onClick={() => setLocation("/app/developers")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Add Developer</h1>
          <p className="text-slate-500 mt-1">Register a new property developer</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Developer Information</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Company Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. EcoWorld Development Group" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="companyRegNo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Registration No.</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. 197401002639" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="address"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Address</FormLabel>
                    <FormControl>
                      <Input placeholder="Full registered address" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="contactPerson"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Contact Person</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Jane Smith" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. +603-12345678" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input placeholder="contact@ecoworld.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="pt-4 flex justify-end gap-4">
                <Button type="button" variant="outline" onClick={() => setLocation("/app/developers")}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createDeveloperMutation.isPending} className="bg-amber-500 hover:bg-amber-600">
                  {createDeveloperMutation.isPending ? "Saving..." : "Save Developer"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
