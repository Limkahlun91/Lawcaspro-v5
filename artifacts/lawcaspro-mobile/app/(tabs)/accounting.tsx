import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { apiFetch } from "@/lib/api";
import { useColors } from "@/hooks/useColors";

interface BillingEntry {
  id: number;
  caseId: number;
  description: string;
  amount: number;
  isPaid: boolean;
  billedAt: string;
  caseReferenceNo: string | null;
}

function fmt(val: number) {
  return `RM ${val.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function AccountingScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const { data: entries = [], isLoading, refetch } = useQuery<BillingEntry[]>({
    queryKey: ["accounting"],
    queryFn: () => apiFetch<BillingEntry[]>("/accounting"),
  });

  const totalBilled = entries.reduce((s, e) => s + e.amount, 0);
  const totalPaid = entries.filter((e) => e.isPaid).reduce((s, e) => s + e.amount, 0);
  const totalOutstanding = totalBilled - totalPaid;

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  return (
    <View style={[styles.flex, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12, backgroundColor: colors.background }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Accounting</Text>
        <View style={styles.summaryRow}>
          {[
            { label: "Total Billed", value: fmt(totalBilled), color: colors.foreground },
            { label: "Paid", value: fmt(totalPaid), color: "#22c55e" },
            { label: "Outstanding", value: fmt(totalOutstanding), color: "#ef4444" },
          ].map((item) => (
            <View key={item.label} style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>{item.label}</Text>
              <Text style={[styles.summaryValue, { color: item.color }]} numberOfLines={1} adjustsFontSizeToFit>
                {item.value}
              </Text>
            </View>
          ))}
        </View>
      </View>

      <FlatList
        data={entries}
        keyExtractor={(e) => String(e.id)}
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
            <Feather name="dollar-sign" size={32} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No billing entries</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Billing entries will appear here</Text>
          </View>
        }
        renderItem={({ item: e }) => (
          <View style={[styles.entryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.entryLeft}>
              <View style={[
                styles.paidDot,
                { backgroundColor: e.isPaid ? "#22c55e" : "#ef4444" },
              ]} />
              <View style={styles.entryInfo}>
                {e.caseReferenceNo && (
                  <Text style={[styles.entryRef, { color: colors.amber }]}>{e.caseReferenceNo}</Text>
                )}
                <Text style={[styles.entryDesc, { color: colors.foreground }]} numberOfLines={2}>{e.description}</Text>
                <Text style={[styles.entryDate, { color: colors.mutedForeground }]}>
                  {new Date(e.billedAt).toLocaleDateString("en-MY")}
                </Text>
              </View>
            </View>
            <View style={styles.entryRight}>
              <Text style={[styles.entryAmount, { color: colors.foreground }]}>{fmt(e.amount)}</Text>
              <View style={[styles.statusChip, { backgroundColor: e.isPaid ? "#22c55e20" : "#ef444420" }]}>
                <Text style={[styles.statusChipText, { color: e.isPaid ? "#22c55e" : "#ef4444" }]}>
                  {e.isPaid ? "Paid" : "Unpaid"}
                </Text>
              </View>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 12 },
  pageTitle: { fontSize: 26, fontFamily: "Inter_700Bold", letterSpacing: -0.5, marginBottom: 12 },
  summaryRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  summaryCard: {
    flex: 1, borderRadius: 10, borderWidth: 1,
    padding: 12,
  },
  summaryLabel: { fontSize: 10, fontFamily: "Inter_500Medium", marginBottom: 4 },
  summaryValue: { fontSize: 13, fontFamily: "Inter_700Bold", letterSpacing: -0.3 },
  emptyBox: { alignItems: "center", marginTop: 60, gap: 8 },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", marginTop: 8 },
  emptyText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  entryCard: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    borderRadius: 10, borderWidth: 1, padding: 14, marginBottom: 8,
  },
  entryLeft: { flexDirection: "row", alignItems: "flex-start", flex: 1, gap: 10, marginRight: 8 },
  paidDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  entryInfo: { flex: 1 },
  entryRef: { fontSize: 11, fontFamily: "Inter_700Bold", marginBottom: 2 },
  entryDesc: { fontSize: 13, fontFamily: "Inter_400Regular", marginBottom: 4 },
  entryDate: { fontSize: 11, fontFamily: "Inter_400Regular" },
  entryRight: { alignItems: "flex-end", gap: 4 },
  entryAmount: { fontSize: 14, fontFamily: "Inter_700Bold", letterSpacing: -0.3 },
  statusChip: { borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 },
  statusChipText: { fontSize: 10, fontFamily: "Inter_600SemiBold" },
});
