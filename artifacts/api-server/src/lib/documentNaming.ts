function sanitizePart(v: string): string {
  const s = (v || "").trim();
  if (!s) return "";
  const cleaned = s.replace(/[\r\n]/g, " ").replace(/[^\p{L}\p{N} _-]+/gu, " ").replace(/\s+/g, " ").trim();
  return cleaned.replace(/ /g, "_").slice(0, 40);
}

function yyyymmdd(d: Date): string {
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function hhmmss(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}${mm}${ss}`;
}

export type NamingInputs = {
  referenceNo: string;
  templateCode: string;
  purchaserName: string;
  projectName: string;
  extension: string;
  now?: Date;
};

export function buildGeneratedDownloadFileName(input: NamingInputs): string {
  const now = input.now ?? new Date();
  const ref = sanitizePart(input.referenceNo) || "REF";
  const code = sanitizePart(input.templateCode) || "DOC";
  const buyer = sanitizePart(input.purchaserName) || "Client";
  const project = sanitizePart(input.projectName) || "Project";
  const ext = (input.extension || "").replace(/^\./, "").toLowerCase() || "docx";
  return `${ref}_${code}_${buyer}_${project}_${yyyymmdd(now)}_${hhmmss(now)}.${ext}`;
}

