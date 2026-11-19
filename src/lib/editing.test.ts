import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { alignShifts, distributeShifts, unionBounds } from "./arrange";
import { cropShift, intersectBox, sceneRectToBox } from "./crop";
import { DEFAULT_DECORATIONS, decorationObjects, fillTokens, hasDecorations, type PageDecorations } from "./decorations";
import { EN } from "./locales/en";
import { tieOutline, toOutlineEntries, type Bookmark } from "./outline";
import { readProject, writeProject } from "./project";
import type { SavedSession } from "./session";
import { markLine, mergeLines } from "./textMarks";
import { buildPageText, findInPage, normalizeQuery } from "./textSearch";
import { createZip, readZip } from "./zip";

describe("text search", () => {
  const page = buildPageText([{ str: "La canción " }, { str: "del " }, { str: "AÑO", hasEOL: true }, { str: "ﬁnal  feliz" }]);

  it("ignores case and accents, and finds text split across items", () => {
    const [match] = findInPage(page, "cancion del año");
    expect(match).toEqual({ start: { item: 0, offset: 3 }, end: { item: 2, offset: 2 } });
  });

  it("matches across a line end and collapses repeated spaces", () => {
    expect(findInPage(page, "año final")).toHaveLength(1);
    expect(findInPage(page, "final feliz")).toEqual([{ start: { item: 3, offset: 0 }, end: { item: 3, offset: 10 } }]);
  });

  it("maps ligatures back to the character that holds them", () => {
    // "ﬁ" is one character in the PDF and two when searched.
    const [match] = findInPage(page, "fin");
    expect(match.start).toEqual({ item: 3, offset: 0 });
    expect(match.end).toEqual({ item: 3, offset: 1 });
  });

  it("finds every occurrence and nothing for an empty query", () => {
    const repeated = buildPageText([{ str: "ana y Ana y ANA" }]);
    expect(findInPage(repeated, "ana")).toHaveLength(3);
    expect(findInPage(repeated, "   ")).toEqual([]);
    expect(normalizeQuery("  Árbol   Ñu ")).toBe("arbol nu");
  });
});

describe("text marks", () => {
  it("merges the boxes of a selection into one box per line", () => {
    const lines = mergeLines([
      { x: 10, y: 100, width: 40, height: 12 },
      { x: 52, y: 101, width: 30, height: 11 },
      { x: 10, y: 120, width: 50, height: 12 },
      { x: 60, y: 100, width: 0, height: 0 },
    ]);
    expect(lines).toEqual([
      { x: 10, y: 100, width: 72, height: 12 },
      { x: 10, y: 120, width: 50, height: 12 },
    ]);
  });

  it("merges vertical lines on turned pages", () => {
    const lines = mergeLines(
      [
        { x: 100, y: 10, width: 12, height: 40 },
        { x: 100, y: 52, width: 12, height: 30 },
      ],
      true,
    );
    expect(lines).toEqual([{ x: 100, y: 10, width: 12, height: 72 }]);
  });

  it("puts underlines under the letters and strikeouts through them, whichever way the page is turned", () => {
    const box = { x: 10, y: 100, width: 80, height: 20 };
    expect(markLine("underline", box, 0)).toEqual({ from: [10, 118], to: [90, 118], width: 1.4 });
    expect(markLine("strikeout", box, 0).from[1]).toBeCloseTo(111, 6);
    expect(markLine("underline", box, 180).from[1]).toBeCloseTo(102, 6);
    const turned = { x: 100, y: 10, width: 20, height: 80 };
    // Turned clockwise, the bottom of the letters faces left.
    expect(markLine("underline", turned, 90).from[0]).toBeCloseTo(102, 6);
    expect(markLine("underline", turned, 270).from[0]).toBeCloseTo(118, 6);
  });
});

describe("align and distribute", () => {
  const boxes = [
    { left: 10, top: 10, width: 20, height: 10 },
    { left: 50, top: 30, width: 10, height: 20 },
    { left: 100, top: 5, width: 30, height: 5 },
  ];

  it("aligns to the edges and centres of the selection", () => {
    expect(alignShifts(boxes, "left").map((s) => s.dx)).toEqual([0, -40, -90]);
    expect(alignShifts(boxes, "right").map((s) => s.dx)).toEqual([100, 70, 0]);
    expect(alignShifts(boxes, "middle").map((s) => s.dy)).toEqual([12.5, -12.5, 20]);
    expect(unionBounds(boxes)).toEqual({ left: 10, top: 5, width: 120, height: 45 });
  });

  it("aligns a single object to the page", () => {
    const [shift] = alignShifts([boxes[0]], "center", { left: 0, top: 0, width: 600, height: 800 });
    expect(shift).toEqual({ dx: 280, dy: 0 });
  });

  it("leaves equal gaps between objects, keeping the outer ones", () => {
    const shifts = distributeShifts(boxes, "horizontal");
    const moved = boxes.map((b, i) => b.left + shifts[i].dx);
    // Gaps: (130 - 10 - 60) / 2 = 30.
    expect(moved).toEqual([10, 60, 100]);
    expect(distributeShifts(boxes.slice(0, 2), "vertical")).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
  });
});

