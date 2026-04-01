import DocumentTemplates from "./DocumentTemplates";

export default function Settings() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Settings</h1>
        <p className="text-slate-500 mt-1">Firm preferences and configuration</p>
      </div>

      <DocumentTemplates />
    </div>
  );
}
