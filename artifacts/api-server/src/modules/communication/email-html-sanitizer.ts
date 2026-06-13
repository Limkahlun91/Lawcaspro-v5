import sanitizeHtml from "sanitize-html";

const allowedTags = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
] as const;

const allowedAttributes: Record<string, string[]> = {
  a: ["href", "name", "target", "rel"],
  img: ["src", "alt", "title", "width", "height"],
  "*": ["style", "class", "data-indent"],
};

const allowedStyles: sanitizeHtml.IOptions["allowedStyles"] = {
  "*": {
    color: [/^#[0-9a-fA-F]{3,8}$/, /^rgb\((?:\s*\d+\s*,){2}\s*\d+\s*\)$/],
    "background-color": [/^#[0-9a-fA-F]{3,8}$/, /^rgb\((?:\s*\d+\s*,){2}\s*\d+\s*\)$/],
    "font-family": [/^[a-zA-Z0-9\s"',.-]+$/],
    "font-size": [/^\d+(?:px|pt|rem|em|%)$/],
    "text-align": [/^(left|right|center|justify)$/],
    "margin-left": [/^\d+(?:px|rem|em)$/],
  },
  table: {
    width: [/^\d+(?:px|%)$/],
    "border-collapse": [/^(collapse|separate)$/],
  },
  td: {
    width: [/^\d+(?:px|%)$/],
  },
  th: {
    width: [/^\d+(?:px|%)$/],
  },
  img: {
    width: [/^\d+(?:px|%)$/],
    height: [/^\d+(?:px|%)$/],
  },
};

export function sanitizeEmailHtml(input: string | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const sanitized = sanitizeHtml(raw, {
    allowedTags: [...allowedTags],
    allowedAttributes,
    allowedStyles,
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {
      img: ["http", "https"],
    },
    allowedClasses: {
      "*": ["email-indent-1", "email-indent-2", "email-indent-3", "email-indent-4"],
    },
    parser: {
      lowerCaseAttributeNames: false,
    },
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
  }).trim();
  return sanitized || null;
}
