import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { apiFetch } from "@/lib/api";
import { useColors } from "@/hooks/useColors";

interface Case {
  id: number;
  referenceNo: string;
  propertyAddress: string;
  status: string;
  purchasePrice: number;
  titleType: string;
  financingType: string;
  assignedLawyerName: string | null;
  projectName: string | null;
  buyerName: string | null;
  createdAt: string;
}

const STATUS_OPTIONS = [
  "All",
  "File Opened / SPA Pending Signing",
  "SPA Stamped",
  "Loan Docs Pending",
  "Loan Docs Signed",
  "MOT Pending",
  "MOT Registered",
  "Completed",
];

const STATUS_SHORT: Record<string, string> = {
  "File Opened / SPA Pending Signing": "SPA Pending",
  "SPA Stamped": "SPA Stamped",
  "Loan Docs Pending": "Loan Pending",
  "Loan Docs Signed": "Loan Signed",
  "MOT Pending": "MOT Pending",
  "MOT Registered": "MOT Registered",
  "NOA Served": "NOA Served",
  Completed: "Completed",
};

const STATUS_COLOR: Record<string, string> = {
  Completed: "#22c55e",
  "MOT Registered": "#0d9488",
  "SPA Stamped": "#3b82f6",
  "Loan Docs Signed": "#8b5cf6",
};

export default function CasesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");

  const { data: cases = [], isLoading, refetch } = useQuery<Case[]>({
    queryKey: ["cases"],
    queryFn: () => apiFetch<Case[]>("/cases"),
  });

  const filtered = useMemo(() => {
    let list = cases;
    if (statusFilter !== "All") {
      list = list.filter((c) => c.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (c) =>
          c.referenceNo.toLowerCase().includes(q) ||
          (c.projectName ?? "").toLowerCase().includes(q) ||
          (c.buyerName ?? "").toLowerCase().includes(q) ||
          c.propertyAddress.toLowerCase().includes(q)
      );
    }
    return list;
  }, [cases, search, statusFilter]);

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  return (
    <View style={[styles.flex, { backgroundColor: colors.background }]}>
      <View style={[styles.searchBar, { paddingTop: topPad + 12, backgroundColor: colors.background }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Cases</Text>
        <View style={[styles.searchWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="search" size={15} color={colors.mutedForeground} />
          <TextInput
            style={[styles.searchInput, { color: colors.foreground }]}
            value={search}
            onChangeText={setSearch}
            placeholder="Search by reference, project, client..."
            placeholderTextColor={colors.mutedForeground}
            autoCorrect={false}
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch("")}>
              <Feather name="x" size={14} color={colors.mutedForeground} />
            </Pressable>
          )}
        </View>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: Platform.OS === "web" ? 84 + 34 : insets.bottom + 84,
          paddingTop: 4,
        }}
        onRefresh={refetch}
        refreshing={isLoading}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            <Feather name="briefcase" size={32} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No cases found</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              {search ? "Try a different search term" : "No cases in this status"}
            </Text>
          </View>
        }
        renderItem={({ item: c }) => {
          const badgeColor = STATUS_COLOR[c.status] ?? colors.mutedForeground;
          const short = STATUS_SHORT[c.status] ?? c.status;
          return (
            <Pressable
              style={({ pressed }) => [
                styles.caseCard,
                { backgroundColor: colors.card, borderColor: colors.border },
                pressed && { opacity: 0.75 },
              ]}
              onPress={() => router.push({ pathname: "/cases/[id]", params: { id: String(c.id) } })}
            >
              <View style={styles.caseTop}>
                <Text style={[styles.caseRef, { color: colors.amber }]}>{c.referenceNo}</Text>
                <View style={[styles.badge, { backgroundColor: badgeColor + "20" }]}>
                  <Text style={[styles.badgeText, { color: badgeColor }]}>{short}</Text>
                </View>
              </View>
              {c.projectName && (
                <Text style={[styles.caseProject, { color: colors.foreground }]} numberOfLines={1}>{c.projectName}</Text>
              )}
              {c.buyerName && (
                <Text style={[styles.caseBuyer, { color: colors.mutedForeground }]} numberOfLines={1}>{c.buyerName}</Text>
              )}
              <View style={styles.caseMeta}>
                <View style={styles.metaPill}>
                  <Feather name="credit-card" size={10} color={colors.mutedForeground} />
                  <Text style={[styles.metaText, { color: colors.mutedForeground }]}>{c.financingType}</Text>
                </View>
                <View style={styles.metaPill}>
                  <Feather name="file-text" size={10} color={colors.mutedForeground} />
                  <Text style={[styles.metaText, { color: colors.mutedForeground }]}>{c.titleType}</Text>
                </View>
                {c.assignedLawyerName && (
                  <View style={styles.metaPill}>
                    <Feather name="user" size={10} color={colors.mutedForeground} />
                    <Text style={[styles.metaText, { color: colors.mutedForeground }]}>{c.assignedLawyerName}</Text>
                  </View>
                )}
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  searchBar: { paddingHorizontal: 16, paddingBottom: 12 },
  pageTitle: { fontSize: 26, fontFamily: "Inter_700Bold", letterSpacing: -0.5, marginBottom: 12 },
  searchWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, height: 42,
  },
  searchInput: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular" },
  emptyBox: { alignItems: "center", marginTop: 60, gap: 8 },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", marginTop: 8 },
  emptyText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  caseCard: {
    borderRadius: 10, borderWidth: 1,
    padding: 14, marginBottom: 10,
  },
  caseTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 },
  caseRef: { fontSize: 13, fontFamily: "Inter_700Bold", letterSpacing: 0.3 },
  badge: { borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 },
  badgeText: { fontSize: 10, fontFamily: "Inter_600SemiBold" },
  caseProject: { fontSize: 14, fontFamily: "Inter_500Medium", marginBottom: 2 },
  caseBuyer: { fontSize: 12, fontFamily: "Inter_400Regular", marginBottom: 8 },
  caseMeta: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  metaPill: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { fontSize: 11, fontFamily: "Inter_400Regular" },
});