describe("crop", () => {
  // Viewport of a 600 × 400 page at scale 1: y flips, origin at the top left.
  const upright = [1, 0, 0, -1, 0, 400];
  // The same page turned 90° clockwise (PDF.js transform).
  const turned = [0, 1, 1, 0, 0, 0];

  it("turns a scene rectangle into a PDF box", () => {
    expect(sceneRectToBox(upright, { x0: 50, y0: 100, x1: 250, y1: 300 })).toEqual([50, 100, 250, 300]);
    expect(sceneRectToBox(turned, { x0: 10, y0: 20, x1: 110, y1: 220 })).toEqual([20, 10, 220, 110]);
  });

  it("intersects boxes", () => {
    expect(intersectBox([0, 0, 100, 100], [50, 50, 200, 200])).toEqual([50, 50, 100, 100]);
    expect(intersectBox([0, 0, 10, 10], [20, 20, 30, 30])).toBeNull();
  });

  it("moves content by where the old origin lands in the cropped view", () => {
    // Cropping to [50, 100, 250, 300]: the viewport now starts at x 50 and y 300.
    const cropped = [1, 0, 0, -1, -50, 300];
    expect(cropShift(upright, cropped)).toEqual([-50, -100]);
    expect(cropShift(cropped, upright)).toEqual([50, 100]);
  });
});

describe("page decorations", () => {
  const decorations: PageDecorations = {
    ...DEFAULT_DECORATIONS,
    numbers: { enabled: true, position: "bottom-right", format: "{n} / {N}", startAt: 1 },
    header: { text: "{nombre} — {fecha}", align: "left" },
    footer: { text: "", align: "center" },
    watermark: { text: "BORRADOR", color: "#999999", opacity: 0.3, diagonal: true },
    fromPage: 2,
  };
  const context = { index: 2, total: 5, width: 600, height: 800, name: "Contrato", date: "12/11/2026" };

  it("knows when there is nothing to draw", () => {
    expect(hasDecorations(null)).toBe(false);
    expect(hasDecorations({ ...DEFAULT_DECORATIONS, numbers: { ...DEFAULT_DECORATIONS.numbers, enabled: false } })).toBe(false);
    expect(hasDecorations(decorations)).toBe(true);
  });

  it("fills the placeholders", () => {
    expect(fillTokens("Página {n} de {N} · {name} · {date}", 3, 9, "Acta", "hoy")).toBe("Página 3 de 9 · Acta · hoy");
  });

  it("numbers from the chosen page and places the texts at the margins", () => {
    const objects = decorationObjects(decorations, { ...context, measure: (text, size) => text.length * size * 0.6 });
    const [watermark, header, number] = objects;
    expect(watermark).toMatchObject({ text: "BORRADOR", left: 300, top: 400, originX: "center", opacity: 0.3 });
    expect(watermark.angle as number).toBeCloseTo((-Math.atan2(800, 600) * 180) / Math.PI, 6);
    expect(header).toMatchObject({ text: "Contrato — 12/11/2026", left: 28, top: 28, originX: "left", originY: "top" });
    // Page 3 is the second decorated page (from page 2), out of 4.
    expect(number).toMatchObject({ text: "2 / 4", left: 572, top: 772, originX: "right", originY: "bottom" });
  });

  it("puts only the watermark on pages before the first decorated one", () => {
    const objects = decorationObjects(decorations, { ...context, index: 0 });
    expect(objects.map((o) => o.text)).toEqual(["BORRADOR"]);
  });
});

