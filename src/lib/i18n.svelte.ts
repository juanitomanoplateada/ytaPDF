import { EN } from "./locales/en";

/**
 * Interface language. Texts are written in Spanish in the code and used as
 * keys: other languages map each Spanish text to its translation, and a text
 * without translation is shown in Spanish rather than as a missing key.
 * Placeholders such as `{n}` are filled from `params`.
 */
export type Locale = "es" | "en";

export const LOCALES: { id: Locale; label: string }[] = [
  { id: "es", label: "Español" },
  { id: "en", label: "English" },
];

const STORAGE_KEY = "ytapdf.locale";
const DICTIONARIES: Record<Locale, Record<string, string> | null> = { es: null, en: EN };

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "es" || saved === "en") return saved;
  } catch {
    // Storage blocked: fall back to the browser's language.
  }
  const languages = typeof navigator === "undefined" ? ["es"] : (navigator.languages ?? [navigator.language]);
  // Spanish speakers get Spanish; everyone else, English.
  return languages.some((language) => language?.toLowerCase().startsWith("es")) ? "es" : "en";
}

class I18n {
  locale = $state<Locale>(globalThis.window === undefined ? "es" : initialLocale());

  set(locale: Locale): void {
    this.locale = locale;
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // The choice simply does not persist.
    }
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  }

  /** BCP 47 tag for `Intl` formatting. */
  get tag(): string {
    return this.locale === "es" ? "es" : "en-GB";
  }
}

export const i18n = new I18n();

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replaceAll(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Translates a Spanish interface text. Reading the locale makes templates update when it changes. */
export function t(text: string, params?: Record<string, string | number>): string {
  const dictionary = DICTIONARIES[i18n.locale];
  return interpolate(dictionary?.[text] ?? text, params);
}

/** "1 página" / "3 páginas", in the interface language. */
export function pagesLabel(count: number): string {
  return count === 1 ? t("1 página") : t("{n} páginas", { n: count });
}

export function formatDate(date: Date | number, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(i18n.tag, options).format(date);
}

/** A file size for people: "850 KB", "2,4 MB". */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(i18n.tag, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}
