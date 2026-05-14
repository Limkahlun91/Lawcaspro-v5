import { useEffect, useMemo, useRef, useState } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Copy } from "lucide-react";

export type VariableDictionaryVariable = {
  key: string;
  label: string;
  category?: string;
  description?: string;
};

export type VariableDictionaryCustomClause = {
  id: number;
  clauseName: string;
  title: string;
};

type DynamicBlock = { label: string; value: string; hint?: string };
type Snippet = { title: string; value: string };

type Section =
  | { id: string; title: string; kind: "variables"; items: VariableDictionaryVariable[]; mode: "copy" | "insert" }
  | { id: string; title: string; kind: "dynamic"; items: DynamicBlock[]; mode: "copy" | "insert" }
  | { id: string; title: string; kind: "snippets"; items: Snippet[] }
  | { id: string; title: string; kind: "customClauses"; items: VariableDictionaryCustomClause[]; mode: "copy" | "insert" };

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

function matchesQuery(params: { q: string; key?: string; label?: string; description?: string }): boolean {
  if (!params.q) return true;
  const hay = `${norm(params.key)} ${norm(params.label)} ${norm(params.description)}`;
  return hay.includes(params.q);
}

export function VariableDictionaryPanel(props: {
  variables: VariableDictionaryVariable[];
  customClauses?: VariableDictionaryCustomClause[];
  mode: "copy" | "insert";
  title?: string;
  subtitle?: string;
  onCopy?: (text: string) => void | Promise<void>;
  onInsert?: (text: string) => void;
  className?: string;
}) {
  const [qRaw, setQRaw] = useState("");
  const q = norm(qRaw);
  const [open, setOpen] = useState<string[]>([]);
  const openBeforeSearchRef = useRef<string[] | null>(null);
  const openRef = useRef<string[]>([]);

  const dynamicBlocks: DynamicBlock[] = useMemo(() => ([
    { label: "Purchasers Loop Start", value: "{#purchasers}", hint: "買家簽名欄/迴圈 起點" },
    { label: "Purchasers Loop End", value: "{/purchasers}", hint: "買家簽名欄/迴圈 終點" },
    { label: "Borrowers Loop Start", value: "{#borrowers}", hint: "借貸人簽名欄/迴圈 起點" },
    { label: "Borrowers Loop End", value: "{/borrowers}", hint: "借貸人簽名欄/迴圈 終點" },
    { label: "Vendors Loop Start", value: "{#vendors}", hint: "賣家簽名欄/迴圈 起點" },
    { label: "Vendors Loop End", value: "{/vendors}", hint: "賣家簽名欄/迴圈 終點" },
  ]), []);

  const snippets: Snippet[] = useMemo(() => ([
    {
      title: "Buyer Signature Block (買家簽名欄)",
      value: `{#purchasers}\n...................................................\n{{name}}\n(NRIC NO.: {{nric}})\n\n{/purchasers}\n`,
    },
    {
      title: "Borrower Signature Block (借貸人簽名欄)",
      value: `{#borrowers}\n...................................................\n{{name}}\n(NRIC NO.: {{ic_no}})\n\n{/borrowers}\n`,
    },
  ]), []);

  const { sections, defaultOpen } = useMemo(() => {
    const vars = Array.isArray(props.variables) ? props.variables : [];
    const clauses = Array.isArray(props.customClauses) ? props.customClauses : [];

    const inline = vars
      .filter((v) => typeof v.key === "string" && v.key.endsWith("_inline"))
      .slice()
      .sort((a, b) => String(a.key).localeCompare(String(b.key)));

    const byCat = new Map<string, VariableDictionaryVariable[]>();
    for (const v of vars) {
      if (typeof v.key === "string" && v.key.endsWith("_inline")) continue;
      const cat = String(v.category ?? "General") || "General";
      const list = byCat.get(cat) ?? [];
      list.push(v);
      byCat.set(cat, list);
    }

    for (const [cat, list] of byCat.entries()) {
      list.sort((a, b) => String(a.key).localeCompare(String(b.key)));
      byCat.set(cat, list);
    }

    const categoryNames = Array.from(byCat.keys()).sort((a, b) => a.localeCompare(b));

    const sectionsAll: Section[] = [];

    const inlineFiltered = inline.filter((v) => matchesQuery({ q, key: v.key, label: v.label, description: v.description }));
    if (inlineFiltered.length) {
      sectionsAll.push({ id: "parties_formatted", title: "Parties (Formatted)", kind: "variables", items: inlineFiltered, mode: props.mode });
    } else if (!q) {
      sectionsAll.push({ id: "parties_formatted", title: "Parties (Formatted)", kind: "variables", items: inline, mode: props.mode });
    }

    const dynamicFiltered = dynamicBlocks.filter((d) => matchesQuery({ q, key: d.value, label: d.label, description: d.hint }));
    if (dynamicFiltered.length) {
      sectionsAll.push({ id: "dynamic_blocks", title: "Dynamic Blocks (Looping)", kind: "dynamic", items: dynamicFiltered, mode: props.mode });
    } else if (!q) {
      sectionsAll.push({ id: "dynamic_blocks", title: "Dynamic Blocks (Looping)", kind: "dynamic", items: dynamicBlocks, mode: props.mode });
    }

    const snippetsFiltered = snippets.filter((s) => matchesQuery({ q, key: s.value, label: s.title }));
    if (snippetsFiltered.length) {
      sectionsAll.push({ id: "snippets", title: "Ready-to-use Snippets", kind: "snippets", items: snippetsFiltered });
    } else if (!q) {
      sectionsAll.push({ id: "snippets", title: "Ready-to-use Snippets", kind: "snippets", items: snippets });
    }

    for (const cat of categoryNames) {
      const items = byCat.get(cat) ?? [];
      const filtered = items.filter((v) => matchesQuery({ q, key: v.key, label: v.label, description: v.description }));
      if (filtered.length) {
        sectionsAll.push({ id: `cat_${cat}`, title: cat, kind: "variables", items: filtered, mode: props.mode });
      } else if (!q && items.length) {
        sectionsAll.push({ id: `cat_${cat}`, title: cat, kind: "variables", items, mode: props.mode });
      }
    }

    if (props.customClauses) {
      const sorted = clauses.slice().sort((a, b) => String(a.clauseName).localeCompare(String(b.clauseName)));
      const filtered = sorted.filter((c) => matchesQuery({ q, key: `clause_${c.clauseName}`, label: c.title || c.clauseName }));
      if (filtered.length) {
        sectionsAll.push({ id: "custom_clauses", title: "Custom Clauses", kind: "customClauses", items: filtered, mode: props.mode });
      } else if (!q) {
        sectionsAll.push({ id: "custom_clauses", title: "Custom Clauses", kind: "customClauses", items: sorted, mode: props.mode });
      }
    }

    const defaultOpenIds = q
      ? sectionsAll.map((s) => s.id)
      : (sectionsAll[0] ? [sectionsAll[0].id] : []);

    return { sections: sectionsAll, defaultOpen: defaultOpenIds };
  }, [props.variables, props.customClauses, props.mode, q, dynamicBlocks, snippets]);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (q) {
      if (openBeforeSearchRef.current === null) openBeforeSearchRef.current = openRef.current;
      setOpen(defaultOpen);
      return;
    }
    if (openBeforeSearchRef.current !== null) {
      const restore = openBeforeSearchRef.current;
      openBeforeSearchRef.current = null;
      const allowed = new Set(sections.map((s) => s.id));
      const next = restore.filter((id) => allowed.has(id));
      setOpen(next.length ? next : defaultOpen);
      return;
    }
    setOpen((prev) => {
      if (prev.length) {
        const allowed = new Set(sections.map((s) => s.id));
        const next = prev.filter((id) => allowed.has(id));
        return next.length ? next : defaultOpen;
      }
      return defaultOpen;
    });
  }, [q, defaultOpen, sections]);

  async function doCopy(text: string) {
    if (props.onCopy) {
      await props.onCopy(text);
      return;
    }
    await navigator.clipboard.writeText(text);
  }

  function action(text: string) {
    if (props.mode === "insert") props.onInsert?.(text);
    else void doCopy(text);
  }

  function renderSection(section: Section) {
    if (section.kind === "variables") {
      return (
        <div className="rounded-md border border-slate-200 bg-white divide-y divide-slate-100">
          {section.items.map((v) => (
            <div key={v.key} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 truncate">{v.label || v.key}</div>
                <div className="text-[11px] text-slate-500 font-mono truncate">{"{{"}{v.key}{"}}"}</div>
                {v.description ? <div className="text-[11px] text-slate-400 truncate">{v.description}</div> : null}
              </div>
              {props.mode === "copy" ? (
                <Button variant="outline" size="icon" onClick={() => action(`{{${v.key}}}`)} aria-label="Copy variable">
                  <Copy className="w-4 h-4" />
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => action(`{{${v.key}}}`)}>
                  Insert
                </Button>
              )}
            </div>
          ))}
        </div>
      );
    }

    if (section.kind === "dynamic") {
      return (
        <div className="rounded-md border border-slate-200 bg-white divide-y divide-slate-100">
          {section.items.map((x) => (
            <div key={x.value} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 truncate">{x.label}</div>
                <div className="text-[11px] text-slate-500 font-mono truncate">{x.value}</div>
                {x.hint ? <div className="text-[11px] text-slate-400 truncate">{x.hint}</div> : null}
              </div>
              {props.mode === "copy" ? (
                <Button variant="outline" size="icon" onClick={() => action(x.value)} aria-label="Copy tag">
                  <Copy className="w-4 h-4" />
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => action(x.value)}>
                  Insert
                </Button>
              )}
            </div>
          ))}
        </div>
      );
    }

    if (section.kind === "snippets") {
      return (
        <div className="space-y-3">
          {section.items.map((s) => (
            <div key={s.title} className="rounded-md border border-slate-200 bg-white overflow-hidden">
              <div className="flex items-start justify-between gap-3 px-3 py-2 border-b border-slate-100">
                <div className="text-sm font-medium text-slate-900">{s.title}</div>
                <Button variant="outline" size="sm" onClick={() => doCopy(s.value)}>Copy Block</Button>
              </div>
              <pre className="p-3 text-[12px] leading-5 font-mono text-slate-700 whitespace-pre-wrap bg-slate-50 overflow-x-auto">
                <code>{s.value}</code>
              </pre>
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="rounded-md border border-slate-200 bg-white divide-y divide-slate-100">
        {section.items.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900 truncate">{c.title || c.clauseName}</div>
              <div className="text-[11px] text-slate-500 font-mono truncate">{"{{"}clause_{c.clauseName}{"}}"}</div>
            </div>
            {props.mode === "copy" ? (
              <Button variant="outline" size="icon" onClick={() => action(`{{clause_${c.clauseName}}}`)} aria-label="Copy clause variable">
                <Copy className="w-4 h-4" />
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => action(`{{clause_${c.clauseName}}}`)}>
                Insert
              </Button>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("min-h-0", props.className)}>
      <div className="sticky top-0 z-10 bg-white pb-3">
        {props.title ? <div className="text-sm font-semibold text-slate-900">{props.title}</div> : null}
        {props.subtitle ? <div className="text-xs text-slate-500">{props.subtitle}</div> : null}
        <Input
          value={qRaw}
          onChange={(e) => setQRaw(e.target.value)}
          placeholder="Search variables..."
          className="mt-2 h-9"
        />
      </div>

      {sections.length === 0 ? (
        <div className="text-sm text-slate-500 py-6 text-center">No results.</div>
      ) : (
        <Accordion type="multiple" value={open} onValueChange={(v) => setOpen(v as string[])}>
          {sections.map((s) => (
            <AccordionItem key={s.id} value={s.id}>
              <AccordionTrigger className="text-left">{s.title}</AccordionTrigger>
              <AccordionContent className="pt-2">
                {renderSection(s)}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </div>
  );
}
