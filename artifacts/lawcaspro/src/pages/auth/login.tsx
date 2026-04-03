import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, Eye, EyeOff, ShieldCheck } from "lucide-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "").replace(/^\/lawcaspro/, "") + "/api";

const loginSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function Login() {
  const { login: setAuthUser } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showPassword, setShowPassword] = useState(false);
  const [isPending, setIsPending] = useState(false);

  const [totpStep, setTotpStep] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [savedCredentials, setSavedCredentials] = useState<LoginFormValues | null>(null);

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  async function doLogin(data: LoginFormValues, code?: string) {
    setIsPending(true);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ...data, ...(code ? { totpCode: code } : {}) }),
      });
      const body = await res.json();

      if (!res.ok) {
        toast({ title: "Login failed", description: body.error || "Please check your credentials.", variant: "destructive" });
        setTotpStep(false);
        setSavedCredentials(null);
        setTotpCode("");
        return;
      }

      if (body.needsTotp) {
        setSavedCredentials(data);
        setTotpStep(true);
        return;
      }

      setAuthUser(body, body.token);
      if (body.userType === "founder") {
        setLocation("/platform/dashboard");
      } else {
        setLocation("/app/dashboard");
      }
    } catch {
      toast({ title: "Login failed", description: "A network error occurred.", variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  }

  const onSubmit = (data: LoginFormValues) => {
    doLogin(data);
  };

  const onTotpSubmit = () => {
    if (!savedCredentials || totpCode.length !== 6) return;
    doLogin(savedCredentials, totpCode);
  };

  if (totpStep) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center mb-8">
            <div className="w-12 h-12 bg-slate-900 rounded-lg flex items-center justify-center mb-4">
              <Building2 className="w-6 h-6 text-amber-500" />
            </div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Lawcaspro</h1>
            <p className="text-slate-500 font-medium mt-1">Legal Operations System</p>
          </div>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <div className="flex items-center gap-2 mb-1">
                <ShieldCheck className="w-5 h-5 text-amber-500" />
                <CardTitle>Two-factor authentication</CardTitle>
              </div>
              <CardDescription>
                Enter the 6-digit code from your authenticator app to continue.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <Input
                    placeholder="000000"
                    value={totpCode}
                    onChange={e => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="font-mono text-center text-2xl tracking-widest h-14"
                    maxLength={6}
                    autoFocus
                    onKeyDown={e => { if (e.key === "Enter") onTotpSubmit(); }}
                  />
                </div>
                <Button
                  className="w-full bg-slate-900 hover:bg-slate-800 text-white"
                  disabled={totpCode.length !== 6 || isPending}
                  onClick={onTotpSubmit}
                >
                  {isPending ? "Verifying..." : "Verify"}
                </Button>
                <Button
                  variant="ghost"
                  className="w-full text-slate-500"
                  onClick={() => { setTotpStep(false); setSavedCredentials(null); setTotpCode(""); }}
                >
                  Back to login
                </Button>
              </div>
            </CardContent>
          </Card>

          <p className="text-center text-xs text-slate-400 mt-6">Lawcaspro &copy; {new Date().getFullYear()}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 bg-slate-900 rounded-lg flex items-center justify-center mb-4">
            <Building2 className="w-6 h-6 text-amber-500" />
          </div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Lawcaspro</h1>
          <p className="text-slate-500 font-medium mt-1">Legal Operations System</p>
        </div>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Sign in to your account</CardTitle>
            <CardDescription>Enter your credentials to access your workspace</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email address</FormLabel>
                      <FormControl>
                        <Input placeholder="name@firm.com" autoComplete="email" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            type={showPassword ? "text" : "password"}
                            placeholder="••••••••"
                            autoComplete="current-password"
                            className="pr-10"
                            {...field}
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword((v) => !v)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                            tabIndex={-1}
                            aria-label={showPassword ? "Hide password" : "Show password"}
                          >
                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  className="w-full bg-slate-900 hover:bg-slate-800 text-white"
                  disabled={isPending}
                >
                  {isPending ? "Signing in..." : "Sign in"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-slate-400 mt-6">Lawcaspro &copy; {new Date().getFullYear()}</p>
      </div>
    </div>
  );
}
