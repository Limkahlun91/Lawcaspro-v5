import DocumentTemplates from "@/pages/app/settings/DocumentTemplates";

export default function DocumentsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Documents</h1>
        <p className="text-slate-500 mt-1">Master document templates for case generation</p>
      </div>
      <DocumentTemplates />
    </div>
  );
}
