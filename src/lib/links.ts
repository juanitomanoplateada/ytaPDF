/**
 * What the user types as a link's destination: a page number, a web
 * address (with or without "https://"), an e-mail address or a phone number.
 */

export type ParsedLink = { kind: "page"; number: number } | { kind: "url"; url: string } | { kind: "invalid" };

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

export function parseLinkInput(value: string): ParsedLink {
  const text = value.trim();
  if (!text) return { kind: "url", url: "" };
  const page = /^(?:p(?:ág(?:ina)?|age)?\.?\s*)?(\d{1,5})$/i.exec(text);
  if (page) return { kind: "page", number: Number(page[1]) };
  if (/\s/.test(text)) return { kind: "invalid" };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1];
  if (scheme) {
    // Anything that could run code or open local files stays out of the PDF.
    return SAFE_SCHEMES.has(`${scheme.toLowerCase()}:`) ? { kind: "url", url: text } : { kind: "invalid" };
  }
  if (/^[^@/]+@[^@/]+\.[^@/]+$/.test(text)) return { kind: "url", url: `mailto:${text}` };
  if (/^[^./]+(\.[^./]+)+/.test(text)) return { kind: "url", url: `https://${text}` };
  return { kind: "invalid" };
}
