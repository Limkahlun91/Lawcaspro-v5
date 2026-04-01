import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { apiFetch } from "@/lib/api";
import { useColors } from "@/hooks/useColors";

interface CommEntry {
  id: number;
  case_id: number;
  type: string;
  direction: string;
  subject: string | null;
  notes: string | null;
  sent_at: string | null;
  created_at: string;
  reference_no: string | null;
}

const TYPE_ICON: Record<string, keyof typeof Feather.glyphMap> = {
  email: "mail",
  letter: "file-text",
  call: "phone",
  sms: "message-square",
  whatsapp: "message-circle",
  meeting: "users",
  note: "edit-3",
};

const TYPE_COLOR: Record<string, string> = {
  email: "#3b82f6",
  letter: "#8b5cf6",
  call: "#22c55e",
  sms: "#f59e0b",
  whatsapp: "#25d366",
  meeting: "#ec4899",
  note: "#6b7280",
};

export default function CommsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const { data: entries = [], isLoading, refetch } = useQuery<CommEntry[]>({
    queryKey: ["communications"],
    queryFn: () => apiFetch<CommEntry[]>("/communications"),
  });

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  return (
    <View style={[styles.flex, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12, backgroundColor: colors.background }]}>
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Communications</Text>
        <Text style={[styles.pageSubtitle, { color: colors.mutedForeground }]}>
          {entries.length} total {entries.length === 1 ? "event" : "events"}
        </Text>
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
            <Feather name="message-square" size={32} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No communications</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Communications will appear here</Text>
          </View>
        }
        renderItem={({ item: e }) => {
          const icon = TYPE_ICON[e.type] ?? "message-square";
          const iconColor = TYPE_COLOR[e.type] ?? colors.mutedForeground;
          const isInbound = e.direction === "inbound";
          return (
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={[styles.iconBox, { backgroundColor: iconColor + "20" }]}>
                <Feather name={icon} size={18} color={iconColor} />
              </View>
              <View style={styles.info}>
                <View style={styles.topRow}>
                  <Text style={[styles.subject, { color: colors.foreground }]} numberOfLines={1}>{e.subject ?? e.type}</Text>
                  <View style={[styles.dirBadge, { backgroundColor: isInbound ? "#3b82f620" : "#22c55e20" }]}>
                    <Feather name={isInbound ? "arrow-down-left" : "arrow-up-right"} size={10} color={isInbound ? "#3b82f6" : "#22c55e"} />
                    <Text style={[styles.dirText, { color: isInbound ? "#3b82f6" : "#22c55e" }]}>
                      {isInbound ? "In" : "Out"}
                    </Text>
                  </View>
                </View>
                {e.reference_no && (
                  <Text style={[styles.caseRef, { color: colors.amber }]}>{e.reference_no}</Text>
                )}
                {e.notes && (
                  <Text style={[styles.body, { color: colors.mutedForeground }]} numberOfLines={2}>{e.notes}</Text>
                )}
                <Text style={[styles.date, { color: colors.mutedForeground }]}>
                  {new Date(e.sent_at ?? e.created_at).toLocaleDateString("en-MY")} · {e.type.charAt(0).toUpperCase() + e.type.slice(1)}
                </Text>
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 12 },
  pageTitle: { fontSize: 26, fontFamily: "Inter_700Bold", letterSpacing: -0.5 },
  pageSubtitle: { fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 2, marginBottom: 4 },
  emptyBox: { alignItems: "center", marginTop: 60, gap: 8 },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", marginTop: 8 },
  emptyText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  card: {
    flexDirection: "row", alignItems: "flex-start",
    borderRadius: 10, borderWidth: 1, padding: 14, marginBottom: 8, gap: 12,
  },
  iconBox: {
    width: 40, height: 40, borderRadius: 10,
    alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  info: { flex: 1 },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  subject: { fontSize: 14, fontFamily: "Inter_600SemiBold", flex: 1, marginRight: 8 },
  dirBadge: { flexDirection: "row", alignItems: "center", gap: 3, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  dirText: { fontSize: 10, fontFamily: "Inter_600SemiBold" },
  caseRef: { fontSize: 11, fontFamily: "Inter_700Bold", marginBottom: 4 },
  body: { fontSize: 12, fontFamily: "Inter_400Regular", marginBottom: 6, lineHeight: 18 },
  date: { fontSize: 11, fontFamily: "Inter_400Regular" },
});
