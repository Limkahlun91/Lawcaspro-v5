import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import { getHttpStatus, isAbortError, isRequestTimeoutError } from "@/lib/error-message";
import { AuthProvider } from "@/lib/auth-context";
import { ReAuthProvider } from "@/components/re-auth-dialog";
import { AuthGuard } from "@/components/auth-guard";
import { PermissionGuard } from "@/components/permission-guard";
import { PlatformLayout } from "@/components/layout/platform-layout";
import { AppLayout } from "@/components/layout/app-layout";
import { DeveloperLayout } from "@/components/layout/developer-layout";
import { GlobalCaseSearch } from "@/components/GlobalCaseSearch";
import { getApiOrigin } from "@/lib/api-base";
import { getStoredAuthToken } from "@/lib/auth-token";
import { DeveloperGuard } from "@/components/developer-guard";
import { isEmailControlEnabled, isEmailSettingsEnabled, isWhatsAppInboxEnabled, isHRModuleEnabled, PHASE2_NOTICE, HR_DISABLED_NOTICE } from "@/lib/feature-flags";
import { useEffect, type ReactNode } from "react";
import { useToast } from "@/hooks/use-toast";

import Login from "@/pages/auth/login";
import NotFound from "@/pages/not-found";
import TrackingTokenPage from "@/pages/public/track/[token]";

// Platform Pages
import PlatformDashboard from "@/pages/platform/dashboard";
import FirmsList from "@/pages/platform/firms";
import NewFirm from "@/pages/platform/firms/new";
import FirmDetail from "@/pages/platform/firms/detail";
import FirmHistoryDetailPage from "@/pages/platform/firms/history-detail";
import PlatformOperationsOverview from "@/pages/platform/operations";
import PlatformOperationsLogs from "@/pages/platform/operations/logs";
import PlatformOperationsIncidents from "@/pages/platform/operations/incidents";
import PlatformOperationsIncidentDetail from "@/pages/platform/operations/incident-detail";
import PlatformOperationsRecommendations from "@/pages/platform/operations/recommendations";
import PlatformOperationsReadiness from "@/pages/platform/operations/readiness";
import PlatformOperationsPending from "@/pages/platform/operations/pending";
import PlatformTemplates from "@/pages/platform/operations/templates";
import PlatformMonitoring from "@/pages/platform/monitoring";
import PlatformAuditLogs from "@/pages/platform/audit-logs";
import PlatformDocuments from "@/pages/platform/documents";
import PlatformMessages from "@/pages/platform/messages";
import FounderBillingPage from "@/pages/founder/billing";
import PlatformSubscriptionPlansPage from "@/pages/platform/subscription-plans";
import PlatformVariablesPage from "@/pages/platform/variables";
import PlatformCustomVariablesPage from "@/pages/platform/custom-variables";

