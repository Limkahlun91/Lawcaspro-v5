import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useCreateClient } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListClientsQueryKey } from "@workspace/api-client-react";

const createClientSchema = z.object({
  name: z.string().min(1, "Name is required"),
  icNo: z.string().optional(),
  nationality: z.string().optional(),
  address: z.string().optional(),
  email: z.string().email("Valid email is required").optional().or(z.literal("")),
  phone: z.string().optional(),
});

type FormValues = z.infer<typeof createClientSchema>;

export default function NewClient() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<FormValues>({
    resolver: zodResolver(createClientSchema),
    defaultValues: {
      name: "",
      icNo: "",
      nationality: "Malaysian",
      address: "",
      email: "",
      phone: "",
    },
  });

  const createClientMutation = useCreateClient();

  const onSubmit = (data: FormValues) => {
    createClientMutation.mutate(
      { data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListClientsQueryKey() });
          toast({ title: "Client created successfully" });
          setLocation("/app/clients");
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
        <Button variant="outline" size="icon" onClick={() => setLocation("/app/clients")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Add Client</h1>
          <p className="text-slate-500 mt-1">Register a new client record</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Client Details</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Full Name / Company Name</FormLabel>
                    <FormControl>
                      <Input placeholder="John Doe" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="icNo"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>IC / Passport / Company No.</FormLabel>
                      <FormControl>
                        <Input placeholder="900101-14-5555" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="nationality"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Nationality</FormLabel>
                      <FormControl>
                        <Input placeholder="Malaysian" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

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
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email Address</FormLabel>
                      <FormControl>
                        <Input placeholder="john@example.com" {...field} />
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
                      <FormLabel>Phone Number</FormLabel>
                      <FormControl>
                        <Input placeholder="+6012-3456789" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="pt-4 flex justify-end gap-4">
                <Button type="button" variant="outline" onClick={() => setLocation("/app/clients")}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createClientMutation.isPending} className="bg-amber-500 hover:bg-amber-600">
                  {createClientMutation.isPending ? "Saving..." : "Save Client"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
