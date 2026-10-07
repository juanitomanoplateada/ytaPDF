/// <reference lib="webworker" />
import fontkit from "@cantoo/fontkit";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { TextDocument } from "./textDocument";

/**
 * Runs the text analysis and builds page previews off the main thread, so
 * reading large documents never freezes the editor.
 */

const documents = new Map<string, Promise<TextDocument>>();
const scope = self as unknown as DedicatedWorkerGlobalScope;

function documentFor(sourceId: string): Promise<TextDocument> {
  const document = documents.get(sourceId);
  if (!document) throw new Error("El documento no está abierto en el analizador de texto.");
  return document;
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    switch (request.type) {
      case "open":
        if (!documents.has(request.sourceId)) {
          const opening = TextDocument.open(request.bytes, request.password, fontkit);
          opening.catch(() => documents.delete(request.sourceId));
          documents.set(request.sourceId, opening);
        }
        await documents.get(request.sourceId);
        scope.postMessage({ id: request.id, result: null } satisfies WorkerResponse);
        break;
      case "analyze": {
        const document = await documentFor(request.sourceId);
        scope.postMessage({ id: request.id, result: await document.analyze(request.pageIndex) } satisfies WorkerResponse);
        break;
      }
      case "derive": {
        const document = await documentFor(request.sourceId);
        const result = await document.derive(request.pageIndex, request.specs, request.fonts);
        scope.postMessage({ id: request.id, result } satisfies WorkerResponse, [result.bytes.buffer as ArrayBuffer]);
        break;
      }
      case "close":
        documents.delete(request.sourceId);
        scope.postMessage({ id: request.id, result: null } satisfies WorkerResponse);
        break;
    }
  } catch (error) {
    console.error("Error en el analizador de texto:", error);
    scope.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse);
  }
};
