import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/api";
import { useColors } from "@/hooks/useColors";

interface DashboardData {
  totalCases: number;
  activeCases: number;
  completedCases: number;
  totalClients: number;
  totalProjects: number;
  totalDevelopers: number;
  cashCases: number;
  loanCases: number;
  commsThisMonth: number;
  billing: { totalBilled: number; totalOutstanding: number };
  recentCases: Array<{
    id: number;
    referenceNo: string;
    projectName: string;
    status: string;
    assignedLawyerName: string | null;
  }>;
}

interface Task {
  id: number;
  caseId: number;
  title: string;
  dueDate: string | null;
  priority: string;
  status: string;
}

const STATUS_COLOR: Record<string, string> = {
  Completed: "#22c55e",
  "MOT Registered": "#0d9488",
  "SPA Stamped": "#3b82f6",
};

function fmt(val: number) {
  return `RM ${val.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function DashboardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();

  const { data, isLoading, refetch } = useQuery<DashboardData>({
    queryKey: ["dashboard"],
    queryFn: () => apiFetch<DashboardData>("/dashboard"),
  });

  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ["upcoming-tasks"],
    queryFn: () => apiFetch<Task[]>("/case-tasks/upcoming?limit=5"),
  });

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 84 + 34 : insets.bottom + 84;

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  const stats = data!;

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={{ paddingTop: topPad + 8, paddingBottom: bottomPad, paddingHorizontal: 16 }}
      refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={colors.primary} />}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={[styles.greeting, { color: colors.mutedForeground }]}>Good day,</Text>
          <Text style={[styles.userName, { color: colors.foreground }]}>{user?.name ?? "User"}</Text>
          {user?.firmName && (
            <Text style={[styles.firmName, { color: colors.mutedForeground }]}>{user.firmName}</Text>
          )}
        </View>
        <View style={[styles.logoMark, { backgroundColor: colors.navy }]}>
          <Text style={styles.logoMarkText}>L</Text>
        </View>
      </View>

      <View style={styles.statGrid}>
        {[
          { label: "Total Cases", value: stats.totalCases, sub: `${stats.activeCases} active`, icon: "briefcase" as const, color: colors.amber },
          { label: "Clients", value: stats.totalClients, sub: null, icon: "users" as const, color: "#3b82f6" },
          { label: "Projects", value: stats.totalProjects, sub: null, icon: "home" as const, color: "#22c55e" },
          { label: "Comms / Mo", value: stats.commsThisMonth, sub: null, icon: "message-square" as const, color: "#8b5cf6" },
        ].map((item) => (
          <View key={item.label} style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.statIcon, { backgroundColor: item.color + "20" }]}>
              <Feather name={item.icon} size={18} color={item.color} />
            </View>
            <Text style={[styles.statValue, { color: colors.foreground }]}>{item.value}</Text>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{item.label}</Text>
            {item.sub && <Text style={[styles.statSub, { color: colors.mutedForeground }]}>{item.sub}</Text>}
          </View>
        ))}
      </View>

      <View style={[styles.billingRow]}>
        <View style={[styles.billingCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.billingLabel, { color: colors.mutedForeground }]}>Total Billed</Text>
          <Text style={[styles.billingValue, { color: colors.foreground }]}>{fmt(stats.billing?.totalBilled ?? 0)}</Text>
        </View>
        <View style={[styles.billingCard, { backgroundColor: colors.card, borderColor: colors.border, marginLeft: 12 }]}>
          <Text style={[styles.billingLabel, { color: colors.mutedForeground }]}>Outstanding</Text>
          <Text style={[styles.billingValue, { color: "#ef4444" }]}>{fmt(stats.billing?.totalOutstanding ?? 0)}</Text>
        </View>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent Cases</Text>
        <Pressable onPress={() => router.push("/(tabs)/cases")}>
          <Text style={[styles.seeAll, { color: colors.amber }]}>See all</Text>
        </Pressable>
      </View>

      {(stats.recentCases ?? []).length === 0 ? (
        <View style={[styles.emptyState, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="inbox" size={28} color={colors.mutedForeground} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No cases yet</Text>
        </View>
      ) : (
        stats.recentCases.map((c) => {
          const badgeColor = STATUS_COLOR[c.status] ?? colors.mutedForeground;
          return (
            <Pressable
              key={c.id}
              style={({ pressed }) => [
                styles.caseRow,
                { backgroundColor: colors.card, borderColor: colors.border },
                pressed && { opacity: 0.75 },
              ]}
              onPress={() => router.push({ pathname: "/cases/[id]", params: { id: String(c.id) } })}
            >
              <View style={styles.caseLeft}>
                <Text style={[styles.caseRef, { color: colors.amber }]}>{c.referenceNo}</Text>
                <Text style={[styles.caseProject, { color: colors.foreground }]} numberOfLines={1}>{c.projectName}</Text>
                {c.assignedLawyerName && (
                  <Text style={[styles.caseLawyer, { color: colors.mutedForeground }]}>{c.assignedLawyerName}</Text>
                )}
              </View>
              <View style={[styles.badge, { backgroundColor: badgeColor + "20" }]}>
                <Text style={[styles.badgeText, { color: badgeColor }]} numberOfLines={2}>{c.status}</Text>
              </View>
            </Pressable>
          );
        })
      )}
      {/* Upcoming Tasks */}
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Upcoming Tasks</Text>
        <Pressable onPress={() => router.push("/tasks" as any)}>
          <Text style={[styles.seeAll, { color: colors.amber }]}>See all</Text>
        </Pressable>
      </View>
      {tasks.length === 0 ? (
        <View style={[styles.emptyState, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="check-square" size={24} color={colors.mutedForeground} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No upcoming tasks</Text>
        </View>
      ) : (
        tasks.map((t) => {
          const overdue = t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10);
          const priorityColor = t.priority === "urgent" ? "#ef4444" : t.priority === "high" ? "#f59e0b" : colors.mutedForeground;
          return (
            <Pressable
              key={t.id}
              style={({ pressed }) => [styles.taskRow, { backgroundColor: colors.card, borderColor: overdue ? "#fca5a5" : colors.border }, pressed && { opacity: 0.75 }]}
              onPress={() => router.push({ pathname: "/cases/[id]", params: { id: String(t.caseId) } })}
            >
              <View style={styles.taskLeft}>
                <View style={[styles.taskDot, { backgroundColor: priorityColor }]} />
                <View>
                  <Text style={[styles.taskTitle, { color: colors.foreground }]} numberOfLines={1}>{t.title}</Text>
                  {t.dueDate && (
                    <Text style={[styles.taskDue, { color: overdue ? "#ef4444" : colors.mutedForeground }]}>
                      Due {t.dueDate}{overdue ? " — Overdue" : ""}
                    </Text>
                  )}
                </View>
              </View>
              <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 },
  greeting: { fontSize: 13, fontFamily: "Inter_400Regular" },
  userName: { fontSize: 22, fontFamily: "Inter_700Bold", marginTop: 2, letterSpacing: -0.3 },
  firmName: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  logoMark: {
    width: 40, height: 40, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  logoMarkText: { fontSize: 18, fontFamily: "Inter_700Bold", color: "#f5a623" },
  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 12 },
  statCard: {
    width: "48%", borderRadius: 10, borderWidth: 1,
    padding: 14, gap: 4,
  },
  statIcon: {
    width: 36, height: 36, borderRadius: 8,
    alignItems: "center", justifyContent: "center", marginBottom: 6,
  },
  statValue: { fontSize: 24, fontFamily: "Inter_700Bold", letterSpacing: -0.5 },
  statLabel: { fontSize: 11, fontFamily: "Inter_500Medium" },
  statSub: { fontSize: 10, fontFamily: "Inter_400Regular" },
  billingRow: { flexDirection: "row", marginBottom: 24 },
  billingCard: {
    flex: 1, borderRadius: 10, borderWidth: 1,
    padding: 14,
  },
  billingLabel: { fontSize: 11, fontFamily: "Inter_500Medium", marginBottom: 4 },
  billingValue: { fontSize: 16, fontFamily: "Inter_700Bold", letterSpacing: -0.3 },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  sectionTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  seeAll: { fontSize: 13, fontFamily: "Inter_500Medium" },
  emptyState: {
    borderRadius: 10, borderWidth: 1, padding: 32,
    alignItems: "center", gap: 8,
  },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  caseRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    borderRadius: 10, borderWidth: 1, padding: 14, marginBottom: 8,
  },
  caseLeft: { flex: 1, marginRight: 12 },
  caseRef: { fontSize: 13, fontFamily: "Inter_700Bold", letterSpacing: 0.3 },
  caseProject: { fontSize: 14, fontFamily: "Inter_500Medium", marginTop: 2 },
  caseLawyer: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  badge: {
    borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4,
    maxWidth: 110, alignItems: "center",
  },
  taskRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    borderRadius: 10, borderWidth: 1, padding: 12, marginBottom: 8,
  },
  taskLeft: { flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 10, marginRight: 8 },
  taskDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  taskTitle: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1 },
  taskDue: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  badgeText: { fontSize: 10, fontFamily: "Inter_600SemiBold", textAlign: "center" },
});
