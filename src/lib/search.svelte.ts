import { editor } from "./editor.svelte";
import { ocrKey, ocrStamp, withOcrText } from "./ocrText";
import { pageTextContent } from "./pdfjs";
import { buildPageText, findInPage, type PageText, type SearchItem, type TextRange } from "./textSearch";

/** A match on one of the document's pages. */
export interface SearchMatch extends TextRange {
  pageId: string;
}

/**
 * Searching the document's text (Ctrl+F). The text of each source page is
 * read once; the editor's pages map to them, so reordered or duplicated pages
 * are found where they are now. Pages draw the highlights from `matches`.
 */
class Search {
  open = $state(false);
  query = $state("");
  matches = $state.raw<SearchMatch[]>([]);
  /** Index of the match being shown, or -1. */
  current = $state(-1);
  searching = $state(false);
  /** The matches were removed because their text was replaced or covered. */
  cleared = $state(false);
  /** Bumped to ask the page of the current match to bring it into view. */
  reveal = $state(0);

  readonly #texts = new Map<string, Promise<PageText>>();
  #run = 0;

  currentMatch = $derived(this.current >= 0 ? (this.matches[this.current] ?? null) : null);

  show(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.matches = [];
    this.current = -1;
  }

  /** Removes the highlights (the text they pointed to was replaced or covered). */
  clearMatches(): void {
    this.matches = [];
    this.current = -1;
    this.cleared = true;
  }

  /** Forgets the text read so far (the document was closed). */
  reset(): void {
    this.#texts.clear();
    this.close();
    this.query = "";
  }

  #pageText(sourceId: string, sourceIndex: number): Promise<PageText> {
    const recognised = editor.ocr[ocrKey(sourceId, sourceIndex)];
    const key = `${sourceId}:${sourceIndex}:${ocrStamp(recognised)}`;
    let text = this.#texts.get(key);
    if (!text) {
      const source = editor.sources.get(sourceId);
      if (!source) return Promise.resolve(buildPageText([]));
      text = source.pdf
        .getPage(sourceIndex + 1)
        .then(pageTextContent)
        .then((content) => withOcrText(content, recognised))
        .then((content) =>
          buildPageText((content.items as object[]).filter((item): item is SearchItem => "str" in item)),
        )
        .catch(() => buildPageText([]));
      this.#texts.set(key, text);
    }
    return text;
  }

  /** Finds every match of `query`, starting the count from the page in view. */
  async find(query = this.query): Promise<void> {
    this.query = query;
    this.cleared = false;
    const run = ++this.#run;
    if (!query.trim()) {
      this.matches = [];
      this.current = -1;
      return;
    }
    this.searching = true;
    const matches: SearchMatch[] = [];
    for (const page of editor.pages) {
      const text = await this.#pageText(page.sourceId, page.sourceIndex);
      if (run !== this.#run) return;
      for (const range of findInPage(text, query)) matches.push({ ...range, pageId: page.id });
    }
    this.searching = false;
    this.matches = matches;
    // The first match from the current page on.
    const from = editor.currentPageIndex;
    const order = new Map(editor.pages.map((page, i) => [page.id, i]));
    const next = matches.findIndex((match) => (order.get(match.pageId) ?? 0) >= from);
    this.current = matches.length === 0 ? -1 : Math.max(0, next);
    this.#show();
  }

  next(): void {
    if (this.matches.length === 0) return;
    this.current = (this.current + 1) % this.matches.length;
    this.#show();
  }

  previous(): void {
    if (this.matches.length === 0) return;
    this.current = (this.current - 1 + this.matches.length) % this.matches.length;
    this.#show();
  }

  #show(): void {
    const match = this.currentMatch;
    if (!match) return;
    if (match.pageId !== editor.currentPageId) editor.goToPage(match.pageId, false);
    this.reveal += 1;
  }

  /** The matches on one page, with whether each is the current one. */
  matchesOn(pageId: string): (SearchMatch & { active: boolean })[] {
    const current = this.currentMatch;
    return this.matches.filter((match) => match.pageId === pageId).map((match) => ({ ...match, active: match === current }));
  }
}

export const search = new Search();
