export type FeatureFlagKey = "intake_inbox";

function parseBool(v: unknown): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  return s === "1" || s === "true" || s === "yes" || s === "on" || s === "enabled";
}

export function isFeatureEnabled(key: FeatureFlagKey): boolean {
  if (key === "intake_inbox") return parseBool((import.meta as any).env?.VITE_FEATURE_INTAKE_INBOX);
  return false;
}

