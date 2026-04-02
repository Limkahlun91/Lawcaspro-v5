import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator, FlatList, Platform, Pressable, ScrollView,
  StyleSheet, Text, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { apiFetch } from "@/lib/api";
import { useColors } from "@/hooks/useColors";

interface Task {
  id: number;
  caseId: number;
  title: string;
  description: string | null;
  dueDate: string | null;
  priority: string;
  status: string;
}

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "#ef4444",
  high: "#f59e0b",
  normal: "#3b82f6",
  low: "#94a3b8",
};

export default function TasksScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"open" | "all">("open");

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 84 + 34 : insets.bottom + 84;

  const { data: tasks = [], isLoading, refetch } = useQuery<Task[]>({
    queryKey: ["all-tasks", filter],
    queryFn: () => apiFetch<Task[]>(`/case-tasks${filter === "open" ? "?status=open" : ""}`),
  });

  const markDone = useMutation({
    mutationFn: (id: number) => apiFetch<Task>(`/case-tasks/${id}`, {
      method: "PUT",
      body: JSON.stringify({ status: "done" }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["all-tasks"] });
      qc.invalidateQueries({ queryKey: ["upcoming-tasks"] });
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  const overdueTasks = tasks.filter(t => t.dueDate && t.dueDate < today && t.status !== "done");
  const upcomingTasks = tasks.filter(t => !t.dueDate || t.dueDate >= today);

  function renderTask(t: Task) {
    const overdue = t.dueDate && t.dueDate < today && t.status !== "done";
    const priorityColor = PRIORITY_COLOR[t.priority] ?? colors.mutedForeground;
    return (
      <Pressable
        key={t.id}
        style={({ pressed }) => [
          styles.taskCard,
          { backgroundColor: colors.card, borderColor: overdue ? "#fca5a5" : colors.border },
          overdue && { backgroundColor: "#fff5f5" },
          pressed && { opacity: 0.8 },
        ]}
      >
        <View style={styles.taskHeader}>
          <View style={[styles.priorityDot, { backgroundColor: priorityColor }]} />
          <Text style={[styles.taskTitle, { color: colors.foreground }]} numberOfLines={2}>{t.title}</Text>
          <Pressable
            onPress={() => markDone.mutate(t.id)}
            hitSlop={8}
          >
            <Feather name="check-circle" size={20} color={overdue ? "#ef4444" : colors.mutedForeground} />
          </Pressable>
        </View>
        {t.description && (
          <Text style={[styles.taskDesc, { color: colors.mutedForeground }]} numberOfLines={1}>{t.description}</Text>
        )}
        <View style={styles.taskFooter}>
          {t.dueDate && (
            <View style={styles.metaItem}>
              <Feather name="calendar" size={11} color={overdue ? "#ef4444" : colors.mutedForeground} />
              <Text style={[styles.metaText, { color: overdue ? "#ef4444" : colors.mutedForeground }]}>
                {overdue ? `Overdue · ` : ""}{t.dueDate}
              </Text>
            </View>
          )}
          <Pressable
            style={styles.metaItem}
            onPress={() => router.push({ pathname: "/cases/[id]", params: { id: String(t.caseId) } })}
          >
            <Feather name="briefcase" size={11} color={colors.primary} />
            <Text style={[styles.metaText, { color: colors.primary }]}>Case #{t.caseId}</Text>
          </Pressable>
        </View>
      </Pressable>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={{ paddingTop: topPad + 8, paddingBottom: bottomPad, paddingHorizontal: 16 }}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Tasks</Text>
        <View style={{ width: 32 }} />
      </View>

      {/* Filter */}
      <View style={[styles.filterRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {(["open", "all"] as const).map(f => (
          <Pressable
            key={f}
            style={[styles.filterBtn, filter === f && { backgroundColor: colors.amber }]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.filterText, { color: filter === f ? "#fff" : colors.mutedForeground }]}>
              {f === "open" ? "Open" : "All Tasks"}
            </Text>
          </Pressable>
        ))}
      </View>

      {isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : tasks.length === 0 ? (
        <View style={[styles.emptyState, { borderColor: colors.border }]}>
          <Feather name="check-square" size={28} color={colors.mutedForeground} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No tasks found</Text>
        </View>
      ) : (
        <>
          {overdueTasks.length > 0 && (
            <>
              <Text style={[styles.groupLabel, { color: "#ef4444" }]}>Overdue ({overdueTasks.length})</Text>
              {overdueTasks.map(renderTask)}
            </>
          )}
          {upcomingTasks.length > 0 && (
            <>
              <Text style={[styles.groupLabel, { color: colors.mutedForeground }]}>Upcoming ({upcomingTasks.length})</Text>
              {upcomingTasks.map(renderTask)}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  backBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontSize: 20, fontFamily: "Inter_700Bold", letterSpacing: -0.3 },
  filterRow: { flexDirection: "row", borderRadius: 10, borderWidth: 1, padding: 3, marginBottom: 20, gap: 3 },
  filterBtn: { flex: 1, paddingVertical: 7, borderRadius: 7, alignItems: "center" },
  filterText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  taskCard: {
    borderRadius: 10, borderWidth: 1, padding: 14, marginBottom: 10,
  },
  taskHeader: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  priorityDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, flexShrink: 0 },
  taskTitle: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium" },
  taskDesc: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 4, marginLeft: 18 },
  taskFooter: { flexDirection: "row", gap: 12, marginTop: 8, marginLeft: 18 },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { fontSize: 11, fontFamily: "Inter_400Regular" },
  groupLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold", marginBottom: 8, marginTop: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  emptyState: { borderRadius: 10, borderWidth: 1, padding: 40, alignItems: "center", gap: 10, marginTop: 20 },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular" },
});