describe("bookmarks", () => {
  const tree: Bookmark[] = [
    {
      id: "a",
      title: "Capítulo 1",
      pageId: "p1",
      top: 700,
      children: [{ id: "a1", title: "Sección borrada", pageId: "gone", top: null, children: [{ id: "a1x", title: "Detalle", pageId: "p3", top: null, children: [] }] }],
    },
    { id: "b", title: "Anexo", pageId: null, top: null, children: [] },
  ];

  it("ties nested entries of a source to the pages now showing them", () => {
    const pages = new Map([
      [0, "p-a"],
      [2, "p-c"],
    ]);
    const tied = tieOutline(
      "src",
      [
        {
          title: "Condiciones",
          pageIndex: 1,
          top: 760,
          children: [{ title: "Rescisión", pageIndex: 2, top: 700, children: [] }],
        },
      ],
      (index) => pages.get(index) ?? null,
    );
    expect(tied).toEqual([
      {
        id: "src:0",
        title: "Condiciones",
        pageId: null,
        top: 760,
        children: [{ id: "src:0:0", title: "Rescisión", pageId: "p-c", top: 700, children: [] }],
      },
    ]);
  });

  it("keeps the entries whose page is exported and lifts the children of the others", () => {
    const index = new Map([
      ["p1", 0],
      ["p3", 1],
    ]);
    expect(toOutlineEntries(tree, (id) => index.get(id) ?? -1)).toEqual([
      {
        title: "Capítulo 1",
        pageIndex: 0,
        top: 700,
        children: [{ title: "Detalle", pageIndex: 1, top: null, children: [] }],
      },
    ]);
  });
});

describe("zip and project files", () => {
  it("reads back the files it writes", async () => {
    const zip = createZip([
      { name: "uno.txt", bytes: new TextEncoder().encode("uno") },
      { name: "carpeta/dos.txt", bytes: new TextEncoder().encode("dos") },
    ]);
    const files = await readZip(zip);
    expect([...files.keys()]).toEqual(["uno.txt", "carpeta/dos.txt"]);
    expect(new TextDecoder().decode(files.get("carpeta/dos.txt"))).toBe("dos");
  });

  it("reads deflated files written by other tools", async () => {
    const text = "texto comprimido ".repeat(50);
    const deflated = new Uint8Array(
      await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer(),
    );
    const zip = createZip([{ name: "a.txt", bytes: deflated }]);
    // Mark the entry as deflated, with its real size, in both headers.
    const view = new DataView(zip.buffer);
    const central = view.getUint32(zip.length - 22 + 16, true);
    view.setUint16(8, 8, true);
    view.setUint16(central + 10, 8, true);
    const files = await readZip(zip);
    expect(new TextDecoder().decode(files.get("a.txt"))).toBe(text);
  });

  it("saves and opens a whole work as a project", async () => {
    const session: SavedSession = {
      version: 1,
      id: "trabajo-1",
      savedAt: 1,
      documentName: "Contrato",
      kept: true,
      sources: [{ id: "s1", name: "contrato.pdf", bytes: new TextEncoder().encode("%PDF-1.4 falso") }],
      pages: [{ id: "p1", sourceId: "s1", sourceIndex: 0, rotation: 90, crop: [10, 10, 200, 300], width: 290, height: 190 }],
      annotations: { p1: { objects: [{ type: "Image", src: "blob:a" }] } },
      formValues: { s1: { nombre: "Ana" } },
      images: [{ url: "blob:a", mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }],
      decorations: DEFAULT_DECORATIONS,
    };
    const opened = await readProject(writeProject(session));
    expect(opened.pages).toEqual(session.pages);
    expect(opened.annotations).toEqual(session.annotations);
    expect(opened.formValues).toEqual(session.formValues);
    expect(opened.decorations).toEqual(DEFAULT_DECORATIONS);
    expect(new TextDecoder().decode(opened.sources[0].bytes)).toBe("%PDF-1.4 falso");
    expect([...opened.images[0].bytes]).toEqual([137, 80, 78, 71]);
  });

  it("refuses files that are not projects", async () => {
    await expect(readProject(new TextEncoder().encode("hola"))).rejects.toThrow();
    await expect(readProject(createZip([{ name: "otro.txt", bytes: new Uint8Array(1) }]))).rejects.toThrow();
  });
});

describe("translations", () => {
  it("has an English text for every text the interface shows", () => {
    const keys = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|svelte)$/.test(name) && !name.endsWith(".test.ts")) {
          for (const match of readFileSync(path, "utf8").matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
            keys.add(JSON.parse(`"${match[1]}"`) as string);
          }
        }
      }
    };
    walk(join(process.cwd(), "src"));
    const missing = [...keys].filter((key) => !(key in EN));
    expect(missing).toEqual([]);
    expect(keys.size).toBeGreaterThan(400);
  });

  it("keeps the placeholders of each text in its translation", () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(byName);
    // Documented tokens of headers and footers have English names in English.
    const renamed: Record<string, string> = { fecha: "date", nombre: "name" };
    for (const [spanish, english] of Object.entries(EN)) {
      const expected = placeholders(spanish).map((name) => renamed[name] ?? name).sort(byName);
      expect(placeholders(english), spanish).toEqual(expected);
    }
  });
});