// App Pages
import AppDashboard from "@/pages/app/dashboard";
import CasesList from "@/pages/app/cases";
import NewCase from "@/pages/app/cases/new";
import CaseDetail from "@/pages/app/cases/detail";
import Workbench from "@/pages/app/workbench";
import CaseIntakeInboxPage from "@/pages/app/cases/intake";

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
import UnifiedLogsPage from "@/pages/app/settings/logs";
import FirmTemplatesSettingsPage from "@/pages/app/settings/templates";
import ClausesSettingsPage from "@/pages/app/settings/clauses";
import AccountingSettingsPage from "@/pages/app/settings/accounting";
import EmailSettingsPage from "@/pages/app/settings/email";
import Settings from "@/pages/app/settings";
import DocumentsPage from "@/pages/app/documents";
import DocumentAutomationHub from "@/pages/app/documents/automation";
import DocumentGenerationLogsPage from "@/pages/app/documents/generation-logs";
import VariableDictionaryPage from "@/pages/app/documents/variables";
import CustomVariablesPage from "@/pages/app/documents/custom-variables";
import Accounting from "@/pages/app/accounting";
import AccountingFileListing from "@/pages/app/accounting/file-listing";
import BankReconciliationPage from "@/pages/app/accounting/bank-reconciliation";
import InvoiceDetail from "@/pages/app/accounting/invoices/detail";
import ReceiptDetail from "@/pages/app/accounting/receipts/detail";
import FileCustodyPage from "@/pages/app/file-custody";
import Reports from "@/pages/app/reports";
import BillsDeliveredBook from "@/pages/app/reports/bills-delivered-book";
import MatterAging from "@/pages/app/reports/matter-aging";
import TrustAccountStatement from "@/pages/app/reports/trust-account-statement";
import ProjectStatusReport from "@/pages/app/reports/project-status";
import Hub from "@/pages/app/hub";
import Communications from "@/pages/app/communications";
import CommunicationThreadDetail from "@/pages/app/communications/thread-detail";
import EmailControlCenterPage from "@/pages/app/communication/email";
import WhatsAppInboxPlaceholderPage from "@/pages/app/communication/whatsapp";
import QuotationsList from "@/pages/app/quotations";
import NewQuotation from "@/pages/app/quotations/new";
import QuotationDetail from "@/pages/app/quotations/detail";

// Partner / Monitor
import CaseMonitorPage from "@/pages/app/case-monitor";
import BankAdaptersPage from "@/pages/app/bank-adapters";

// HR Full pages
import HrDashboard from "@/pages/app/hr/dashboard";
import HrEmployees from "@/pages/app/hr/employees";
import HrAttendance from "@/pages/app/hr/attendance";
import HrLeave from "@/pages/app/hr/leave";
import HrClaims from "@/pages/app/hr/claims";
import HrPayroll from "@/pages/app/hr/payroll";
import HrRecruitment from "@/pages/app/hr/recruitment";
import HrPerformance from "@/pages/app/hr/performance";
import HrTraining from "@/pages/app/hr/training";
import HrAssets from "@/pages/app/hr/assets";
import HrDocuments from "@/pages/app/hr/documents";
import HrOnboarding from "@/pages/app/hr/onboarding";
import HrOffboarding from "@/pages/app/hr/offboarding";
import HrDepartments from "@/pages/app/hr/departments";
import HrPositions from "@/pages/app/hr/positions";
import HrReports from "@/pages/app/hr/reports";
import HrSettings from "@/pages/app/hr/settings";

// My Work / Self Service
import MyDashboard from "@/pages/app/my/dashboard";
import MyLeave from "@/pages/app/my/leave";
import MyClaims from "@/pages/app/my/claims";
import MyPayslips from "@/pages/app/my/payslips";
import MyProfile from "@/pages/app/my/profile";
import MyAttendance from "@/pages/app/my/attendance";
import MyDocuments from "@/pages/app/my/documents";
import MyRequests from "@/pages/app/my/requests";

// Developer Pages
import DeveloperDashboardPage from "@/pages/developer/dashboard";

const apiOrigin = getApiOrigin();
if (apiOrigin) setBaseUrl(apiOrigin);
setAuthTokenGetter(() => getStoredAuthToken());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: (failureCount, err) => {
        if (isAbortError(err) && !isRequestTimeoutError(err)) return false;
        const status = getHttpStatus(err);
        if (status === 401 || status === 403 || status === 404) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});

export function ModuleRedirectGuard({
  enabled,
  notice,
  fallback = "/app/dashboard",
  children,
}: {
  enabled: boolean;
  notice: string;
  fallback?: "/app/dashboard" | "/app/workbench";
  children: ReactNode;
}) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  useEffect(() => {
    if (enabled) return;
    toast({ title: notice, variant: "default" });
    setLocation(fallback, { replace: true });
  }, [enabled, notice, fallback, setLocation, toast]);
  if (enabled) return <>{children}</>;
  return null;
}

