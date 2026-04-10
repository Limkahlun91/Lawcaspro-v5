export function isFirmDocumentTypeLetterLike(documentType: string | undefined): boolean {
  const dt = (documentType || "").toLowerCase();
  return dt === "letter_of_offer" || dt === "acting_letter" || dt === "undertaking";
}

export function isMasterDocumentLetterLike(d: { name?: string; category?: string; fileName?: string } | undefined): boolean {
  const name = (d?.name || "").toLowerCase();
  const category = (d?.category || "").toLowerCase();
  const fileName = (d?.fileName || "").toLowerCase();
  if (category === "letter") return true;
  const parts = `${name} ${fileName}`;
  if (/(^|[\s_\-])letter($|[\s_\-])/i.test(parts)) return true;
  if (/(^|[\s_\-])acting[\s_\-]+letter($|[\s_\-])/i.test(parts)) return true;
  if (/(^|[\s_\-])undertaking($|[\s_\-])/i.test(parts)) return true;
  if (/(^|[\s_\-])letter[\s_\-]+of[\s_\-]+offer($|[\s_\-])/i.test(parts)) return true;
  return false;
}

