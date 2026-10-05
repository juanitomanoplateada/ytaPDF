import { cache as fabricCache } from "fabric";
import notoSansRegular from "@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf?url";
import notoSansBold from "@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf?url";
import notoSansItalic from "@expo-google-fonts/noto-sans/400Regular_Italic/NotoSans_400Regular_Italic.ttf?url";
import notoSansBoldItalic from "@expo-google-fonts/noto-sans/700Bold_Italic/NotoSans_700Bold_Italic.ttf?url";
import notoSerifRegular from "@expo-google-fonts/noto-serif/400Regular/NotoSerif_400Regular.ttf?url";
import notoSerifBold from "@expo-google-fonts/noto-serif/700Bold/NotoSerif_700Bold.ttf?url";
import notoSerifItalic from "@expo-google-fonts/noto-serif/400Regular_Italic/NotoSerif_400Regular_Italic.ttf?url";
import notoSerifBoldItalic from "@expo-google-fonts/noto-serif/700Bold_Italic/NotoSerif_700Bold_Italic.ttf?url";
import { familyFromCss, type EmbeddedFamilyId, type FontVariant } from "./fonts";

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

/** Loads every embedded family that a set of Fabric objects uses. */
export async function ensureFontsFor(objects: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  const ids = new Set<EmbeddedFamilyId>();
  for (const object of objects) {
    if (typeof object.fontFamily !== "string") continue;
    const option = familyFromCss(object.fontFamily);
    if (option.embedded) ids.add(option.id as EmbeddedFamilyId);
  }
  await Promise.all([...ids].map(ensureFamilyLoaded));
}

/** Bytes of a font file, for embedding with fontkit. */
export function embeddedFontBytes(id: EmbeddedFamilyId, variant: FontVariant): Promise<Uint8Array> {
  const url = FONT_FILES[id].files[variant];
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
