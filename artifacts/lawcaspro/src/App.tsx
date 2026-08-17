import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppRuntimeErrorBoundary } from "@/components/app-runtime-error-boundary";
import { getHttpStatus, isAbortError, isRequestTimeoutError } from "@/lib/error-message";
import { AuthProvider, useAuth } from "@/lib/auth-context";
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
import { isWhatsAppInboxEnabled, PHASE2_NOTICE, isHRModuleEnabled, HR_DISABLED_NOTICE } from "@/lib/feature-flags";
import {
  FeatureGuard,
  UserFeatureGuard,
  UserFeatureNotEnabledPage,
  FeatureNotEnabledPage,
  RouteFeatureAccessGuard,
} from "@/lib/feature-guards";
import { Card, CardContent } from "@/components/ui/card";
import { useEffect, lazy, Suspense, type ReactNode } from "react";
import { useToast } from "@/hooks/use-toast";

import Login from "@/pages/auth/login";
import NotFound from "@/pages/not-found";
import TrackingTokenPage from "@/pages/public/track/[token]";

function PageLoading() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center bg-slate-50 p-6">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6 pb-5 text-center">
          <div className="w-10 h-10 mx-auto mb-3 rounded-full border-4 border-amber-500 border-t-transparent animate-spin"></div>
          <div className="text-sm font-medium text-slate-700">Loading…</div>
        </CardContent>
      </Card>
    </div>
  );
}

// Platform Pages — keep core landing pages static, lazy-load heavy operational pages
import PlatformDashboard from "@/pages/platform/dashboard";
import FirmsList from "@/pages/platform/firms";
import NewFirm from "@/pages/platform/firms/new";
import FirmDetail from "@/pages/platform/firms/detail";
import FirmHistoryDetailPage from "@/pages/platform/firms/history-detail";
const PlatformOperationsOverview = lazy(() => import("@/pages/platform/operations"));
const PlatformOperationsLogs = lazy(() => import("@/pages/platform/operations/logs"));
const PlatformOperationsIncidents = lazy(() => import("@/pages/platform/operations/incidents"));
const PlatformOperationsIncidentDetail = lazy(() => import("@/pages/platform/operations/incident-detail"));
const PlatformOperationsRecommendations = lazy(() => import("@/pages/platform/operations/recommendations"));
const PlatformOperationsReadiness = lazy(() => import("@/pages/platform/operations/readiness"));
const PlatformOperationsPending = lazy(() => import("@/pages/platform/operations/pending"));
const PlatformTemplates = lazy(() => import("@/pages/platform/operations/templates"));
const PlatformMonitoring = lazy(() => import("@/pages/platform/monitoring"));
const PlatformAuditLogs = lazy(() => import("@/pages/platform/audit-logs"));
const PlatformDocuments = lazy(() => import("@/pages/platform/documents"));
const PlatformMessages = lazy(() => import("@/pages/platform/messages"));
const FounderBillingPage = lazy(() => import("@/pages/founder/billing"));
const PlatformSubscriptionPlansPage = lazy(() => import("@/pages/platform/subscription-plans"));
const PlatformVariablesPage = lazy(() => import("@/pages/platform/variables"));
const PlatformCustomVariablesPage = lazy(() => import("@/pages/platform/custom-variables"));

