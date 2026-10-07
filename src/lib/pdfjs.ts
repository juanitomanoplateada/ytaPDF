import * as pdfjsLib from "pdfjs-dist";
import type { PageViewport, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

const ASSET_BASE = `${import.meta.env.BASE_URL}pdfjs/`;

/** Asset locations served locally by the `pdfjs-assets` Vite plugin. */
const assetOptions = {
  cMapUrl: `${ASSET_BASE}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
  wasmUrl: `${ASSET_BASE}wasm/`,
  iccUrl: `${ASSET_BASE}iccs/`,
};

/** Resolves with the password typed by the user, or `null` if they cancel. */
export type PasswordPrompt = (incorrect: boolean) => Promise<string | null>;

export class PasswordCancelledError extends Error {
  constructor() {
    super("El usuario canceló la contraseña.");
    this.name = "PasswordCancelledError";
  }
}

export async function openPdf(
  bytes: Uint8Array,
  askPassword: PasswordPrompt,
): Promise<{ pdf: PDFDocumentProxy; password?: string }> {
  let password: string | undefined;
  let cancelled = false;

  // PDF.js transfers the buffer to its worker, so it gets its own copy.
  const task = pdfjsLib.getDocument({ data: bytes.slice(), ...assetOptions });
  task.onPassword = (update: (password: string) => void, reason: number) => {
    const incorrect = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    void askPassword(incorrect).then((typed) => {
      if (typed === null) {
        cancelled = true;
        void task.destroy();
        return;
      }
      password = typed;
      update(typed);
    });
  };

  try {
    const pdf = await task.promise;
    return { pdf, password };
  } catch (error) {
    if (cancelled) throw new PasswordCancelledError();
    throw error;
  }
}

/** Opens bytes produced by the app itself (edited previews), which are never encrypted. */
export function openDerivedPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjsLib.getDocument({ data: bytes, ...assetOptions }).promise;
}

export function isRenderCancelled(error: unknown): boolean {
  return error instanceof pdfjsLib.RenderingCancelledException;
}

/**
 * Viewport of a page with an extra rotation on top of its own `/Rotate`, as
 * the editor shows it. At scale 1 its units are PDF points.
 */
export function viewportOf(page: PDFPageProxy, scale: number, extraRotation = 0): PageViewport {
  return page.getViewport({ scale, rotation: (page.rotate + extraRotation) % 360 });
}

/**
 * Renders `page` into `canvas` at `scale` CSS pixels per PDF point, using the
 * device pixel ratio for sharpness. Form fields are drawn with the values held
 * in the document's annotation storage. The returned task can be cancelled.
 */
export function renderPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
  pixelRatio = window.devicePixelRatio || 1,
  extraRotation = 0,
): RenderTask {
  const cssViewport = viewportOf(page, scale, extraRotation);
  const outputScale = clampOutputScale(cssViewport.width, cssViewport.height, pixelRatio);
  const viewport = viewportOf(page, scale * outputScale, extraRotation);

  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  canvas.style.width = `${cssViewport.width}px`;
  canvas.style.height = `${cssViewport.height}px`;

  return page.render({
    canvas,
    viewport,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE,
  });
}

/** Browsers refuse canvases above ~16.7M pixels (less on iOS). */
export const MAX_CANVAS_PIXELS = 16_777_216;

function clampOutputScale(width: number, height: number, desired: number): number {
  const maxScale = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height));
  return Math.max(0.25, Math.min(desired, maxScale));
}

// ── Form fields ────────────────────────────────────────────────────────────

export type FormFieldKind = "text" | "checkbox" | "radio" | "choice";
export type FormValue = string | boolean | string[] | null;

/** A fillable widget on a page, in PDF user space. */
export interface FormWidget {
  id: string;
  fieldName: string;
  kind: FormFieldKind;
  rect: [number, number, number, number];
  readOnly: boolean;
  multiLine: boolean;
  maxLen: number;
  /** Value the field had in the original file. */
  initialValue: FormValue;
  /** Radio: the value this widget selects. Checkbox: its "on" value. */
  onValue?: string;
  options?: { value: string; label: string }[];
  multiSelect: boolean;
  fontSize: number;
  textAlign: "left" | "center" | "right";
}

interface RawWidget {
  id: string;
  annotationType: number;
  fieldType?: string;
  fieldName?: string;
  fieldValue?: unknown;
  rect: number[];
  readOnly?: boolean;
  hidden?: boolean;
  multiLine?: boolean;
  maxLen?: number;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: string;
  buttonValue?: string;
  options?: { exportValue: string; displayValue: string }[];
  multiSelect?: boolean;
  textAlignment?: number;
  defaultAppearanceData?: { fontSize?: number };
}

const WIDGET = 20;
const widgetCache = new WeakMap<PDFPageProxy, Promise<FormWidget[]>>();

function toWidget(raw: RawWidget): FormWidget | null {
  if (raw.annotationType !== WIDGET || raw.hidden || !raw.fieldName) return null;
  const base = widgetBase(raw, raw.fieldName);
  if (raw.fieldType === "Tx") {
    return { ...base, kind: "text", initialValue: typeof raw.fieldValue === "string" ? raw.fieldValue : "" };
  }
  if (raw.fieldType === "Ch") {
    const options = (raw.options ?? []).map((o) => ({ value: o.exportValue, label: o.displayValue }));
    return { ...base, kind: "choice", options, initialValue: choiceValue(raw.fieldValue, !!raw.multiSelect) };
  }
  if (raw.fieldType === "Btn" && raw.checkBox) {
    return { ...base, kind: "checkbox", onValue: raw.exportValue, initialValue: raw.fieldValue === raw.exportValue };
  }
  if (raw.fieldType === "Btn" && raw.radioButton) {
    const selected = textOf(raw.fieldValue);
    return {
      ...base,
      kind: "radio",
      onValue: raw.buttonValue,
      initialValue: selected && selected !== "Off" ? selected : null,
    };
  }
  return null;
}

/** Properties shared by every kind of widget. */
function widgetBase(raw: RawWidget, fieldName: string): Omit<FormWidget, "kind" | "initialValue" | "onValue" | "options"> {
  return {
    id: raw.id,
    fieldName,
    rect: raw.rect as [number, number, number, number],
    readOnly: !!raw.readOnly,
    multiLine: !!raw.multiLine,
    maxLen: raw.maxLen ?? 0,
    multiSelect: !!raw.multiSelect,
    fontSize: raw.defaultAppearanceData?.fontSize ?? 0,
    textAlign: (["left", "center", "right"] as const)[raw.textAlignment ?? 0] ?? "left",
  };
}

/** Initial value of a choice field: every selected option of a list, or the single choice. */
function choiceValue(value: unknown, multiSelect: boolean): FormValue {
  if (!Array.isArray(value)) return textOf(value);
  return multiSelect ? value.map(textOf) : textOf(value[0]);
}

/** A value PDF.js read from the file, as text; anything but a string or a number is empty. */
function textOf(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** Fillable widgets of a page (text, checkboxes, radio buttons and choices). */
export function pageWidgets(page: PDFPageProxy): Promise<FormWidget[]> {
  let widgets = widgetCache.get(page);
  if (!widgets) {
    widgets = page
      .getAnnotations({ intent: "display" })
      .then((annotations) =>
        (annotations as RawWidget[]).map(toWidget).filter((w): w is FormWidget => w !== null),
      )
      .catch(() => []);
    widgetCache.set(page, widgets);
  }
  return widgets;
}

interface FieldObject {
  id: string;
  type: string;
  exportValues?: string;
}

const fieldCache = new WeakMap<PDFDocumentProxy, Promise<Map<string, FieldObject[]>>>();

/** Every widget of every field in a document, grouped by field name. */
export function documentFields(pdf: PDFDocumentProxy): Promise<Map<string, FieldObject[]>> {
  let fields = fieldCache.get(pdf);
  if (!fields) {
    fields = pdf
      .getFieldObjects()
      .then((map) => {
        const result = new Map<string, FieldObject[]>();
        for (const [name, list] of map ?? []) {
          // The first entry of a field with widgets is the field itself, without a type.
          result.set(name, (list as FieldObject[]).filter((field) => field.id && field.type));
        }
        return result;
      })
      .catch(() => new Map());
    fieldCache.set(pdf, fields);
  }
  return fields;
}

/**
 * Writes form values into PDF.js's annotation storage, so pages and thumbnails
 * render them. `values` maps field names to values; missing fields keep the
 * value they have in the file.
 */
export async function syncFormStorage(
  pdf: PDFDocumentProxy,
  values: Record<string, FormValue>,
  previous: Record<string, FormValue> = {},
): Promise<void> {
  const fields = await documentFields(pdf);
  const storage = pdf.annotationStorage;
  const names = new Set([...Object.keys(values), ...Object.keys(previous)]);
  for (const name of names) {
    const widgets = fields.get(name);
    if (!widgets || values[name] === previous[name]) continue;
    const value = values[name];
    for (const widget of widgets) {
      if (value === undefined) {
        // Back to the value stored in the file (for example, after undo).
        storage.remove(widget.id);
        continue;
      }
      if (widget.type === "radiobutton") {
        storage.setValue(widget.id, { value: value === widget.exportValues });
      } else if (widget.type === "checkbox") {
        storage.setValue(widget.id, { value: value === true });
      } else {
        storage.setValue(widget.id, { value: value ?? "" });
      }
    }
  }
}