function Phase2RedirectGuard({
  enabled,
  fallback = "/app/dashboard",
  children,
}: {
  enabled: boolean;
  fallback?: "/app/dashboard" | "/app/workbench";
  children: ReactNode;
}) {
  return (
    <ModuleRedirectGuard enabled={enabled} notice={PHASE2_NOTICE} fallback={fallback}>
      {children}
    </ModuleRedirectGuard>
  );
}

function HRRedirectGuard({
  fallback = "/app/dashboard",
  children,
  extraEnabled = true,
}: {
  fallback?: "/app/dashboard" | "/app/workbench";
  children: ReactNode;
  extraEnabled?: boolean;
}) {
  const enabled = isHRModuleEnabled() && extraEnabled;
  return (
    <ModuleRedirectGuard enabled={enabled} notice={HR_DISABLED_NOTICE} fallback={fallback}>
      {children}
    </ModuleRedirectGuard>
  );
}

function PlatformRoutes() {
  return (
    <AuthGuard requireRole="founder">
      <PlatformLayout>
        <Switch>
          <Route path="/platform/dashboard" component={PlatformDashboard} />
          <Route path="/platform/operations/logs" component={PlatformOperationsLogs} />
          <Route path="/platform/operations/incidents/:id" component={PlatformOperationsIncidentDetail} />
          <Route path="/platform/operations/incidents" component={PlatformOperationsIncidents} />
          <Route path="/platform/operations/recommendations" component={PlatformOperationsRecommendations} />
          <Route path="/platform/operations/readiness" component={PlatformOperationsReadiness} />
          <Route path="/platform/operations/pending" component={PlatformOperationsPending} />
          <Route path="/platform/operations/templates" component={PlatformTemplates} />
          <Route path="/platform/operations" component={PlatformOperationsOverview} />
          <Route path="/platform/firms/new" component={NewFirm} />
          <Route path="/platform/firms/:id/history/:kind/:historyId" component={FirmHistoryDetailPage} />
          <Route path="/platform/firms/:id" component={FirmDetail} />
          <Route path="/platform/firms" component={FirmsList} />
          <Route path="/platform/billing" component={FounderBillingPage} />
          <Route path="/platform/subscription-plans" component={PlatformSubscriptionPlansPage} />
          <Route path="/platform/documents" component={PlatformDocuments} />
          <Route path="/platform/variables" component={PlatformVariablesPage} />
          <Route path="/platform/custom-variables" component={PlatformCustomVariablesPage} />
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
        <GlobalCaseSearch />
        <Switch>
          <Route path="/app/dashboard" component={() => (
            <PermissionGuard module="dashboard" action="read" mode="silent">
              <AppDashboard />
            </PermissionGuard>
          )} />

          <Route path="/app/workbench" component={() => <Redirect to="/app/my-work" />} />

          <Route path="/app/my-work" component={() => (
            <PermissionGuard module="cases" action="read" mode="silent">
              <Workbench />
            </PermissionGuard>
          )} />
          
          <Route path="/app/cases/new" component={() => (
            <PermissionGuard module="cases" action="create">
              <NewCase />
            </PermissionGuard>
          )} />
          <Route path="/app/cases/intake" component={() => (
            <PermissionGuard module="cases" action="create">
              <CaseIntakeInboxPage />
            </PermissionGuard>
          )} />
          <Route path="/app/cases/:id" component={() => (
            <PermissionGuard module="cases" action="read">
              <CaseDetail />
            </PermissionGuard>
          )} />
          <Route path="/app/cases" component={() => (
            <PermissionGuard module="cases" action="read" mode="silent">
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

          <Route path="/app/communication/email" component={() => (
            <Phase2RedirectGuard enabled={isEmailControlEnabled()}>
              <PermissionGuard module="communications" action="read">
                <EmailControlCenterPage />
              </PermissionGuard>
            </Phase2RedirectGuard>
          )} />
          <Route path="/app/communication/whatsapp" component={() => (
            <Phase2RedirectGuard enabled={isWhatsAppInboxEnabled()}>
              <PermissionGuard module="communications" action="read">
                <WhatsAppInboxPlaceholderPage />
              </PermissionGuard>
            </Phase2RedirectGuard>
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
          <Route path="/app/documents/generation-logs" component={() => <Redirect to="/app/settings/logs" />} />
          <Route path="/app/documents/automation" component={() => (
            <PermissionGuard module="documents" action="read">
              <DocumentAutomationHub />
            </PermissionGuard>
          )} />
          <Route path="/app/documents/variables" component={() => (
            <PermissionGuard module="documents" action="read">
              <VariableDictionaryPage />
            </PermissionGuard>
          )} />
          <Route path="/app/documents/custom-variables" component={() => <Redirect to="/app/documents/variables#custom" />} />
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
          <Route path="/app/accounting/receipts/:id" component={() => (
            <PermissionGuard module="accounting" action="read">
              <ReceiptDetail />
            </PermissionGuard>
          )} />
          <Route path="/app/accounting/bank-reconciliation" component={() => (
            <PermissionGuard module="accounting" action="read">
              <BankReconciliationPage />
            </PermissionGuard>
          )} />
          <Route path="/app/accounting/file-listing" component={() => (
            <PermissionGuard module="accounting" action="read">
              <AccountingFileListing />
            </PermissionGuard>
          )} />
          <Route path="/app/accounting" component={() => (
            <PermissionGuard module="accounting" action="read">
              <Accounting />
            </PermissionGuard>
          )} />
          <Route path="/app/file-custody" component={() => (
            <PermissionGuard module="file_custody" action="view">
              <FileCustodyPage />
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
          <Route path="/app/reports/project-status" component={() => (
            <PermissionGuard module="reports" action="read">
              <ProjectStatusReport />
            </PermissionGuard>
          )} />
          <Route path="/app/reports" component={() => (
            <PermissionGuard module="reports" action="read">
              <Reports />
            </PermissionGuard>
          )} />
          <Route path="/app/audit-logs" component={() => <Redirect to="/app/settings/logs" />} />
          <Route path="/app/settings/templates" component={() => (
            <PermissionGuard module="documents" action="read">
              <FirmTemplatesSettingsPage />
            </PermissionGuard>
          )} />
          <Route path="/app/settings/clauses" component={() => (
            <PermissionGuard module="documents" action="read">
              <ClausesSettingsPage />
            </PermissionGuard>
          )} />
          <Route path="/app/settings/accounting" component={() => (
            <PermissionGuard module="accounting" action="read">
              <AccountingSettingsPage />
            </PermissionGuard>
          )} />
          <Route path="/app/settings/logs" component={() => (
            <PermissionGuard module="audit" action="read">
              <UnifiedLogsPage />
            </PermissionGuard>
          )} />
          <Route path="/app/settings/email" component={() => (
            <Phase2RedirectGuard enabled={isEmailSettingsEnabled()}>
              <PermissionGuard module="communications" action="read">
                <EmailSettingsPage />
              </PermissionGuard>
            </Phase2RedirectGuard>
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

          {/* My Work /app/my/* pages already handled via /app/* catch-all above via Switch */}

          {/* Partner / Monitor (Partner / Manager only via page-guard) */}
          <Route path="/app/case-monitor" component={CaseMonitorPage} />

          {/* Bank Adapters */}
          <Route path="/app/bank-adapters" component={BankAdaptersPage} />

          {/* HR Full Admin (HRRedirectGuard wraps module.hr) */}
          <Route path="/app/hr/dashboard" component={() => <HRRedirectGuard><PermissionGuard module="hr" action="read" mode="silent"><HrDashboard /></PermissionGuard></HRRedirectGuard>} />
          <Route path="/app/hr/employees" component={() => <HRRedirectGuard><PermissionGuard module="hr" action="read" mode="silent"><HrEmployees /></PermissionGuard></HRRedirectGuard>} />
          <Route path="/app/hr/attendance" component={() => <HRRedirectGuard><HrAttendance /></HRRedirectGuard>} />
          <Route path="/app/hr/leave" component={() => <HRRedirectGuard><HrLeave /></HRRedirectGuard>} />
          <Route path="/app/hr/claims" component={() => <HRRedirectGuard><HrClaims /></HRRedirectGuard>} />
          <Route path="/app/hr/payroll" component={() => <HRRedirectGuard><HrPayroll /></HRRedirectGuard>} />
          <Route path="/app/hr/recruitment" component={() => <HRRedirectGuard><HrRecruitment /></HRRedirectGuard>} />
          <Route path="/app/hr/performance" component={() => <HRRedirectGuard><HrPerformance /></HRRedirectGuard>} />
          <Route path="/app/hr/training" component={() => <HRRedirectGuard><HrTraining /></HRRedirectGuard>} />
          <Route path="/app/hr/assets" component={() => <HRRedirectGuard><HrAssets /></HRRedirectGuard>} />
          <Route path="/app/hr/documents" component={() => <HRRedirectGuard><HrDocuments /></HRRedirectGuard>} />
          <Route path="/app/hr/onboarding" component={() => <HRRedirectGuard><HrOnboarding /></HRRedirectGuard>} />
          <Route path="/app/hr/offboarding" component={() => <HRRedirectGuard><HrOffboarding /></HRRedirectGuard>} />
          <Route path="/app/hr/departments" component={() => <HRRedirectGuard><HrDepartments /></HRRedirectGuard>} />
          <Route path="/app/hr/positions" component={() => <HRRedirectGuard><HrPositions /></HRRedirectGuard>} />
          <Route path="/app/hr/reports" component={() => <HRRedirectGuard><HrReports /></HRRedirectGuard>} />
          <Route path="/app/hr/settings" component={() => <HRRedirectGuard><HrSettings /></HRRedirectGuard>} />
          <Route path="/app/hr" component={() => <Redirect to="/app/hr/dashboard" />} />

          {/* Self Service My Work */}
          <Route path="/app/my/dashboard" component={() => <PermissionGuard module="dashboard" action="read" mode="silent"><MyDashboard /></PermissionGuard>} />
          <Route path="/app/my/leave" component={MyLeave} />
          <Route path="/app/my/claims" component={MyClaims} />
          <Route path="/app/my/payslips" component={MyPayslips} />
          <Route path="/app/my/profile" component={MyProfile} />
          <Route path="/app/my/attendance" component={MyAttendance} />
          <Route path="/app/my/documents" component={MyDocuments} />
          <Route path="/app/my/requests" component={MyRequests} />
          <Route path="/app/my" component={() => <Redirect to="/app/my/dashboard" />} />
          
          <Route path="/app/*" component={NotFound} />
        </Switch>
      </AppLayout>
    </AuthGuard>
  );
}

function DeveloperRoutes() {
  return (
    <AuthGuard requireRole="firm_user">
      <DeveloperGuard>
        <DeveloperLayout>
          <Switch>
            <Route path="/developer/dashboard" component={DeveloperDashboardPage} />
            <Route path="/developer/inventory" component={() => <Redirect to="/developer/dashboard" />} />
            <Route path="/developer" component={() => <Redirect to="/developer/dashboard" />} />
            <Route path="/developer/*" component={NotFound} />
          </Switch>
        </DeveloperLayout>
      </DeveloperGuard>
    </AuthGuard>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/track/:token" component={TrackingTokenPage} />
      <Route path="/" component={() => <Redirect to="/auth/login" />} />
      <Route path="/auth/login" component={Login} />
      
      <Route path="/platform" component={() => <Redirect to="/platform/dashboard" />} />
      <Route path="/platform/*" component={PlatformRoutes} />
      
      <Route path="/developer" component={() => <Redirect to="/developer/dashboard" />} />
      <Route path="/developer/*" component={DeveloperRoutes} />

      <Route path="/app" component={() => <Redirect to="/app/my-work" />} />
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
