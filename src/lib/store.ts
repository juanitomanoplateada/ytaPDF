import { writable } from "svelte/store";
import type * as pdfjsLib from "pdfjs-dist";

export type ToolType = "SELECT" | "TEXT" | "SIGNATURE";

export interface PageAnnotation {
  viewportDimensions: { width: number; height: number };
  fabricJSON: any;
}

export interface RootState {
  documentId: string;
  originalPdfBytes: Uint8Array | null;
  loadedPdfDocument: pdfjsLib.PDFDocumentProxy | null;
  numPages: number;
  currentPage: number;
  globalZoom: number;
  activeTool: ToolType;
  isOrganizerMode: boolean;
  isMobileSidebarOpen: boolean;
  pagesAnnotations: Record<number, PageAnnotation>;
  errorMessage: string | null;
  activeTextParams: {
    fontFamily: string;
    fontSize: number;
    fill: string;
    fontWeight: string;
    fontStyle: string;
    underline: boolean;
  } | null;
  activeObjectParams: {
    angle: number;
    flipX: boolean;
    flipY: boolean;
    opacity: number;
  } | null;
  history: Record<number, PageAnnotation>[];
  historyIndex: number;
}

export const editorStore = writable<RootState>({
  documentId: "",
  originalPdfBytes: null,
  loadedPdfDocument: null,
  numPages: 0,
  currentPage: 1,
  globalZoom: 1.0,
  activeTool: "SELECT",
  isOrganizerMode: false,
  isMobileSidebarOpen: false,
  pagesAnnotations: {},
  errorMessage: null,
  activeTextParams: null,
  activeObjectParams: null,
  history: [{}],
  historyIndex: 0,
});
