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
import { useEffect, useMemo, useState } from "react";
import { getStateFromPostcode } from "@/utils/my-address-helper";

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
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [city, setCity] = useState("");
  const [postcode, setPostcode] = useState("");
  const [stateValue, setStateValue] = useState("");
  const [postcodeWarning, setPostcodeWarning] = useState<string | null>(null);

  const derivedState = useMemo(() => (postcode.length === 5 ? getStateFromPostcode(postcode) : null), [postcode]);

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

  useEffect(() => {
    if (derivedState) {
      if (stateValue.trim() && stateValue.trim() !== derivedState) {
        setPostcodeWarning(`Warning: Postcode ${postcode} belongs to ${derivedState}`);
      } else {
        setPostcodeWarning(null);
      }
      setStateValue(derivedState);
    } else {
      setPostcodeWarning(null);
    }
  }, [derivedState, postcode]);

  useEffect(() => {
    const lines = [addressLine1, addressLine2].map((x) => x.trim()).filter(Boolean);
    const pc = postcode.trim();
    const st = (derivedState ?? stateValue).trim();
    const c = city.trim();
    const addr = (() => {
      if (pc.length !== 5 || !derivedState) return [...lines, c, st].filter(Boolean).join(", ");
      if (derivedState === "Kuala Lumpur") return [...lines, [c, `${pc} ${derivedState}`].filter(Boolean).join(", ")].filter(Boolean).join(", ");
      return [...lines, [`${pc}${c ? ` ${c}` : ""}`, derivedState].filter(Boolean).join(", ")].filter(Boolean).join(", ");
    })();
    form.setValue("address", addr);
  }, [addressLine1, addressLine2, city, postcode, stateValue, derivedState, form]);

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
          const data = error && typeof error === "object" && "data" in error ? (error as { data?: unknown }).data : null;
          let msg: string | null = null;
          if (data && typeof data === "object") {
            const rec = data as Record<string, unknown>;
            if (typeof rec.error === "string" && rec.error.trim()) msg = rec.error.trim();
          }
          if (!msg && error instanceof Error) msg = error.message;
          toast({
            title: "Error",
            description: msg || "Please try again.",
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
                      <div className="space-y-3">
                        <div className="grid grid-cols-1 gap-3">
                          <Input value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} placeholder="Line 1" />
                          <Input value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} placeholder="Line 2" />
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                          <div className="md:col-span-4">
                            <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" />
                          </div>
                          <div className="md:col-span-4">
                            <Input
                              value={postcode}
                              onChange={(e) => setPostcode(e.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
                              inputMode="numeric"
                              placeholder="Postcode"
                            />
                          </div>
                          <div className="md:col-span-4">
                            <Input
                              value={stateValue}
                              onChange={(e) => setStateValue(e.target.value)}
                              disabled={Boolean(derivedState)}
                              placeholder="State"
                            />
                            {postcodeWarning ? <div className="text-xs text-amber-700 mt-1">{postcodeWarning}</div> : null}
                          </div>
                        </div>

                        <Input placeholder="Composed address" {...field} readOnly />
                      </div>
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
