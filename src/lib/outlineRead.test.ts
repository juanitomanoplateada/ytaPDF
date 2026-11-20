import { describe, expect, it } from "vitest";
import { readOutline, tieOutline, toOutlineEntries } from "./outline";

/** A PDF.js document that only knows about its outline. */
function fakePdf(outline: unknown, destinations: Record<string, unknown> = {}) {
  return {
    getOutline: async () => {
      if (outline instanceof Error) throw outline;
      return outline;
    },
    getDestination: async (name: string) => {
      if (name === "rota") throw new Error("destino dañado");
      return destinations[name] ?? null;
    },
    getPageIndex: async (ref: { num: number }) => ref.num - 1,
  } as never;
}

const item = (title: unknown, dest: unknown, items?: unknown[]) => ({ title, dest, items });

describe("reading outlines", () => {
  it("has nothing to read when the outline is missing or broken", async () => {
    expect(await readOutline(fakePdf(null))).toEqual([]);
    expect(await readOutline(fakePdf(new Error("roto")))).toEqual([]);
  });

  it("reads explicit and named destinations, with the height of each fit mode", async () => {
    const outline = [
      item("  Uno  ", [{ num: 3 }, { name: "XYZ" }, 0, 700, null]),
      item("", "capitulo"),
      item(undefined, [0, { name: "FitBH" }, 300]),
      item("Fit", [1, { name: "Fit" }]),
      item("Sin destino", []),
      item("Nombre roto", "rota"),
      item("Raro", ["x", undefined]),
      item("Alto no numérico", [0, { name: "XYZ" }, 0, "alto"]),
    ];
    const result = await readOutline(fakePdf(outline, { capitulo: [{ num: 2 }, { name: "FitH" }, 500] }));
    expect(result.map(({ title, pageIndex, top }) => [title, pageIndex, top])).toEqual([
      ["Uno", 2, 700],
      ["—", 1, 500],
      ["—", 0, 300],
      ["Fit", 1, null],
      ["Sin destino", null, null],
      ["Nombre roto", null, null],
      ["Raro", null, null],
      ["Alto no numérico", 0, null],
    ]);
  });

  it("stops at a depth of twelve levels and after two thousand entries", async () => {
    let deep = item("hoja", [0, { name: "Fit" }]);
    for (let i = 0; i < 14; i++) deep = item(`nivel ${i}`, [0, { name: "Fit" }], [deep]);
    let depth = 0;
    for (let node = (await readOutline(fakePdf([deep])))[0]; node; node = node.children[0]) depth++;
    expect(depth).toBe(13);

    const many = Array.from({ length: 2100 }, (_, i) => item(`${i}`, [0, { name: "Fit" }]));
    expect(await readOutline(fakePdf(many))).toHaveLength(2000);
  });

  it("ties entries without a page to none", () => {
    const pageFor = (index: number) => `p${index}`;
    expect(tieOutline("s", [{ title: "A", pageIndex: null, top: null, children: [] }], pageFor)[0].pageId).toBeNull();
  });

  it("keeps the children of entries whose page is gone", () => {
    const entries = toOutlineEntries(
      [{ id: "a", title: "A", pageId: null, top: null, children: [{ id: "b", title: "B", pageId: "p1", top: 10, children: [] }] }],
      () => 0,
    );
    expect(entries).toEqual([{ title: "B", pageIndex: 0, top: 10, children: [] }]);
  });
});
