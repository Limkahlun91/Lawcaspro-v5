import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";

export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 84 + 34 : insets.bottom + 84;

  const initials = (user?.name ?? "?")
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  const handleLogout = () => {
    if (Platform.OS === "web") {
      doLogout();
      return;
    }
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: doLogout },
    ]);
  };

  const doLogout = async () => {
    setLoggingOut(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await logout();
      router.replace("/login");
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={{ paddingTop: topPad + 12, paddingHorizontal: 16, paddingBottom: bottomPad }}
      showsVerticalScrollIndicator={false}
    >
      <Text style={[styles.pageTitle, { color: colors.foreground }]}>Profile</Text>

      <View style={[styles.avatarCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.avatar, { backgroundColor: colors.navy }]}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <View style={styles.avatarInfo}>
          <Text style={[styles.name, { color: colors.foreground }]}>{user?.name}</Text>
          <Text style={[styles.email, { color: colors.mutedForeground }]}>{user?.email}</Text>
        </View>
      </View>

      <View style={[styles.infoCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>Account Details</Text>

        {[
          { icon: "shield" as const, label: "Role", value: user?.roleName ?? (user?.userType === "founder" ? "Founder" : "User") },
          { icon: "home" as const, label: "Firm", value: user?.firmName ?? "Platform" },
          { icon: "user" as const, label: "Account Type", value: user?.userType === "founder" ? "Platform Founder" : "Firm User" },
        ].map((item, idx, arr) => (
          <View
            key={item.label}
            style={[styles.infoRow, idx < arr.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.border }]}
          >
            <View style={[styles.infoIcon, { backgroundColor: colors.muted }]}>
              <Feather name={item.icon} size={14} color={colors.mutedForeground} />
            </View>
            <View style={styles.infoText}>
              <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>{item.label}</Text>
              <Text style={[styles.infoValue, { color: colors.foreground }]}>{item.value}</Text>
            </View>
          </View>
        ))}
      </View>

      <Pressable
        style={({ pressed }) => [
          styles.logoutBtn,
          { borderColor: colors.destructive + "40", backgroundColor: colors.card },
          pressed && { opacity: 0.75 },
          loggingOut && { opacity: 0.5 },
        ]}
        onPress={handleLogout}
        disabled={loggingOut}
      >
        {loggingOut ? (
          <ActivityIndicator color={colors.destructive} size="small" />
        ) : (
          <>
            <Feather name="log-out" size={16} color={colors.destructive} />
            <Text style={[styles.logoutText, { color: colors.destructive }]}>Sign Out</Text>
          </>
        )}
      </Pressable>

      <Text style={[styles.version, { color: colors.mutedForeground }]}>Lawcaspro Mobile v1.0</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  pageTitle: { fontSize: 26, fontFamily: "Inter_700Bold", letterSpacing: -0.5, marginBottom: 20 },
  avatarCard: {
    flexDirection: "row", alignItems: "center", gap: 16,
    borderRadius: 12, borderWidth: 1, padding: 16, marginBottom: 16,
  },
  avatar: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { fontSize: 20, fontFamily: "Inter_700Bold", color: "#f5a623" },
  avatarInfo: { flex: 1 },
  name: { fontSize: 18, fontFamily: "Inter_600SemiBold" },
  email: { fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 2 },
  infoCard: {
    borderRadius: 12, borderWidth: 1,
    overflow: "hidden", marginBottom: 24,
  },
  sectionLabel: {
    fontSize: 11, fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase", letterSpacing: 0.8,
    paddingHorizontal: 16, paddingVertical: 10,
  },
  infoRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
  },
  infoIcon: {
    width: 32, height: 32, borderRadius: 8,
    alignItems: "center", justifyContent: "center",
  },
  infoText: { flex: 1 },
  infoLabel: { fontSize: 11, fontFamily: "Inter_500Medium" },
  infoValue: { fontSize: 14, fontFamily: "Inter_500Medium", marginTop: 2 },
  logoutBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 10, borderRadius: 10, borderWidth: 1,
    height: 50, marginBottom: 24,
  },
  logoutText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  version: { textAlign: "center", fontSize: 12, fontFamily: "Inter_400Regular" },
});
