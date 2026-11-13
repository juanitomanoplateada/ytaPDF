import { cache as fabricCache } from "fabric";
import notoSansRegular from "@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf?url";
import notoSansBold from "@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf?url";
import notoSansItalic from "@expo-google-fonts/noto-sans/400Regular_Italic/NotoSans_400Regular_Italic.ttf?url";
import notoSansBoldItalic from "@expo-google-fonts/noto-sans/700Bold_Italic/NotoSans_700Bold_Italic.ttf?url";
import notoSerifRegular from "@expo-google-fonts/noto-serif/400Regular/NotoSerif_400Regular.ttf?url";
import notoSerifBold from "@expo-google-fonts/noto-serif/700Bold/NotoSerif_700Bold.ttf?url";
import notoSerifItalic from "@expo-google-fonts/noto-serif/400Regular_Italic/NotoSerif_400Regular_Italic.ttf?url";
import notoSerifBoldItalic from "@expo-google-fonts/noto-serif/700Bold_Italic/NotoSerif_700Bold_Italic.ttf?url";
import notoSansArabicRegular from "@expo-google-fonts/noto-sans-arabic/400Regular/NotoSansArabic_400Regular.ttf?url";
import notoSansArabicBold from "@expo-google-fonts/noto-sans-arabic/700Bold/NotoSansArabic_700Bold.ttf?url";
import notoSansScRegular from "@expo-google-fonts/noto-sans-sc/400Regular/NotoSansSC_400Regular.ttf?url";
import notoSansKrRegular from "@expo-google-fonts/noto-sans-kr/400Regular/NotoSansKR_400Regular.ttf?url";
import {
  familyFromCss,
  SCRIPT_FONT_NAMES,
  scriptFontsIn,
  type EmbeddedFamilyId,
  type FontVariant,
  type ScriptFontId,
} from "./fonts";

/**
 * Font files for the embedded families. They are only downloaded when a text
 * uses them, and the same file serves the canvas and the exported PDF, so what
 * is on screen is exactly what gets embedded.
 */
const FONT_FILES: Record<EmbeddedFamilyId, { name: string; files: Record<FontVariant, string> }> = {
  "noto-sans": {
    name: "Noto Sans",
    files: { regular: notoSansRegular, bold: notoSansBold, italic: notoSansItalic, boldItalic: notoSansBoldItalic },
  },
  "noto-serif": {
    name: "Noto Serif",
    files: { regular: notoSerifRegular, bold: notoSerifBold, italic: notoSerifItalic, boldItalic: notoSerifBoldItalic },
  },
};

const DESCRIPTORS: Record<FontVariant, FontFaceDescriptors> = {
  regular: { weight: "400", style: "normal" },
  bold: { weight: "700", style: "normal" },
  italic: { weight: "400", style: "italic" },
  boldItalic: { weight: "700", style: "italic" },
};

const loadedFamilies = new Map<EmbeddedFamilyId, Promise<void>>();
const fileBytes = new Map<string, Promise<Uint8Array>>();

/** Registers the four styles of a family with the browser so Fabric can measure it. */
export function ensureFamilyLoaded(id: EmbeddedFamilyId): Promise<void> {
  let loading = loadedFamilies.get(id);
  if (!loading) {
    const { name, files } = FONT_FILES[id];
    loading = Promise.all(
      (Object.keys(files) as FontVariant[]).map(async (variant) => {
        const face = new FontFace(name, `url(${files[variant]})`, DESCRIPTORS[variant]);
        await face.load();
        document.fonts.add(face);
      }),
    ).then(() => {
      // Widths measured before the font arrived would be wrong.
      fabricCache.clearFontCache(name);
    });
    loading.catch(() => loadedFamilies.delete(id));
    loadedFamilies.set(id, loading);
  }
  return loading;
}

/**
 * Script fonts (Arabic, Chinese, Japanese, Korean). Chinese and Korean have
 * one weight only: it is registered for bold and italic too, so the browser
 * does not fake a bold the PDF would not have.
 */
const SCRIPT_FILES: Record<ScriptFontId, { regular: string; bold: string }> = {
  "noto-sans-arabic": { regular: notoSansArabicRegular, bold: notoSansArabicBold },
  "noto-sans-sc": { regular: notoSansScRegular, bold: notoSansScRegular },
  "noto-sans-kr": { regular: notoSansKrRegular, bold: notoSansKrRegular },
};

const loadedScripts = new Map<ScriptFontId, Promise<void>>();

export function ensureScriptFontLoaded(id: ScriptFontId): Promise<void> {
  let loading = loadedScripts.get(id);
  if (!loading) {
    const name = SCRIPT_FONT_NAMES[id];
    const files = SCRIPT_FILES[id];
    loading = Promise.all(
      (Object.keys(DESCRIPTORS) as FontVariant[]).map(async (variant) => {
        const bold = variant === "bold" || variant === "boldItalic";
        const face = new FontFace(name, `url(${bold ? files.bold : files.regular})`, DESCRIPTORS[variant]);
        await face.load();
        document.fonts.add(face);
      }),
    ).then(() => {
      // Every family's stack ends with the script fonts: their widths changed.
      fabricCache.clearFontCache();
    });
    loading.catch(() => loadedScripts.delete(id));
    loadedScripts.set(id, loading);
  }
  return loading;
}

/** Loads the script fonts a text needs. Resolves to true if any had to be loaded. */
export async function ensureScriptFontsFor(text: string): Promise<boolean> {
  const missing = [...scriptFontsIn(text)].filter((id) => !loadedScripts.has(id));
  const all = [...scriptFontsIn(text)].map(ensureScriptFontLoaded);
  await Promise.all(all);
  return missing.length > 0;
}

/** Loads every embedded family and script font that a set of Fabric objects uses. */
export async function ensureFontsFor(objects: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  const ids = new Set<EmbeddedFamilyId>();
  let text = "";
  const visit = (object: Record<string, unknown>) => {
    if (typeof object.text === "string") text += object.text;
    if (Array.isArray(object.objects)) (object.objects as Record<string, unknown>[]).forEach(visit);
    if (typeof object.fontFamily !== "string") return;
    const option = familyFromCss(object.fontFamily);
    if (option.embedded) ids.add(option.id as EmbeddedFamilyId);
  };
  objects.forEach(visit);
  await Promise.all([...[...ids].map(ensureFamilyLoaded), ensureScriptFontsFor(text)]);
}

/** Bytes of a script font, for embedding with fontkit. */
export function scriptFontBytes(id: ScriptFontId, bold: boolean): Promise<Uint8Array> {
  return fetchBytes(bold ? SCRIPT_FILES[id].bold : SCRIPT_FILES[id].regular);
}

/** Bytes of a font file, for embedding with fontkit. */
export function embeddedFontBytes(id: EmbeddedFamilyId, variant: FontVariant): Promise<Uint8Array> {
  return fetchBytes(FONT_FILES[id].files[variant]);
}

function fetchBytes(url: string): Promise<Uint8Array> {
  let bytes = fileBytes.get(url);
  if (!bytes) {
    bytes = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`No se pudo cargar la fuente ${url}`);
      return new Uint8Array(await response.arrayBuffer());
    });
    bytes.catch(() => fileBytes.delete(url));
    fileBytes.set(url, bytes);
  }
  return bytes;
}
