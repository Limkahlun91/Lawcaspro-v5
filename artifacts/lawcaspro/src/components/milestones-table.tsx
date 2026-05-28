import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import type { ReactNode } from "react";

type MilestoneCard = {
  key: string;
  label: string;
  count: number;
  pendingCount?: number;
  doneCount?: number;
  filter: { milestone?: string; milestonePresence?: string; milestoneStatus?: string; purchaseMode?: string; titleType?: string; assignedToUserId?: string };
};

type MilestoneSection = { key: string; label: string; total: number; cards: MilestoneCard[] };

const MILESTONE_SECTION_ROW_CLASS: Record<string, string> = {
  spa: "bg-amber-50",
  loan_master: "bg-blue-50",
  loan_title: "bg-emerald-50",
};

function buildCasesHref(filter: { milestone?: string | null; milestonePresence?: string | null; milestoneStatus?: string | null; purchaseMode?: string | null; titleType?: string | null; assignedToUserId?: string | null }) {
  const qs = new URLSearchParams();
  const milestone = (filter as Record<string, unknown>)?.milestone as string | undefined;
  const milestonePresence = (filter as Record<string, unknown>)?.milestonePresence as string | undefined;
  const milestoneStatus = (filter as Record<string, unknown>)?.milestoneStatus as string | undefined;
  const presence = milestoneStatus || milestonePresence;
  const status =
    presence === "completed" ? "done"
      : presence === "pending" ? "pending"
        : presence === "missing" ? "missing"
          : presence === "filled" ? "filled"
            : presence;
  if (milestone && status) {
    qs.set("milestone", milestone);
    qs.set("status", status);
    qs.set("milestonePresence", presence === "done" ? "completed" : presence ?? "");
  }
  const assignedToUserId = (filter as Record<string, unknown>)?.assignedToUserId as string | undefined;
  if (assignedToUserId) qs.set("assignedToUserId", assignedToUserId);
  if (filter.purchaseMode) qs.set("purchaseMode", filter.purchaseMode);
  if (filter.titleType) qs.set("titleType", filter.titleType);
  const q = qs.toString();
  return q ? `/app/cases?${q}` : "/app/cases";
}

export function MilestonesTable({
  title = "Milestones",
  milestoneSections,
  milestoneCards,
  onNavigate,
  headerRight,
}: {
  title?: string;
  milestoneSections: MilestoneSection[];
  milestoneCards: MilestoneCard[];
  onNavigate: (href: string) => void;
  headerRight?: ReactNode;
}) {
  const empty = milestoneSections.length === 0 && milestoneCards.length === 0;

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-3">
        <CardTitle>{title}</CardTitle>
        {headerRight}
      </CardHeader>
      <CardContent>
        {empty ? (
          <div className="text-sm text-slate-500">No milestones available.</div>
        ) : (
        <Table>
          <TableBody>
            {milestoneSections.length > 0
              ? milestoneSections.flatMap((section) => {
                  const sectionRowClass = MILESTONE_SECTION_ROW_CLASS[section.key] ?? "bg-slate-50";
                  const sectionRow = (
                    <TableRow key={`section_${section.key}`} className={sectionRowClass}>
                      <TableCell className="py-3" colSpan={2}>
                        <div className="flex items-center justify-between">
                          <div className="text-base font-semibold text-slate-900">{section.label}</div>
                          <div className="text-sm font-semibold text-slate-700">Total: {section.total}</div>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                  const rows = section.cards.map((card) => {
                    const filter = card.filter ?? {};
                    const href = buildCasesHref(filter);
                    const pendingCount = Number(card.pendingCount ?? card.count ?? 0) || 0;
                    const doneCount = Number(card.doneCount ?? 0) || 0;
                    const hasMilestone = Boolean(filter.milestone);
                    const pendingHref = buildCasesHref({ ...filter, milestonePresence: "pending" });
                    const doneHref = buildCasesHref({ ...filter, milestonePresence: "completed" });
                    return (
                      <TableRow
                        key={card.key}
                        className={hasMilestone ? "" : "cursor-pointer"}
                        role={hasMilestone ? undefined : "button"}
                        tabIndex={hasMilestone ? undefined : 0}
                        onClick={hasMilestone ? undefined : () => onNavigate(href)}
                        onKeyDown={hasMilestone ? undefined : (e) => {
                          if (e.key === "Enter" || e.key === " ") onNavigate(href);
                        }}
                      >
                        <TableCell className="py-3">
                          <div className="text-base font-medium text-slate-900">{card.label}</div>
                        </TableCell>
                        <TableCell className="py-3 text-right">
                          {hasMilestone ? (
                            <div className="flex items-center justify-end gap-3">
                              <button
                                type="button"
                                className="text-sm font-semibold text-emerald-700 hover:text-emerald-800 hover:underline cursor-pointer transition-colors"
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onNavigate(doneHref); }}
                              >
                                DONE ({doneCount})
                              </button>
                              <button
                                type="button"
                                className="text-sm font-semibold text-amber-700 hover:text-amber-800 hover:underline cursor-pointer transition-colors"
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onNavigate(pendingHref); }}
                              >
                                Pending ({pendingCount})
                              </button>
                            </div>
                          ) : (
                            <span className="font-semibold text-slate-900">{card.count}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  });
                  return [sectionRow, ...rows];
                })
              : milestoneCards.map((card) => {
                  const filter = card.filter ?? {};
                  const href = buildCasesHref(filter);
                  const pendingCount = Number(card.pendingCount ?? card.count ?? 0) || 0;
                  const doneCount = Number(card.doneCount ?? 0) || 0;
                  const hasMilestone = Boolean(filter.milestone);
                  const pendingHref = buildCasesHref({ ...filter, milestonePresence: "pending" });
                  const doneHref = buildCasesHref({ ...filter, milestonePresence: "completed" });
                  return (
                    <TableRow
                      key={card.key}
                      className={hasMilestone ? "" : "cursor-pointer"}
                      role={hasMilestone ? undefined : "button"}
                      tabIndex={hasMilestone ? undefined : 0}
                      onClick={hasMilestone ? undefined : () => onNavigate(href)}
                      onKeyDown={hasMilestone ? undefined : (e) => {
                        if (e.key === "Enter" || e.key === " ") onNavigate(href);
                      }}
                    >
                      <TableCell className="py-3">
                        <div className="text-base font-medium text-slate-900">{card.label}</div>
                      </TableCell>
                      <TableCell className="py-3 text-right">
                        {hasMilestone ? (
                          <div className="flex items-center justify-end gap-3">
                            <button
                              type="button"
                              className="text-sm font-semibold text-emerald-700 hover:text-emerald-800 hover:underline cursor-pointer transition-colors"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onNavigate(doneHref); }}
                            >
                              DONE ({doneCount})
                            </button>
                            <button
                              type="button"
                              className="text-sm font-semibold text-amber-700 hover:text-amber-800 hover:underline cursor-pointer transition-colors"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onNavigate(pendingHref); }}
                            >
                              Pending ({pendingCount})
                            </button>
                          </div>
                        ) : (
                          <span className="font-semibold text-slate-900">{card.count}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
          </TableBody>
        </Table>
        )}
      </CardContent>
    </Card>
  );
}

