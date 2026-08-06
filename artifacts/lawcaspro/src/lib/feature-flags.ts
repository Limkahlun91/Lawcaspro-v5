export type FeatureFlagKey = "intake_inbox";

export const PHASE2_FLAGS = {
  phase2EmailEnabled: false,
  phase2WhatsAppEnabled: false,
  phase2EmailSettingsEnabled: false,
} as const;

function parseBool(v: unknown): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return false;
  return s === "1" || s === "true" || s === "yes" || s === "on" || s === "enabled";
}

export function isFeatureEnabled(key: FeatureFlagKey): boolean {
  if (key === "intake_inbox") {
    const env = (import.meta as any).env ?? {};
    const v = env.VITE_CASE_INTAKE_ENABLED ?? env.VITE_FEATURE_INTAKE_INBOX;
    return parseBool(v);
  }
  return false;
}

export function isEmailControlEnabled(): boolean {
  return PHASE2_FLAGS.phase2EmailEnabled;
}

export function isWhatsAppInboxEnabled(): boolean {
  return PHASE2_FLAGS.phase2WhatsAppEnabled;
}

export function isEmailSettingsEnabled(): boolean {
  return PHASE2_FLAGS.phase2EmailSettingsEnabled;
}

export const PHASE2_NOTICE = "This module will be available in Phase 2.";
