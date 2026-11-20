import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  editor: {
    ocr: {} as Record<string, unknown>,
    sources: new Map<string, { pdf: { getPage: (n: number) => Promise<unknown> } }>(),
    pages: [] as { id: string; sourceId: string; sourceIndex: number }[],
    currentPageIndex: 0,
    currentPageId: null as string | null,
    goToPage: vi.fn(),
  },
}));

vi.mock("./editor.svelte", () => ({ editor: state.editor }));
vi.mock("./pdfjs", () => ({ pageTextContent: async (page: { items: unknown[] }) => ({ items: page.items, styles: {} }) }));

const { search } = await import("./search.svelte");

const item = (str: string) => ({ str, transform: [1, 0, 0, 1, 0, 0], width: str.length, height: 1, fontName: "f", hasEOL: true, dir: "ltr" });

/** A source whose page n has the given texts; pages listed in `broken` fail to load. */
function source(pages: string[][], broken: number[] = []) {
  const getPage = vi.fn(async (n: number) => {
    if (broken.includes(n)) throw new Error("página dañada");
    return { items: [...pages[n - 1].map(item), { type: "beginMarkedContent" }] };
  });
  return { pdf: { getPage } };
}

beforeEach(() => {
  search.reset();
  state.editor.sources.clear();
  state.editor.ocr = {};
  state.editor.goToPage.mockReset();
  state.editor.currentPageIndex = 0;
  state.editor.currentPageId = "p1";
});

describe("searching the document", () => {
  it("finds matches on every page, starting from the page in view", async () => {
    const doc = source([["hola mundo"], ["adiós"], ["hola otra vez, hola"]]);
    state.editor.sources.set("s", doc);
    state.editor.pages = [1, 2, 3].map((n) => ({ id: `p${n}`, sourceId: "s", sourceIndex: n - 1 }));
    state.editor.currentPageIndex = 1;
    search.show();
    expect(search.open).toBe(true);
    await search.find("hola");
    expect(search.matches.map((m) => m.pageId)).toEqual(["p1", "p3", "p3"]);
    expect(search.current).toBe(1);
    expect(state.editor.goToPage).toHaveBeenCalledWith("p3", false);
    expect(search.matchesOn("p3").map((m) => m.active)).toEqual([true, false]);

    search.next();
    search.next();
    expect(search.current).toBe(0);
    search.previous();
    expect(search.current).toBe(2);
    // Pages are read once.
    await search.find("mundo");
    expect(doc.pdf.getPage).toHaveBeenCalledTimes(3);
  });

  it("picks the first match when none comes after the page in view", async () => {
    state.editor.sources.set("s", source([["hola"], ["nada"]]));
    state.editor.pages = [
      { id: "p1", sourceId: "s", sourceIndex: 0 },
      { id: "p2", sourceId: "s", sourceIndex: 1 },
    ];
    state.editor.currentPageIndex = 1;
    await search.find("hola");
    expect(search.current).toBe(0);
    // The match is already on the page in view.
    expect(state.editor.goToPage).not.toHaveBeenCalled();
  });

  it("finds nothing in missing sources or pages that fail to load", async () => {
    state.editor.sources.set("s", source([["hola"]], [1]));
    state.editor.pages = [
      { id: "p1", sourceId: "s", sourceIndex: 0 },
      { id: "p2", sourceId: "falta", sourceIndex: 0 },
    ];
    await search.find("hola");
    expect(search.matches).toEqual([]);
    expect(search.current).toBe(-1);
    search.next();
    search.previous();
    expect(search.current).toBe(-1);
  });

  it("clears results for an empty query and when matches are covered", async () => {
    state.editor.sources.set("s", source([["hola"]]));
    state.editor.pages = [{ id: "p1", sourceId: "s", sourceIndex: 0 }];
    await search.find("hola");
    search.clearMatches();
    expect(search.cleared).toBe(true);
    expect(search.matches).toEqual([]);
    await search.find("   ");
    expect(search.cleared).toBe(false);
    expect(search.current).toBe(-1);
    search.close();
    expect(search.open).toBe(false);
  });

  it("drops the results of a search overtaken by a newer one", async () => {
    let release!: () => void;
    const slow = { pdf: { getPage: () => new Promise((resolve) => (release = () => resolve({ items: [item("hola")] }))) } };
    state.editor.sources.set("s", slow as never);
    state.editor.pages = [{ id: "p1", sourceId: "s", sourceIndex: 0 }];
    const first = search.find("hola");
    await search.find("");
    release();
    await first;
    expect(search.matches).toEqual([]);
  });

  it("searches recognised text as well", async () => {
    state.editor.sources.set("s", source([[]]));
    state.editor.pages = [{ id: "p1", sourceId: "s", sourceIndex: 0 }];
    state.editor.ocr = {
      "s:0": { languages: "spa", lines: [{ quad: [[0, 0], [10, 0], [10, 2], [0, 2]], words: [{ text: "escaneado", quad: [[0, 0], [10, 0], [10, 2], [0, 2]] }] }] },
    };
    await search.find("escaneado");
    expect(search.matches).toHaveLength(1);
  });
});
