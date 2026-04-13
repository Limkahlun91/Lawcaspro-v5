import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import { getHttpStatus } from "@/lib/error-message";
import { AuthProvider } from "@/lib/auth-context";
import { ReAuthProvider } from "@/components/re-auth-dialog";
import { AuthGuard } from "@/components/auth-guard";
import { PermissionGuard } from "@/components/permission-guard";
import { PlatformLayout } from "@/components/layout/platform-layout";
import { AppLayout } from "@/components/layout/app-layout";
import { getApiOrigin } from "@/lib/api-base";
import { getStoredAuthToken } from "@/lib/auth-token";

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
import Workbench from "@/pages/app/workbench";

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
import Communications from "@/pages/app/communications";
import CommunicationThreadDetail from "@/pages/app/communications/thread-detail";
import QuotationsList from "@/pages/app/quotations";
import NewQuotation from "@/pages/app/quotations/new";
import QuotationDetail from "@/pages/app/quotations/detail";

const apiOrigin = getApiOrigin();
if (apiOrigin) setBaseUrl(apiOrigin);
setAuthTokenGetter(() => getStoredAuthToken());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, err) => {
        const status = getHttpStatus(err);
        if (status === 401 || status === 403 || status === 404) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});

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
          <Route path="/app/dashboard" component={() => (
            <PermissionGuard module="dashboard" action="read">
              <AppDashboard />
            </PermissionGuard>
          )} />

          <Route path="/app/workbench" component={() => (
            <PermissionGuard module="cases" action="read">
              <Workbench />
            </PermissionGuard>
          )} />
          
          <Route path="/app/cases/new" component={() => (
            <PermissionGuard module="cases" action="create">
              <NewCase />
            </PermissionGuard>
          )} />
          <Route path="/app/cases/:id" component={() => (
            <PermissionGuard module="cases" action="read">
              <CaseDetail />
            </PermissionGuard>
          )} />
          <Route path="/app/cases" component={() => (
            <PermissionGuard module="cases" action="read">
              <CasesList />
            </PermissionGuard>
          )} />
          
          <Route path="/app/projects/new" component={() => (
            <PermissionGuard module="projects" action="create">
              <NewProject />
            </PermissionGuard>
          )} />
          <Route path="/app/projects/:id/edit" component={() => (
            <PermissionGuard module="projects" action="update">
              <EditProject />
            </PermissionGuard>
          )} />
          <Route path="/app/projects/:id" component={() => (
            <PermissionGuard module="projects" action="read">
              <ProjectDetail />
            </PermissionGuard>
          )} />
          <Route path="/app/projects" component={() => (
            <PermissionGuard module="projects" action="read">
              <ProjectsList />
            </PermissionGuard>
          )} />
          
          <Route path="/app/developers/new" component={() => (
            <PermissionGuard module="developers" action="create">
              <NewDeveloper />
            </PermissionGuard>
          )} />
          <Route path="/app/developers/:id" component={() => (
            <PermissionGuard module="developers" action="read">
              <DeveloperDetail />
            </PermissionGuard>
          )} />
          <Route path="/app/developers" component={() => (
            <PermissionGuard module="developers" action="read">
              <DevelopersList />
            </PermissionGuard>
          )} />
          
          <Route path="/app/clients/new" component={NewClient} />
          <Route path="/app/clients/:id" component={ClientDetail} />
          <Route path="/app/clients" component={ClientsList} />
          
          <Route path="/app/users/new" component={() => (
            <PermissionGuard module="users" action="create">
              <NewUser />
            </PermissionGuard>
          )} />
          <Route path="/app/users" component={() => <Redirect to="/app/settings?tab=users" />} />
          
          <Route path="/app/roles" component={() => <Redirect to="/app/settings?tab=roles" />} />
          
          <Route path="/app/communications/:threadId" component={() => (
            <PermissionGuard module="communications" action="read">
              <CommunicationThreadDetail />
            </PermissionGuard>
          )} />
          <Route path="/app/communications" component={() => (
            <PermissionGuard module="communications" action="read">
              <Communications />
            </PermissionGuard>
          )} />
          <Route path="/app/quotations/new" component={() => (
            <PermissionGuard module="accounting" action="write">
              <NewQuotation />
            </PermissionGuard>
          )} />
          <Route path="/app/quotations/:id" component={() => (
            <PermissionGuard module="accounting" action="read">
              <QuotationDetail />
            </PermissionGuard>
          )} />
          <Route path="/app/quotations" component={() => (
            <PermissionGuard module="accounting" action="read">
              <QuotationsList />
            </PermissionGuard>
          )} />
          
          <Route path="/app/settings/documents" component={() => <Redirect to="/app/documents" />} />
          <Route path="/app/documents" component={() => (
            <PermissionGuard module="documents" action="read">
              <DocumentsPage />
            </PermissionGuard>
          )} />
          <Route path="/app/accounting/invoices/:id" component={() => (
            <PermissionGuard module="accounting" action="read">
              <InvoiceDetail />
            </PermissionGuard>
          )} />
          <Route path="/app/accounting" component={() => (
            <PermissionGuard module="accounting" action="read">
              <Accounting />
            </PermissionGuard>
          )} />
          <Route path="/app/reports/bills-delivered-book" component={() => (
            <PermissionGuard module="reports" action="read">
              <BillsDeliveredBook />
            </PermissionGuard>
          )} />
          <Route path="/app/reports/matter-aging" component={() => (
            <PermissionGuard module="reports" action="read">
              <MatterAging />
            </PermissionGuard>
          )} />
          <Route path="/app/reports/trust-account-statement" component={() => (
            <PermissionGuard module="reports" action="read">
              <TrustAccountStatement />
            </PermissionGuard>
          )} />
          <Route path="/app/reports" component={() => (
            <PermissionGuard module="reports" action="read">
              <Reports />
            </PermissionGuard>
          )} />
          <Route path="/app/audit-logs" component={() => (
            <PermissionGuard module="audit" action="read">
              <AuditLogs />
            </PermissionGuard>
          )} />
          <Route path="/app/settings" component={() => (
            <PermissionGuard module="settings" action="read">
              <Settings />
            </PermissionGuard>
          )} />
          <Route path="/app/hub" component={() => (
            <PermissionGuard module="communications" action="read">
              <Hub />
            </PermissionGuard>
          )} />
          
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
              <AppErrorBoundary>
                <Router />
              </AppErrorBoundary>
            </WouterRouter>
            <Toaster />
          </TooltipProvider>
        </ReAuthProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
