import type { CommunicationChannel } from "./communication.types.js";

export function buildConsolidatedDraftBody(args: {
  channel: CommunicationChannel;
  tasks: Array<{
    id: number;
    caseRef: string | null;
    partyName: string | null;
    bankRef: string | null;
    propertyRef: string | null;
    taskStatus: string;
    replyNote: string | null;
  }>;
}) {
  const rows = args.tasks.map((t, idx) => {
    const no = idx + 1;
    const caseRef = escapeHtml(t.caseRef ?? "");
    const party = escapeHtml(t.partyName ?? "");
    const bank = escapeHtml(t.bankRef ?? "");
    const property = escapeHtml(t.propertyRef ?? "");
    const reply = escapeHtml(t.replyNote ?? "");
    return `<tr><td>${no}</td><td>${caseRef}</td><td>${party}</td><td>${bank}</td><td>${property}</td><td>${reply}</td></tr>`;
  });

  const html = [
    `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;">`,
    `<thead><tr><th>No</th><th>Case Ref</th><th>Party</th><th>Bank Ref</th><th>Property</th><th>Status / Reply</th></tr></thead>`,
    `<tbody>`,
    ...rows,
    `</tbody>`,
    `</table>`,
  ].join("");

  const textLines = args.tasks.map((t, idx) => {
    const no = idx + 1;
    return `${no}. ${t.caseRef ?? ""} | ${t.partyName ?? ""} | ${t.bankRef ?? ""} | ${t.propertyRef ?? ""} | ${(t.replyNote ?? "").trim()}`;
  });

  return { bodyHtml: html, bodyText: textLines.join("\n") };
}

function escapeHtml(v: string) {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

