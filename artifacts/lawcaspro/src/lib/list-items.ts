export function listItems<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== "object") return [];
  const v = value as Record<string, unknown>;
  const items = (v as any).items;
  if (Array.isArray(items)) return items as T[];
  const documents = (v as any).documents;
  if (Array.isArray(documents)) return documents as T[];
  const data = (v as any).data;
  if (Array.isArray(data)) return data as T[];
  const nestedItems = (v as any)?.data?.items;
  if (Array.isArray(nestedItems)) return nestedItems as T[];
  const nestedDocuments = (v as any)?.data?.documents;
  if (Array.isArray(nestedDocuments)) return nestedDocuments as T[];
  return [];
}

export function ensureArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
