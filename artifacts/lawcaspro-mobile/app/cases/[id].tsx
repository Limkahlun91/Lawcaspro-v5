import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { apiFetch } from "@/lib/api";
import { useColors } from "@/hooks/useColors";

interface CaseDetail {
  id: number;
  referenceNo: string;
  projectName: string;
  developerName: string;
  purchaseMode: string;
  titleType: string;
  spaPrice: number | null;
  status: string;
  createdAt: string;
  purchasers: Array<{
    id: number;
    clientName: string;
    icNo: string | null;
    role: string;
  }>;
  assignments: Array<{
    id: number;
    userName: string;
    roleInCase: string;
  }>;
}

interface WorkflowStep {
  id: number;
  stepName: string;
  stepOrder: number;
  status: string;
  completedByName: string | null;
  completedAt: string | null;
  notes: string | null;
}

interface BillingEntry {
  id: number;
  description: string;
  amount: number;
  is_paid: boolean;
  created_at: string;
}

interface CommEntry {
  id: number;
  type: string;
  direction: string;
  subject: string | null;
  notes: string | null;
  sent_at: string | null;
  created_at: string;
}

function fmt(val: number) {
  return `RM ${val.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const TABS = ["Overview", "Workflow", "Billing", "Comms", "Tasks"] as const;
type Tab = typeof TABS[number];

interface CaseTask {
  id: number;
  title: string;
  dueDate: string | null;
  priority: string;
  status: string;
  description: string | null;
}

const TYPE_ICON: Record<string, keyof typeof Feather.glyphMap> = {
  email: "mail", letter: "file-text", call: "phone",
  sms: "message-square", whatsapp: "message-circle", meeting: "users", note: "edit-3",
};

const STATUS_LABEL: Record<string, string> = {
  sub_sale: "Sub Sale",
  primary_market: "Primary Market",
  individual: "Individual",
  master: "Master",
  strata: "Strata",
};

function humanize(s: string) {
  return STATUS_LABEL[s] ?? s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function CaseDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [activeTab, setActiveTab] = useState<Tab>("Overview");

  const { data: caseData, isLoading: loadingCase } = useQuery<CaseDetail>({
    queryKey: ["case", id],
    queryFn: () => apiFetch<CaseDetail>(`/cases/${id}`),
    enabled: !!id,
  });

  const { data: workflow = [] } = useQuery<WorkflowStep[]>({
    queryKey: ["case-workflow", id],
    queryFn: () => apiFetch<WorkflowStep[]>(`/cases/${id}/workflow`),
    enabled: !!id,
  });

  const { data: billing = [] } = useQuery<BillingEntry[]>({
    queryKey: ["case-billing", id],
    queryFn: () => apiFetch<BillingEntry[]>(`/cases/${id}/billing`),
    enabled: !!id,
  });

  const { data: comms = [] } = useQuery<CommEntry[]>({
    queryKey: ["case-comms", id],
    queryFn: () => apiFetch<CommEntry[]>(`/cases/${id}/communications`),
    enabled: !!id,
  });

  const { data: caseTasks = [] } = useQuery<CaseTask[]>({
    queryKey: ["case-tasks-mobile", id],
    queryFn: () => apiFetch<CaseTask[]>(`/case-tasks?caseId=${id}`),
    enabled: !!id,
  });

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 34 : insets.bottom + 16;

  if (loadingCase) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (!caseData) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.mutedForeground }}>Case not found</Text>
      </View>
    );
  }

  const c = caseData;
  const lawyer = c.assignments.find((a) => a.roleInCase === "lawyer");
  const buyers = c.purchasers.filter((p) => p.role === "buyer");
  const sellers = c.purchasers.filter((p) => p.role === "seller");

  const renderOverview = () => (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottomPad + 16 }} showsVerticalScrollIndicator={false}>
      <View style={[styles.statusBanner, { backgroundColor: colors.amber + "20", borderColor: colors.amber + "40" }]}>
        <Text style={[styles.statusBannerLabel, { color: colors.mutedForeground }]}>Current Status</Text>
        <Text style={[styles.statusBannerValue, { color: colors.amber }]}>{humanize(c.status)}</Text>
      </View>

      {[
        { label: "Project", value: c.projectName, icon: "home" as const },
        { label: "Developer", value: c.developerName, icon: "briefcase" as const },
        c.spaPrice != null && { label: "SPA Price", value: fmt(c.spaPrice), icon: "dollar-sign" as const },
        { label: "Purchase Mode", value: humanize(c.purchaseMode), icon: "shopping-bag" as const },
        { label: "Title Type", value: humanize(c.titleType), icon: "file-text" as const },
        lawyer && { label: "Assigned Lawyer", value: lawyer.userName, icon: "user-check" as const },
        buyers.length > 0 && { label: buyers.length === 1 ? "Buyer" : "Buyers", value: buyers.map((b) => b.clientName).join(", "), icon: "user" as const },
        sellers.length > 0 && { label: sellers.length === 1 ? "Seller" : "Sellers", value: sellers.map((s) => s.clientName).join(", "), icon: "user" as const },
        { label: "Opened", value: new Date(c.createdAt).toLocaleDateString("en-MY"), icon: "calendar" as const },
      ].filter(Boolean).map((item) => {
        if (!item) return null;
        return (
          <View key={item.label} style={[styles.detailRow, { borderBottomColor: colors.border }]}>
            <View style={[styles.detailIcon, { backgroundColor: colors.muted }]}>
              <Feather name={item.icon} size={13} color={colors.mutedForeground} />
            </View>
            <View style={styles.detailText}>
              <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>{item.label}</Text>
              <Text style={[styles.detailValue, { color: colors.foreground }]}>{item.value}</Text>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );

  const renderWorkflow = () => (
    <FlatList
      data={workflow}
      keyExtractor={(s) => String(s.id)}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottomPad + 16 }}
      showsVerticalScrollIndicator={false}
      ListEmptyComponent={
        <View style={styles.emptyBox}>
          <Feather name="activity" size={28} color={colors.mutedForeground} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No workflow steps</Text>
        </View>
      }
      renderItem={({ item: step, index }) => {
        const isDone = step.status === "completed";
        const isActive = step.status === "in_progress";
        const stepColor = isDone ? "#22c55e" : isActive ? colors.amber : colors.mutedForeground;
        return (
          <View style={styles.stepRow}>
            <View style={styles.stepLine}>
              <View style={[styles.stepDot, { backgroundColor: stepColor, borderColor: stepColor + "40" }]} />
              {index < workflow.length - 1 && (
                <View style={[styles.stepConnector, { backgroundColor: isDone ? "#22c55e40" : colors.border }]} />
              )}
            </View>
            <View style={[styles.stepCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.stepTop}>
                <Text style={[styles.stepName, { color: colors.foreground }]}>{step.stepName}</Text>
                <View style={[styles.stepBadge, { backgroundColor: stepColor + "20" }]}>
                  <Text style={[styles.stepBadgeText, { color: stepColor }]}>
                    {isDone ? "Done" : isActive ? "Active" : "Pending"}
                  </Text>
                </View>
              </View>
              {step.completedAt && (
                <Text style={[styles.stepDate, { color: colors.mutedForeground }]}>
                  {new Date(step.completedAt).toLocaleDateString("en-MY")}
                  {step.completedByName ? ` · ${step.completedByName}` : ""}
                </Text>
              )}
              {step.notes && (
                <Text style={[styles.stepNotes, { color: colors.mutedForeground }]}>{step.notes}</Text>
              )}
            </View>
          </View>
        );
      }}
    />
  );

  const renderBilling = () => (
    <FlatList
      data={billing}
      keyExtractor={(e) => String(e.id)}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottomPad + 16 }}
      showsVerticalScrollIndicator={false}
      ListEmptyComponent={
        <View style={styles.emptyBox}>
          <Feather name="dollar-sign" size={28} color={colors.mutedForeground} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No billing entries</Text>
        </View>
      }
      renderItem={({ item: e }) => (
        <View style={[styles.billingCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.billingDesc, { color: colors.foreground }]}>{e.description}</Text>
            <Text style={[styles.billingDate, { color: colors.mutedForeground }]}>
              {new Date(e.created_at).toLocaleDateString("en-MY")}
            </Text>
          </View>
          <View style={styles.billingRight}>
            <Text style={[styles.billingAmount, { color: colors.foreground }]}>{fmt(e.amount)}</Text>
            <View style={[styles.paidChip, { backgroundColor: e.is_paid ? "#22c55e20" : "#ef444420" }]}>
              <Text style={[styles.paidChipText, { color: e.is_paid ? "#22c55e" : "#ef4444" }]}>
                {e.is_paid ? "Paid" : "Unpaid"}
              </Text>
            </View>
          </View>
        </View>
      )}
    />
  );

  const renderComms = () => (
    <FlatList
      data={comms}
      keyExtractor={(e) => String(e.id)}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottomPad + 16 }}
      showsVerticalScrollIndicator={false}
      ListEmptyComponent={
        <View style={styles.emptyBox}>
          <Feather name="message-square" size={28} color={colors.mutedForeground} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No communications</Text>
        </View>
      }
      renderItem={({ item: e }) => {
        const icon = TYPE_ICON[e.type] ?? "message-square";
        return (
          <View style={[styles.commCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.commIcon, { backgroundColor: colors.muted }]}>
              <Feather name={icon} size={15} color={colors.mutedForeground} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.commSubject, { color: colors.foreground }]} numberOfLines={1}>{e.subject ?? e.type}</Text>
              {e.notes && (
                <Text style={[styles.commBody, { color: colors.mutedForeground }]} numberOfLines={2}>{e.notes}</Text>
              )}
              <Text style={[styles.commDate, { color: colors.mutedForeground }]}>
                {new Date(e.sent_at ?? e.created_at).toLocaleDateString("en-MY")} · {e.type} · {e.direction}
              </Text>
            </View>
          </View>
        );
      }}
    />
  );

  return (
    <View style={[styles.flex, { backgroundColor: colors.background }]}>
      <View style={[styles.topBar, { paddingTop: topPad + 8, backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>
        <View style={styles.titleArea}>
          <Text style={[styles.caseRef, { color: colors.amber }]}>{c.referenceNo}</Text>
          <Text style={[styles.caseProject, { color: colors.foreground }]} numberOfLines={1}>{c.projectName}</Text>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.tabBar, { borderBottomColor: colors.border, backgroundColor: colors.background }]}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 4 }}
      >
        {TABS.map((tab) => (
          <Pressable
            key={tab}
            onPress={() => setActiveTab(tab)}
            style={[
              styles.tabBtn,
              activeTab === tab && { borderBottomColor: colors.amber },
            ]}
          >
            <Text
              style={[
                styles.tabText,
                { color: activeTab === tab ? colors.amber : colors.mutedForeground },
                activeTab === tab && styles.tabTextActive,
              ]}
            >
              {tab}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={styles.flex}>
        {activeTab === "Overview" && renderOverview()}
        {activeTab === "Workflow" && renderWorkflow()}
        {activeTab === "Billing" && renderBilling()}
        {activeTab === "Comms" && renderComms()}
        {activeTab === "Tasks" && (() => {
          const today = new Date().toISOString().slice(0, 10);
          const PRIORITY_COLOR: Record<string, string> = { urgent: "#ef4444", high: "#f59e0b", normal: "#3b82f6", low: "#94a3b8" };
          return (
            <FlatList
              data={caseTasks}
              keyExtractor={(t) => String(t.id)}
              contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: bottomPad + 16 }}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                <View style={styles.emptyBox}>
                  <Feather name="check-square" size={28} color={colors.mutedForeground} />
                  <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No tasks for this matter</Text>
                </View>
              }
              renderItem={({ item: t }) => {
                const overdue = t.dueDate && t.dueDate < today && t.status !== "done";
                const pc = PRIORITY_COLOR[t.priority] ?? colors.mutedForeground;
                return (
                  <View style={[styles.commCard, { backgroundColor: overdue ? "#fff5f5" : colors.card, borderColor: overdue ? "#fca5a5" : colors.border }]}>
                    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pc, marginTop: 5 }} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: t.status === "done" ? colors.mutedForeground : colors.foreground }}>{t.title}</Text>
                        {t.description && <Text style={{ fontSize: 12, color: colors.mutedForeground, marginTop: 2 }}>{t.description}</Text>}
                        {t.dueDate && <Text style={{ fontSize: 11, color: overdue ? "#ef4444" : colors.mutedForeground, marginTop: 4 }}>{overdue ? "Overdue · " : "Due "}{t.dueDate}</Text>}
                      </View>
                      {t.status === "done" && <Feather name="check-circle" size={16} color="#22c55e" />}
                    </View>
                  </View>
                );
              }}
            />
          );
        })()}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  topBar: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingBottom: 12,
    borderBottomWidth: 1,
  },
  backBtn: { padding: 4, marginRight: 12 },
  titleArea: { flex: 1 },
  caseRef: { fontSize: 12, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5 },
  caseProject: { fontSize: 16, fontFamily: "Inter_600SemiBold", marginTop: 2 },
  tabBar: { borderBottomWidth: 1, flexGrow: 0, flexShrink: 0 },
  tabBtn: {
    paddingVertical: 10, paddingHorizontal: 12,
    borderBottomWidth: 2, borderBottomColor: "transparent",
  },
  tabText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  tabTextActive: { fontFamily: "Inter_600SemiBold" },
  statusBanner: {
    borderRadius: 10, borderWidth: 1,
    padding: 14, marginTop: 16, marginBottom: 8,
  },
  statusBannerLabel: { fontSize: 11, fontFamily: "Inter_500Medium", marginBottom: 4 },
  statusBannerValue: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  detailRow: {
    flexDirection: "row", alignItems: "flex-start",
    paddingVertical: 12, borderBottomWidth: 1, gap: 12,
  },
  detailIcon: {
    width: 30, height: 30, borderRadius: 7,
    alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  detailText: { flex: 1 },
  detailLabel: { fontSize: 11, fontFamily: "Inter_500Medium", marginBottom: 2 },
  detailValue: { fontSize: 14, fontFamily: "Inter_400Regular" },
  emptyBox: { alignItems: "center", marginTop: 60, gap: 8 },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  stepRow: { flexDirection: "row", marginBottom: 0 },
  stepLine: { width: 32, alignItems: "center", paddingTop: 16 },
  stepDot: {
    width: 12, height: 12, borderRadius: 6,
    borderWidth: 2, zIndex: 1,
  },
  stepConnector: { width: 2, flex: 1, marginTop: 4, minHeight: 20 },
  stepCard: {
    flex: 1, borderRadius: 10, borderWidth: 1,
    padding: 12, marginLeft: 8, marginBottom: 8, marginTop: 8,
  },
  stepTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  stepName: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1 },
  stepBadge: { borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 },
  stepBadgeText: { fontSize: 10, fontFamily: "Inter_600SemiBold" },
  stepDate: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 4 },
  stepNotes: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 4, lineHeight: 18 },
  billingCard: {
    flexDirection: "row", alignItems: "center",
    borderRadius: 10, borderWidth: 1, padding: 14, marginBottom: 8, gap: 12,
  },
  billingDesc: { fontSize: 13, fontFamily: "Inter_400Regular", marginBottom: 4 },
  billingDate: { fontSize: 11, fontFamily: "Inter_400Regular" },
  billingRight: { alignItems: "flex-end", gap: 4 },
  billingAmount: { fontSize: 14, fontFamily: "Inter_700Bold", letterSpacing: -0.3 },
  paidChip: { borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 },
  paidChipText: { fontSize: 10, fontFamily: "Inter_600SemiBold" },
  commCard: {
    flexDirection: "row", alignItems: "flex-start",
    borderRadius: 10, borderWidth: 1, padding: 14, marginBottom: 8, gap: 10,
  },
  commIcon: {
    width: 34, height: 34, borderRadius: 8,
    alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  commSubject: { fontSize: 13, fontFamily: "Inter_600SemiBold", marginBottom: 4 },
  commBody: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 18, marginBottom: 4 },
  commDate: { fontSize: 11, fontFamily: "Inter_400Regular" },
});
