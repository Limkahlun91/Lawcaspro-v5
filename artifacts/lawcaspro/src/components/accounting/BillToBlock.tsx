import React from "react";

type ClientDetail = {
  name: string;
  tin?: string | null;
};

type Props = {
  title?: string;
  clientDetails?: ClientDetail[] | null;
  clientName?: string | null;
  clientTin?: string | null;
  address?: string | null;
  className?: string;
};

export function BillToBlock({
  title = "Bill To",
  clientDetails,
  clientName,
  clientTin,
  address,
  className,
}: Props) {
  const normalizedDetails = Array.isArray(clientDetails)
    ? clientDetails
        .map((c) => ({
          name: typeof c?.name === "string" ? c.name.trim() : "",
          tin: typeof c?.tin === "string" ? c.tin.trim() : "",
        }))
        .filter((c) => c.name)
    : [];

  const fallbackName = typeof clientName === "string" ? clientName.trim() : "";
  const fallbackTin = typeof clientTin === "string" ? clientTin.trim() : "";
  const rows = normalizedDetails.length
    ? normalizedDetails
    : fallbackName
      ? [{ name: fallbackName, tin: fallbackTin }]
      : [];

  const addr = typeof address === "string" ? address.trim() : "";

  return (
    <div className={className}>
      <div className="text-[10px] text-slate-500 uppercase">{title}</div>
      {rows.length ? (
        <>
          <div className="text-sm font-medium text-slate-900">{rows.map((r) => r.name).join(" & ")}</div>
          <div className="mt-1 space-y-0.5">
            {rows.map((r, idx) => (
              <div key={`${r.name}-${idx}`} className="text-xs text-slate-700">
                {r.name}
                {r.tin ? ` — TIN: ${r.tin}` : ""}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="text-sm font-medium text-slate-900">—</div>
      )}
      {addr ? <div className="text-xs text-slate-700 whitespace-pre-wrap mt-0.5">{addr}</div> : null}
    </div>
  );
}