// App Pages — keep core landing static, lazy-load optional/heavy modules
import AppDashboard from "@/pages/app/dashboard";
import CasesList from "@/pages/app/cases";
import NewCase from "@/pages/app/cases/new";
import CaseDetail from "@/pages/app/cases/detail";
import Workbench from "@/pages/app/workbench";
import CaseIntakeInboxPage from "@/pages/app/cases/intake";
const LegacyCaseImportPage = lazy(() => import("@/pages/app/cases/legacy-import"));

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
const AccountingSettingsPage = lazy(() => import("@/pages/app/settings/accounting"));
const EmailSettingsPage = lazy(() => import("@/pages/app/settings/email"));
import Settings from "@/pages/app/settings";
const DocumentsPage = lazy(() => import("@/pages/app/documents"));
const DocumentAutomationHub = lazy(() => import("@/pages/app/documents/automation"));
const DocumentGenerationLogsPage = lazy(() => import("@/pages/app/documents/generation-logs"));
const VariableDictionaryPage = lazy(() => import("@/pages/app/documents/variables"));
const CustomVariablesPage = lazy(() => import("@/pages/app/documents/custom-variables"));
const Accounting = lazy(() => import("@/pages/app/accounting"));
const AccountingFileListing = lazy(() => import("@/pages/app/accounting/file-listing"));
const BankReconciliationPage = lazy(() => import("@/pages/app/accounting/bank-reconciliation"));
const InvoiceDetail = lazy(() => import("@/pages/app/accounting/invoices/detail"));
const ReceiptDetail = lazy(() => import("@/pages/app/accounting/receipts/detail"));
const PaymentVoucherDetail = lazy(() => import("@/pages/app/accounting/payment-vouchers/detail"));
const FileCustodyPage = lazy(() => import("@/pages/app/file-custody"));
const Reports = lazy(() => import("@/pages/app/reports"));
const BillsDeliveredBook = lazy(() => import("@/pages/app/reports/bills-delivered-book"));
const MatterAging = lazy(() => import("@/pages/app/reports/matter-aging"));
const TrustAccountStatement = lazy(() => import("@/pages/app/reports/trust-account-statement"));
const ProjectStatusReport = lazy(() => import("@/pages/app/reports/project-status"));
const Hub = lazy(() => import("@/pages/app/hub"));
const Communications = lazy(() => import("@/pages/app/communications"));
const CommunicationThreadDetail = lazy(() => import("@/pages/app/communications/thread-detail"));
const EmailControlCenterPage = lazy(() => import("@/pages/app/communication/email"));
const WhatsAppInboxPlaceholderPage = lazy(() => import("@/pages/app/communication/whatsapp"));
import QuotationsList from "@/pages/app/quotations";
import NewQuotation from "@/pages/app/quotations/new";
import QuotationDetail from "@/pages/app/quotations/detail";

// Partner / Monitor — lazy-load optional integrations
const CaseMonitorPage = lazy(() => import("@/pages/app/case-monitor"));
const BankAdaptersPage = lazy(() => import("@/pages/app/bank-adapters"));

// HR Full pages — ALL lazy (optional module with guards)
const HrDashboard = lazy(() => import("@/pages/app/hr/dashboard"));
const HrEmployees = lazy(() => import("@/pages/app/hr/employees"));
const HrAttendance = lazy(() => import("@/pages/app/hr/attendance"));
const HrLeave = lazy(() => import("@/pages/app/hr/leave"));
const HrClaims = lazy(() => import("@/pages/app/hr/claims"));
const HrPayroll = lazy(() => import("@/pages/app/hr/payroll"));
const HrRecruitment = lazy(() => import("@/pages/app/hr/recruitment"));
const HrPerformance = lazy(() => import("@/pages/app/hr/performance"));
const HrTraining = lazy(() => import("@/pages/app/hr/training"));
const HrAssets = lazy(() => import("@/pages/app/hr/assets"));
const HrDocuments = lazy(() => import("@/pages/app/hr/documents"));
const HrOnboarding = lazy(() => import("@/pages/app/hr/onboarding"));
const HrOffboarding = lazy(() => import("@/pages/app/hr/offboarding"));
const HrDepartments = lazy(() => import("@/pages/app/hr/departments"));
const HrPositions = lazy(() => import("@/pages/app/hr/positions"));
const HrReports = lazy(() => import("@/pages/app/hr/reports"));
const HrSettings = lazy(() => import("@/pages/app/hr/settings"));
const HimsTrackerIndex = lazy(() => import("@/pages/app/hims"));

// My Work / Self Service — keep static (core user landing)
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
  return (
    <div className="min-h-[60vh] flex items-center justify-center bg-slate-50 p-6">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6 pb-5 text-center">
          <div className="w-10 h-10 mx-auto mb-3 rounded-full border-4 border-amber-500 border-t-transparent animate-spin"></div>
          <div className="text-sm font-medium text-slate-700">Redirecting…</div>
          <div className="text-xs text-slate-500 mt-1">{notice}</div>
        </CardContent>
      </Card>
    </div>
  );
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
        <Suspense fallback={<PageLoading />}>
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
        </Suspense>
      </PlatformLayout>
    </AuthGuard>
  );
}

