import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth-context";
import { ReAuthProvider } from "@/components/re-auth-dialog";
import { AuthGuard } from "@/components/auth-guard";
import { PlatformLayout } from "@/components/layout/platform-layout";
import { AppLayout } from "@/components/layout/app-layout";

import Login from "@/pages/auth/login";
import NotFound from "@/pages/not-found";

// Platform Pages
import PlatformDashboard from "@/pages/platform/dashboard";
import FirmsList from "@/pages/platform/firms";
import NewFirm from "@/pages/platform/firms/new";
import FirmDetail from "@/pages/platform/firms/detail";
import PlatformMonitoring from "@/pages/platform/monitoring";
import PlatformAuditLogs from "@/pages/platform/audit-logs";
import PlatformDocuments from "@/pages/platform/documents";
import PlatformMessages from "@/pages/platform/messages";

// App Pages
import AppDashboard from "@/pages/app/dashboard";
import CasesList from "@/pages/app/cases";
import NewCase from "@/pages/app/cases/new";
import CaseDetail from "@/pages/app/cases/detail";

import NewUser from "@/pages/app/users/new";

import DevelopersList from "@/pages/app/developers";
import NewDeveloper from "@/pages/app/developers/new";
import DeveloperDetail from "@/pages/app/developers/detail";

import ProjectsList from "@/pages/app/projects";
import NewProject from "@/pages/app/projects/new";
import EditProject from "@/pages/app/projects/edit";
import ProjectDetail from "@/pages/app/projects/detail";

import ClientsList from "@/pages/app/clients";
import NewClient from "@/pages/app/clients/new";
import ClientDetail from "@/pages/app/clients/detail";

import AuditLogs from "@/pages/app/audit-logs";
import Settings from "@/pages/app/settings";
import DocumentsPage from "@/pages/app/documents";
import Accounting from "@/pages/app/accounting";
import InvoiceDetail from "@/pages/app/accounting/invoices/detail";
import Reports from "@/pages/app/reports";
import BillsDeliveredBook from "@/pages/app/reports/bills-delivered-book";
import MatterAging from "@/pages/app/reports/matter-aging";
import TrustAccountStatement from "@/pages/app/reports/trust-account-statement";
import Hub from "@/pages/app/hub";
import QuotationsList from "@/pages/app/quotations";
import NewQuotation from "@/pages/app/quotations/new";
import QuotationDetail from "@/pages/app/quotations/detail";

const queryClient = new QueryClient();

function PlatformRoutes() {
  return (
    <AuthGuard requireRole="founder">
      <PlatformLayout>
        <Switch>
          <Route path="/platform/dashboard" component={PlatformDashboard} />
          <Route path="/platform/firms/new" component={NewFirm} />
          <Route path="/platform/firms/:id" component={FirmDetail} />
          <Route path="/platform/firms" component={FirmsList} />
          <Route path="/platform/documents" component={PlatformDocuments} />
          <Route path="/platform/messages" component={PlatformMessages} />
          <Route path="/platform/monitoring" component={PlatformMonitoring} />
          <Route path="/platform/audit-logs" component={PlatformAuditLogs} />
          <Route path="/platform/*" component={NotFound} />
        </Switch>
      </PlatformLayout>
    </AuthGuard>
  );
}

function AppRoutes() {
  return (
    <AuthGuard requireRole="firm_user">
      <AppLayout>
        <Switch>
          <Route path="/app/dashboard" component={AppDashboard} />
          
          <Route path="/app/cases/new" component={NewCase} />
          <Route path="/app/cases/:id" component={CaseDetail} />
          <Route path="/app/cases" component={CasesList} />
          
          <Route path="/app/projects/new" component={NewProject} />
          <Route path="/app/projects/:id/edit" component={EditProject} />
          <Route path="/app/projects/:id" component={ProjectDetail} />
          <Route path="/app/projects" component={ProjectsList} />
          
          <Route path="/app/developers/new" component={NewDeveloper} />
          <Route path="/app/developers/:id" component={DeveloperDetail} />
          <Route path="/app/developers" component={DevelopersList} />
          
          <Route path="/app/clients/new" component={NewClient} />
          <Route path="/app/clients/:id" component={ClientDetail} />
          <Route path="/app/clients" component={ClientsList} />
          
          <Route path="/app/users/new" component={NewUser} />
          <Route path="/app/users" component={() => <Redirect to="/app/settings?tab=users" />} />
          
          <Route path="/app/roles" component={() => <Redirect to="/app/settings?tab=roles" />} />
          
          <Route path="/app/communications" component={() => <Redirect to="/app/hub" />} />
          <Route path="/app/quotations/new" component={NewQuotation} />
          <Route path="/app/quotations/:id" component={QuotationDetail} />
          <Route path="/app/quotations" component={QuotationsList} />
          
          <Route path="/app/settings/documents" component={() => <Redirect to="/app/documents" />} />
          <Route path="/app/documents" component={DocumentsPage} />
          <Route path="/app/accounting/invoices/:id" component={InvoiceDetail} />
          <Route path="/app/accounting" component={Accounting} />
          <Route path="/app/reports/bills-delivered-book" component={BillsDeliveredBook} />
          <Route path="/app/reports/matter-aging" component={MatterAging} />
          <Route path="/app/reports/trust-account-statement" component={TrustAccountStatement} />
          <Route path="/app/reports" component={Reports} />
          <Route path="/app/audit-logs" component={AuditLogs} />
          <Route path="/app/settings" component={Settings} />
          <Route path="/app/hub" component={Hub} />
          
          <Route path="/app/*" component={NotFound} />
        </Switch>
      </AppLayout>
    </AuthGuard>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={() => <Redirect to="/auth/login" />} />
      <Route path="/auth/login" component={Login} />
      
      <Route path="/platform" component={() => <Redirect to="/platform/dashboard" />} />
      <Route path="/platform/*" component={PlatformRoutes} />
      
      <Route path="/app" component={() => <Redirect to="/app/dashboard" />} />
      <Route path="/app/*" component={AppRoutes} />
      
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ReAuthProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <Router />
            </WouterRouter>
            <Toaster />
          </TooltipProvider>
        </ReAuthProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
