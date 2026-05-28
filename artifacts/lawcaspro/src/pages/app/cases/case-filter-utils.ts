export function normalizeAssignedToUserIdParam(
  raw: string | null,
  opts: { myUserId: number | null; isPartnerOrManager: boolean },
): string {
  if (!raw || raw === "all") return "all";
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "all";
  if (!opts.isPartnerOrManager && opts.myUserId && n !== opts.myUserId) return String(opts.myUserId);
  return String(Math.trunc(n));
}