function AppRoutes() {
  return (
    <AuthGuard requireRole="firm_user">
      <AppLayout>
        <GlobalCaseSearch />
        <Suspense fallback={<PageLoading />}>
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
          <Route path="/app/cases/import" component={() => (
            <FeatureGuard feature="cases.legacy_import" hideDisabled={false}>
              <PermissionGuard module="cases" action="create">
                <LegacyCaseImportPage />
              </PermissionGuard>
            </FeatureGuard>
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
          
          <Route path="/app/clients/new" component={() => (
            <PermissionGuard module="contacts" action="read">
              <NewClient />
            </PermissionGuard>
          )} />
          <Route path="/app/clients/:id" component={() => (
            <PermissionGuard module="contacts" action="read">
              <ClientDetail />
            </PermissionGuard>
          )} />
          <Route path="/app/clients" component={() => (
            <PermissionGuard module="contacts" action="read">
              <ClientsList />
            </PermissionGuard>
          )} />
          
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
            <FeatureGuard feature="module.communications" allOf={["communications.email"]} hideDisabled={false}>
              <PermissionGuard module="communications" action="read">
                <EmailControlCenterPage />
              </PermissionGuard>
            </FeatureGuard>
          )} />
          <Route path="/app/communication/whatsapp" component={() => (
            <Phase2RedirectGuard enabled={isWhatsAppInboxEnabled()}>
              <PermissionGuard module="communications" action="read">
                <WhatsAppInboxPlaceholderPage />
              </PermissionGuard>
            </Phase2RedirectGuard>
          )} />

          <Route path="/app/quotations/new" component={() => (
            <UserFeatureGuard feature="accounting.quotation" hideDisabled={false} fallback={<UserFeatureNotEnabledPage featureKey="accounting.quotation" />}>
              <PermissionGuard module="accounting" action="write">
                <NewQuotation />
              </PermissionGuard>
            </UserFeatureGuard>
          )} />
          <Route path="/app/quotations/:id" component={() => (
            <UserFeatureGuard feature="accounting.quotation" hideDisabled={false} fallback={<UserFeatureNotEnabledPage featureKey="accounting.quotation" />}>
              <PermissionGuard module="accounting" action="read">
                <QuotationDetail />
              </PermissionGuard>
            </UserFeatureGuard>
          )} />
          <Route path="/app/quotations" component={() => (
            <UserFeatureGuard feature="accounting.quotation" hideDisabled={false} fallback={<UserFeatureNotEnabledPage featureKey="accounting.quotation" />}>
              <PermissionGuard module="accounting" action="read">
                <QuotationsList />
              </PermissionGuard>
            </UserFeatureGuard>
          )} />
          
          <Route path="/app/settings/documents" component={() => <Redirect to="/app/documents" />} />
          <Route path="/app/documents/automation" component={() => (
            <UserFeatureGuard feature="documents.hub" hideDisabled={false} fallback={<UserFeatureNotEnabledPage featureKey="documents.hub" />}>
              <PermissionGuard module="documents" action="read">
                <DocumentAutomationHub />
              </PermissionGuard>
            </UserFeatureGuard>
          )} />
          <Route path="/app/documents/variables" component={() => (
            <UserFeatureGuard feature="documents.variables" hideDisabled={false} fallback={<UserFeatureNotEnabledPage featureKey="documents.variables" />}>
              <PermissionGuard module="documents" action="read">
                <VariableDictionaryPage />
              </PermissionGuard>
            </UserFeatureGuard>
          )} />
          <Route path="/app/documents/custom-variables" component={() => <Redirect to="/app/documents/variables#custom" />} />
          <Route path="/app/documents" component={() => (
            <UserFeatureGuard feature="documents.hub" hideDisabled={false} fallback={<UserFeatureNotEnabledPage featureKey="documents.hub" />}>
              <PermissionGuard module="documents" action="read">
                <DocumentsPage />
              </PermissionGuard>
            </UserFeatureGuard>
          )} />
          <Route path="/app/accounting/invoices/:id" component={() => (
            <UserFeatureGuard feature="accounting.invoice" hideDisabled={false} fallback={<UserFeatureNotEnabledPage featureKey="accounting.invoice" />}>
              <PermissionGuard module="accounting" action="read">
                <InvoiceDetail />
              </PermissionGuard>
            </UserFeatureGuard>
          )} />
          <Route path="/app/accounting/receipts/:id" component={() => (
            <UserFeatureGuard feature="accounting.receipt" hideDisabled={false} fallback={<UserFeatureNotEnabledPage featureKey="accounting.receipt" />}>
              <PermissionGuard module="accounting" action="read">
                <ReceiptDetail />
              </PermissionGuard>
            </UserFeatureGuard>
          )} />
          <Route path="/app/accounting/payment-vouchers/:id" component={() => (
            <UserFeatureGuard feature="accounting.payment_voucher" hideDisabled={false} fallback={<UserFeatureNotEnabledPage featureKey="accounting.payment_voucher" />}>
              <PermissionGuard module="accounting" action="read">
                <PaymentVoucherDetail />
              </PermissionGuard>
            </UserFeatureGuard>
          )} />
          <Route path="/app/accounting/bank-reconciliation" component={() => (
            <UserFeatureGuard feature="accounting.bank_reconciliation" hideDisabled={false} fallback={<UserFeatureNotEnabledPage featureKey="accounting.bank_reconciliation" />}>
              <PermissionGuard module="accounting" action="read">
                <BankReconciliationPage />
              </PermissionGuard>
            </UserFeatureGuard>
          )} />
          <Route path="/app/accounting/file-listing" component={() => (
            <UserFeatureGuard feature="accounting.file_listing" hideDisabled={false} fallback={<UserFeatureNotEnabledPage featureKey="accounting.file_listing" />}>
              <PermissionGuard module="accounting" action="read">
                <AccountingFileListing />
              </PermissionGuard>
            </UserFeatureGuard>
          )} />
          <Route path="/app/accounting" component={() => (
            <UserFeatureGuard feature="accounting.dashboard" hideDisabled={false} fallback={<UserFeatureNotEnabledPage featureKey="accounting.dashboard" />}>
              <PermissionGuard module="accounting" action="read">
                <Accounting />
              </PermissionGuard>
            </UserFeatureGuard>
          )} />
          <Route path="/app/file-custody" component={() => (
            <FeatureGuard feature="storage.file_custody" hideDisabled={false}>
              <PermissionGuard module="file_custody" action="view">
                <FileCustodyPage />
              </PermissionGuard>
            </FeatureGuard>
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
              <Redirect to="/app/accounting?tab=settings" />
            </PermissionGuard>
          )} />
          <Route path="/app/settings/logs" component={() => (
            <PermissionGuard module="audit" action="read">
              <Redirect to="/app/settings?tab=logs" />
            </PermissionGuard>
          )} />
          <Route path="/app/settings/email" component={() => (
            <FeatureGuard feature="module.communications" allOf={["communications.email", "communications.email.settings"]} hideDisabled={false}>
              <PermissionGuard module="communications" action="read">
                <Redirect to="/app/settings?tab=email" />
              </PermissionGuard>
            </FeatureGuard>
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

          <Route path="/app/hr/dashboard" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.dashboard"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.dashboard"><PermissionGuard module="hr" action="read"><HrDashboard /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/employees" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.employees"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.employees"><PermissionGuard module="hr" action="read"><HrEmployees /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/attendance" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.attendance"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.attendance"><PermissionGuard module="hr" action="read"><HrAttendance /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/leave" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.leave"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.leave"><PermissionGuard module="hr" action="read"><HrLeave /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/claims" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.claims"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.claims"><PermissionGuard module="hr" action="read"><HrClaims /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/payroll" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.payroll"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.payroll"><PermissionGuard module="hr" action="read"><HrPayroll /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/recruitment" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.recruitment"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.recruitment"><PermissionGuard module="hr" action="read"><HrRecruitment /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/performance" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.performance"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.performance"><PermissionGuard module="hr" action="read"><HrPerformance /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/training" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.training"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.training"><PermissionGuard module="hr" action="read"><HrTraining /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/assets" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.assets"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.assets"><PermissionGuard module="hr" action="read"><HrAssets /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/documents" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.documents"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.documents"><PermissionGuard module="hr" action="read"><HrDocuments /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/onboarding" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.onboarding"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.onboarding"><PermissionGuard module="hr" action="read"><HrOnboarding /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/offboarding" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.offboarding"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.offboarding"><PermissionGuard module="hr" action="read"><HrOffboarding /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/departments" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.departments"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.departments"><PermissionGuard module="hr" action="read"><HrDepartments /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/positions" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.positions"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.positions"><PermissionGuard module="hr" action="read"><HrPositions /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/reports" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.reports"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.reports"><PermissionGuard module="hr" action="read"><HrReports /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr/settings" component={() => <UserFeatureGuard feature="module.hr" allOf={["hr.settings"]} hideDisabled={false} fallback={<FeatureNotEnabledPage featureKey="module.hr" />}><RouteFeatureAccessGuard feature="hr.settings"><PermissionGuard module="hr" action="write"><HrSettings /></PermissionGuard></RouteFeatureAccessGuard></UserFeatureGuard>} />
          <Route path="/app/hr" component={() => <Redirect to="/app/hr/dashboard" />} />

          <Route path="/app/hims" component={() => (
            <RouteFeatureAccessGuard feature="hims.tracker" permission={{ module: "cases", action: "read" }}>
              <HimsTrackerIndex />
            </RouteFeatureAccessGuard>
          )} />

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
        </Suspense>
      </AppLayout>
    </AuthGuard>
  );
}

function DeveloperRoutes() {
  return (
    <AuthGuard requireRole="firm_user">
      <DeveloperGuard>
        <DeveloperLayout>
          <Suspense fallback={<PageLoading />}>
            <Switch>
              <Route path="/developer/dashboard" component={DeveloperDashboardPage} />
              <Route path="/developer/inventory" component={() => <Redirect to="/developer/dashboard" />} />
              <Route path="/developer" component={() => <Redirect to="/developer/dashboard" />} />
              <Route path="/developer/*" component={NotFound} />
            </Switch>
          </Suspense>
        </DeveloperLayout>
      </DeveloperGuard>
    </AuthGuard>
  );
}

function AppRootLanding() {
  const { user, isLoading, authStatus } = useAuth();
  const [, setLocation] = useLocation();
  useEffect(() => {
    if (isLoading) return;
    if (authStatus !== "authenticated" || !user) {
      setLocation("/auth/login", { replace: true });
      return;
    }
    if (user.userType === "founder") {
      setLocation("/platform/dashboard", { replace: true });
      return;
    }
    if (user.userType === "firm_user") {
      const roleName = String((user as any)?.roleName ?? "").toLowerCase();
      const isManagement = roleName.includes("partner") || roleName.includes("manager");
      if (isManagement) {
        setLocation("/app/dashboard", { replace: true });
      } else {
        setLocation("/app/my-work", { replace: true });
      }
      return;
    }
    setLocation("/auth/login", { replace: true });
  }, [user, isLoading, authStatus, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="w-10 h-10 rounded-full border-4 border-amber-500 border-t-transparent animate-spin"></div>
      </div>
    );
  }
  if (authStatus !== "authenticated" || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 pb-5 text-center">
            <div className="w-10 h-10 mx-auto mb-3 rounded-full border-4 border-amber-500 border-t-transparent animate-spin"></div>
            <div className="text-sm font-medium text-slate-700">Session expired</div>
            <div className="text-xs text-slate-500 mt-1">Redirecting to login…</div>
          </CardContent>
        </Card>
      </div>
    );
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6 pb-5 text-center">
          <div className="w-10 h-10 mx-auto mb-3 rounded-full border-4 border-amber-500 border-t-transparent animate-spin"></div>
          <div className="text-sm font-medium text-slate-700">Loading workspace…</div>
        </CardContent>
      </Card>
    </div>
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

      <Route path="/app" component={AppRootLanding} />
      <Route path="/app/*" component={AppRoutes} />
      
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <AppRuntimeErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ReAuthProvider>
            <TooltipProvider>
              <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                <Router />
                <Toaster />
              </WouterRouter>
            </TooltipProvider>
          </ReAuthProvider>
        </AuthProvider>
      </QueryClientProvider>
    </AppRuntimeErrorBoundary>
  );
}

export default App;
