export const CUSTOM_VARIABLE_KEY_REGEX = /^[a-z][a-z0-9_]*$/;

export function canonicalizeCustomVariableKey(input: string): string {
  const raw = String(input ?? "").trim().toLowerCase();
  const replaced = raw.replace(/[\s-]+/g, "_");
  const cleaned = replaced.replace(/[^a-z0-9_]/g, "");
  const collapsed = cleaned.replace(/_+/g, "_");
  return collapsed.replace(/^_+|_+$/g, "");
}

export function validateCustomVariableKey(key: string): { ok: true } | { ok: false; message: string } {
  const k = String(key ?? "");
  if (!k.trim()) return { ok: false, message: "Key is required." };
  if (!CUSTOM_VARIABLE_KEY_REGEX.test(k)) return { ok: false, message: "Key may contain only lowercase letters, numbers and underscores, and must start with a letter." };
  return { ok: true };
}

export function findTokenSyntaxError(body: string): { message: string; index: number; near: string } | null {
  const text = String(body ?? "");
  const firstOpen = text.indexOf("{{");
  const firstClose = text.indexOf("}}");
  if (firstClose !== -1 && (firstOpen === -1 || firstClose < firstOpen)) {
    return { message: "Invalid token syntax near }}.", index: firstClose, near: "}}" };
  }

  const tokenRe = /^[a-zA-Z][a-zA-Z0-9_]*$/;
  let i = 0;
  while (true) {
    const open = text.indexOf("{{", i);
    if (open === -1) break;
    const close = text.indexOf("}}", open + 2);
    if (close === -1) {
      const near = text.slice(open, Math.min(text.length, open + 48));
      return { message: "Invalid token syntax near {{...}}.", index: open, near };
    }
    const inner = text.slice(open + 2, close);
    const token = inner.trim();
    if (!token || token.includes("{") || token.includes("}") || /\s/.test(token) || !tokenRe.test(token)) {
      const near = text.slice(open, Math.min(text.length, close + 2));
      return { message: "Invalid token syntax near {{...}}.", index: open, near };
    }
    i = close + 2;
  }
  return null;
}

