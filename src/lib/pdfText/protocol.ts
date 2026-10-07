import type { NativeSpec, PageTextAnalysis } from "./types";

/** Messages between the editor and the text worker. */

export type WorkerRequest =
  | { id: number; type: "open"; sourceId: string; bytes: Uint8Array; password?: string }
  | { id: number; type: "analyze"; sourceId: string; pageIndex: number }
  | {
      id: number;
      type: "derive";
      sourceId: string;
      pageIndex: number;
      specs: NativeSpec[];
      /** Embedded fallback fonts the specs need, by "family:variant". */
      fonts: Record<string, Uint8Array>;
    }
  | { id: number; type: "close"; sourceId: string };

export interface DeriveResult {
  /** The source document with the edited page appended as an update. */
  bytes: Uint8Array;
  /** Specs that could not be applied completely. */
  failed: string[];
  /** Characters no font could draw. */
  unsupported: string[];
}

export type WorkerResponse =
  | { id: number; result: PageTextAnalysis | DeriveResult | null; error?: undefined }
  | { id: number; error: string; result?: undefined };
