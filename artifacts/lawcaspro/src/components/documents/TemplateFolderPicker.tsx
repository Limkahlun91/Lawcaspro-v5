import { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { ChevronRight, FileText } from "lucide-react";

export type TemplateFolderPickerFolder = {
  id: number;
  firm_id: number;
  name: string;
  parent_id: number | null;
  sort_order: number;
  created_at: string;
};

export type TemplateFolderPickerTemplate = {
  id: number;
  name: string;
  file_name: string;
  folder_id: number | null;
  extension: string | null;
  is_template_capable: boolean;
};

export function TemplateFolderPicker(props: {
  folders: TemplateFolderPickerFolder[];
  templates: TemplateFolderPickerTemplate[];
  selectedTemplateIds: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  const { folders, templates, selectedTemplateIds, onChange } = props;

  const folderChildren = useMemo(() => {
    const byParent = new Map<number | null, TemplateFolderPickerFolder[]>();
    for (const f of folders) {
      const k = f.parent_id ?? null;
      const arr = byParent.get(k) ?? [];
      arr.push(f);
      byParent.set(k, arr);
    }
    for (const [k, arr] of byParent) {
      arr.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      byParent.set(k, arr);
    }
    return byParent;
  }, [folders]);

  const templatesByFolder = useMemo(() => {
    const m = new Map<number | null, TemplateFolderPickerTemplate[]>();
    for (const t of templates) {
      const k = t.folder_id ?? null;
      const arr = m.get(k) ?? [];
      arr.push(t);
      m.set(k, arr);
    }
    for (const [k, arr] of m) {
      arr.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      m.set(k, arr);
    }
    return m;
  }, [templates]);

  const templateIdsInFolder = useMemo(() => {
    const memo = new Map<number | null, number[]>();
    const visit = (folderId: number | null): number[] => {
      if (memo.has(folderId)) return memo.get(folderId)!;
      const direct = (templatesByFolder.get(folderId) ?? []).map((t) => t.id);
      const children = folderChildren.get(folderId) ?? [];
      const fromChildren = children.flatMap((c) => visit(c.id));
      const all = [...direct, ...fromChildren];
      memo.set(folderId, all);
      return all;
    };
    visit(null);
    return memo;
  }, [folderChildren, templatesByFolder]);

  const folderCheckboxState = (folderId: number | null): { checked: boolean; indeterminate: boolean } => {
    const ids = templateIdsInFolder.get(folderId) ?? [];
    if (!ids.length) return { checked: false, indeterminate: false };
    const selectedCount = ids.filter((id) => selectedTemplateIds.has(id)).length;
    if (selectedCount === 0) return { checked: false, indeterminate: false };
    if (selectedCount === ids.length) return { checked: true, indeterminate: false };
    return { checked: false, indeterminate: true };
  };

  const setFolderTemplates = (folderId: number | null, checked: boolean) => {
    const ids = templateIdsInFolder.get(folderId) ?? [];
    if (!ids.length) return;
    const next = new Set(selectedTemplateIds);
    if (!checked) {
      for (const id of ids) next.delete(id);
    } else {
      for (const id of ids) next.add(id);
    }
    onChange(next);
  };

  const toggleTemplate = (id: number) => {
    const next = new Set(selectedTemplateIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  function FolderNode({ folder, depth }: { folder: TemplateFolderPickerFolder; depth: number }) {
    const children = folderChildren.get(folder.id) ?? [];
    const [expanded, setExpanded] = useState(true);
    const cb = folderCheckboxState(folder.id);
    const hasChildren = children.length > 0;
    const hasTemplates = (templateIdsInFolder.get(folder.id) ?? []).length > 0;

    return (
      <div>
        <div
          className={cn("flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50")}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
        >
          <button
            className={cn("p-0.5", !hasChildren && "invisible")}
            onClick={() => setExpanded((v) => !v)}
            type="button"
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
          </button>
          <Checkbox
            checked={cb.indeterminate ? "indeterminate" : cb.checked}
            disabled={!hasTemplates}
            onCheckedChange={(v) => setFolderTemplates(folder.id, v === true)}
          />
          <button
            className="flex-1 truncate text-left"
            onClick={() => setExpanded((v) => !v)}
            type="button"
          >
            {folder.name}
          </button>
        </div>

        {expanded && (
          <div>
            {(templatesByFolder.get(folder.id) ?? []).map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50"
                style={{ paddingLeft: `${(depth + 1) * 14 + 22}px` }}
              >
                <Checkbox checked={selectedTemplateIds.has(t.id)} onCheckedChange={() => toggleTemplate(t.id)} />
                <FileText className="h-3.5 w-3.5 text-slate-500" />
                <div className="flex-1 truncate">{t.name}</div>
              </div>
            ))}
            {children.map((c) => (
              <FolderNode key={c.id} folder={c} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-h-[360px] overflow-auto rounded-md border border-slate-200">
      {folders.length === 0 && templates.length === 0 ? (
        <div className="p-4 text-sm text-slate-500">No templates found.</div>
      ) : (
        <div className="py-2">
          {(templatesByFolder.get(null) ?? []).map((t) => (
            <div key={t.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50" style={{ paddingLeft: 22 }}>
              <Checkbox checked={selectedTemplateIds.has(t.id)} onCheckedChange={() => toggleTemplate(t.id)} />
              <FileText className="h-3.5 w-3.5 text-slate-500" />
              <div className="flex-1 truncate">{t.name}</div>
            </div>
          ))}
          {(folderChildren.get(null) ?? []).map((f) => (
            <FolderNode key={f.id} folder={f} depth={0} />
          ))}
        </div>
      )}
    </div>
  );
}

