import { EmailSettingsPanel } from "@/components/communication/email-settings-panel";

export default function EmailSettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Email Settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          Mailbox connection, provider setup, folder sync, import status, and sync logs are managed here instead of the daily inbox view.
        </p>
      </div>
      <EmailSettingsPanel />
    </div>
  );
}
